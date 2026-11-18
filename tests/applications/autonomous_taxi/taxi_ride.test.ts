import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TypedObject } from "../../../core/protocol/interfaces/internal/types.js";
import { rideTaskType } from "../../../core/protocol/type_definition/task_types/taxi_ride.js";
import { runTaskTypeConformance } from "../task_type_conformance.js";

// Fixtures in San Diego: downtown to Little Italy, about 1.3 km
const DOWNTOWN = { latE7: 327157000, lonE7: -1171611000 };
const LITTLE_ITALY = { latE7: 327254000, lonE7: -1171683000 };

// Payloads arrive from the network as plain JSON, so the fixtures are plain objects too
const payload = (value: object) => value as unknown as TypedObject;

const validRequest = payload({
	$type: "com.hivemind-network.mobility.ride#request",
	pickup: DOWNTOWN,
	dropoff: LITTLE_ITALY,
	passengers: 2,
});

const validOffer = payload({
	$type: "com.hivemind-network.mobility.ride#offer",
	pickupEtaSeconds: 240,
	tripDurationSeconds: 420,
	tripDistanceMeters: 1700,
	price: { amountMinor: 1450, currency: "USD" },
	vehicle: { model: "Robotaxi R1", plate: "HM-001", seats: 4 },
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Shared conformance
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

runTaskTypeConformance(rideTaskType, {
	validRequest,
	invalidRequests: {
		"no passengers": payload({
			$type: "com.hivemind-network.mobility.ride#request",
			pickup: DOWNTOWN,
			dropoff: LITTLE_ITALY,
			passengers: 0,
		}),
		"missing dropoff": payload({
			$type: "com.hivemind-network.mobility.ride#request",
			pickup: DOWNTOWN,
			passengers: 1,
		}),
		"latitude out of range": payload({
			$type: "com.hivemind-network.mobility.ride#request",
			pickup: { latE7: 950000000, lonE7: 0 },
			dropoff: LITTLE_ITALY,
			passengers: 1,
		}),
		"pickup equals dropoff": payload({
			$type: "com.hivemind-network.mobility.ride#request",
			pickup: DOWNTOWN,
			dropoff: DOWNTOWN,
			passengers: 1,
		}),
	},
	validOffer,
	invalidOffers: {
		"negative ETA": payload({
			...validOffer,
			pickupEtaSeconds: -1,
		}),
		"too few seats for the passengers": payload({
			...validOffer,
			vehicle: { model: "Robotaxi R1", seats: 1 },
		}),
	},
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Ride specifics
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("ride task type", () => {
	test("the headline shows pickup minutes and the price in the offer's currency", () => {
		const request = rideTaskType.parseRequest(validRequest);
		const offer = rideTaskType.parseOffer(validOffer, request);
		assert.equal(rideTaskType.headline(offer), "Pickup in 4 min · $14.50");
	});

	test("currencies without minor units are formatted without decimals", () => {
		const request = rideTaskType.parseRequest(validRequest);
		const offer = rideTaskType.parseOffer(
			payload({ ...validOffer, price: { amountMinor: 2100, currency: "JPY" } }),
			request,
		);
		assert.equal(rideTaskType.headline(offer), "Pickup in 4 min · ¥2,100");
	});

	test("coarsening rounds onto the 0.005-degree grid and states 400 m uncertainty", () => {
		const coarse = rideTaskType.coarsen(
			rideTaskType.parseRequest(validRequest),
		);
		assert.deepEqual(coarse.pickup, {
			latE7: 327150000,
			lonE7: -1171600000,
			uncertaintyMeters: 400,
		});
		assert.equal(coarse.passengers, 2);
	});

	test("features are the ETA, the price in minor units and the trip time", () => {
		const request = rideTaskType.parseRequest(validRequest);
		const offer = rideTaskType.parseOffer(validOffer, request);
		assert.deepEqual(rideTaskType.featureValues(offer), [
			{ feature: "pickupEtaSeconds", value: 240 },
			{ feature: "price", value: 1450 },
			{ feature: "tripDurationSeconds", value: 420 },
		]);
	});
});
