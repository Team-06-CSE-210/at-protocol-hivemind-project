import { l } from "@atproto/lex";
import * as hivemind from "../../../core/protocol/generated/com/hivemind-network.js";
import type {
	AgentBehavior,
	OfferAnswer,
	ProgressReporter,
} from "../../../core/protocol/interfaces/internal/client_lib.js";
import type {
	AgentSnapshot,
	Assignment,
	Dispatch,
	GeoPoint,
} from "../../../core/protocol/interfaces/internal/types.js";

// How a simulated robotaxi answers dispatches and carries out rides. The agent client
// (hivemind_sdk/hivemind_agent.ts) calls it; it never talks to atproto itself.
// Numbers come from demo/autonomous_taxi/config/taxi_fleet.json.
//
// Payloads are checked with the ride lexicon only. The ride task type module
// (core/protocol/type_definition/task_types/taxi_ride.ts) is the coordinator's half; its extra
// rules would reject a short ride whose pickup and dropoff were rounded onto the same point
// in a dispatch.
const ride = hivemind.mobility.ride;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Configuration
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface TaxiConfig {
	id: string;
	displayName: string;
	model: string;
	plate: string;
	seats: number;
	start: GeoPoint;
	speedMetersPerSecond: number;
	maxPickupDistanceMeters: number;
	pricing: {
		currency: string;
		baseFareMinor: number;
		perKilometerMinor: number;
		perMinuteMinor: number;
	};
}

export interface TaxiFleetConfig {
	// Simulated seconds per real second: 10 means a 10-minute ride takes 1 minute in the demo
	timeScale: number;
	// Real milliseconds between two position updates while driving
	tickMs: number;
	// Street distance per straight-line distance. US road networks average about 1.2
	// (Ballou, Rahardja & Sakai 2002, Transportation Research Part A 36); city centres run higher.
	roadDistanceFactor: number;
	vehicles: TaxiConfig[];
}

