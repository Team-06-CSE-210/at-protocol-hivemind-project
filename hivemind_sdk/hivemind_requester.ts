import { TID } from "@atproto/common-web";
import { l } from "@atproto/lex";
import * as hivemind from "../core/protocol/generated/com/hivemind-network.js";
import {
	type RecordChange,
	SpaceAccessDeniedError,
} from "../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	RequesterClient,
	RequesterClientOptions,
	TaskHandle,
} from "../core/protocol/interfaces/internal/client_lib.js";
import type {
	AgentProgress,
	Assignment,
	Did,
	Registration,
	SpaceRef,
	TaskId,
	TaskState,
	TypedObject,
} from "../core/protocol/interfaces/internal/types.js";
import {
	createTaskId,
	requestIntakeSpaceRef,
	taskSpaceRef,
} from "../core/protocol/protocol_config/space_definition.js";
import { rideTaskType } from "../core/protocol/type_definition/task_types/taxi_ride.js";

// Submit a taxi request from an active requester's account to the coordinator's request intake.
// The demo and the requester SDK can share this write step.

const REQUEST_COLLECTION = "com.hivemind-network.requester.request";
const RIDE_REQUEST_TYPE = "com.hivemind-network.mobility.ride#request";
const STATE_COLLECTION = "com.hivemind-network.coordinator.taskState";
const ASSIGNMENT_COLLECTION = "com.hivemind-network.coordinator.assignment";
const PROGRESS_COLLECTION = "com.hivemind-network.agent.progress";
const SELECTION_COLLECTION = "com.hivemind-network.requester.selection";

const TASK_SPACE_WAIT_MS = 10_000;
const END_PHASES = new Set([
	"cancelled",
	"completed",
	"expired",
	"failed",
	"noCoverage",
	"noOffers",
]);

type SubmitRequestOptions = {
	selectionMode?: "auto" | "choose";
	maxWaitMs?: number;
};

type SubmittedRequest = {
	taskId: TaskId;
	requestRkey: string;
};

// Resolve when the Gateway write completes. The coordinator observes the request separately.
export async function submitRequest(
	dependencies: Omit<RequesterClientOptions, "gateway"> & {
		gateway: Pick<RequesterClientOptions["gateway"], "putSpaceRecord">;
	},
	payload: unknown,
	options: SubmitRequestOptions = {},
): Promise<SubmittedRequest> {
	const { gateway, coordinator } = dependencies;
	const { selectionMode, maxWaitMs } = options;

	// Match the SDK's two selection modes; Lexicon knownValues are open to future values.
	if (
		selectionMode !== undefined &&
		selectionMode !== "auto" &&
		selectionMode !== "choose"
	) {
		throw new Error("submitRequest: selectionMode must be auto or choose");
	}

	// Validate the full record before writing. The open payload union also needs a task-specific check.
	const taskId = createTaskId();
	const request = hivemind.requester.request.main.parse({
		$type: REQUEST_COLLECTION,
		taskId,
		payload,
		...(selectionMode === undefined ? {} : { selectionMode }),
		...(maxWaitMs === undefined ? {} : { maxWaitMs }),
		createdAt: l.toDatetimeString(new Date()),
	});
	if (request.payload.$type !== RIDE_REQUEST_TYPE) {
		throw new Error(`submitRequest: expected a ${RIDE_REQUEST_TYPE} payload`);
	}
	rideTaskType.parseRequest(request.payload);

	// The task ID identifies the task across spaces; the TID identifies this request record.
	const requestRkey = TID.nextStr();
	await gateway.putSpaceRecord(
		requestIntakeSpaceRef(coordinator),
		REQUEST_COLLECTION,
		requestRkey,
		l.asUnknown$TypedObject(request),
	);
	return { taskId, requestRkey };
}

export class HivemindRequester implements RequesterClient {
	constructor(private readonly dependencies: RequesterClientOptions) {}

