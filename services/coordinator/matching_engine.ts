import type { MatchingEngine } from "../../protocol/interfaces/internal/matching_engine.js";
import type {
	RankCandidate,
	RankedOption,
	ScoringCriterion,
} from "../../protocol/interfaces/internal/types.js";

/** An invalid set of criteria or candidates supplied to the matching engine. */
export class RankingInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RankingInputError";
	}
}

type CandidateValues = {
	optionId: string;
	values: Map<string, number>;
};

type FeatureRange = {
	minimum: number;
	maximum: number;
};

/**
 * Rank one task's accepted offers using weighted min-max normalization.
 *
 * Each criterion contributes a goodness from 0 (worst value in this batch) to
 * 1 (best value in this batch). When every candidate has the same value for a
 * feature, they all receive a goodness of 1 for that feature. Scores are
 * rounded to the protocol's 0-1000 scale. Equal scores retain input order.
 */
export function rankCandidates(
	criteria: ScoringCriterion[],
	candidates: RankCandidate[],
): RankedOption[] {
	const totalWeight = validateCriteria(criteria);
	const candidateValues = validateCandidates(criteria, candidates);
	if (candidateValues.length === 0) {
		return [];
	}

	const ranges = calculateRanges(criteria, candidateValues);
	return candidateValues
		.map((candidate, arrivalIndex) => ({
			arrivalIndex,
			optionId: candidate.optionId,
			score: calculateScore(criteria, candidate.values, ranges, totalWeight),
		}))
		.sort(
			(left, right) =>
				right.score - left.score || left.arrivalIndex - right.arrivalIndex,
		)
		.map(({ optionId, score }) => ({ optionId, score }));
}

/** The coordinator's in-process implementation of the matching interface. */
export class WeightedMatchingEngine implements MatchingEngine {
	async rank(
		criteria: ScoringCriterion[],
		candidates: RankCandidate[],
	): Promise<RankedOption[]> {
		return rankCandidates(criteria, candidates);
	}
}

function validateCriteria(criteria: ScoringCriterion[]): number {
	if (criteria.length === 0) {
		throw new RankingInputError("At least one scoring criterion is required");
	}

	const features = new Set<string>();
	let totalWeight = 0;
	for (const criterion of criteria) {
		if (criterion.feature.trim().length === 0) {
			throw new RankingInputError("Criterion feature names cannot be empty");
		}
		if (features.has(criterion.feature)) {
			throw new RankingInputError(
				`Duplicate scoring criterion: ${criterion.feature}`,
			);
		}
		features.add(criterion.feature);

		if (
			!Number.isInteger(criterion.weightPercent) ||
			criterion.weightPercent < 0 ||
			criterion.weightPercent > 100
		) {
			throw new RankingInputError(
				`Weight for ${criterion.feature} must be an integer from 0 to 100`,
			);
		}
		if (criterion.better !== "lower" && criterion.better !== "higher") {
			throw new RankingInputError(
				`Direction for ${criterion.feature} must be lower or higher`,
			);
		}
		totalWeight += criterion.weightPercent;
	}

	if (totalWeight === 0) {
		throw new RankingInputError(
			"Scoring criteria must have positive total weight",
		);
	}
	return totalWeight;
}

function validateCandidates(
	criteria: ScoringCriterion[],
	candidates: RankCandidate[],
): CandidateValues[] {
	const optionIds = new Set<string>();
	return candidates.map((candidate) => {
		if (candidate.optionId.trim().length === 0) {
			throw new RankingInputError("Candidate option IDs cannot be empty");
		}
		if (optionIds.has(candidate.optionId)) {
			throw new RankingInputError(
				`Duplicate candidate option ID: ${candidate.optionId}`,
			);
		}
		optionIds.add(candidate.optionId);

		const values = new Map<string, number>();
		for (const featureValue of candidate.values) {
			if (values.has(featureValue.feature)) {
				throw new RankingInputError(
					`Candidate ${candidate.optionId} has duplicate feature ${featureValue.feature}`,
				);
			}
			if (!Number.isSafeInteger(featureValue.value)) {
				throw new RankingInputError(
					`Candidate ${candidate.optionId} feature ${featureValue.feature} must be a safe integer`,
				);
			}
			values.set(featureValue.feature, featureValue.value);
		}

		for (const criterion of criteria) {
			if (!values.has(criterion.feature)) {
				throw new RankingInputError(
					`Candidate ${candidate.optionId} is missing feature ${criterion.feature}`,
				);
			}
		}
		return { optionId: candidate.optionId, values };
	});
}

function calculateRanges(
	criteria: ScoringCriterion[],
	candidates: CandidateValues[],
): Map<string, FeatureRange> {
	const ranges = new Map<string, FeatureRange>();
	for (const criterion of criteria) {
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		for (const candidate of candidates) {
			const value = candidate.values.get(criterion.feature);
			if (value === undefined) {
				throw new RankingInputError(
					`Candidate ${candidate.optionId} is missing feature ${criterion.feature}`,
				);
			}
			minimum = Math.min(minimum, value);
			maximum = Math.max(maximum, value);
		}
		ranges.set(criterion.feature, { minimum, maximum });
	}
	return ranges;
}

function calculateScore(
	criteria: ScoringCriterion[],
	values: Map<string, number>,
	ranges: Map<string, FeatureRange>,
	totalWeight: number,
): number {
	let weightedGoodness = 0;
	for (const criterion of criteria) {
		const value = values.get(criterion.feature);
		const range = ranges.get(criterion.feature);
		if (value === undefined || range === undefined) {
			throw new RankingInputError(
				`Cannot score missing feature ${criterion.feature}`,
			);
		}

		const span = range.maximum - range.minimum;
		const goodness =
			span === 0
				? 1
				: criterion.better === "lower"
					? (range.maximum - value) / span
					: (value - range.minimum) / span;
		weightedGoodness += criterion.weightPercent * goodness;
	}
	return Math.round((1000 * weightedGoodness) / totalWeight);
}