export interface TaxiSimulationOptions {
	timeScale: number;
	tickMs: number;
	roadDistanceFactor: number;
	// Injected so tests can run a whole ride without waiting
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => Date;
	// Called on every position update, e.g. to move the taxi on the demo map
	onMove?: (position: GeoPoint) => void;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Taxi behavior
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class TaxiBehavior implements AgentBehavior {
	private position: GeoPoint;
	private busy = false;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly now: () => Date;

	constructor(
		private readonly taxi: TaxiConfig,
		private readonly simulation: TaxiSimulationOptions,
	) {
		this.position = { ...taxi.start };
		this.sleep =
			simulation.sleep ??
			((milliseconds) =>
				new Promise((resolve) => setTimeout(resolve, milliseconds)));
		this.now = simulation.now ?? (() => new Date());
	}

	get currentPosition(): GeoPoint {
		return { ...this.position };
	}

	// * * * * * * * * * * * * * * * * * *
	// Answering dispatches
	// * * * * * * * * * * * * * * * * * *

	// The dispatch shows a coarsened pickup (about ±400 m); good enough for an estimate
	async onDispatch(dispatch: Dispatch): Promise<OfferAnswer> {
		const snapshot = this.snapshot();

		// Only rides, and only when free
		if (!ride.request.isTypeOf(dispatch.payload)) {
			return { decision: "decline", declineReason: "other", snapshot };
		}
		if (this.busy) {
			return { decision: "decline", declineReason: "busy", snapshot };
		}

		// Can this vehicle take everyone, and is the pickup close enough?
		const request = ride.request.parse(dispatch.payload);
		if (request.passengers > this.taxi.seats) {
			return {
				decision: "decline",
				declineReason: "insufficientCapacity",
				snapshot,
			};
		}
		const pickupDistanceMeters = this.roadDistance(
			this.position,
			request.pickup,
		);
		if (pickupDistanceMeters > this.taxi.maxPickupDistanceMeters) {
			return { decision: "decline", declineReason: "outOfArea", snapshot };
		}

		// Estimate the ride in simulated seconds and price it
		const tripDistanceMeters = this.roadDistance(
			request.pickup,
			request.dropoff,
		);
		const pickupEtaSeconds = Math.round(
			pickupDistanceMeters / this.taxi.speedMetersPerSecond,
		);
		const tripDurationSeconds = Math.round(
			tripDistanceMeters / this.taxi.speedMetersPerSecond,
		);
		const { pricing } = this.taxi;
		const priceMinor = Math.round(
			pricing.baseFareMinor +
				(pricing.perKilometerMinor * tripDistanceMeters) / 1000 +
				(pricing.perMinuteMinor * tripDurationSeconds) / 60,
		);

		// build() adds the $type; asUnknown$TypedObject lets it into the open payload union
		const offer = ride.offer.build({
			pickupEtaSeconds,
			tripDurationSeconds,
			tripDistanceMeters: Math.round(tripDistanceMeters),
			price: { amountMinor: priceMinor, currency: pricing.currency },
			vehicle: {
				model: this.taxi.model,
				plate: this.taxi.plate,
				seats: this.taxi.seats,
			},
		});
		return {
			decision: "accept",
			payload: l.asUnknown$TypedObject(offer),
			snapshot,
		};
	}

	// * * * * * * * * * * * * * * * * * *
	// Carrying out an assignment
	// * * * * * * * * * * * * * * * * * *

	// The agent client has verified the attestation before this is called.
	// The assignment carries the exact pickup and dropoff.
	async onAssignment(
		assignment: Assignment,
		report: ProgressReporter,
	): Promise<void> {
		this.busy = true;
		try {
			const request = ride.request.parse(assignment.request);

			// Drive to the pickup
			await report({ status: "accepted", position: this.currentPosition });
			await report({
				status: "enRoute",
				position: this.currentPosition,
				eta: this.etaTo(request.pickup),
			});
			await this.driveTo(request.pickup);
			await report({ status: "arrived", position: this.currentPosition });

			// Drive the passengers to the dropoff
			await report({
				status: "inProgress",
				position: this.currentPosition,
				eta: this.etaTo(request.dropoff),
			});
			await this.driveTo(request.dropoff);
			await report({ status: "completed", position: this.currentPosition });
		} catch (error) {
			await report({
				status: "failed",
				position: this.currentPosition,
				note: String(error).slice(0, 300),
			});
		} finally {
			this.busy = false;
		}
	}

	// Nothing to undo: the taxi only reserves itself once assigned
	onLost(): void {}

	// * * * * * * * * * * * * * * * * * *
	// Simulation
	// * * * * * * * * * * * * * * * * * *

	// Straight-line movement in ticks; each tick covers speed × tick × timeScale meters
	private async driveTo(target: GeoPoint): Promise<void> {
		const metersPerTick =
			(this.taxi.speedMetersPerSecond *
				this.simulation.tickMs *
				this.simulation.timeScale) /
			1000;
		let remainingMeters = straightLineDistance(this.position, target);
		while (remainingMeters > metersPerTick) {
			const fraction = metersPerTick / remainingMeters;
			this.position = {
				latE7: Math.round(
					this.position.latE7 + (target.latE7 - this.position.latE7) * fraction,
				),
				lonE7: Math.round(
					this.position.lonE7 + (target.lonE7 - this.position.lonE7) * fraction,
				),
			};
			this.simulation.onMove?.(this.currentPosition);
			await this.sleep(this.simulation.tickMs);
			remainingMeters = straightLineDistance(this.position, target);
		}
		this.position = { latE7: target.latE7, lonE7: target.lonE7 };
		this.simulation.onMove?.(this.currentPosition);
	}

	// Wall-clock time of arrival in the demo, i.e. simulated travel time divided by timeScale
	private etaTo(target: GeoPoint): l.DatetimeString {
		const simulatedSeconds =
			straightLineDistance(this.position, target) /
			this.taxi.speedMetersPerSecond;
		const realMilliseconds =
			(simulatedSeconds * 1000) / this.simulation.timeScale;
		return l.toDatetimeString(
			new Date(this.now().getTime() + realMilliseconds),
		);
	}

	private roadDistance(from: GeoPoint, to: GeoPoint): number {
		return straightLineDistance(from, to) * this.simulation.roadDistanceFactor;
	}

	private snapshot(): AgentSnapshot {
		return {
			position: this.currentPosition,
			batteryPercent: 100,
			operationalStatus: this.busy ? "busy" : "available",
		};
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Geometry
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Mean Earth radius R1 = 6,371,008.8 m (IUGG, from GRS 80; Moritz 2000)
const EARTH_RADIUS_METERS = 6_371_008.8;
const DEG_E7_TO_RAD = Math.PI / 180 / 1e7;

// Haversine great-circle distance between two degE7 positions
function straightLineDistance(from: GeoPoint, to: GeoPoint): number {
	const fromLat = from.latE7 * DEG_E7_TO_RAD;
	const toLat = to.latE7 * DEG_E7_TO_RAD;
	const deltaLat = toLat - fromLat;
	const deltaLon = (to.lonE7 - from.lonE7) * DEG_E7_TO_RAD;
	const halfChord =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(halfChord));
}
