import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	GeoCircle,
	GeoPoint,
	GeoPolygon,
} from "../../../core/protocol/interfaces/internal/types.js";
import {
	distanceMeters,
	isInsideCircle,
	isInsidePolygon,
} from "../../../services/routing_service/geometry.js";

// Point-in-area tests of the routing service: circles by distance, polygons by crossing number,
// borders counted as inside, concave corners and exact integer arithmetic.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Places
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Mean Earth radius R1 = 6,371,008.8 m (IUGG, from GRS 80; Moritz 2000), as in geometry.ts
const EARTH_RADIUS_METERS = 6_371_008.8;

// Little Italy, San Diego
const LITTLE_ITALY: GeoPoint = { latE7: 327_236_000, lonE7: -1_171_686_000 };

// A 1,000 m circle around Little Italy
const DOWNTOWN_CIRCLE: GeoCircle = {
	center: LITTLE_ITALY,
	radiusMeters: 1_000,
};

// A square of 0.01° (about 1.1 km north to south) with its south-west corner at (32.70°, -117.17°)
const SQUARE: GeoPolygon = {
	points: [
		point(327_000_000, -1_171_700_000),
		point(327_000_000, -1_171_600_000),
		point(327_100_000, -1_171_600_000),
		point(327_100_000, -1_171_700_000),
	],
};

// A U open to the north: two arms of 0.005°, a notch between them, a base below.
// Its corners at (32.705°, -117.165°) and (32.705°, -117.155°) are concave.
//
//   (32.72)  +--+     +--+
//            |  |notch|  |
//   (32.705) |  +-----+  |
//            |   base    |
//   (32.70)  +-----------+
//         -117.17     -117.15
const U_SHAPE: GeoPolygon = {
	points: [
		point(327_000_000, -1_171_700_000),
		point(327_000_000, -1_171_500_000),
		point(327_200_000, -1_171_500_000),
		point(327_200_000, -1_171_550_000),
		point(327_050_000, -1_171_550_000),
		point(327_050_000, -1_171_650_000),
		point(327_200_000, -1_171_650_000),
		point(327_200_000, -1_171_700_000),
	],
};

// A diamond of 0.01° with corners pointing south, east, north and west. Its east and west corners
// lie at 32.705°, the north corner at 32.71°.
//
//   (32.71)        N
//                /   \
//   (32.705)    W     E
//                \   /
//   (32.70)        S
//            -117.17  -117.16
const DIAMOND: GeoPolygon = {
	points: [
		point(327_000_000, -1_171_650_000),
		point(327_050_000, -1_171_600_000),
		point(327_100_000, -1_171_650_000),
		point(327_050_000, -1_171_700_000),
	],
};

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Tests
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("isInsideCircle", () => {
	it("contains its center", () => {
		assert.equal(isInsideCircle(LITTLE_ITALY, DOWNTOWN_CIRCLE), true);
	});

	it("contains a point 1 m inside its border and not one 1 m outside", () => {
		assert.equal(
			isInsideCircle(northOf(LITTLE_ITALY, 999), DOWNTOWN_CIRCLE),
			true,
		);
		assert.equal(
			isInsideCircle(northOf(LITTLE_ITALY, 1_001), DOWNTOWN_CIRCLE),
			false,
		);
	});

	it("contains a point exactly on its border", () => {
		// Integer E7 coordinates almost never lie an integer number of meters from the center, so
		// the radius is set to the computed distance itself (not an integer, which a feed
		// declaration would require): this checks the comparison, <= and not <
		const onBorder = northOf(LITTLE_ITALY, 1_000);
		const exactRadius = distanceMeters(onBorder, LITTLE_ITALY);
		assert.equal(
			isInsideCircle(onBorder, {
				center: LITTLE_ITALY,
				radiusMeters: exactRadius,
			}),
			true,
		);
	});

	it("measures east-west distance on the sphere, shorter towards the poles", () => {
		// 0.01° of longitude: about 1,112 m at the equator, about 935 m at 32.72° north
		const equator = point(0, 0);
		assert.equal(Math.round(distanceMeters(equator, point(0, 100_000))), 1_112);
		assert.equal(
			Math.round(
				distanceMeters(LITTLE_ITALY, {
					...LITTLE_ITALY,
					lonE7: LITTLE_ITALY.lonE7 + 100_000,
				}),
			),
			935,
		);
	});
});

