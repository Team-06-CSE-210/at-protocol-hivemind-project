import type { IndexedFeed } from "./stores.js";
import type { GeoPoint, Nsid } from "./types.js";

// Which feeds a request is routed to.
// Implemented by: services/routing_service/
// Used by: core/coordinator/runtime/task_runner.ts
//
// Only task types and geometry decide here. Whether a requester may post into a private feed is
// the coordinator's own check (allowlists), made on the feeds this returns.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Request Router
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface RequestRouter {
	// The feeds that accept the task type and whose coverage contains every routing point
	route(
		taskType: Nsid,
		routingPoints: GeoPoint[],
		feeds: IndexedFeed[],
	): Promise<IndexedFeed[]>;
}
