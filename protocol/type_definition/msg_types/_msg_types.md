# Message types

Hivemind's message types are atproto lexicons (the analogue of ROS `.msg` files).

- `general/`: record types every task type shares. A record type is defined by its behavior: who writes it, which space or repo it lives in, and whether it changes after writing.
- `applications/<name>/`: payload objects for one task type. An application never defines records; it only fills the `payload`, `request` and `terms` slots of the general records.

Below each of these folders the path mirrors the NSID (`network/hivemind/agent/offer.json` is `network.hivemind.agent.offer`). The folder names `general` and `applications/<name>` are not part of any NSID; the build merges all trees into one before running codegen.

`general/` has two NSID roots:

- `network/hivemind/`: the open protocol.
- `internal/hivemind/`: types that never leave Hivemind's own infrastructure. The `internal.` prefix is atproto's convention for these; `@atproto/lex` keeps them out of published SDKs.

## General records

| NSID (`network.hivemind.…`) | Written by | Lives in | Record key |
| --- | --- | --- | --- |
| `requester.request` | requester | intake space | tid |
| `requester.selection` | requester | task space | self |
| `agent.profile` | agent | public repo | self |
| `agent.offer` | agent | intake space | tid |
| `agent.progress` | assigned agent | task space | tid |
| `coordinator.dispatch` | coordinator | feed space | any |
| `coordinator.taskState` | coordinator | task space | self |
| `coordinator.assignment` | coordinator | task space | self |
| `feed.declaration` | feed owner | public repo | any |

Shared types are in `network.hivemind.defs`: `taskId`, `geoPoint`, `geoCircle`, `geoPolygon`, `money`, `attestation`.

## Coordinator types

Types that only the coordinator's interfaces use, kept here so every type lives in one place:

| NSID | Types | Used by |
| --- | --- | --- |
| `network.hivemind.coordinator.defs` | `registration`, `feedMember` | the coordinator's methods (`interfaces/external`) and its stores |
| `internal.hivemind.coordinator.defs` | `scoringCriterion`, `featureValue`, `rankCandidate`, `rankedOption` | task type modules and the matching engine (`interfaces/internal`) |

Deleting a record is part of the protocol: a requester cancels by deleting its request, an agent withdraws by deleting its offer, and the coordinator closes a dispatch by deleting it.

## Task types

A task type is one lexicon in `applications/`, named after the task rather than the machine (`network.hivemind.mobility.ride`, not `...autonomousTaxi`). It defines:

- `#request`: what is asked for
- `#offer`: what an agent commits to

The task type of a message is the NSID of its payload's `$type`, without the `#fragment`.

## Validation

The payload slots are open unions with no listed members, so the general lexicons never depend on an application. A validator therefore only checks that a payload has a `$type`. Validate the payload separately against its own lexicon (the coordinator's task-type module does this).

## Changing a lexicon

Until someone outside the team implements a lexicon, breaking changes are fine. After that, only add optional fields; anything else needs a new NSID. Length limits, `enum` sets and required fields cannot change after release (see the [lexicon spec](https://atproto.com/specs/lexicon)).
