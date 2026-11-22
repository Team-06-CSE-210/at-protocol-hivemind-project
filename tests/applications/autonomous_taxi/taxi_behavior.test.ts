import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import type { OfferAnswer } from "../../../core/protocol/interfaces/internal/client_lib.js";
import type {
	AgentProgress,
	Assignment,
	Dispatch,
	Draft,
	GeoPoint,
	TypedObject,
} from "../../../core/protocol/interfaces/internal/types.js";
import { rideTaskType } from "../../../core/protocol/type_definition/task_types/taxi_ride.js";
import {
	TaxiBehavior,
	type TaxiConfig,
	type TaxiFleetConfig,
	type TaxiSimulationOptions,
} from "../../../demo/autonomous_taxi/simulation/taxi_behavior.js";

// The demo taxi on its own: no network, no coordinator, simulated time that does not wait.

const LITTLE_ITALY = { latE7: 327254000, lonE7: -1171683000 };
const BALBOA_PARK = { latE7: 327341000, lonE7: -1171446000 };
const LOS_ANGELES = { latE7: 340522000, lonE7: -1182437000 };

let fleet: TaxiFleetConfig;
let downtownTaxi: TaxiConfig;

before(async () => {
	const file = path.join(
		process.cwd(),
		"demo/autonomous_taxi/config/taxi_fleet.json",
	);
	fleet = JSON.parse(await readFile(file, "utf8")) as TaxiFleetConfig;
	downtownTaxi = fleet.vehicles[0];
});

// Simulation that never really sleeps
function instantSimulation(
	overrides: Partial<TaxiSimulationOptions> = {},
): TaxiSimulationOptions {
	return {
		timeScale: fleet.timeScale,
		tickMs: fleet.tickMs,
		roadDistanceFactor: fleet.roadDistanceFactor,
		sleep: async () => {},
		now: () => new Date("2026-11-05T12:00:00Z"),
		...overrides,
	};
}

// The exact request, and the dispatch the coordinator would send for it (coarsened)
function rideRequest(pickup: GeoPoint, dropoff: GeoPoint, passengers = 1) {
	return {
		$type: "com.hivemind-network.mobility.ride#request",
		pickup,
		dropoff,
		passengers,
	} as const;
}

function dispatchFor(request: ReturnType<typeof rideRequest>): Dispatch {
	return {
		$type: "com.hivemind-network.coordinator.dispatch",
		taskId: "testtask",
		payload: rideTaskType.coarsen(request) as unknown as TypedObject,
		respondBy: "2026-11-05T12:00:30.000Z",
		createdAt: "2026-11-05T12:00:00.000Z",
	} as Dispatch;
}

function assignmentFor(request: ReturnType<typeof rideRequest>): Assignment {
	return {
		$type: "com.hivemind-network.coordinator.assignment",
		taskId: "testtask",
		agent: "did:example:taxi",
		requester: "did:example:rider",
		request: request as unknown as TypedObject,
		terms: {} as TypedObject,
		issuedAt: "2026-11-05T12:00:05.000Z",
		attestation: {},
	} as unknown as Assignment;
}

function expectDecline(answer: OfferAnswer, reason: string): void {
	assert.equal(answer.decision, "decline");
	assert.equal(answer.decision === "decline" && answer.declineReason, reason);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Dispatches
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("taxi behavior: answering dispatches", () => {
	test("offers a nearby ride with a valid ride offer", async () => {
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const request = rideRequest(LITTLE_ITALY, BALBOA_PARK, 2);
		const answer = await taxi.onDispatch(dispatchFor(request));

		assert.equal(answer.decision, "accept");
		if (answer.decision !== "accept") {
			return;
		}
		// The coordinator's module must accept what the taxi offers
		const offer = rideTaskType.parseOffer(
			answer.payload,
			rideTaskType.parseRequest(request as unknown as TypedObject),
		);
		assert.ok(offer.pickupEtaSeconds > 0);
		assert.ok(offer.price.amountMinor > downtownTaxi.pricing.baseFareMinor);
		assert.equal(offer.price.currency, "USD");
		assert.equal(answer.snapshot?.operationalStatus, "available");
	});

	test("answers a short ride whose dispatch rounds pickup and dropoff together", async () => {
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const nextDoor = {
			latE7: LITTLE_ITALY.latE7 + 2000,
			lonE7: LITTLE_ITALY.lonE7,
		};
		const answer = await taxi.onDispatch(
			dispatchFor(rideRequest(LITTLE_ITALY, nextDoor)),
		);
		assert.equal(answer.decision, "accept");
	});

	test("declines a pickup beyond its range", async () => {
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const answer = await taxi.onDispatch(
			dispatchFor(rideRequest(LOS_ANGELES, LITTLE_ITALY)),
		);
		expectDecline(answer, "outOfArea");
	});

	test("declines more passengers than seats", async () => {
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const answer = await taxi.onDispatch(
			dispatchFor(rideRequest(LITTLE_ITALY, BALBOA_PARK, 7)),
		);
		expectDecline(answer, "insufficientCapacity");
	});

	test("declines other task types", async () => {
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const dispatch = {
			...dispatchFor(rideRequest(LITTLE_ITALY, BALBOA_PARK)),
			payload: { $type: "com.hivemind-network.delivery.parcel#request" },
		} as unknown as Dispatch;
		expectDecline(await taxi.onDispatch(dispatch), "other");
	});

	test("declines while busy with a ride", async () => {
		// Hold the taxi on its first tick until the test lets it go
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const taxi = new TaxiBehavior(
			downtownTaxi,
			instantSimulation({ sleep: () => held }),
		);
		const request = rideRequest(LITTLE_ITALY, BALBOA_PARK);
		const ride = taxi.onAssignment(assignmentFor(request), async () => {});

		expectDecline(await taxi.onDispatch(dispatchFor(request)), "busy");
		release();
		await ride;
		assert.equal(
			(await taxi.onDispatch(dispatchFor(request))).decision,
			"accept",
		);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Assignments
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("taxi behavior: carrying out a ride", () => {
	test("reports every status in order and ends at the exact dropoff", async () => {
		const reports: Draft<AgentProgress>[] = [];
		const moves: GeoPoint[] = [];
		const taxi = new TaxiBehavior(
			downtownTaxi,
			instantSimulation({ onMove: (position) => moves.push(position) }),
		);
		const request = rideRequest(LITTLE_ITALY, BALBOA_PARK);

		await taxi.onAssignment(assignmentFor(request), async (progress) => {
			reports.push(progress);
		});

		assert.deepEqual(
			reports.map((report) => report.status),
			["accepted", "enRoute", "arrived", "inProgress", "completed"],
		);
		assert.deepEqual(reports[2].position, LITTLE_ITALY);
		assert.deepEqual(taxi.currentPosition, BALBOA_PARK);
		assert.ok(moves.length > 2, "moves in several steps");
		assert.ok(reports[1].eta && reports[1].eta > "2026-11-05T12:00:00.000Z");
	});

	test("reports failed when the assignment carries no valid ride", async () => {
		const reports: Draft<AgentProgress>[] = [];
		const taxi = new TaxiBehavior(downtownTaxi, instantSimulation());
		const broken = {
			...assignmentFor(rideRequest(LITTLE_ITALY, BALBOA_PARK)),
			request: { $type: "com.hivemind-network.mobility.ride#request" },
		} as unknown as Assignment;

		await taxi.onAssignment(broken, async (progress) => {
			reports.push(progress);
		});
		assert.deepEqual(
			reports.map((report) => report.status),
			["failed"],
		);
		assert.deepEqual(taxi.currentPosition, downtownTaxi.start);
	});
});
