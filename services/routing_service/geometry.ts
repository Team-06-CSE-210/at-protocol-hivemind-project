import type {
	GeoCircle,
	GeoPoint,
	GeoPolygon,
} from "../../core/protocol/interfaces/internal/types.js";

// Point-in-area tests on the shared geo types of com.hivemind-network.defs.
// Used by: coverage_routing.ts
//
// A point on the border counts as inside, for circles and polygons alike.
// The point's uncertaintyMeters is ignored: routing points come from the request itself, not from
// a coarsened dispatch.
// Polygon edges are straight lines in latE7/lonE7 (as drawn on a lat/lon map), and the polygon test
// uses exact integer arithmetic. Not supported: polygons that cross the antimeridian (±180°) or
// contain a pole. City-sized zones never do.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Constants
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Mean Earth radius R1 = 6,371,008.8 m (IUGG, from GRS 80; Moritz 2000)
const EARTH_RADIUS_METERS = 6_371_008.8;

// degE7 -> radians: degrees x 10^7 (com.hivemind-network.defs#geoPoint)
const RADIANS_PER_DEG_E7 = Math.PI / 180 / 1e7;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Point in Area
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Whether the point lies inside the circle or on its border
// -> great-circle distance to the center compared with radiusMeters
export function isInsideCircle(point: GeoPoint, circle: GeoCircle): boolean {
	return distanceMeters(point, circle.center) <= circle.radiusMeters;
}

// Whether the point lies inside the polygon or on one of its edges
// -> on an edge or a corner: inside
// -> otherwise crossing number: a ray from the point towards the east crosses the border an odd
//    number of times exactly when the point is inside (also for concave polygons)
export function isInsidePolygon(point: GeoPoint, polygon: GeoPolygon): boolean {
	const { points } = polygon;
	// Implicitly closed: the last point connects back to the first
	let previous = points.at(-1);
	if (previous === undefined) {
		return false;
	}

	let inside = false;
	for (const current of points) {
		if (isOnSegment(point, previous, current)) {
			return true;
		}
		if (crossesEastwardRay(point, previous, current)) {
			inside = !inside;
		}
		previous = current;
	}
	return inside;
}

// Great-circle distance between two points (haversine)
export function distanceMeters(from: GeoPoint, to: GeoPoint): number {
	const deltaLat = (to.latE7 - from.latE7) * RADIANS_PER_DEG_E7;
	const deltaLon = (to.lonE7 - from.lonE7) * RADIANS_PER_DEG_E7;
	const halfChord =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(from.latE7 * RADIANS_PER_DEG_E7) *
			Math.cos(to.latE7 * RADIANS_PER_DEG_E7) *
			Math.sin(deltaLon / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, halfChord)));
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Whether the point lies on the segment from start to end, corners included
function isOnSegment(point: GeoPoint, start: GeoPoint, end: GeoPoint): boolean {
	if (crossProduct(start, end, point) !== 0n) {
		return false;
	}
	return (
		isBetween(point.lonE7, start.lonE7, end.lonE7) &&
		isBetween(point.latE7, start.latE7, end.latE7)
	);
}

// Whether the edge from start to end crosses the ray from the point towards the east
// -> half-open in latitude, so a corner on the point's latitude is counted once, not twice
// -> east of the point = the point lies left of a northward edge, right of a southward one
function crossesEastwardRay(
	point: GeoPoint,
	start: GeoPoint,
	end: GeoPoint,
): boolean {
	const startNorth = start.latE7 > point.latE7;
	const endNorth = end.latE7 > point.latE7;
	if (startNorth === endNorth) {
		return false;
	}
	const side = crossProduct(start, end, point);
	return endNorth ? side > 0n : side < 0n;
}

// Cross product of (to - origin) and (point - origin), with x = lonE7 and y = latE7
// -> positive: point left of the line origin -> to; zero: on the line; negative: right
// -> BigInt, because products of E7 coordinates reach about 6.5 x 10^18, beyond the 2^53 that a
//    number holds exactly
function crossProduct(origin: GeoPoint, to: GeoPoint, point: GeoPoint): bigint {
	const toLon = BigInt(to.lonE7 - origin.lonE7);
	const toLat = BigInt(to.latE7 - origin.latE7);
	const pointLon = BigInt(point.lonE7 - origin.lonE7);
	const pointLat = BigInt(point.latE7 - origin.latE7);
	return toLon * pointLat - toLat * pointLon;
}

// Whether value lies between the two bounds, in either order, bounds included
function isBetween(value: number, first: number, second: number): boolean {
	return Math.min(first, second) <= value && value <= Math.max(first, second);
}
