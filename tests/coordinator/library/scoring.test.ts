import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	optionIdFor,
	selectCriteria,
	toRankCandidates,
} from "../../../core/coordinator/library/scoring.js";
import type { ScoringCriterion } from "../../../core/protocol/interfaces/internal/types.js";
import { rideTaskType } from "../../../core/protocol/type_definition/task_types/taxi_ride.js";
import { rideOffer, taskIdFor } from "../fixtures.js";

// Which criteria rank a task's offers, and the candidates handed to the matching service.

const DEFAULTS = rideTaskType.defaultCriteria;
const PRICE_ONLY: ScoringCriterion[] = [
	{ feature: "price", weightPercent: 100, better: "lower" },
];

describe("scoring", () => {
	test("feed weights apply only when every matched feed declares the same ones", () => {
		assert.deepEqual(selectCriteria([undefined], DEFAULTS), DEFAULTS);
		assert.deepEqual(
			selectCriteria([PRICE_ONLY, [...PRICE_ONLY]], DEFAULTS),
			PRICE_ONLY,
		);
		assert.deepEqual(
			selectCriteria([PRICE_ONLY, DEFAULTS], DEFAULTS),
			DEFAULTS,
		);
		assert.deepEqual(
			selectCriteria([PRICE_ONLY, undefined], DEFAULTS),
			DEFAULTS,
		);
		assert.deepEqual(selectCriteria([], DEFAULTS), DEFAULTS);
	});

	test("each accepted offer becomes a candidate with its task type's feature values", () => {
		const offer = rideOffer(taskIdFor("scoring"), 240).payload;
		const [candidate] = toRankCandidates(
			[{ optionId: optionIdFor(0), payload: offer }],
			rideTaskType,
		);
		assert.equal(candidate.optionId, "option-1");
		assert.deepEqual(candidate.values, [
			{ feature: "pickupEtaSeconds", value: 240 },
			{ feature: "price", value: 1_450 },
			{ feature: "tripDurationSeconds", value: 600 },
		]);
	});
});
