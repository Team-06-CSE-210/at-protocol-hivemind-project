# Routing Service

Placeholder. Decides which feeds a request is routed to, through `RequestRouter` (`core/protocol/interfaces/internal/request_router.ts`).

| File | What it will be |
| --- | --- |
| `coverage_routing.ts` | `CoverageRouting`: feeds whose task types include the request's and whose coverage contains every routing point. |
| `geometry.ts` | Point-in-circle and point-in-polygon tests on the shared geo types. |

Private-feed allowlists are not checked here; the coordinator applies them to the feeds this returns.
