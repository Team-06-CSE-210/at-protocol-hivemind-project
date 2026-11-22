import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	RankCandidate,
	ScoringCriterion,
} from "../protocol/interfaces/internal/types.js";
import {
	RankingInputError,
	rankCandidates,
	WeightedMatchingEngine,
} from "../services/coordinator/matching_engine.js";

const rideCriteria: ScoringCriterion[] = [
	{ feature: "pickupEtaSeconds", weightPercent: 50, better: "lower" },
	{ feature: "price", weightPercent: 40, better: "lower" },
	{ feature: "tripDurationSeconds", weightPercent: 10, better: "lower" },
];

function candidate(
	optionId: string,
	pickupEtaSeconds: number,
	price: number,
	tripDurationSeconds: number,
): RankCandidate {
	return {
		optionId,
		values: [
			{ feature: "pickupEtaSeconds", value: pickupEtaSeconds },
			{ feature: "price", value: price },
			{ feature: "tripDurationSeconds", value: tripDurationSeconds },
		],
	};
}

describe("rankCandidates", () => {
	it("normalizes ride features, applies weights, and keeps arrival order for ties", () => {
		const result = rankCandidates(rideCriteria, [
			candidate("offer-a", 120, 2_000, 900),
			candidate("offer-b", 240, 1_000, 600),
			candidate("offer-c", 180, 1_200, 600),
		]);

		assert.deepEqual(result, [
			{ optionId: "offer-c", score: 670 },
			{ optionId: "offer-a", score: 500 },
			{ optionId: "offer-b", score: 500 },
		]);
	});

	it("supports higher-is-better criteria", () => {
		const result = rankCandidates(
			[{ feature: "reliability", weightPercent: 100, better: "higher" }],
			[
				{
					optionId: "standard",
					values: [{ feature: "reliability", value: 80 }],
				},
				{
					optionId: "premium",
					values: [{ feature: "reliability", value: 95 }],
				},
			],
		);

		assert.deepEqual(result, [
			{ optionId: "premium", score: 1000 },
			{ optionId: "standard", score: 0 },
		]);
	});

	it("gives every candidate full goodness when a feature is equal", () => {
		const result = rankCandidates(
			[{ feature: "price", weightPercent: 100, better: "lower" }],
			[
				{ optionId: "first", values: [{ feature: "price", value: 1_500 }] },
				{ optionId: "second", values: [{ feature: "price", value: 1_500 }] },
			],
		);

		assert.deepEqual(result, [
			{ optionId: "first", score: 1000 },
			{ optionId: "second", score: 1000 },
		]);
	});

	it("returns an empty ranking when there are no candidates", () => {
		assert.deepEqual(rankCandidates(rideCriteria, []), []);
	});

	it("implements the asynchronous MatchingEngine contract", async () => {
		const engine = new WeightedMatchingEngine();
		const result = await engine.rank(rideCriteria, [
			candidate("only-offer", 120, 1_500, 600),
		]);

		assert.deepEqual(result, [{ optionId: "only-offer", score: 1000 }]);
	});

	it("rejects criteria with no positive weight", () => {
		assert.throws(
			() =>
				rankCandidates(
					[{ feature: "price", weightPercent: 0, better: "lower" }],
					[{ optionId: "offer", values: [{ feature: "price", value: 100 }] }],
				),
			RankingInputError,
		);
	});

	it("rejects duplicate option IDs and missing required features", () => {
		assert.throws(
			() =>
				rankCandidates(rideCriteria, [
					candidate("duplicate", 120, 1_500, 600),
					candidate("duplicate", 180, 1_200, 700),
				]),
			/Duplicate candidate option ID/,
		);

		assert.throws(
			() =>
				rankCandidates(rideCriteria, [
					{
						optionId: "incomplete",
						values: [{ feature: "price", value: 1_500 }],
					},
				]),
			/missing feature pickupEtaSeconds/,
		);
	});
});
