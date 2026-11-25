# Routing Service

Decides which feeds a request is routed to, through `RequestRouter` (`core/protocol/interfaces/internal/request_router.ts`). `core/coordinator/main.ts` selects it; `core/coordinator/runtime/task_runner.ts` calls it when a task opens.

| File | What it is |
| --- | --- |
| `coverage_routing.ts` | `CoverageRouting`: the feeds whose task types include the request's and whose coverage (`geoCircle` or `geoPolygon`) contains every routing point. |
| `geometry.ts` | Point-in-circle (great-circle distance) and point-in-polygon (crossing number, exact integer arithmetic) on the shared geo types of `com.hivemind-network.defs`. |

## Rules

- A routing point on a coverage border counts as inside.
- A request without routing points is routed to no feed.
- A feed whose coverage type this version does not know is left out.
- The feeds keep the order they are given in.
- A routing point's `uncertaintyMeters` is ignored: routing points come from the request itself, not from a coarsened dispatch.

Private-feed allowlists are not checked here; the coordinator applies them to the feeds this returns.

## Limits

- Polygon edges are straight lines in latitude and longitude (as drawn on a lat/lon map).
- Polygons that cross the antimeridian (±180°) or contain a pole are not supported.

## Tests

`tests/services/routing_service/`: `coverage_routing.test.ts` (task types, coverage, border, several routing points, unknown coverage types) and `geometry.test.ts` (circles, polygons, edges and corners, a concave polygon, exactness at large coordinates).
