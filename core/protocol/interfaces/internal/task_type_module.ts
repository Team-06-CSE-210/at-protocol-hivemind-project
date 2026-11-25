import type {
	FeatureValue,
	GeoPoint,
	Nsid,
	ScoringCriterion,
	TypedObject,
} from "./types.js";

/**
 * The coordinator's half of an application: everything the coordinator must know about one
 * task type. Each lexicon in type_definition/msg_types/applications/ gets exactly one module,
 * e.g. the ride module for com.hivemind-network.mobility.ride.
 *
 * Owner: coordinator. Implemented once per application.
 */
export interface TaskTypeModule<RequestPayload, OfferPayload> {
	/** NSID of the task type's lexicon. */
	readonly taskType: Nsid;

	/**
	 * Check a request payload against the task type's lexicon and its own rules (rides: pickup and
	 * dropoff differ). Throws if invalid. The general lexicons only check that a $type is present.
	 */
	parseRequest(payload: TypedObject): RequestPayload;

	/** Same for an offer payload, which may also be checked against the request it answers. */
	parseOffer(payload: TypedObject, request: RequestPayload): OfferPayload;

	/** Points that must lie inside a feed's coverage for the request to be routed there. Rides: the pickup. */
	routingPoints(request: RequestPayload): GeoPoint[];

	/** The request as agents see it in a dispatch: locations rounded, with uncertaintyMeters set. */
	coarsen(request: RequestPayload): RequestPayload;

	/** Ranking criteria used when the matched feeds set no custom weights. Rides: pickup ETA 50, price 40, trip time 10. */
	readonly defaultCriteria: ScoringCriterion[];

	/** The offer's value for every feature the criteria name. */
	featureValues(offer: OfferPayload): FeatureValue[];

	/** One-line summary for the requester, e.g. "Pickup in 4 min · $14.50". */
	headline(offer: OfferPayload): string;
}
