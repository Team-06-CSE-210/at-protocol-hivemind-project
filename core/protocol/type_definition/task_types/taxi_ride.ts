import * as hivemind from "../../generated/com/hivemind-network.js";
import type { TaskTypeModule } from "../../interfaces/internal/task_type_module.js";
import type {
	FeatureValue,
	GeoPoint,
	Nsid,
	ScoringCriterion,
	TypedObject,
} from "../../interfaces/internal/types.js";

// The coordinator's half of the task type com.hivemind-network.mobility.ride
// (lexicon: type_definition/msg_types/applications/autonomous_taxi/network/hivemind/mobility/ride.json).
// Robotaxis are the demo, but any vehicle that carries passengers can serve the same rides.

export type RideRequest = hivemind.mobility.ride.Request;
export type RideOffer = hivemind.mobility.ride.Offer;

const RIDE_TASK_TYPE: Nsid = "com.hivemind-network.mobility.ride";

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Coarsening for dispatches
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Dispatches show agents a rounded pickup and dropoff; the exact points reach only the winner.
// Grid: 0.005 degrees = 50,000 degE7
const COARSE_GRID_DEG_E7 = 50_000;

// On the WGS 84 ellipsoid a degree of longitude is at most 111,320 m (equator) and a degree of
// latitude at most 111,694 m (poles), so half a cell is at most 278.3 m by 279.2 m. Rounding moves
// a point by at most sqrt(278.3^2 + 279.2^2) ~ 394 m; 400 m always covers it.
const COARSE_UNCERTAINTY_METERS = 400;

function coarsenPoint(point: GeoPoint): GeoPoint {
	return {
		latE7: Math.round(point.latE7 / COARSE_GRID_DEG_E7) * COARSE_GRID_DEG_E7,
		lonE7: Math.round(point.lonE7 / COARSE_GRID_DEG_E7) * COARSE_GRID_DEG_E7,
		uncertaintyMeters:
			(point.uncertaintyMeters ?? 0) + COARSE_UNCERTAINTY_METERS,
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Headline formatting
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Money is stored in the currency's smallest unit; Intl knows how many decimals each currency has
function formatMoney(amountMinor: number, currency: string): string {
	const formatter = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
	});
	const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(amountMinor / 10 ** decimals);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Task type module
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export const rideTaskType: TaskTypeModule<RideRequest, RideOffer> = {
	taskType: RIDE_TASK_TYPE,

	parseRequest(payload: TypedObject): RideRequest {
		// The lexicon checks shape, integers and ranges
		const request = hivemind.mobility.ride.request.parse(payload);
		// Rules the lexicon cannot express
		if (
			request.pickup.latE7 === request.dropoff.latE7 &&
			request.pickup.lonE7 === request.dropoff.lonE7
		) {
			throw new Error("Ride request: pickup and dropoff are the same point");
		}
		return request;
	},

	parseOffer(payload: TypedObject, request: RideRequest): RideOffer {
		const offer = hivemind.mobility.ride.offer.parse(payload);
		// A vehicle that cannot seat everyone cannot serve the ride
		if (offer.vehicle.seats < request.passengers) {
			throw new Error(
				`Ride offer: ${offer.vehicle.seats} seats for ${request.passengers} passengers`,
			);
		}
		return offer;
	},

	// Feeds are matched by where the ride starts
	routingPoints(request: RideRequest): GeoPoint[] {
		return [request.pickup];
	},

	coarsen(request: RideRequest): RideRequest {
		return {
			...request,
			pickup: coarsenPoint(request.pickup),
			dropoff: coarsenPoint(request.dropoff),
		};
	},

	// Default ranking: pickup ETA 50 %, price 40 %, trip time 10 %, all lower is better
	defaultCriteria: [
		{ feature: "pickupEtaSeconds", weightPercent: 50, better: "lower" },
		{ feature: "price", weightPercent: 40, better: "lower" },
		{ feature: "tripDurationSeconds", weightPercent: 10, better: "lower" },
	] satisfies ScoringCriterion[],

	featureValues(offer: RideOffer): FeatureValue[] {
		return [
			{ feature: "pickupEtaSeconds", value: offer.pickupEtaSeconds },
			{ feature: "price", value: offer.price.amountMinor },
			{ feature: "tripDurationSeconds", value: offer.tripDurationSeconds },
		];
	},

	headline(offer: RideOffer): string {
		const pickupMinutes = Math.max(1, Math.round(offer.pickupEtaSeconds / 60));
		const price = formatMoney(offer.price.amountMinor, offer.price.currency);
		return `Pickup in ${pickupMinutes} min · ${price}`;
	},
};
