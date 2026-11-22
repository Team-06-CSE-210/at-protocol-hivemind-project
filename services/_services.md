# Services

Components the coordinator calls that can be swapped without anything else breaking. Each service implements an interface from `core/protocol/interfaces/internal/`. Nothing in the repository imports from `services/` except the coordinator's entry point (`core/coordinator/main.ts`), which picks the implementation to use.

| Service | Implements | Status |
| --- | --- | --- |
| `matching_service/` | `MatchingEngine`: ranks the accepted offers of one task | implemented |
| `routing_service/` | `RequestRouter`: picks the feeds a request goes to (task types, coverage geometry) | placeholder |
| `space_service/` | `SpaceService`: the intakes, feed spaces and task spaces on atproto Spaces | placeholder |
| `payment_service/` | not defined yet: charges operators, reports payment outcomes to billing | later |

Live coordinator startup still requires routing and space services. Tests pass service implementations to `startCoordinator`.

## Rules

- A service may import from `core/protocol/`, never from `core/coordinator/` or from another service.
- The interface is the only contract. Whatever a service needs beyond its inputs (configuration, data) is passed in by `core/coordinator/main.ts`.

## Adding or swapping a service

1. Define the interface in `core/protocol/interfaces/internal/`, or reuse the existing one.
2. Implement it in a new folder here, with a `_<folder>.md` overview.
3. Select it in `core/coordinator/main.ts`.
