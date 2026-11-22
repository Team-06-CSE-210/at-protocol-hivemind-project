import { l } from "@atproto/lex";
import * as hivemind from "../../protocol/generated/com/hivemind-network.js";
import type { RecordChange } from "../../protocol/interfaces/internal/atproto_gateway.js";
import type { AttestationSigner } from "../../protocol/interfaces/internal/attestation.js";
import type { MatchingEngine } from "../../protocol/interfaces/internal/matching_engine.js";
import type { RequestRouter } from "../../protocol/interfaces/internal/request_router.js";
import type { SpaceService } from "../../protocol/interfaces/internal/space_service.js";
import type {
	CoordinatorStores,
	TaskRecord,
} from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentOffer,
	Assignment,
	Did,
	Nsid,
	OfferOption,
	RankedOption,
	RequesterRequest,
	TaskId,
	TaskState,
	TypedObject,
} from "../../protocol/interfaces/internal/types.js";
import {
	type AnyTaskTypeModule,
	taskTypeModules,
	taskTypeOf,
} from "../../protocol/type_definition/task_types/task_index.js";
import type { TasksConfig } from "../config/tasks_config.js";
import { isActiveRequester } from "../library/access_rules.js";
import type { Clock } from "../library/clock.js";
import {
	optionIdFor,
	selectCriteria,
	toRankCandidates,
} from "../library/scoring.js";
import {
	canChangePhase,
	everyEligibleAgentAnswered,
	isEndPhase,
	phaseAfterCollection,
	respondBy,
	retryDelayMs,
	selectBy,
	type TaskPhase,
} from "../library/task_rules.js";
import { agentMayReadFeed, requesterMayPostIntoFeed } from "./access_checks.js";
import type { BillingRuntime } from "./billing.js";

// Runs every task through its lifecycle (core/protocol/interfaces/external/task_lifecycle.md):
// reads requests and offers from the intakes, routes, dispatches, ranks, assigns and follows the
// task space until an end phase. What to decide is in library/; how spaces work is the space
// service's business.
//
// Each task's steps run one after another (a queue per task), so an offer and the deadline that
// closes its task never interleave. Changes to one intake record are queued by record too, so a
// request deleted right after it was written still finds its task.
//
// Every state change is stored first, marked as not yet published, and then published: the space
// writes and billing the state implies, all idempotent (commit, sync, publish). Writes that fail
// are tried again after a growing delay, and at the next start(), until they succeed. Deadlines
// do not wait for the spaces.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface TaskRunnerDependencies {
	stores: CoordinatorStores;
	spaces: SpaceService;
	router: RequestRouter;
	matching: MatchingEngine;
	signer: AttestationSigner;
	billing: BillingRuntime;
	clock: Clock;
	// Supported task types; default: every module in task_types/task_index.ts
	modules?: ReadonlyMap<Nsid, AnyTaskTypeModule>;
	// Errors of background steps (a failed write, a broken module); default: console.error
	onError?: (error: unknown) => void;
}

// What a task needs while it runs, besides its stored record
interface RunningTask {
	cancelTimer?: () => void;
	stopWatching?: () => void;
}

// A task whose writes failed: how often so far, and the timer of the next attempt
interface PendingRetry {
	failedAttempts: number;
	cancel?: () => void;
}

type StoredOffer = TaskRecord["offers"][number];

