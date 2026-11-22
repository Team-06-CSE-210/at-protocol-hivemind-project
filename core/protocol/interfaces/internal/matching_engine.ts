import type { RankCandidate, RankedOption, ScoringCriterion } from "./types.js";

/**
 * Ranks the accepted offers of one task.
 *
 * Runs in-process in TypeScript for now. If it moves to its own service (possibly Java), this
 * interface gets an internal.hivemind.* XRPC lexicon with the same input and output types, and
 * the TypeScript side becomes a thin client of that service.
 *
 * Owner: coordinator.
 */
export interface MatchingEngine {
	/** Every candidate with a score from 0 to 1000, best first. */
	rank(
		criteria: ScoringCriterion[],
		candidates: RankCandidate[],
	): Promise<RankedOption[]>;
}
