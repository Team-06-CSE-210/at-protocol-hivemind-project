import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	RankCandidate,
	ScoringCriterion,
} from "../../../core/protocol/interfaces/internal/types.js";
import {
	RankingInputError,
	rankCandidates,
	WeightedRanking,
} from "../../../services/matching_service/weighted_ranking.js";

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
			candidate("offer-b", 240, 1_000, 600),
			candidate("offer-a", 120, 2_000, 900),
			candidate("offer-c", 180, 1_200, 600),
		]);

		assert.deepEqual(result, [
			{ optionId: "offer-c", score: 670 },
			{ optionId: "offer-b", score: 500 },
			{ optionId: "offer-a", score: 500 },
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

	for (const better of ["lower", "higher"] as const) {
		it(`gives equal values full goodness when ${better} is better`, () => {
			const result = rankCandidates(
				[{ feature: "price", weightPercent: 100, better }],
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
	}

	it("combines lower- and higher-is-better features in the same ranking", () => {
		const result = rankCandidates(
			[
				{ feature: "price", weightPercent: 40, better: "lower" },
				{ feature: "reliability", weightPercent: 60, better: "higher" },
			],
			[
				{
					optionId: "cheap",
					values: [
						{ feature: "price", value: 100 },
						{ feature: "reliability", value: 80 },
					],
				},
				{
					optionId: "reliable",
					values: [
						{ feature: "reliability", value: 100 },
						{ feature: "price", value: 200 },
					],
				},
				{
					optionId: "middle",
					values: [
						{ feature: "price", value: 150 },
						{ feature: "reliability", value: 90 },
					],
				},
			],
		);
		assert.deepEqual(result, [
			{ optionId: "reliable", score: 600 },
			{ optionId: "middle", score: 500 },
			{ optionId: "cheap", score: 400 },
		]);
	});

	it("keeps a constant feature's weight while other features distinguish offers", () => {
		assert.deepEqual(
			rankCandidates(rideCriteria, [
				candidate("expensive", 120, 2_000, 600),
				candidate("cheap", 120, 1_000, 900),
			]),
			[
				{ optionId: "cheap", score: 900 },
				{ optionId: "expensive", score: 600 },
			],
		);
	});

	it("rounds scores before ordering ties by arrival instead of option ID", () => {
		const result = rankCandidates(
			[{ feature: "price", weightPercent: 100, better: "lower" }],
			[
				candidate("z-first", 0, 4_999, 0),
				candidate("a-second", 0, 4_998, 0),
				candidate("worst", 0, 10_000, 0),
				candidate("best", 0, 0, 0),
			],
		);
		assert.deepEqual(result, [
			{ optionId: "best", score: 1000 },
			{ optionId: "z-first", score: 500 },
			{ optionId: "a-second", score: 500 },
			{ optionId: "worst", score: 0 },
		]);
	});

	it("rounds fractional weighted scores to the nearest integer", () => {
		assert.deepEqual(
			rankCandidates(
				[{ feature: "price", weightPercent: 100, better: "lower" }],
				[0, 1, 2, 3].map((price) => candidate(String(price), 0, price, 0)),
			),
			[
				{ optionId: "0", score: 1000 },
				{ optionId: "1", score: 667 },
				{ optionId: "2", score: 333 },
				{ optionId: "3", score: 0 },
			],
		);
	});

	it("ignores zero-weight and unselected features without mutating inputs", () => {
		const criteria: ScoringCriterion[] = [
			{ feature: "price", weightPercent: 100, better: "lower" },
			{ feature: "pickupEtaSeconds", weightPercent: 0, better: "lower" },
		];
		const candidates = [
			candidate("fast", 60, 200, 300),
			candidate("cheap", 300, 100, 900),
		];
		const before = structuredClone({ criteria, candidates });
		assert.deepEqual(rankCandidates(criteria, candidates), [
			{ optionId: "cheap", score: 1000 },
			{ optionId: "fast", score: 0 },
		]);
		assert.deepEqual({ criteria, candidates }, before);
	});

	it("handles negative values and the safe-integer endpoints", () => {
		assert.deepEqual(
			rankCandidates(
				[{ feature: "value", weightPercent: 100, better: "higher" }],
				[Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER].map((value) => ({
					optionId: String(value),
					values: [{ feature: "value", value }],
				})),
			),
			[
				{ optionId: String(Number.MAX_SAFE_INTEGER), score: 1000 },
				{ optionId: "0", score: 500 },
				{ optionId: String(Number.MIN_SAFE_INTEGER), score: 0 },
			],
		);
	});

	it("returns an empty ranking when there are no candidates", () => {
		assert.deepEqual(rankCandidates(rideCriteria, []), []);
	});

	it("implements the asynchronous MatchingEngine contract", async () => {
		const engine = new WeightedRanking();
		const result = await engine.rank(rideCriteria, [
			candidate("only-offer", 120, 1_500, 600),
		]);

		assert.deepEqual(result, [{ optionId: "only-offer", score: 1000 }]);
	});

	it("normalizes by the sum of the configured weights", () => {
		const result = rankCandidates(
			[{ feature: "price", weightPercent: 40, better: "lower" }],
			[
				candidate("expensive", 120, 2_000, 600),
				candidate("cheaper", 120, 1_000, 600),
			],
		);

		assert.deepEqual(result, [
			{ optionId: "cheaper", score: 1000 },
			{ optionId: "expensive", score: 0 },
		]);
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

	it("rejects empty or duplicate criteria and invalid percentage weights", () => {
		const candidates = [candidate("offer", 120, 1_500, 600)];
		assert.throws(() => rankCandidates([], candidates), RankingInputError);
		assert.throws(
			() => rankCandidates([rideCriteria[0], rideCriteria[0]], candidates),
			/Duplicate scoring criterion/,
		);
		for (const weightPercent of [
			-1,
			101,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			assert.throws(
				() =>
					rankCandidates(
						[{ feature: "price", weightPercent, better: "lower" }],
						candidates,
					),
				RankingInputError,
			);
		}
	});

	it("rejects non-integer or non-finite values and duplicate features", () => {
		for (const value of [
			1.5,
			Number.NaN,
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			assert.throws(
				() =>
					rankCandidates(rideCriteria, [candidate("invalid", 120, value, 600)]),
				/must be a safe integer/,
			);
		}
		const duplicate = candidate("duplicate", 120, 1_500, 600);
		duplicate.values.push({ feature: "price", value: 1_000 });
		assert.throws(
			() => rankCandidates(rideCriteria, [duplicate]),
			/duplicate feature price/,
		);
	});

	it("rejects invalid inputs through the asynchronous matching interface", async () => {
		await assert.rejects(
			new WeightedRanking().rank(rideCriteria, [
				{ optionId: "incomplete", values: [] },
			]),
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