describe("isInsidePolygon", () => {
	it("contains a point inside and not one outside", () => {
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_650_000), SQUARE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_150_000, -1_171_650_000), SQUARE),
			false,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_550_000), SQUARE),
			false,
		);
	});

	it("counts a point on an edge or a corner as inside", () => {
		assert.equal(
			isInsidePolygon(point(327_000_000, -1_171_650_000), SQUARE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_600_000), SQUARE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_100_000, -1_171_700_000), SQUARE),
			true,
		);
	});

	it("counts a point one E7 unit (about 1 cm) beyond an edge as outside", () => {
		assert.equal(
			isInsidePolygon(point(327_000_000 - 1, -1_171_650_000), SQUARE),
			false,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_600_000 + 1), SQUARE),
			false,
		);
	});

	it("leaves out the notch of a concave polygon", () => {
		assert.equal(
			isInsidePolygon(point(327_150_000, -1_171_600_000), U_SHAPE),
			false,
		);
		assert.equal(
			isInsidePolygon(point(327_150_000, -1_171_680_000), U_SHAPE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_150_000, -1_171_520_000), U_SHAPE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_020_000, -1_171_600_000), U_SHAPE),
			true,
		);
	});

	it("counts the concave corners and the notch's floor as inside", () => {
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_650_000), U_SHAPE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_550_000), U_SHAPE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_600_000), U_SHAPE),
			true,
		);
	});

	it("counts a ray through corners once when the point shares their latitude", () => {
		// The ray east from these points runs along the notch's floor and through both concave corners
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_690_000), U_SHAPE),
			true,
		);
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_710_000), U_SHAPE),
			false,
		);
		// The ray east from here passes the tops of both arms
		assert.equal(
			isInsidePolygon(point(327_200_000, -1_171_800_000), U_SHAPE),
			false,
		);
	});

	it("counts a ray through a convex corner once", () => {
		// Inside, on the latitude of the east and west corners: the ray leaves through the east
		// corner, which two edges share. Counting it for both edges would make this point outside.
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_670_000), DIAMOND),
			true,
		);
		// West of the diamond on the same latitude: the ray enters at the west corner and leaves at
		// the east corner
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_730_000), DIAMOND),
			false,
		);
		// West of the north corner: the ray only touches the corner from outside
		assert.equal(
			isInsidePolygon(point(327_100_000, -1_171_680_000), DIAMOND),
			false,
		);
		// East of the diamond on the corners' latitude
		assert.equal(
			isInsidePolygon(point(327_050_000, -1_171_580_000), DIAMOND),
			false,
		);
	});

	it("stays exact one E7 unit from an edge across a whole hemisphere", () => {
		// The diagonal runs from (-89°, -179°) to (89°, 179°): products of these coordinates
		// exceed 2^53, the largest integer a number holds exactly; the test stays exact anyway
		const triangle: GeoPolygon = {
			points: [
				point(-890_000_000, -1_790_000_000),
				point(890_000_000, 1_790_000_000),
				point(890_000_000, -1_790_000_000),
			],
		};
		assert.equal(isInsidePolygon(point(890_000, 1_790_000), triangle), true);
		assert.equal(isInsidePolygon(point(890_000, 1_789_999), triangle), true);
		assert.equal(isInsidePolygon(point(890_000, 1_790_001), triangle), false);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

function point(latE7: number, lonE7: number): GeoPoint {
	return { latE7, lonE7 };
}

// The point the given distance due north: along a meridian, 1 m = 1 / R radians
function northOf(origin: GeoPoint, meters: number): GeoPoint {
	const degreesE7 = (meters / EARTH_RADIUS_METERS) * (180 / Math.PI) * 1e7;
	return { ...origin, latE7: origin.latE7 + Math.round(degreesE7) };
}
