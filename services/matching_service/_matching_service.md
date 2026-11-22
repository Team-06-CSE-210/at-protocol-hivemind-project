# Matching Service

Ranks the accepted offers of one task. The coordinator calls it through `MatchingEngine` (`core/protocol/interfaces/internal/matching_engine.ts`) and knows nothing else about it.

| File | What it is |
| --- | --- |
| `weighted_ranking.ts` | `WeightedRanking`: weighted min-max scoring |

## Contract

- **Input:** the scoring criteria (`feature`, `weightPercent`, `better`) and one candidate per accepted offer with its feature values, as the task type module's `featureValues` returns them.
- **Output:** every candidate with a score from 0 to 1000, best first.
- Criteria and candidates are not mutated. A valid call with no candidates returns `[]`; a single candidate scores 1000.
- Invalid inputs reject with `RankingInputError`: criteria must be nonempty with unique feature names, integer weights from 0 to 100 and a positive total weight. Candidate IDs and feature names must be unique within their respective lists, and each candidate must supply every scoring feature as a safe integer. The coordinator then ends the task in `failed`.
- Which criteria apply (feed-owner weights or the task type's defaults) is decided by the coordinator before the call, not here.

## Weighted min-max scoring

1. Per criterion, scale the candidates' values to 0..1 with `(value - min) / (max - min)`, and use `1 - x` where lower is better. If the values are all equal, give each candidate 1 for that criterion.
2. Multiply each scaled value by its weight, add the results, and divide by the total weight. Multiply by 1000 and round to an integer. For weights totaling 100 this is `1000 × sum(weightPercent / 100 × scaledValue)`; other positive totals are normalized to preserve the 0–1000 scale. Zero-weight and unselected features do not affect scores.
3. Sort by the rounded score, best first. Ties, including those created by rounding, keep input order, so the coordinator supplies candidates in arrival order.

Equal feature values receive full credit in either direction: every candidate is equally best on that feature. Its weight still contributes to the score; it is not redistributed to other features.

## Tests

`tests/services/matching_service/weighted_ranking.test.ts` covers the scoring rules, equal values, ties, input validation and the asynchronous interface. `tests/coordinator/runtime/task_runner.test.ts` also exercises the real matcher in auto and choose modes.

## Swapping it

Another algorithm is a new class or folder implementing `MatchingEngine`, selected in `core/coordinator/main.ts`. If ranking moves into its own process (e.g. Java), `MatchingEngine` gets an `internal.hivemind.*` XRPC lexicon with the same input and output, and the TypeScript side becomes a thin client of that process.
