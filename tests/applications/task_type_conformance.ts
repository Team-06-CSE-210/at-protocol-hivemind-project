import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskTypeModule } from "../../core/protocol/interfaces/internal/task_type_module.js";
import type {
	GeoPoint,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	moduleForPayload,
	taskTypeOf,
} from "../../core/protocol/type_definition/task_types/task_index.js";

// What every task type module must do, so the coordinator can treat all applications alike.
// Each application's test (e.g. autonomous_taxi/taxi_ride.test.ts) runs it with its own fixtures.

export interface TaskTypeFixtures {
	validRequest: TypedObject;
	invalidRequests: Record<string, TypedObject>;
	// An offer that answers validRequest
	validOffer: TypedObject;
	invalidOffers: Record<string, TypedObject>;
}

export function runTaskTypeConformance<RequestPayload, OfferPayload>(
	module: TaskTypeModule<RequestPayload, OfferPayload>,
	fixtures: TaskTypeFixtures,
): void {
	describe(`${module.taskType}: task type conformance`, () => {
		test("is registered under the NSID its payloads carry", () => {
			assert.equal(taskTypeOf(fixtures.validRequest), module.taskType);
			assert.equal(taskTypeOf(fixtures.validOffer), module.taskType);
			assert.equal(moduleForPayload(fixtures.validRequest), module);
		});

		test("parseRequest accepts the valid request and rejects every invalid one", () => {
			module.parseRequest(fixtures.validRequest);
			for (const [name, payload] of Object.entries(fixtures.invalidRequests)) {
				assert.throws(() => module.parseRequest(payload), Error, name);
			}
		});

		test("parseOffer accepts the valid offer and rejects every invalid one", () => {
			const request = module.parseRequest(fixtures.validRequest);
			module.parseOffer(fixtures.validOffer, request);
			for (const [name, payload] of Object.entries(fixtures.invalidOffers)) {
				assert.throws(() => module.parseOffer(payload, request), Error, name);
			}
		});

		test("coarsen moves every routing point by no more than its stated uncertainty", () => {
			const request = module.parseRequest(fixtures.validRequest);
			const exactPoints = module.routingPoints(request);
			const coarsePoints = module.routingPoints(module.coarsen(request));
			assert.ok(exactPoints.length > 0, "at least one routing point");
			assert.equal(coarsePoints.length, exactPoints.length);
			exactPoints.forEach((exact, index) => {
				const coarse = coarsePoints[index];
				assert.ok(
					(coarse.uncertaintyMeters ?? 0) > 0,
					"coarse points state their uncertainty",
				);
				assert.ok(
					distanceMeters(exact, coarse) <= (coarse.uncertaintyMeters ?? 0),
					`point ${index} moved further than its uncertainty`,
				);
			});
		});

		test("default criteria add up to 100 % and every feature has a value", () => {
			const total = module.defaultCriteria.reduce(
				(sum, criterion) => sum + criterion.weightPercent,
				0,
			);
			assert.equal(total, 100);

			const request = module.parseRequest(fixtures.validRequest);
			const offer = module.parseOffer(fixtures.validOffer, request);
			const values = new Map(
				module
					.featureValues(offer)
					.map(({ feature, value }) => [feature, value]),
			);
			for (const { feature } of module.defaultCriteria) {
				assert.ok(Number.isFinite(values.get(feature)), `value for ${feature}`);
			}
		});

		test("headline is one short line", () => {
			const request = module.parseRequest(fixtures.validRequest);
			const headline = module.headline(
				module.parseOffer(fixtures.validOffer, request),
			);
			assert.ok(headline.length > 0 && headline.length <= 80);
			assert.ok(!headline.includes("\n"));
		});
	});
}

// Haversine distance; mean Earth radius 6,371,008.8 m (IUGG, Moritz 2000)
function distanceMeters(from: GeoPoint, to: GeoPoint): number {
	const toRadians = Math.PI / 180 / 1e7;
	const deltaLat = (to.latE7 - from.latE7) * toRadians;
	const deltaLon = (to.lonE7 - from.lonE7) * toRadians;
	const halfChord =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(from.latE7 * toRadians) *
			Math.cos(to.latE7 * toRadians) *
			Math.sin(deltaLon / 2) ** 2;
	return 2 * 6_371_008.8 * Math.asin(Math.sqrt(halfChord));
}
