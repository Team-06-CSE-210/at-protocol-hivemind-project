# Space Service

Placeholder. Carries out the coordinator's space operations through `SpaceService` (`core/protocol/interfaces/internal/space_service.ts`): setting up and following the request intake and the offer intake, writing and closing dispatches in feed spaces, creating task spaces, writing task states and assignments, and following task spaces.

| File | What it will be |
| --- | --- |
| `atproto_spaces.ts` | `AtprotoSpaces`: the operations on atproto Spaces, using the coordinator's `AtprotoGateway` and `SpaceAuthority`. |

The space layout itself (space types, policies, addresses) is protocol and stays in `core/protocol/`.
