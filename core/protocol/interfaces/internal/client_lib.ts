import type { AtprotoGateway } from "./atproto_gateway.js";
import type {
	AgentProfile,
	AgentProgress,
	AgentSnapshot,
	Assignment,
	AtUri,
	Did,
	Dispatch,
	Draft,
	FeedDeclaration,
	FeedMember,
	Registration,
	TaskId,
	TaskState,
	TypedObject,
} from "./types.js";

/*
 * The SDK (hivemind_sdk/): how requesters, agents and organizations take part without handling
 * spaces, credentials or signatures themselves. Used by demo/ (simulated taxis), view/ (rider
 * app) and, later, outside operators.
 */

// Agent side

/** What an operator implements to run an agent. The SDK does everything else. */
export interface AgentBehavior {
	/** Decide on a dispatch before its respondBy. Called once per dispatch the agent can read. */
	onDispatch(dispatch: Dispatch): Promise<OfferAnswer>;
	/** Carry out an assignment whose attestation has already been verified. Finish with completed or failed. */
	onAssignment(assignment: Assignment, report: ProgressReporter): Promise<void>;
	/** A dispatch this agent answered closed without assigning it. */
	onLost?(taskId: TaskId): void;
}

export type OfferAnswer =
	| { decision: "accept"; payload: TypedObject; snapshot?: AgentSnapshot }
	| { decision: "decline"; declineReason?: string; snapshot?: AgentSnapshot };

export type ProgressReporter = (
	progress: Draft<AgentProgress>,
) => Promise<void>;

export interface AgentClientOptions {
	gateway: AtprotoGateway;
	coordinator: Did;
	profile: Draft<AgentProfile>;
	behavior: AgentBehavior;
	/** Coordinators whose assignments this agent accepts. */
	trustedCoordinators: Did[];
}

export interface AgentClient {
	/** Publish the profile, follow the feed spaces it lists and answer dispatches through the behavior. */
	start(): Promise<void>;
	stop(): Promise<void>;
}

// Requester side

export interface RequesterClientOptions {
	gateway: AtprotoGateway;
	coordinator: Did;
}

export interface RequesterClient {
	register(): Promise<Registration>;
	/** Choose a fresh task ID, write the request into the request intake space and follow the task space. */
	request(
		payload: TypedObject,
		options?: { selectionMode?: "auto" | "choose"; maxWaitMs?: number },
	): Promise<TaskHandle>;
}

export interface TaskHandle {
	readonly taskId: TaskId;
	/** Resolves after the task space's first sync; rejects if following fails for a reason other than the space not being ready yet. */
	readonly ready: Promise<void>;
	/** Each listener returns a function that removes it. */
	onState(listener: (state: TaskState) => void): () => void;
	onAssignment(listener: (assignment: Assignment) => void): () => void;
	onProgress(listener: (progress: AgentProgress) => void): () => void;
	select(optionId: string): Promise<void>;
	/** Delete the request, which cancels the task. */
	cancel(): Promise<void>;
	/** Stop following the task and release the space watch. Cached values remain available to new listeners. */
	close(): void;
}

// Organization side (operators and feed owners)

export interface OrganizationClientOptions {
	gateway: AtprotoGateway;
	coordinator: Did;
}

export interface OrganizationClient {
	registerAsOperator(): Promise<Registration>;
	/** The agent's profile must already name this organization as its operator. */
	enrollAgent(agent: Did): Promise<Registration>;
	/** Publish or update a feed declaration; returns its AT-URI. Feed owners need no registration. */
	declareFeed(
		rkey: string,
		declaration: Draft<FeedDeclaration>,
	): Promise<AtUri>;
	setFeedMember(member: FeedMember): Promise<void>;
}
