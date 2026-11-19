# Matching Service

Ranks the accepted offers of one task. The coordinator calls it through `MatchingEngine` (`core/protocol/interfaces/internal/matching_engine.ts`) and knows nothing else about it.

| File | What it is |
| --- | --- |
| `weighted_ranking.ts` | `WeightedRanking`: weighted min-max scoring (stub, not implemented yet) |

## Contract

- **Input:** the scoring criteria (`feature`, `weightPercent`, `better`) and one candidate per accepted offer with its feature values, as the task type module's `featureValues` returns them.
- **Output:** every candidate with a score from 0 to 1000, best first.
- Which criteria apply (feed-owner weights or the task type's defaults) is decided by the coordinator before the call, not here.

## Planned algorithm: weighted min-max

1. Per criterion, scale the candidates' values to 0..1 with `(value - min) / (max - min)`, and use `1 - x` where lower is better.
2. Score = 1000 × the sum of `weightPercent / 100` × scaled value, rounded.
3. Sort by score, best first.

Open before implementing: the score when all candidates share one value for a feature (division by zero in step 1), and how ties are ordered.

## Swapping it

Another algorithm is a new class or folder implementing `MatchingEngine`, selected in `core/coordinator/main.ts`. If ranking moves into its own process (e.g. Java), `MatchingEngine` gets an `internal.hivemind.*` XRPC lexicon with the same input and output, and the TypeScript side becomes a thin client of that process.