	async register(): Promise<Registration> {
		const { coordinator, gateway } = this.dependencies;
		const registration = await gateway.callProcedure(
			`${coordinator}#hivemind_coordinator`,
			"com.hivemind-network.coordinator.register",
			{ role: "requester" },
		);
		return hivemind.coordinator.defs.registration.parse(registration);
	}

	async request(
		payload: TypedObject,
		options?: SubmitRequestOptions,
	): Promise<RequesterTask> {
		const submitted = await submitRequest(this.dependencies, payload, options);
		return RequesterTask.follow(this.dependencies, submitted);
	}
}

type Listener<T> = (value: T) => void;

export class RequesterTask implements TaskHandle {
	readonly taskId: TaskId;
	/** Resolves after the first sync. A watch failure is reported here. */
	readonly ready: Promise<void>;
	private readonly space: SpaceRef;
	private state?: TaskState;
	private assignment?: Assignment;
	private progress?: AgentProgress;
	private pendingProgress: { author: Did; progress: AgentProgress }[] = [];
	private readonly stateListeners = new Set<Listener<TaskState>>();
	private readonly assignmentListeners = new Set<Listener<Assignment>>();
	private readonly progressListeners = new Set<Listener<AgentProgress>>();
	private stopWatching?: () => void;
	private wakeRetry?: () => void;
	private closed = false;
	private cancellation?: Promise<void>;

	private constructor(
		private readonly dependencies: RequesterClientOptions,
		private readonly submitted: SubmittedRequest,
	) {
		this.taskId = submitted.taskId;
		this.space = taskSpaceRef(dependencies.coordinator, this.taskId);
		this.ready = this.startWatching();
		// Callers can use the handle immediately, including cancelling before the first sync.
		// Keep a rejected watch observable through ready even if the caller is only listening.
		void this.ready.catch(() => {});
	}

	static follow(
		dependencies: RequesterClientOptions,
		submitted: SubmittedRequest,
	): RequesterTask {
		return new RequesterTask(dependencies, submitted);
	}

	private async startWatching(): Promise<void> {
		const deadline = performance.now() + TASK_SPACE_WAIT_MS;
		let delayMs = 50;
		while (!this.closed) {
			try {
				const stop = await this.dependencies.gateway.watchSpace(
					this.space,
					(change) => this.receive(change),
				);
				if (this.closed) {
					stop();
				} else {
					this.stopWatching = stop;
					this.closeIfFinished();
				}
				return;
			} catch (error) {
				if (this.closed) return;
				// The intake write can finish before the coordinator grants task-space access.
				const remainingMs = deadline - performance.now();
				if (!(error instanceof SpaceAccessDeniedError) || remainingMs <= 0) {
					throw error;
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(delayMs, remainingMs));
					this.wakeRetry = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				this.wakeRetry = undefined;
				delayMs = Math.min(delayMs * 2, 1_000);
			}
		}
	}

	onState(listener: Listener<TaskState>): () => void {
		return this.subscribe(this.stateListeners, listener, this.state);
	}

	onAssignment(listener: Listener<Assignment>): () => void {
		return this.subscribe(this.assignmentListeners, listener, this.assignment);
	}

	onProgress(listener: Listener<AgentProgress>): () => void {
		return this.subscribe(this.progressListeners, listener, this.progress);
	}

	async select(optionId: string): Promise<void> {
		const state = this.state;
		const now = new Date();
		if (this.closed || state?.phase !== "awaitingSelection") {
			throw new Error("This task is not awaiting selection");
		}
		if (state.selectBy !== undefined && now > new Date(state.selectBy)) {
			throw new Error("The selection deadline has passed");
		}
		if (!state.options?.some((option) => option.optionId === optionId)) {
			throw new Error("Unknown option for this task");
		}
		const selection = hivemind.requester.selection.main.parse({
			$type: SELECTION_COLLECTION,
			optionId,
			createdAt: l.toDatetimeString(now),
		});
		await this.dependencies.gateway.putSpaceRecord(
			this.space,
			SELECTION_COLLECTION,
			"self",
			l.asUnknown$TypedObject(selection),
		);
	}

