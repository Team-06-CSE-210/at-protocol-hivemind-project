# Offer routing

This module moves an agent's response from a feed dispatch into the coordinator's
task store. It depends on the repository's existing interfaces, so the gateway,
storage, identity/access checks and task-specific validation can be replaced
without rewriting the routing logic.

```text
Coordinator writes a dispatch into a feed space
    -> AgentOfferRouter watches that space
    -> AgentBehavior.onDispatch returns an acceptance or decline
    -> AgentOfferRouter writes agent.offer into the intake space
    -> OfferIntakeRouter watches intake, validates and authorizes the response
    -> TaskStore saves the offer against taskId
```

Requests and offers use the same intake space, as specified in
`protocol/type_definition/policy_types/intake.json`. Agents need write access;
only the coordinator reads intake. A deployed gateway handles PDS writes,
credentials, notifications and fetching records behind `watchSpace`. The router
does not make direct PDS calls or import the demo's simulated network.

## Run the example and tests

Requires Node.js 24.x, as specified in `package.json`.

For an immediate terminal walkthrough without installing dependencies:

```sh
npm run demo:offers:local
# Or invoke Node directly:
node --experimental-strip-types scripts/offer_routing_local_demo.ts
```

It prints each stage from dispatch through storing one sample $18 offer. It uses
the actual routing modules with the in-memory gateway/store and small test
validators. It does not connect to AT Protocol servers or validate against the
generated Lexicons. Both demos share `scripts/offer_routing_walkthrough.ts`.

To run with generated validators and check the full project:

```sh
npm ci
npm run demo:offers
npm test
npm run typecheck
```

PR #12's merged setup pins AT Protocol packages to
`0.0.0-spaces-alpha-20261105160032` and adds `npm run lex:build`. Both `build` and
`typecheck` generate the types and validators first. The import source is merge
commit `ada3eb8dc1302927d2538e4be6c912297a757a68`; see [ADR-001](ADR.md).

The example uses real generated envelope and ride-payload validators, a
pre-existing task, a sample $18 offer, and in-memory transport/storage. It does
not calculate prices or connect to a real PDS. The gateway, access checks,
task lifecycle and ranking remain separate integration dependencies.

`npm test` builds the project and runs both routing unit tests and generated-schema
integration tests. `npm run test:schemas` runs only the latter after building.
The compiled JavaScript is used because generated files import other generated
files with `.js` extensions; running their TypeScript sources directly with
Node's type stripping does not resolve those imports.

For routing-only work without dependencies or generated code:

```sh
npm run test:unit
# Or invoke Node directly:
node --experimental-strip-types --test tests/*.test.ts
```

These unit tests use small validator doubles to check the routing contract;
they do not establish Lexicon compliance or replace the full build/schema checks.
Native TypeScript execution does **not** typecheck. Generated sources belong in
`protocol/generated/`, are ignored by git, and must not be edited by hand.

## Files and ownership

| File | Responsibility |
| --- | --- |
| `hivemind_library/hivemind_agent.ts` | `AgentOfferRouter`: follow configured feed spaces, invoke behavior, send/withdraw offers |
| `services/coordinator/offer_intake.ts` | `OfferIntakeRouter`: validate, authorize, associate and store responses |
| `protocol/interfaces/internal/offer_routing.ts` | Validator, eligibility and result/observer contracts; collection names |
| `protocol/offer_validation.ts` | Adapter from generated Lexicon validators to the routing validation interface |
| `scripts/offer_routing_demo.ts` | Example wiring using generated validators and development gateway/store doubles |
| `tests/support/` | In-memory test infrastructure and fixtures, not deployed services |
| `tests/integration/offer_validation.test.ts` | Generated-schema checks and dispatch-to-intake integration |

The agent module implements only the offer part of an agent. It does not claim to
implement the full `AgentClient` assignment/progress lifecycle.

## Dependencies to supply during integration

1. **Gateway per account.** Supply the agent's and coordinator's `AtprotoGateway`
   implementations. Writers' identities must come from authentication; changes
   delivered by `watchSpace` must have trusted `author` metadata. Watchers replay
   current records and then follow changes in order. The gateway owns reliable
   delivery/reconnection, permission enforcement and credential renewal.
2. **Space setup.** Create the intake space and feed spaces first. Pass the actual
   space references into the routers. Neither router provisions spaces or routes
   incoming rider requests.
