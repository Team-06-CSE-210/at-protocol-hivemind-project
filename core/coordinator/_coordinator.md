# Coordinator

The Hivemind coordinator: it registers participants, answers the access checks of every managed space, and runs each task from request to result (`core/protocol/interfaces/external/task_lifecycle.md`). It is the authority of every Hivemind space; its account lives on the Hivemind PDS (`core/hivemind_pds/`).

| Folder or file | What it holds |
| --- | --- |
| `config/` | Parameters only, as config objects: a type `<Context>Config` and its defaults `DEFAULT_<CONTEXT>_CONFIG` (style sheet, section 6). |
| `library/` | Functions only: the rules (task lifecycle, access, registration, scoring, billing), the clock and reading secrets. No network, no storage. |
| `authentication/` | Who is calling and who the coordinator is: login, service-auth verification, the attestation signer, the DID document. |
| `data/` | Storage behind the interfaces in `stores.ts`: SQLite for running, memory for tests, one contract test for both. |
| `runtime/` | The running parts: task runner, public-record indexer, API handlers, XRPC server, billing. |
| `main.ts` | Entry point: `startCoordinator()` wires everything from what it is given; `main()` builds the real dependencies. |

## Config and library

| Config | Read by |
| --- | --- |
| `identity_config.ts` | account, PDS, PLC directory, did:web domain, service and key fragments |
| `tasks_config.ts` | answer-window bounds, the selection window and the retry delays for failed writes (`library/task_rules.ts`) |
| `billing_config.ts` | pricing (`library/billing_rules.ts`) |
| `runtime_config.ts` | poll interval, firehose, XRPC port |
| `data_config.ts` | database file |
| `environment_config.ts` | names of the environment variables holding the secrets (`library/environment.ts`) |

## How a task runs

1. **Request intake.** `runtime/task_runner.ts` reads `requester.request` records through the space service. Active requesters only; an unsupported task type ends in `noCoverage`.
2. **Routing.** The routing service picks the feeds by task type and coverage; the coordinator then drops private feeds the requester is not allowlisted for.
3. **Dispatch.** Task space, `collecting` state and one coarsened dispatch per feed; the deadline is `respondBy`.
4. **Offer intake.** Offers from eligible agents only, before `respondBy`. An offer change that cannot be stored is tried again with the delays of ADR-007 while it can still matter (ADR-009); an answer from the same agent for the same task that arrives later supersedes a pending retry. Collection ends early once every eligible agent has answered.
5. **Ranking.** The matching service ranks the accepted offers with the task type's default criteria.
6. **Assignment.** An agent holds at most one active task, so the last step before assigning checks that the agent is still free and reserves it (ADR-008). Auto mode assigns the best offer from a free agent; choose mode lists only free agents and waits for the requester's selection until `selectBy`, assigning the next free option if the chosen agent took another task meanwhile. With no free agent the task ends in `noOffers`. The reservations are kept in memory and rebuilt from the stored tasks at start. The assignment is signed (`authentication/attestation_signer.ts`) and counted once for billing.
7. **Result.** The assigned agent's `completed` or `failed` progress ends the task; deleting the request cancels it.

Every phase change is stored first, marked as not yet published, and then published: the space writes and the billing it implies. All of them can be repeated, so a write that fails is simply tried again, after `firstRetryDelayMs` and then with a doubling delay up to `maxRetryDelayMs` (`config/tasks_config.ts`), and again after a restart, until it succeeds. Deadlines run on the stored phase and do not wait for the spaces. After a restart, running tasks are written again in full and their deadlines re-armed; ended tasks only get the writes they still owe (`core/protocol/interfaces/external/task_lifecycle.md`, Failed writes; ADR-007).

## Calls

`runtime/xrpc_server.ts` verifies the service-auth token of every call (`authentication/service_auth.ts`), then hands the caller's DID to `runtime/api_handlers.ts`:

| Method | Called by |
| --- | --- |
| `com.hivemind-network.coordinator.register` | requesters, operators, operators for their agents |
| `com.hivemind-network.coordinator.setFeedMember` | owners of private feeds |
| `com.atproto.managedspace.checkUserAccess` | the coordinator's own PDS, for both intakes and every feed space |

## Identity

The coordinator's DID document must carry two entries besides the PDS's own (ADR-006):

| Entry | Used by |
| --- | --- |
| `#hivemind_coordinator` | PDSes, to reach `checkUserAccess` before a write to a managed space lands |
| `#hivemind_attestation` | agents, to verify an assignment's signature |

`main()` checks both at startup and refuses to start if one is missing or outdated (`identityProblems` in `authentication/did_document.ts`).

- Locally, `core/hivemind_pds/start_local.ts` publishes them in the coordinator's did:plc.
- In production, `scripts/did_document.ts` builds the did:web document; the web host serves it at `https://<webDomain>/.well-known/did.json`. Run it again after rotating the attestation key or changing `serviceUrl`.

## Secrets

The account password and the attestation key come from environment variables (`config/environment_config.ts`), never from code or config files. `scripts/generate_attestation_key.ts` makes a new attestation key.

## Not finished

- `main()` cannot start a real coordinator until `services/` has implementations; `selectServices` says so. Tests pass their own services to `startCoordinator`.
- Feed declarations cannot carry scoring weights yet, so the task type's default criteria always apply (`library/scoring.ts` already handles feed weights).
- The firehose delivers new changes only. Records written before the coordinator started reach the index when they change, or when `register` and `setFeedMember` read them directly. Records carry no revision in the index, so such a direct read can replace a newer firehose change with an older copy. Both go away once the coordinator saves its firehose position and resumes from it.
- The SDK's `AttestationVerifier` must encode assignments exactly like `attestedBytes` in `authentication/attestation_signer.ts`.
