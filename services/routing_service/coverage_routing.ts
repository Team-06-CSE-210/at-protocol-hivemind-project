import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import type { RequestRouter } from "../../core/protocol/interfaces/internal/request_router.js";
import type { IndexedFeed } from "../../core/protocol/interfaces/internal/stores.js";
import type {
	FeedDeclaration,
	GeoPoint,
	Nsid,
} from "../../core/protocol/interfaces/internal/types.js";
import { isInsideCircle, isInsidePolygon } from "./geometry.js";

// CoverageRouting: the routing service (RequestRouter, core/protocol/interfaces/internal/request_router.ts).
// Used by: core/coordinator/main.ts (selectServices); called in task_runner.ts when a task opens
//
// Only task types and geometry decide. Private-feed allowlists are the coordinator's own check,
// made on the feeds this returns.

type FeedCoverage = FeedDeclaration["coverage"];

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Request Router
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class CoverageRouting implements RequestRouter {
	// The feeds that accept the task type and whose coverage contains every routing point
	// -> in the order given
	// -> a point on a coverage border counts as inside (geometry.ts)
	// -> no routing points -> no feeds: a request without a location is routed nowhere
	// -> a coverage type this version does not know -> that feed is left out
	async route(
		taskType: Nsid,
		routingPoints: GeoPoint[],
		feeds: IndexedFeed[],
	): Promise<IndexedFeed[]> {
		if (routingPoints.length === 0) {
			return [];
		}
		return feeds.filter(
			({ declaration }) =>
				declaration.taskTypes.includes(taskType) &&
				routingPoints.every((point) =>
					coverageContains(declaration.coverage, point),
				),
		);
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Whether one point lies inside a feed's coverage (com.hivemind-network.defs#geoCircle or
// #geoPolygon). isTypeOf also accepts an object without $type, so $type is compared first.
function coverageContains(coverage: FeedCoverage, point: GeoPoint): boolean {
	const { geoCircle, geoPolygon } = hivemind.defs;
	if (coverage.$type === geoCircle.$type && geoCircle.isTypeOf(coverage)) {
		return isInsideCircle(point, coverage);
	}
	if (coverage.$type === geoPolygon.$type && geoPolygon.isTypeOf(coverage)) {
		return isInsidePolygon(point, coverage);
	}
	return false;
}
