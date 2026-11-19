import type { MatchingEngine } from "../../core/protocol/interfaces/internal/matching_engine.js";
import type {
	RankCandidate,
	RankedOption,
	ScoringCriterion,
} from "../../core/protocol/interfaces/internal/types.js";

// Default matching service: ranks the accepted offers of one task by weighted min-max scoring.
// The coordinator only knows the MatchingEngine interface; core/coordinator/main.ts selects this
// implementation, so another algorithm can replace it without changing anything else.
//
// Stub. Planned behaviour (details in _matching_service.md):
// -> scale each feature to 0..1 across the candidates (min-max), flipped where lower is better
// -> weighted sum with each criterion's weightPercent, scaled to 0..1000
// -> best first

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Weighted Ranking
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class WeightedRanking implements MatchingEngine {
	// Every candidate with a score from 0 to 1000, best first
	async rank(
		_criteria: ScoringCriterion[],
		_candidates: RankCandidate[],
	): Promise<RankedOption[]> {
		throw new Error("WeightedRanking.rank is not implemented yet");
	}
}
