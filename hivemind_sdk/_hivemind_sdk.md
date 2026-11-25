# Hivemind SDK

The main interface for building and simulating applications with the Hivemind protocol: what requesters, operators and their agents use to take part. The interfaces are defined in `core/protocol/interfaces/internal/client_lib.ts` (`RequesterClient`, `OrganizationClient`, `AgentClient`, `AgentBehavior`) and `attestation.ts` (`AttestationVerifier`). The SDK implements them on an `AtprotoGateway`, so the same code runs on a real PDS and on the in-memory network.

| File | What it is | Status |
| --- | --- | --- |
| `hivemind_requester.ts` | `submitRequest(dependencies, payload, options)`: checks a request against the lexicon and its task type's module, writes it into the coordinator's request intake through the requester's own PDS, and returns the task ID and the record key. `RequesterClient` (register, request, task handle) builds on it. | `submitRequest` done; the rest is K3 (#22) and K6 (#40) |
| `hivemind_organization.ts` | `OrganizationClient`: register as operator, enroll agents, declare feeds, manage private allowlists | empty: K1 (#37), K2 (#38) |
| `hivemind_agent.ts` | `AgentOfferRouter`: follows the feeds listed in an agent's profile, asks `AgentBehavior.onDispatch`, writes offers and declines, and withdraws offers | offer routing implemented: K4 (#26); onboarding K1 (#37) and assignment handling K5 (#39) remain separate |
| `offer_routing_config.ts` | `OfferRoutingConfig`, `DEFAULT_OFFER_ROUTING_CONFIG`: bounded write retry count and delay | used by `AgentOfferRouter` |

## Offer routing

`Feed space -> AgentOfferRouter -> offer intake -> AtprotoSpaces.watchOfferIntake -> TaskRunner.handleOfferChange`

Create `AgentOfferRouter` with the agent's Gateway, coordinator DID, profile's feed declaration URIs,
behavior and an `onError` callback, then call `start()`. The caller must first register the agent and
its operator, publish the profile, and arrange access to the feed spaces. Those onboarding operations
belong to K1. The router derives addresses with `feedSpaceRef` and `offerIntakeSpaceRef`.

The router accepts only coordinator-authored dispatches, validates their envelopes with generated
lexicons, and asks the behavior once per task. Duplicate feed deliveries share the same decision.
A deadline update is applied even while the behavior is deciding. Deletion, expiry or `stop()`
prevents a pending answer from being written. Assignment verification and `onLost` belong to K5.

Accepts need a payload that the task type's module accepts for the dispatch (`moduleForPayload`,
then `parseOffer` against the dispatch's payload; coarsening keeps what that check reads). The
coordinator would drop a refused accept without telling the agent, so the router reports it
through `onError` and writes nothing. Declines may carry a reason.

A failed key generation or write is retried up to `maxWriteAttempts`, reusing the validated offer
and any key already generated. Each retry rechecks closure and the latest deadline. After exhaustion
the router reports `onError`; a later dispatch delivery can retry the retained offer. This retry
state lasts for the router instance, not across process restarts. `withdraw(taskId)` closes a
pending decision immediately, waits for any offer write already in flight, and deletes the agent's
own record with bounded retries. Concurrent restarts wait for shutdown to finish; partial startup
releases earlier subscriptions. The behavior receives a copy of the dispatch so it cannot change
routing identity or deadlines.

`onSent` means the Gateway write completed, not that the coordinator accepted the offer. A PDS can
accept a write that stays invisible because the agent lacks space access (see `_communication.md`).
The coordinator separately checks eligibility, the task phase and deadline, and task-specific terms.

`tests/hivemind_sdk/hivemind_agent.test.ts` exercises the router on `LocalSimGateway`.
`tests/coordinator/runtime/offer_routing.test.ts` connects it to the existing coordinator collector;
request routing and ranking use existing test fixtures because those are separate work packages.

## Rules

- The SDK imports from `core/protocol/` only, never from `core/coordinator/`.
- Payloads are checked with the module of their task type (`moduleForPayload` in `core/protocol/type_definition/task_types/task_index.ts`), so the SDK works for every task type the coordinator supports.
- A request's record key is a fresh TID; the task ID is a separate field the requester chooses (`createTaskId`), so it knows its task space before the coordinator answers.
