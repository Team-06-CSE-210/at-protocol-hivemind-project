# Task types

The coordinator's half of each application: one `TaskTypeModule` (`interfaces/internal/task_type_module.ts`) per task type lexicon in `msg_types/applications/`. With it the coordinator can check, route, coarsen and rank tasks it otherwise knows nothing about.

| File | Task type | Lexicon |
| --- | --- | --- |
| `taxi_ride.ts` | `com.hivemind-network.mobility.ride` | `msg_types/applications/autonomous_taxi/network/hivemind/mobility/ride.json` |
| `task_index.ts` | registry: `taskTypeModules`, `moduleForPayload(payload)` | |

A payload's task type is its `$type` without the `#fragment`: `com.hivemind-network.mobility.ride#request` belongs to `com.hivemind-network.mobility.ride`.

`taxi_ride.ts` serves the robotaxi demo, but the task type it implements is the general `com.hivemind-network.mobility.ride`: any vehicle that carries passengers can answer the same rides.

## Adding an application

1. Write the task type lexicon with a `#request` and an `#offer` object in `msg_types/applications/<application>/`, and run `npm run lex:build`.
2. Add a module file here (e.g. `taxi_ride.ts`) implementing `TaskTypeModule<Request, Offer>` with the generated types.
3. Register it in `task_index.ts`.
4. Add a test named after the module (e.g. `tests/applications/autonomous_taxi/taxi_ride.test.ts`) calling `runTaskTypeConformance` with valid and invalid fixtures, plus tests for its own rules.
5. Agents of the application implement `AgentBehavior` and build offers with the generated lexicon code (as `demo/autonomous_taxi/simulation/taxi_behavior.ts` does).

## What a module decides

| Member | Ride |
| --- | --- |
| `parseRequest`, `parseOffer` | lexicon check plus rules it cannot express: pickup and dropoff differ; enough seats |
| `routingPoints` | the pickup |
| `coarsen` | pickup and dropoff rounded to a 0.005° grid, `uncertaintyMeters` + 400 |
| `defaultCriteria` | pickup ETA 50 %, price 40 %, trip time 10 %, all lower is better |
| `featureValues` | `pickupEtaSeconds`, `price` (minor units), `tripDurationSeconds` |
| `headline` | `Pickup in 4 min · $14.50` |

Agents parse dispatches with the lexicon alone, not with the module: a coarsened request may break the module's own rules (a short ride's pickup and dropoff can round onto the same point).
