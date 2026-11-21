import type { RecordChange } from './atproto_gateway.js'
import type {
  AgentOffer,
  AgentProfile,
  Assignment,
  AtUri,
  Did,
  FeedDeclaration,
  FeedMember,
  Nsid,
  Registration,
  RequesterRequest,
  SpaceRef,
  TaskId,
  TaskState,
} from './types.js'

/*
 * Storage of the coordinator. Implemented in core/coordinator/data/: SQLite for running, in memory
 * for tests. The stored shapes are compositions of protocol messages and add no message types of
 * their own.
 */

/** Registered participants: requesters, operators and agents. */
export interface ParticipantStore {
  get(subject: Did): Promise<Registration | undefined>
  put(registration: Registration): Promise<void>
  /** The agents an operator has enrolled, e.g. to suspend them together. */
  listByOperator(operator: Did): Promise<Registration[]>
}

/** Allowlists of private feeds. */
export interface FeedMemberStore {
  set(member: FeedMember): Promise<void>
  isAllowed(feed: AtUri, subject: Did): Promise<boolean>
  list(feed: AtUri): Promise<FeedMember[]>
}

/** Everything the coordinator knows about one task. */
export interface TaskRecord {
  taskId: TaskId
  requester: Did
  /** Record key of the request in the requester's repo inside the request intake space. */
  requestRkey: string
  request: RequesterRequest
  matchedFeeds: AtUri[]
  offers: Array<{ agent: Did; rkey: string; offer: AgentOffer }>
  /** The task state the spaces should show; the coordinator's own copy. */
  state: TaskState
  assignment?: Assignment
  /**
   * Whether the spaces and billing reflect this record. Every state change stores the task with
   * false first; the coordinator then makes the writes the state implies (all idempotent) and sets
   * it to true. A false one is retried until the writes succeed, also after a restart.
   * Records stored before this field existed count as published.
   */
  published: boolean
}

export interface TaskStore {
  get(taskId: TaskId): Promise<TaskRecord | undefined>
  /**
   * The task a request or offer record belongs to. A delete carries only author, collection and
   * record key, so cancellations and withdrawn offers are matched to their task this way.
   */
  findByRecord(author: Did, collection: Nsid, rkey: string): Promise<TaskRecord | undefined>
  put(task: TaskRecord): Promise<void>
  /**
   * Tasks the coordinator still has work on, so it can resume them after a restart: those not in
   * an end phase, and those whose writes are still owed (published false).
   */
  listOpen(): Promise<TaskRecord[]>
}

export interface IndexedFeed {
  uri: AtUri
  owner: Did
  declaration: FeedDeclaration
}

/** The coordinator's view of the public records (agent profiles, feed declarations), fed from the firehose. */
export interface PublicRecordIndex {
  /** Apply one create, update or delete seen on the firehose. */
  apply(change: RecordChange): Promise<void>
  getAgentProfile(agent: Did): Promise<AgentProfile | undefined>
  getFeed(feed: AtUri): Promise<IndexedFeed | undefined>
  /** Feeds that name this coordinator. */
  listFeeds(): Promise<IndexedFeed[]>
  /** Agents whose profile lists the feed. */
  listAgentsServing(feed: AtUri): Promise<Did[]>
}

/**
 * Last revision a gateway has synced per space and writer (table sync_cursors). Given one, a
 * watch resumes where it stopped after a restart instead of replaying every record.
 */
export interface RevisionStore {
  get(space: SpaceRef, writer: Did): Promise<string | undefined>
  set(space: SpaceRef, writer: Did, revision: string): Promise<void>
}

/** Assignments per agent and month, for the included quota and the fee above it (table billing_assignments). */
export interface BillingStore {
  /**
   * Count a task's assignment to the agent in the month (YYYY-MM). Once per task: recording the
   * same task again changes nothing, so a repeated write cannot bill twice.
   */
  recordAssignment(taskId: TaskId, agent: Did, month: string): Promise<void>
  countAssignments(agent: Did, month: string): Promise<number>
}

/** Every store the coordinator uses, as one object for wiring. */
export interface CoordinatorStores {
  participants: ParticipantStore
  feedMembers: FeedMemberStore
  tasks: TaskStore
  publicIndex: PublicRecordIndex
  revisions: RevisionStore
  billing: BillingStore
}