3. **Task store.** Create the task before dispatching. It must contain `taskId`,
   the original request, matched feed URIs, an empty `offers` array and state with
   `phase: collecting` and a valid `respondBy` deadline. The task manager owns
   deadlines, closing collection, ranking and assignment.
4. **Envelope validators.** Pass the provided generated-validator adapter:

   ```ts
   import { lexiconOfferValidation } from "../protocol/offer_validation.js";

   // In both router option objects:
   // validation: lexiconOfferValidation
   ```

   It wraps `network.hivemind.coordinator.dispatch.$validate` and
   `network.hivemind.agent.offer.$validate`. Do not wire the unit tests' validator
   doubles into a deployed service.
5. **Task payload validation.** Supply `validatePayload(payload, request)` using
   the matching `TaskTypeModule.parseOffer`. This checks the ride offer schema
   and business rules against the original request. The router enforces that an
   acceptance has a payload even if the envelope schema treats it as optional.
6. **Eligibility.** Supply `isAgentEligible(agent, task)`. Check agent and operator
   standing, task capability, subscription to at least one matched feed and
   private-feed allowlists. Offers have no `feed` field in the main repo; use the
   task's matched feeds and the authenticated record author.
7. **TIDs and errors.** Supply `createRkey()` with the shared TID generator and
   `onError(error, change)` with your application's error reporting. Observers
   should not throw. `now()` can be omitted outside tests.

Instantiate the two routers as shown in `scripts/offer_routing_demo.ts`, changing
the supplied dependencies. Start the coordinator intake watcher before agents.
Call `stop()` during shutdown. A caller that already owns a space watcher can
instead forward changes directly to `handleChange()` and await its result.

## Defined behavior

- Only dispatches authored by the configured coordinator, in configured feed
  spaces, reach the agent behavior.
- The same task arriving through several feeds triggers one answer per router
  instance. A dispatch deletion or deadline reached during evaluation prevents a
  subsequent write.
  Validated updates refresh the active task's deadline while its decision is pending;
  closed tasks and already-sent offers remain ignored.
- An agent writes `network.hivemind.agent.offer`. Both acceptances and declines
  are collected. Taxi pricing belongs in the injected behavior.
- A failed agent gateway write can be retried by forwarding the dispatch again.
  A prepared offer and its record key are reused, so an ambiguous write failure does not
  produce a second record. Automatic backoff belongs in the gateway or caller.
- Coordinator offer-storage writes retry automatically, up to three total attempts,
  with waits of 25 ms and 50 ms. Every attempt re-reads the task and checks collection
  state, the deadline and existing answers before writing. Exhaustion reaches the
  caller or `onError`; recovery does not depend on another watcher notification.
- The coordinator trusts `RecordChange.author`, not identity fields inside a
  record. Wrong collections/spaces are ignored; invalid or unauthorized offers
  are rejected with a reason.
- Collection must be open and the coordinator's clock must be before `respondBy`.
  Client timestamps cannot bypass the deadline. State is checked again after
  asynchronous validation/eligibility calls.
- The first valid response per agent is retained. Repeated notifications, edits
  and extra response records do not replace that response. An existing record
  cannot move to a different task. Store the accepted response before ranking.
- Deleting an offer removes it during collection. It does not revise ranking
  after collection closes. Deleting another author's record cannot withdraw the
  accepted offer. The agent's explicit `withdraw(taskId)` ends its participation
  for that task in that router instance.
- `onResult` can notify the task manager when a response is stored or withdrawn;
  collection-window management and checking whether every agent answered remain
  with the task manager. Dispatch deletion alone does not imply an agent lost;
  assignment handling must check task-space membership and the signed assignment.
- Unexpected gateway/store/behavior failures reach the caller of `handleChange`
  or the required `onError` observer when processing background notifications.

## Concurrency and persistence boundary

The intake router serializes its own store operations, preventing simultaneous
responses handled by one instance from overwriting each other. It does not make
`TaskStore.get()` plus `put()` a database transaction. When a task manager or
multiple workers write the same task, use shared per-task serialization or an
atomic/transactional store adapter. Coordinate that change at the store boundary.

Agent deduplication and retry state live in memory for the router's lifetime.
Coordinator replay protection uses stored task offers. Durable agent-side retry
and restart recovery require persistence/reconciliation work in the agent runtime.
Generated-schema tests are included here and run with `npm run test:schemas`.
Actual PDS/authentication integration needs contract tests when that prerequisite
implementation is available; it remains the gateway implementation's responsibility.