	cancel(): Promise<void> {
		const { coordinator, gateway } = this.dependencies;
		this.cancellation ??= gateway
			.deleteSpaceRecord(
				requestIntakeSpaceRef(coordinator),
				REQUEST_COLLECTION,
				this.submitted.requestRkey,
			)
			.catch((error) => {
				this.cancellation = undefined;
				throw error;
			});
		return this.cancellation;
	}

	/** Stop following the task when the client leaves. The last records remain available. */
	close(): void {
		this.closed = true;
		this.wakeRetry?.();
		this.stopWatching?.();
		this.stopWatching = undefined;
		this.pendingProgress = [];
		this.stateListeners.clear();
		this.assignmentListeners.clear();
		this.progressListeners.clear();
	}

	private subscribe<T>(
		listeners: Set<Listener<T>>,
		listener: Listener<T>,
		latest: T | undefined,
	): () => void {
		if (latest !== undefined) {
			listener(latest);
		}
		if (!this.closed) {
			listeners.add(listener);
		}
		return () => listeners.delete(listener);
	}

	private receive(change: RecordChange): void {
		const { action, author, collection, record, rkey, space } = change;
		if (
			this.closed ||
			action === "delete" ||
			record === undefined ||
			record.$type !== collection ||
			(space !== undefined && space !== this.space)
		) {
			return;
		}
		if (collection === PROGRESS_COLLECTION && TID.is(rkey)) {
			this.receiveProgress(author, record);
		} else if (author === this.dependencies.coordinator && rkey === "self") {
			this.receiveCoordinatorRecord(collection, record);
		}
		this.closeIfFinished();
	}

	private receiveCoordinatorRecord(
		collection: string,
		record: TypedObject,
	): void {
		if (collection === STATE_COLLECTION) {
			const state = hivemind.coordinator.taskState.main.safeParse(record);
			if (state.success) {
				this.state = state.value;
				for (const listener of this.stateListeners) listener(state.value);
			}
		} else if (
			collection === ASSIGNMENT_COLLECTION &&
			this.assignment === undefined
		) {
			const assignment = hivemind.coordinator.assignment.main.safeParse(record);
			if (
				assignment.success &&
				assignment.value.taskId === this.taskId &&
				assignment.value.requester === this.dependencies.gateway.did
			) {
				this.assignment = assignment.value;
				for (const listener of this.assignmentListeners)
					listener(assignment.value);
			}
		}
		// Space sync orders each writer separately. The agent may be replayed first.
		if (this.assignedAgent !== undefined) {
			const pending = this.pendingProgress;
			this.pendingProgress = [];
			for (const { author, progress } of pending) {
				if (author === this.assignedAgent) this.publishProgress(progress);
			}
		}
	}

	private get assignedAgent(): Did | undefined {
		return this.assignment?.agent ?? this.state?.assignedAgent;
	}

	private receiveProgress(author: Did, record: TypedObject): void {
		const agent = this.assignedAgent;
		if (agent !== undefined && author !== agent) return;
		const progress = hivemind.agent.progress.main.safeParse(record);
		if (!progress.success) return;
		if (agent === undefined) {
			this.pendingProgress.push({ author, progress: progress.value });
		} else {
			this.publishProgress(progress.value);
		}
	}

	private publishProgress(progress: AgentProgress): void {
		this.progress = progress;
		for (const listener of this.progressListeners) listener(progress);
	}

	private closeIfFinished(): void {
		const state = this.state;
		if (!this.stopWatching || !state || !END_PHASES.has(state.phase)) return;
		if (state.assignedAgent !== undefined && this.assignment === undefined)
			return;
		if (
			(state.phase === "completed" || state.phase === "failed") &&
			this.progress?.status !== state.phase
		) {
			return;
		}
		this.close();
	}
}
