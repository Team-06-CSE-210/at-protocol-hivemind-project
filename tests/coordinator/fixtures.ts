import type { RecordChange } from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type { AttestationSigner } from "../../core/protocol/interfaces/internal/attestation.js";
import type { MatchingEngine } from "../../core/protocol/interfaces/internal/matching_engine.js";
import type { RequestRouter } from "../../core/protocol/interfaces/internal/request_router.js";
import type { SpaceService } from "../../core/protocol/interfaces/internal/space_service.js";
import type {
	CoordinatorStores,
	IndexedFeed,
} from "../../core/protocol/interfaces/internal/stores.js";
import type {
	AgentOffer,
	AgentProfile,
	Assignment,
	AtUri,
	Did,
	Dispatch,
	FeedDeclaration,
	Registration,
	RequesterRequest,
	SpaceRef,
	TaskId,
	TaskState,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import { taskSpaceRef } from "../../core/protocol/protocol_config/space_definition.js";

// Participants, records and fake services shared by the coordinator tests. The fakes record what
// the coordinator asks of them, so tests check its decisions without a network.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Participants
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export const COORDINATOR: Did = "did:plc:coordinator";
export const RIDER: Did = "did:plc:rider";
export const OPERATOR: Did = "did:plc:operator";
export const TAXI_ONE: Did = "did:plc:taxione";
export const TAXI_TWO: Did = "did:plc:taxitwo";
export const FEED_OWNER: Did = "did:plc:feedowner";
export const STRANGER: Did = "did:plc:stranger";

export const START = new Date("2026-11-19T12:00:00.000Z");
const CREATED_AT = START.toISOString() as RequesterRequest["createdAt"];

export const RIDE_TASK_TYPE = "com.hivemind-network.mobility.ride";
export const DOWNTOWN_FEED: AtUri = `at://${FEED_OWNER}/com.hivemind-network.feed.declaration/downtown`;
export const PRIVATE_FEED: AtUri = `at://${FEED_OWNER}/com.hivemind-network.feed.declaration/private`;

// San Diego, as in the demo
export const LITTLE_ITALY = { latE7: 327254000, lonE7: -1171683000 };
export const BALBOA_PARK = { latE7: 327341000, lonE7: -1171446000 };

export function registration(
	subject: Did,
	role: "requester" | "operator" | "agent",
	status: "active" | "pendingPayment" | "suspended" = "active",
): Registration {
	return {
		subject,
		role,
		status,
		...(role === "agent" ? { operator: OPERATOR } : {}),
		registeredAt: CREATED_AT,
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Records
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export function agentProfile(feeds: AtUri[] = [DOWNTOWN_FEED]): AgentProfile {
	return {
		$type: "com.hivemind-network.agent.profile",
		displayName: "Test taxi",
		operator: OPERATOR,
		taskTypes: [RIDE_TASK_TYPE],
		feeds,
		createdAt: CREATED_AT,
	};
}

export function feedDeclaration(
	access: "public" | "private" = "public",
	answerWindowMs = 30_000,
): FeedDeclaration {
	return {
		$type: "com.hivemind-network.feed.declaration",
		displayName: "Downtown San Diego",
		coordinator: COORDINATOR,
		coverage: {
			$type: "com.hivemind-network.defs#geoCircle",
			center: LITTLE_ITALY,
			radiusMeters: 10_000,
		},
		taskTypes: [RIDE_TASK_TYPE],
		access,
		answerWindowMs,
		createdAt: CREATED_AT,
	} as FeedDeclaration;
}

export function indexedFeed(
	uri: AtUri = DOWNTOWN_FEED,
	declaration: FeedDeclaration = feedDeclaration(),
): IndexedFeed {
	return { uri, owner: FEED_OWNER, declaration };
}

// Task IDs: at least 16 lowercase base32 characters (com.hivemind-network.defs#taskId)
export function taskIdFor(name: string): TaskId {
	return `${name}aaaaaaaaaaaaaaaa`.slice(0, 26) as TaskId;
}

export function rideRequest(
	taskId: TaskId,
	selectionMode: "auto" | "choose" = "auto",
): RequesterRequest {
	return {
		$type: "com.hivemind-network.requester.request",
		taskId,
		payload: {
			$type: "com.hivemind-network.mobility.ride#request",
			pickup: LITTLE_ITALY,
			dropoff: BALBOA_PARK,
			passengers: 1,
		} as unknown as TypedObject,
		selectionMode,
		createdAt: CREATED_AT,
	} as RequesterRequest;
}

export function rideOffer(
	taskId: TaskId,
	pickupEtaSeconds: number,
): AgentOffer {
	return {
		$type: "com.hivemind-network.agent.offer",
		taskId,
		decision: "accept",
		payload: {
			$type: "com.hivemind-network.mobility.ride#offer",
			pickupEtaSeconds,
			tripDurationSeconds: 600,
			tripDistanceMeters: 4_000,
			price: { amountMinor: 1_450, currency: "USD" },
			vehicle: { model: "Test car", seats: 4 },
		} as unknown as TypedObject,
		createdAt: CREATED_AT,
	} as AgentOffer;
}

export function decline(taskId: TaskId): AgentOffer {
	return {
		$type: "com.hivemind-network.agent.offer",
		taskId,
		decision: "decline",
		declineReason: "busy",
		createdAt: CREATED_AT,
	} as AgentOffer;
}

export function created(
	author: Did,
	rkey: string,
	record: object,
): RecordChange {
	const { $type } = record as { $type: RecordChange["collection"] };
	return {
		action: "create",
		author,
		collection: $type,
		rkey,
		record: record as TypedObject,
	};
}

export function deleted(
	author: Did,
	collection: RecordChange["collection"],
	rkey: string,
): RecordChange {
	return { action: "delete", author, collection, rkey };
}

// Registered rider, active operator with two taxis, one public feed both taxis serve
export async function seedParticipants(
	stores: CoordinatorStores,
): Promise<void> {
	const { participants, publicIndex } = stores;
	await participants.put(registration(RIDER, "requester"));
	await participants.put(registration(OPERATOR, "operator"));
	await participants.put(registration(TAXI_ONE, "agent"));
	await participants.put(registration(TAXI_TWO, "agent"));
	await publicIndex.apply(created(FEED_OWNER, "downtown", feedDeclaration()));
	await publicIndex.apply(created(TAXI_ONE, "self", agentProfile()));
	await publicIndex.apply(created(TAXI_TWO, "self", agentProfile()));
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Fake services
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

type ChangeListener = (change: RecordChange) => void;

// Records every space operation; tests push intake and task space changes through it
export class FakeSpaceService implements SpaceService {
	readonly feedSpaces = new Set<AtUri>();
	readonly taskSpaces = new Map<TaskId, Did>();
	readonly states = new Map<TaskId, TaskState[]>();
	readonly assignments = new Map<TaskId, Assignment>();
	// Open dispatches, by "feed taskId"
	readonly dispatches = new Map<string, Dispatch>();
	readonly closedDispatches: string[] = [];
	intakesSetUp = false;

	private readonly requestListeners = new Set<ChangeListener>();
	private readonly offerListeners = new Set<ChangeListener>();
	private readonly taskListeners = new Map<TaskId, Set<ChangeListener>>();

	async setUpIntakes(): Promise<void> {
		this.intakesSetUp = true;
	}

	async watchRequestIntake(onChange: ChangeListener): Promise<() => void> {
		this.requestListeners.add(onChange);
		return () => this.requestListeners.delete(onChange);
	}

	async watchOfferIntake(onChange: ChangeListener): Promise<() => void> {
		this.offerListeners.add(onChange);
		return () => this.offerListeners.delete(onChange);
	}

	async setUpFeedSpace(feed: AtUri): Promise<SpaceRef> {
		this.feedSpaces.add(feed);
		return `at://${COORDINATOR}/space/com.hivemind-network.space.feed/${feed.length}`;
	}

	async writeDispatch(feed: AtUri, dispatch: Dispatch): Promise<void> {
		this.dispatches.set(`${feed} ${dispatch.taskId}`, dispatch);
	}

	async closeDispatch(feed: AtUri, taskId: TaskId): Promise<void> {
		this.dispatches.delete(`${feed} ${taskId}`);
		this.closedDispatches.push(`${feed} ${taskId}`);
	}

	async createTaskSpace(taskId: TaskId, requester: Did): Promise<SpaceRef> {
		this.taskSpaces.set(taskId, requester);
		return taskSpaceRef(COORDINATOR, taskId);
	}

	async writeTaskState(taskId: TaskId, state: TaskState): Promise<void> {
		this.states.set(taskId, [...(this.states.get(taskId) ?? []), state]);
	}

	async assign(taskId: TaskId, assignment: Assignment): Promise<void> {
		this.assignments.set(taskId, assignment);
	}

	async watchTaskSpace(
		taskId: TaskId,
		onChange: ChangeListener,
	): Promise<() => void> {
		const listeners =
			this.taskListeners.get(taskId) ?? new Set<ChangeListener>();
		listeners.add(onChange);
		this.taskListeners.set(taskId, listeners);
		return () => listeners.delete(onChange);
	}

	// * * * Test controls * * *

	pushRequest(change: RecordChange): void {
		for (const listener of this.requestListeners) {
			listener(change);
		}
	}

	pushOffer(change: RecordChange): void {
		for (const listener of this.offerListeners) {
			listener(change);
		}
	}

	pushTaskSpace(taskId: TaskId, change: RecordChange): void {
		for (const listener of this.taskListeners.get(taskId) ?? []) {
			listener(change);
		}
	}

	phaseOf(taskId: TaskId): string | undefined {
		return this.states.get(taskId)?.at(-1)?.phase;
	}

	lastState(taskId: TaskId): TaskState | undefined {
		return this.states.get(taskId)?.at(-1);
	}

	isWatched(taskId: TaskId): boolean {
		return (this.taskListeners.get(taskId)?.size ?? 0) > 0;
	}
}

// Every feed that accepts the task type; geometry is the routing service's job
export const fakeRouter: RequestRouter = {
	route: async (taskType, _routingPoints, feeds) =>
		feeds.filter((feed) => feed.declaration.taskTypes.includes(taskType)),
};

// Ranks by the first criterion only, lower first: enough to know which offer wins
export const fakeMatching: MatchingEngine = {
	rank: async (criteria, candidates) => {
		const [first] = criteria;
		const firstValue = (candidate: (typeof candidates)[number]) =>
			candidate.values.find(({ feature }) => feature === first.feature)
				?.value ?? 0;
		return [...candidates]
			.sort((one, other) => firstValue(one) - firstValue(other))
			.map(({ optionId }, index) => ({ optionId, score: 1_000 - index * 100 }));
	},
};

export const fakeSigner: AttestationSigner = {
	sign: async () => ({
		keyId: `${COORDINATOR}#hivemind_attestation`,
		signature: new Uint8Array([1, 2, 3]),
	}),
};
