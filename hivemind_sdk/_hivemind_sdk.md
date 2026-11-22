# Hivemind SDK

The main interface for building and simulating applications with the Hivemind protocol: what requesters, operators and their agents use to take part. The interfaces are defined in `core/protocol/interfaces/internal/client_lib.ts` (`RequesterClient`, `OrganizationClient`, `AgentClient`, `AgentBehavior`) and `attestation.ts` (`AttestationVerifier`). The SDK implements them on an `AtprotoGateway`, so the same code runs on a real PDS and on the in-memory network.

| File | What it is | Status |
| --- | --- | --- |
| `hivemind_requester.ts` | `submitRequest(dependencies, payload, options)`: checks a request against the lexicon and its task type's module, writes it into the coordinator's request intake through the requester's own PDS, and returns the task ID and the record key. `RequesterClient` (register, request, task handle) builds on it. | `submitRequest` done; the rest is K3 (#22) and K6 (#40) |
| `hivemind_organization.ts` | `OrganizationClient`: register as operator, enroll agents, declare feeds, manage private allowlists | empty: K1 (#37), K2 (#38) |
| `hivemind_agent.ts` | `AgentClient`: publishes the agent's profile, answers dispatches through its `AgentBehavior`, carries out assignments | empty: K1 (#37), K4 (#26), K5 (#39) |

## Rules

- The SDK imports from `core/protocol/` only, never from `core/coordinator/`.
- Payloads are checked with the module of their task type (`moduleForPayload` in `core/protocol/type_definition/task_types/task_index.ts`), so the SDK works for every task type the coordinator supports.
- A request's record key is a fresh TID; the task ID is a separate field the requester chooses (`createTaskId`), so it knows its task space before the coordinator answers.