const REQUEST_COLLECTION = "com.hivemind-network.requester.request";
const SELECTION_COLLECTION = "com.hivemind-network.requester.selection";
const PROGRESS_COLLECTION = "com.hivemind-network.agent.progress";

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Task Runner
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class TaskRunner {
	private readonly modules: ReadonlyMap<Nsid, AnyTaskTypeModule>;
	private readonly onError: (error: unknown) => void;
	private readonly running = new Map<TaskId, RunningTask>();
	// Tasks whose writes are tried again; kept apart from running, as ended tasks may need it too
	private readonly retries = new Map<TaskId, PendingRetry>();
	// Queues by task ID, and by "author collection rkey" for intake records
	private readonly queues = new Map<string, Promise<void>>();
	private readonly stopIntakes: Array<() => void> = [];
	private stopped = false;

	constructor(
		private readonly dependencies: TaskRunnerDependencies,
		private readonly config: TasksConfig,
	) {
		this.modules = dependencies.modules ?? taskTypeModules;
		this.onError = dependencies.onError ?? ((error) => console.error(error));
	}

	// * * * * * * * * * * * * * * * * * *
	// Start and stop
	// * * * * * * * * * * * * * * * * * *

	async start(): Promise<void> {
		const { stores, spaces } = this.dependencies;

		// 1. Resume tasks with work left first, so intake records already handled find their task.
		//    A task that fails to resume is tried again on its own; the others go on
		for (const task of await stores.tasks.listOpen()) {
			await this.enqueue(task.taskId, () => this.resume(task.taskId));
		}

		// 2. Follow both intakes; each replays what it holds, and known records are skipped.
		//    Each stop function is kept as soon as it exists, so a failed start leaves nothing subscribed
		try {
			this.stopIntakes.push(
				await spaces.watchRequestIntake((change) => {
					this.handleRequestChange(change).catch(this.onError);
				}),
			);
			this.stopIntakes.push(
				await spaces.watchOfferIntake((change) => {
					this.handleOfferChange(change).catch(this.onError);
				}),
			);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	// Stops following spaces and drops timers; stored tasks resume on the next start()
	async stop(): Promise<void> {
		this.stopped = true;
		for (const stopIntake of this.stopIntakes.splice(0)) {
			stopIntake();
		}
		for (const taskId of [...this.running.keys()]) {
			this.release(taskId);
		}
		for (const retry of this.retries.values()) {
			retry.cancel?.();
		}
		this.retries.clear();
		await Promise.allSettled([...this.queues.values()]);
	}

	// Resolves once every step queued so far has run (tests use it to wait for a task)
	async settled(): Promise<void> {
		while (this.queues.size > 0) {
			await Promise.allSettled([...this.queues.values()]);
		}
	}

	// * * * * * * * * * * * * * * * * * *
	// Intakes
	// * * * * * * * * * * * * * * * * * *

	async handleRequestChange(change: RecordChange): Promise<void> {
		const { author, collection, rkey } = change;
		if (collection !== REQUEST_COLLECTION) {
			return;
		}
		await this.enqueue(recordKey(change), async () => {
			// A deleted request cancels its task
			if (change.action === "delete" || change.record === undefined) {
				const task = await this.dependencies.stores.tasks.findByRecord(
					author,
					collection,
					rkey,
				);
				if (task?.requester === author) {
					await this.enqueue(task.taskId, () => this.cancel(task.taskId));
				}
				return;
			}
			// A request record is read once: a later change to it, even to a new task ID, is ignored
			const consumed = await this.dependencies.stores.tasks.findByRecord(
				author,
				collection,
				rkey,
			);
			if (consumed !== undefined) {
				return;
			}
			const parsed = hivemind.requester.request.main.safeParse(change.record);
			if (!parsed.success) {
				return;
			}
			const request = parsed.value;
			await this.enqueue(request.taskId, () =>
				this.openTask(author, rkey, request),
			);
		});
	}

	async handleOfferChange(change: RecordChange): Promise<void> {
		const { author, collection, rkey } = change;
		await this.enqueue(recordKey(change), async () => {
			// A deleted offer is withdrawn
			if (change.action === "delete" || change.record === undefined) {
				const task = await this.dependencies.stores.tasks.findByRecord(
					author,
					collection,
					rkey,
				);
				if (task !== undefined) {
					await this.enqueue(task.taskId, () =>
						this.withdrawOffer(task.taskId, author, rkey),
					);
				}
				return;
			}
			const parsed = hivemind.agent.offer.main.safeParse(change.record);
			if (!parsed.success) {
				return;
			}
			const offer = parsed.value;
			// An offer record stays with the task it was first written for
			const linked = await this.dependencies.stores.tasks.findByRecord(
				author,
				collection,
				rkey,
			);
			if (linked !== undefined && linked.taskId !== offer.taskId) {
				return;
			}
			await this.enqueue(offer.taskId, () =>
				this.receiveOffer(offer.taskId, { agent: author, rkey, offer }),
			);
		});
	}

	// * * * * * * * * * * * * * * * * * *
	// Collecting
	// * * * * * * * * * * * * * * * * * *

	private async openTask(
		requester: Did,
		requestRkey: string,
		request: RequesterRequest,
	): Promise<void> {
		const { stores, router, clock } = this.dependencies;
		const { taskId } = request;

		// 1. Only new tasks by active requesters; requests do not change once read
		if ((await stores.tasks.get(taskId)) !== undefined) {
			return;
		}
		if (!isActiveRequester(await stores.participants.get(requester))) {
			return;
		}

		// 2. An unsupported task type is not covered; an invalid payload is dropped like any bad record
		const module = this.modules.get(taskTypeOf(request.payload));
		let parsedRequest: unknown;
		if (module !== undefined) {
			try {
				parsedRequest = module.parseRequest(request.payload);
			} catch {
				return;
			}
		}

		// 3. Route: task type and geometry, then private-feed allowlists
		const routedFeeds =
			module === undefined
				? []
				: await router.route(
						module.taskType,
						module.routingPoints(parsedRequest),
						await stores.publicIndex.listFeeds(),
					);
		const matchedFeeds = [];
		for (const feed of routedFeeds) {
			if (await requesterMayPostIntoFeed(stores, requester, feed)) {
				matchedFeeds.push(feed);
			}
		}

		// 4. The task space exists in every case, so the requester can read the phase
		const now = clock.now();
		const deadline = respondBy(
			now,
			matchedFeeds.map((feed) => feed.declaration.answerWindowMs),
			request.maxWaitMs,
			this.config,
		);
		const state: TaskState =
			matchedFeeds.length === 0
				? taskState("noCoverage", now)
				: {
						...taskState("collecting", now),
						respondBy: l.toDatetimeString(deadline),
					};
		const task: TaskRecord = {
			taskId,
			requester,
			requestRkey,
			request,
			matchedFeeds: matchedFeeds.map((feed) => feed.uri),
			offers: [],
			state,
			published: false,
		};

		// 5. Store and publish: task space, dispatches, state; then wait for offers until respondBy
		await this.commit(task);
	}

	private async receiveOffer(
		taskId: TaskId,
		received: StoredOffer,
	): Promise<void> {
		const { stores, clock } = this.dependencies;
		const { agent, offer } = received;

		// 1. Only while collecting and before respondBy
		const task = await stores.tasks.get(taskId);
		if (task?.state.phase !== "collecting") {
			return;
		}
		if (
			task.state.respondBy !== undefined &&
			clock.now() > new Date(task.state.respondBy)
		) {
			return;
		}

		// 2. Only from agents eligible for one of the task's feeds
		if (!(await this.isEligibleForTask(task, agent))) {
			return;
		}

		// 3. An accept needs a payload that fits the request
		if (offer.decision === "accept" && !this.offerFits(task, offer)) {
			return;
		}

		// 4. A new offer from the same agent replaces its earlier one
		task.offers = [
			...task.offers.filter((stored) => stored.agent !== agent),
			received,
		];
		await stores.tasks.put(task);

		// 5. Collection ends early once every eligible agent has answered
		const answeredAgents = new Set(task.offers.map((stored) => stored.agent));
		if (
			everyEligibleAgentAnswered(
				await this.eligibleAgents(task),
				answeredAgents,
			)
		) {
			await this.endCollection(taskId);
		}
	}

	private async withdrawOffer(
		taskId: TaskId,
		agent: Did,
		rkey: string,
	): Promise<void> {
		const { stores } = this.dependencies;
		const task = await stores.tasks.get(taskId);
		if (task?.state.phase !== "collecting") {
			return;
		}
		task.offers = task.offers.filter(
			(stored) => !(stored.agent === agent && stored.rkey === rkey),
		);
		await stores.tasks.put(task);
	}

	// respondBy passed, or every eligible agent answered
	private async endCollection(taskId: TaskId): Promise<void> {
		const { stores, matching, clock } = this.dependencies;
		const task = await stores.tasks.get(taskId);
		if (task?.state.phase !== "collecting") {
			return;
		}
		// The dispatches are closed when the next phase is published
		this.cancelTimer(taskId);

		// 1. Rank the accepted offers; option IDs follow their order of arrival
		const module = this.moduleOf(task);
		const accepted = task.offers.filter(
			({ offer }) => offer.decision === "accept",
		);
		const request = this.requestOf(task);
		const candidates = accepted.map((stored, index) => ({
			optionId: optionIdFor(index),
			payload: module.parseOffer(offerPayload(stored), request),
		}));
		const parsedOfferByOption = new Map(
			candidates.map(({ optionId, payload }) => [optionId, payload]),
		);
		const criteria = selectCriteria(
			task.matchedFeeds.map(() => undefined),
			module.defaultCriteria,
		);
		// A ranking that throws (invalid criteria or feature values) ends the task as failed. The
		// collection timer is already cancelled, so the task would otherwise stay collecting forever.
		let ranked: RankedOption[] = [];
		if (candidates.length > 0) {
			try {
				ranked = await matching.rank(
					criteria,
					toRankCandidates(candidates, module),
				);
			} catch (error) {
				this.onError(error);
				await this.finish(task, "failed");
				return;
			}
		}
		const now = clock.now();
		const phase = phaseAfterCollection(
			task.request.selectionMode,
			ranked.length,
		);

		// 2. Nothing to choose from
		if (phase === "noOffers") {
			await this.finish(task, "noOffers");
			return;
		}

		// 3. Auto mode: the best option wins
		const offerByOption = new Map(
			accepted.map((stored, index) => [optionIdFor(index), stored]),
		);
		if (phase === "assigned") {
			const winner = offerByOption.get(ranked[0].optionId);
			if (winner === undefined) {
				await this.finish(task, "noOffers");
				return;
			}
			await this.assign(task, winner);
			return;
		}

		// 4. Choose mode: the requester picks before selectBy
		const options: OfferOption[] = [];
		for (const { optionId, score } of ranked) {
			const stored = offerByOption.get(optionId);
			if (stored === undefined) {
				continue;
			}
			options.push({
				optionId,
				agent: stored.agent,
				score,
				headline: module.headline(parsedOfferByOption.get(optionId)),
				terms: offerPayload(stored),
			});
		}
		task.state = {
			...taskState("awaitingSelection", now),
			options,
			selectBy: l.toDatetimeString(selectBy(now, this.config)),
		};
		await this.commit(task);
	}

	// * * * * * * * * * * * * * * * * * *
	// Assignment and end phases
	// * * * * * * * * * * * * * * * * * *

	private async assign(task: TaskRecord, winner: StoredOffer): Promise<void> {
		const { signer, clock } = this.dependencies;
		const now = clock.now();

		// 1. The signed assignment carries the exact request and the winner's terms
		const unsigned: Omit<Assignment, "attestation"> = {
			$type: "com.hivemind-network.coordinator.assignment",
			taskId: task.taskId,
			agent: winner.agent,
			requester: task.requester,
			request: task.request.payload,
			terms: offerPayload(winner),
			issuedAt: l.toDatetimeString(now),
		};
		const assignment: Assignment = {
			...unsigned,
			attestation: await signer.sign(unsigned),
		};

		// 2. Store and publish: billed once, the winner joins the task space with the assignment.
		//    The task space watch then waits for its progress
		task.assignment = assignment;
		task.state = { ...taskState("assigned", now), assignedAgent: winner.agent };
		await this.commit(task);
	}

	private async finish(task: TaskRecord, phase: TaskPhase): Promise<void> {
		// An assigned agent stays named in the end phase
		const { assignedAgent } = task.state;
		task.state = {
			...taskState(phase, this.dependencies.clock.now()),
			...(assignedAgent === undefined ? {} : { assignedAgent }),
		};
		await this.commit(task);
	}

	// Publishing the end phase also closes the dispatches of a task still collecting
	private async cancel(taskId: TaskId): Promise<void> {
		const task = await this.dependencies.stores.tasks.get(taskId);
		if (task === undefined || !canChangePhase(task.state.phase, "cancelled")) {
			return;
		}
		await this.finish(task, "cancelled");
	}

	private async expire(taskId: TaskId): Promise<void> {
		const task = await this.dependencies.stores.tasks.get(taskId);
		if (task?.state.phase === "awaitingSelection") {
			await this.finish(task, "expired");
		}
	}

	// * * * * * * * * * * * * * * * * * *
	// Task space
	// * * * * * * * * * * * * * * * * * *

	private async onTaskSpaceChange(
		taskId: TaskId,
		change: RecordChange,
	): Promise<void> {
		const { stores, clock } = this.dependencies;
		const { author, collection, record } = change;
		if (change.action === "delete" || record === undefined) {
			return;
		}
		const task = await stores.tasks.get(taskId);
		if (task === undefined || isEndPhase(task.state.phase)) {
			return;
		}

		// The requester's selection, in choose mode and before selectBy
		if (
			collection === SELECTION_COLLECTION &&
			author === task.requester &&
			task.state.phase === "awaitingSelection"
		) {
			const parsed = hivemind.requester.selection.main.safeParse(record);
			const deadlinePassed =
				task.state.selectBy !== undefined &&
				clock.now() > new Date(task.state.selectBy);
			if (!parsed.success || deadlinePassed) {
				return;
			}
			const option = task.state.options?.find(
				({ optionId }) => optionId === parsed.value.optionId,
			);
			const winner = task.offers.find(({ agent }) => agent === option?.agent);
			if (winner !== undefined) {
				await this.assign(task, winner);
			}
			return;
		}

		// The assigned agent's result
		if (
			collection === PROGRESS_COLLECTION &&
			author === task.assignment?.agent &&
			task.state.phase === "assigned"
		) {
			const parsed = hivemind.agent.progress.main.safeParse(record);
			if (!parsed.success) {
				return;
			}
			const { status } = parsed.value;
			if (status === "completed") {
				await this.finish(task, "completed");
			}
			if (status === "failed") {
				await this.finish(task, "failed");
			}
		}
		// Everything else in the task space is the coordinator's own or written by the wrong role
	}

	// * * * * * * * * * * * * * * * * * *
	// Resuming after a restart
	// * * * * * * * * * * * * * * * * * *

	// After a restart. A running task is published again in full (the writes are idempotent), so the
	// spaces show it even if they lost a write; its deadline is re-armed and fires right away if it
	// passed while the coordinator was down. An ended task gets only the writes it still owes
	private async resume(taskId: TaskId): Promise<void> {
		const task = await this.dependencies.stores.tasks.get(taskId);
		if (task === undefined) {
			return;
		}
		if (isEndPhase(task.state.phase)) {
			await this.sync(taskId);
			return;
		}
		await this.commit(task);
	}

	// * * * * * * * * * * * * * * * * * *
	// Publishing
	// * * * * * * * * * * * * * * * * * *

	// Every state change: stored as not yet published, the deadline re-armed (an end phase releases
	// timer and watch instead), then published. The deadline does not wait for the spaces
	private async commit(task: TaskRecord): Promise<void> {
		task.published = false;
		await this.dependencies.stores.tasks.put(task);
		if (isEndPhase(task.state.phase)) {
			this.release(task.taskId);
		} else {
			this.armTimer(task);
		}
		await this.sync(task.taskId);
	}

	// Publishes the stored task if that is still owed, and follows the task space while the task
	// runs. A failure is reported and tried again later; the task also stays listed for start()
	private async sync(taskId: TaskId): Promise<void> {
		const { stores } = this.dependencies;
		const task = await stores.tasks.get(taskId);
		if (task === undefined || this.stopped) {
			return;
		}
		try {
			if (task.published === false) {
				await this.publish(task);
				task.published = true;
				await stores.tasks.put(task);
			}
			if (!isEndPhase(task.state.phase)) {
				await this.watch(task);
			}
			this.clearRetry(taskId);
		} catch (error) {
			this.onError(error);
			this.scheduleRetry(taskId);
		}
	}

	// What the spaces and billing must show for the stored task. Every write is idempotent, so a
	// publish that failed halfway is simply repeated
	private async publish(task: TaskRecord): Promise<void> {
		const { spaces, billing } = this.dependencies;
		const { taskId, state, assignment } = task;

		// 1. The task space, with the requester as member
		await spaces.createTaskSpace(taskId, task.requester);

		// 2. The calls for offers: open while collecting, closed in every later phase
		if (state.phase === "collecting") {
			await this.writeDispatches(task);
		} else {
			for (const feed of task.matchedFeeds) {
				await spaces.closeDispatch(feed, taskId);
			}
		}

		// 3. An assignment: billed once per task, in the month it was issued; the winner joins the
		//    task space while the task is assigned
		if (assignment !== undefined) {
			await billing.recordAssignment(
				taskId,
				assignment.agent,
				new Date(assignment.issuedAt),
			);
			if (state.phase === "assigned") {
				await spaces.assign(taskId, assignment);
			}
		}

		// 4. The state last: once the requester sees it, everything it implies is in place
		await spaces.writeTaskState(taskId, state);
	}

	private scheduleRetry(taskId: TaskId): void {
		if (this.stopped) {
			return;
		}
		const { clock } = this.dependencies;
		const retry = this.retries.get(taskId) ?? { failedAttempts: 0 };
		retry.cancel?.();
		retry.failedAttempts += 1;
		const delayMs = retryDelayMs(retry.failedAttempts, this.config);
		retry.cancel = clock.setTimer(
			new Date(clock.now().getTime() + delayMs),
			() => {
				retry.cancel = undefined;
				this.enqueue(taskId, () => this.sync(taskId)).catch(this.onError);
			},
		);
		this.retries.set(taskId, retry);
	}

	private clearRetry(taskId: TaskId): void {
		this.retries.get(taskId)?.cancel?.();
		this.retries.delete(taskId);
	}

	// * * * * * * * * * * * * * * * * * *
	// Helpers
	// * * * * * * * * * * * * * * * * * *

	private async writeDispatches(task: TaskRecord): Promise<void> {
		const { spaces, clock } = this.dependencies;
		const module = this.moduleOf(task);
		const dispatch = {
			$type: "com.hivemind-network.coordinator.dispatch" as const,
			taskId: task.taskId,
			payload: l.asUnknown$TypedObject(
				module.coarsen(this.requestOf(task)) as TypedObject,
			),
			respondBy: task.state.respondBy ?? l.toDatetimeString(clock.now()),
			createdAt: task.state.updatedAt,
		};
		for (const feed of task.matchedFeeds) {
			await spaces.writeDispatch(feed, dispatch);
		}
	}

	// Follows the task space, once per run. The runner may stop, or the task end, while the watch
	// is being set up; the new watch is then closed right away
	private async watch(task: TaskRecord): Promise<void> {
		const runningTask = this.runningTask(task.taskId);
		if (runningTask.stopWatching !== undefined) {
			return;
		}
		const stopWatching = await this.dependencies.spaces.watchTaskSpace(
			task.taskId,
			(change) => {
				this.enqueue(task.taskId, () =>
					this.onTaskSpaceChange(task.taskId, change),
				).catch(this.onError);
			},
		);
		if (this.stopped || this.running.get(task.taskId) !== runningTask) {
			stopWatching();
			return;
		}
		runningTask.stopWatching = stopWatching;
	}

	// Arms the current phase's deadline; nothing once the runner has stopped
	private armTimer(task: TaskRecord): void {
		if (this.stopped) {
			return;
		}
		const {
			phase,
			respondBy: collectionDeadline,
			selectBy: selectionDeadline,
		} = task.state;
		this.cancelTimer(task.taskId);
		const { taskId } = task;
		if (phase === "collecting" && collectionDeadline !== undefined) {
			this.runningTask(taskId).cancelTimer = this.dependencies.clock.setTimer(
				new Date(collectionDeadline),
				() => {
					this.enqueue(taskId, () => this.endCollection(taskId)).catch(
						this.onError,
					);
				},
			);
		}
		if (phase === "awaitingSelection" && selectionDeadline !== undefined) {
			this.runningTask(taskId).cancelTimer = this.dependencies.clock.setTimer(
				new Date(selectionDeadline),
				() => {
					this.enqueue(taskId, () => this.expire(taskId)).catch(this.onError);
				},
			);
		}
	}

	private cancelTimer(taskId: TaskId): void {
		const runningTask = this.running.get(taskId);
		runningTask?.cancelTimer?.();
		if (runningTask !== undefined) {
			runningTask.cancelTimer = undefined;
		}
	}

	// The task is over (or the runner stops): no timer, no watch
	private release(taskId: TaskId): void {
		const runningTask = this.running.get(taskId);
		runningTask?.cancelTimer?.();
		runningTask?.stopWatching?.();
		this.running.delete(taskId);
	}

	private runningTask(taskId: TaskId): RunningTask {
		const existing = this.running.get(taskId);
		if (existing !== undefined) {
			return existing;
		}
		const created: RunningTask = {};
		this.running.set(taskId, created);
		return created;
	}

	// Steps of one task run in order; a failing step is reported and does not block the next
	private enqueue(key: string, step: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous.then(step).catch(this.onError);
		this.queues.set(key, next);
		next.finally(() => {
			if (this.queues.get(key) === next) {
				this.queues.delete(key);
			}
		});
		return next;
	}

	private async isEligibleForTask(
		task: TaskRecord,
		agent: Did,
	): Promise<boolean> {
		const { stores } = this.dependencies;
		for (const feedUri of task.matchedFeeds) {
			const feed = await stores.publicIndex.getFeed(feedUri);
			if (feed !== undefined && (await agentMayReadFeed(stores, agent, feed))) {
				return true;
			}
		}
		return false;
	}

	// Agents that list one of the task's feeds and may read it
	private async eligibleAgents(task: TaskRecord): Promise<Set<Did>> {
		const { stores } = this.dependencies;
		const eligible = new Set<Did>();
		for (const feedUri of task.matchedFeeds) {
			const feed = await stores.publicIndex.getFeed(feedUri);
			if (feed === undefined) {
				continue;
			}
			for (const agent of await stores.publicIndex.listAgentsServing(feedUri)) {
				if (await agentMayReadFeed(stores, agent, feed)) {
					eligible.add(agent);
				}
			}
		}
		return eligible;
	}

	private offerFits(task: TaskRecord, offer: AgentOffer): boolean {
		if (offer.payload === undefined) {
			return false;
		}
		try {
			this.moduleOf(task).parseOffer(
				l.asUnknown$TypedObject(offer.payload),
				this.requestOf(task),
			);
			return true;
		} catch {
			return false;
		}
	}

	// A stored task always has a supported task type, or it ended in noCoverage
	private moduleOf(task: TaskRecord): AnyTaskTypeModule {
		const module = this.modules.get(taskTypeOf(task.request.payload));
		if (module === undefined) {
			throw new Error(`Task ${task.taskId}: task type no longer supported`);
		}
		return module;
	}

	private requestOf(task: TaskRecord): unknown {
		return this.moduleOf(task).parseRequest(task.request.payload);
	}
}

// A task state without options or deadlines; callers add what the phase needs
function taskState(phase: TaskPhase, at: Date): TaskState {
	return {
		$type: "com.hivemind-network.coordinator.taskState",
		phase,
		updatedAt: l.toDatetimeString(at),
	};
}

// The payload of an accepted offer; receiveOffer stores accepts only with one
function offerPayload({ agent, offer }: StoredOffer): TypedObject {
	if (offer.payload === undefined) {
		throw new Error(`Accepted offer by ${agent} has no payload`);
	}
	return l.asUnknown$TypedObject(offer.payload);
}

// Queue key of an intake record: its changes are handled in the order they arrive
function recordKey({ author, collection, rkey }: RecordChange): string {
	return `${author} ${collection} ${rkey}`;
}
