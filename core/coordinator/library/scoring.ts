import type {
	RankCandidate,
	ScoringCriterion,
} from "../../protocol/interfaces/internal/types.js";
import type { AnyTaskTypeModule } from "../../protocol/type_definition/task_types/task_index.js";

// Preparing a task's offers for ranking. The ranking itself is the matching service's job.
// Used by: runtime/task_runner.ts

// Which criteria rank a task's offers. Feed owners' weights apply only when every matched feed
// declares the same ones; otherwise the task type's defaults do. Feed declarations cannot carry
// weights yet, so today every entry is undefined and the defaults apply.
export function selectCriteria(
	feedCriteria: readonly (readonly ScoringCriterion[] | undefined)[],
	defaults: readonly ScoringCriterion[],
): ScoringCriterion[] {
	const [first, ...others] = feedCriteria;
	if (
		first === undefined ||
		others.some((criteria) => criteria === undefined)
	) {
		return [...defaults];
	}
	const firstKey = criteriaKey(first);
	const allAgree = others.every(
		(criteria) => criteria !== undefined && criteriaKey(criteria) === firstKey,
	);
	return allAgree ? [...first] : [...defaults];
}

// The same criteria in any order give the same key
function criteriaKey(criteria: readonly ScoringCriterion[]): string {
	return JSON.stringify(
		[...criteria]
			.map(({ feature, weightPercent, better }) => [
				feature,
				weightPercent,
				better,
			])
			.sort(),
	);
}

// The option ID of the n-th accepted offer; the requester sees it in choose mode
export function optionIdFor(index: number): string {
	return `option-${index + 1}`;
}

export interface ScorableOffer {
	optionId: string;
	// The offer payload as the task type module parsed it
	payload: unknown;
}

// One ranking candidate per offer, with the values of every feature the task type defines
export function toRankCandidates(
	offers: readonly ScorableOffer[],
	module: AnyTaskTypeModule,
): RankCandidate[] {
	return offers.map(({ optionId, payload }) => ({
		optionId,
		values: module.featureValues(payload),
	}));
}
