# Message types

Hivemind's message types are atproto lexicons (the analogue of ROS `.msg` files).

- `general/`: record types every task type shares. A record type is defined by its behavior: who writes it, which space or repo it lives in, and whether it changes after writing.
- `applications/<name>/`: payload objects for one task type. An application never defines records; it only fills the `payload`, `request` and `terms` slots of the general records.

Folder paths do not have to mirror the NSIDs: `npm run lex:build` (`scripts/build_lexicons.ts`) reads each file's `id`, places it accordingly and refuses an NSID defined twice.

`general/` has two NSID roots:

- `network/` (`com.hivemind-network.*`): the open protocol, under Hivemind's domain hivemind-network.com. The domain is what lets us publish these lexicons later (see ADR-002 in `docs/ADR.md`).
- `internal/` (`internal.hivemind.*`): types that never leave Hivemind's own infrastructure. The top-level `internal` root belongs to no domain and is never published; Bluesky does the same for its own (`internal.bsky.*`).

## General records

| NSID (`com.hivemind-network.…`) | Written by | Lives in | Record key |
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

Shared types are in `com.hivemind-network.defs`: `taskId`, `geoPoint`, `geoCircle`, `geoPolygon`, `money`, `attestation`.

## Space types

Each space type is a lexicon of type `space` that lists the collections its spaces hold. OAuth uses it to expand a `space:<type>` grant into those collections. Who may read and write is in `type_definition/policy_types/`.

| NSID (`com.hivemind-network.…`) | Space key | Collections |
| --- | --- | --- |
| `space.intake` | `main` | `requester.request`, `agent.offer` |
| `space.feed` | derived from the feed declaration | `coordinator.dispatch` |
| `space.task` | task ID | `requester.selection`, `agent.progress`, `coordinator.taskState`, `coordinator.assignment` |

## Coordinator types

Types that only the coordinator's interfaces use, kept here so every type lives in one place:

| NSID | Types | Used by |
| --- | --- | --- |
| `com.hivemind-network.coordinator.defs` | `registration`, `feedMember` | the coordinator's methods (`interfaces/external`) and its stores |
| `internal.hivemind.coordinator.defs` | `scoringCriterion`, `featureValue`, `rankCandidate`, `rankedOption` | task type modules and the matching engine (`interfaces/internal`) |

Deleting a record is part of the protocol: a requester cancels by deleting its request, an agent withdraws by deleting its offer, and the coordinator closes a dispatch by deleting it.

## Task types

A task type is one lexicon in `applications/`, named after the task rather than the machine (`com.hivemind-network.mobility.ride`, not `...autonomousTaxi`). It defines:

- `#request`: what is asked for
- `#offer`: what an agent commits to

The task type of a message is the NSID of its payload's `$type`, without the `#fragment`.

## Validation

The payload slots are open unions with no listed members, so the general lexicons never depend on an application. A validator therefore only checks that a payload has a `$type`. Validate the payload separately against its own lexicon (the coordinator's task-type module does this).

## Changing a lexicon

Until someone outside the team implements a lexicon, breaking changes are fine. After that, only add optional fields; anything else needs a new NSID. Length limits, `enum` sets and required fields cannot change after release (see the [lexicon spec](https://atproto.com/specs/lexicon)).
