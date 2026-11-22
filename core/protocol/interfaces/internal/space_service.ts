import type { RecordChange } from "./atproto_gateway.js";
import type {
	Assignment,
	AtUri,
	Did,
	Dispatch,
	SpaceRef,
	TaskId,
	TaskState,
} from "./types.js";

// How the coordinator carries out its space operations without knowing how spaces work.
// Implemented by: services/space_service/ (atproto Spaces today; a fallback channel could replace it)
// Used by: core/coordinator/runtime/
//
// The space layout itself (space types, policies, addresses, who writes which record) is part of
// the protocol and lives in type_definition/ and protocol_config/. This interface only executes it;
// the decisions (which feeds, who wins, when a deadline has passed) stay with the coordinator.
//
// The coordinator repeats a write until it succeeds, also after a restart (runtime/task_runner.ts).
// Every method that creates or writes must therefore be idempotent: calling it again with the same
// input leaves the same result and does not fail because the first call already succeeded.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Service
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface SpaceService {
	// * * * * * * * * * * * * * * * * * *
	// Intakes
	// * * * * * * * * * * * * * * * * * *

	// Create the request intake and the offer intake if they do not exist yet
	setUpIntakes(): Promise<void>;

	// Follow the request intake: every request already in it, then new, changed and deleted ones
	// -> a deleted request is a cancellation
	watchRequestIntake(
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	// Follow the offer intake the same way
	// -> a deleted offer is withdrawn
	watchOfferIntake(
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	// * * * * * * * * * * * * * * * * * *
	// Feed Spaces
	// * * * * * * * * * * * * * * * * * *

	// Create the space behind a feed declaration if it does not exist yet
	setUpFeedSpace(feed: AtUri): Promise<SpaceRef>;

	// Write a task's call for offers into a feed space (record key: the task ID)
	writeDispatch(feed: AtUri, dispatch: Dispatch): Promise<void>;

	// Delete a task's dispatch from a feed space: the call for offers is over. A dispatch that is
	// already closed, or was never written, counts as closed
	closeDispatch(feed: AtUri, taskId: TaskId): Promise<void>;

	// * * * * * * * * * * * * * * * * * *
	// Task Spaces
	// * * * * * * * * * * * * * * * * * *

	// Create the task space with the requester as member (read and write)
	createTaskSpace(taskId: TaskId, requester: Did): Promise<SpaceRef>;

	// Write or replace the task state (record key: self)
	writeTaskState(taskId: TaskId, state: TaskState): Promise<void>;

	// Add the winning agent as member and write the signed assignment (record key: self)
	assign(taskId: TaskId, assignment: Assignment): Promise<void>;

	// Follow a task space: selections by the requester, progress by the assigned agent
	// -> records by other writers arrive too; the coordinator drops them
	watchTaskSpace(
		taskId: TaskId,
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;
}
