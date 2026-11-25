import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IndexedFeed } from "../../../core/protocol/interfaces/internal/stores.js";
import type {
	AtUri,
	Did,
	FeedDeclaration,
	GeoPoint,
	Nsid,
} from "../../../core/protocol/interfaces/internal/types.js";
import { CoverageRouting } from "../../../services/routing_service/coverage_routing.js";

// CoverageRouting as the coordinator calls it: task types and coverage decide which feeds a
// request goes to. Geometry details are in geometry.test.ts.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Feeds
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

const COORDINATOR: Did = "did:plc:coordinator";
const FEED_OWNER: Did = "did:plc:feedowner";
const RIDE_TASK_TYPE: Nsid = "com.hivemind-network.mobility.ride";
const DELIVERY_TASK_TYPE: Nsid = "com.hivemind-network.logistics.delivery";

// Little Italy, San Diego, and a point about 4.5 km north-east of it
const LITTLE_ITALY: GeoPoint = { latE7: 327_236_000, lonE7: -1_171_686_000 };
const NORTH_PARK: GeoPoint = { latE7: 327_480_000, lonE7: -1_171_300_000 };

// Downtown: a 2 km circle around Little Italy
const DOWNTOWN = feed("downtown", {
	$type: "com.hivemind-network.defs#geoCircle",
	center: LITTLE_ITALY,
	radiusMeters: 2_000,
});

// A square from (32.70°, -117.20°) to (32.76°, -117.12°) that holds both points;
// its western edge runs along -117.20°
const CITY = feed("city", {
	$type: "com.hivemind-network.defs#geoPolygon",
	points: [
		{ latE7: 327_000_000, lonE7: -1_172_000_000 },
		{ latE7: 327_000_000, lonE7: -1_171_200_000 },
		{ latE7: 327_600_000, lonE7: -1_171_200_000 },
		{ latE7: 327_600_000, lonE7: -1_172_000_000 },
	],
});

// The city square, for deliveries only
const CITY_DELIVERIES = feed("city-deliveries", CITY.declaration.coverage, [
	DELIVERY_TASK_TYPE,
]);

const router = new CoverageRouting();

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Tests
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("CoverageRouting", () => {
	it("routes a pickup to every circle and polygon feed of its task type that contains it", async () => {
		const routed = await router.route(
			RIDE_TASK_TYPE,
			[LITTLE_ITALY],
			[DOWNTOWN, CITY, CITY_DELIVERIES],
		);
		assert.deepEqual(uris(routed), [DOWNTOWN.uri, CITY.uri]);
	});

	it("leaves out feeds whose coverage does not contain the pickup", async () => {
		const routed = await router.route(
			RIDE_TASK_TYPE,
			[NORTH_PARK],
			[DOWNTOWN, CITY],
		);
		assert.deepEqual(uris(routed), [CITY.uri]);
	});

	it("leaves out feeds of another task type", async () => {
		const routed = await router.route(
			DELIVERY_TASK_TYPE,
			[LITTLE_ITALY],
			[DOWNTOWN, CITY, CITY_DELIVERIES],
		);
		assert.deepEqual(uris(routed), [CITY_DELIVERIES.uri]);
	});

	it("routes a pickup on a feed's border to that feed", async () => {
		const onWesternEdge: GeoPoint = {
			latE7: 327_300_000,
			lonE7: -1_172_000_000,
		};
		const justWest: GeoPoint = {
			...onWesternEdge,
			lonE7: onWesternEdge.lonE7 - 1,
		};
		assert.deepEqual(
			uris(await router.route(RIDE_TASK_TYPE, [onWesternEdge], [CITY])),
			[CITY.uri],
		);
		assert.deepEqual(
			await router.route(RIDE_TASK_TYPE, [justWest], [CITY]),
			[],
		);
	});

	it("needs every routing point inside a feed", async () => {
		const routed = await router.route(
			RIDE_TASK_TYPE,
			[LITTLE_ITALY, NORTH_PARK],
			[DOWNTOWN, CITY],
		);
		assert.deepEqual(uris(routed), [CITY.uri]);
	});

	it("routes a request without routing points nowhere", async () => {
		assert.deepEqual(
			await router.route(RIDE_TASK_TYPE, [], [DOWNTOWN, CITY]),
			[],
		);
	});

	it("leaves out a feed whose coverage type it does not know", async () => {
		const unknownShape = feed("corridor", {
			$type: "com.example.geo#corridor",
			widthMeters: 500,
		});
		const routed = await router.route(
			RIDE_TASK_TYPE,
			[LITTLE_ITALY],
			[unknownShape, CITY],
		);
		assert.deepEqual(uris(routed), [CITY.uri]);
	});

	it("keeps the order of the feeds it is given", async () => {
		const routed = await router.route(
			RIDE_TASK_TYPE,
			[LITTLE_ITALY],
			[CITY, DOWNTOWN],
		);
		assert.deepEqual(uris(routed), [CITY.uri, DOWNTOWN.uri]);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// An indexed feed of the feed owner with the given coverage, for rides unless told otherwise.
// coverage is a plain object so a test can also pass a shape the lexicon does not list.
function feed(
	rkey: string,
	coverage: object,
	taskTypes: Nsid[] = [RIDE_TASK_TYPE],
): IndexedFeed {
	const uri: AtUri = `at://${FEED_OWNER}/com.hivemind-network.feed.declaration/${rkey}`;
	const declaration = {
		$type: "com.hivemind-network.feed.declaration",
		displayName: rkey,
		coordinator: COORDINATOR,
		coverage,
		taskTypes,
		access: "public",
		answerWindowMs: 30_000,
		createdAt: "2026-11-22T00:00:00.000Z",
	} as FeedDeclaration;
	return { uri, owner: FEED_OWNER, declaration };
}

function uris(feeds: IndexedFeed[]): AtUri[] {
	return feeds.map((routedFeed) => routedFeed.uri);
}
