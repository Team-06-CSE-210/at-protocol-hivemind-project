# Architecture Decision Records

## ADR-001: Freeze atproto at the Spaces alpha of 2026-11-05

Date: 2026-11-15. Status: accepted.

### Context

The atproto Spaces alpha changes weekly, often incompatibly. The 2026-11-05 update, for example, replaced commit signatures with a MAC derived from a new `#atproto_kem` DID-document key and reworked how space credentials are requested and presented. Following every update would keep us rewriting plumbing instead of building Hivemind.

### Decision

Every atproto package is pinned to the snapshot `0.0.0-spaces-alpha-20261105160032`:

- `dependencies` and `devDependencies` name that exact version.
- `overrides` pins each of the 43 `@atproto/*` and `@atproto-labs/*` packages the snapshot pulls in. The packages depend on each other with `^0.0.0-spaces-alpha-…` ranges, which also match later snapshots and a bare `0.0.0` release, so pinning only the top level would not freeze anything.
- `package-lock.json` is committed; install with `npm ci`.
- The local network (PDS and PLC directory) runs in-process from `@atproto/dev-env` of the same snapshot. The hosted alpha PDS is not used, because it is updated every Thursday.

### Consequences

- Our setup only syncs with PDSes on the same snapshot. Operators who host their own PDS must run it too.
- No upstream bug or security fixes reach us. Acceptable for a local demo, not for anything public.
- If the PDS is later deployed with Docker, pin the image by digest (`ghcr.io/bluesky-social/atproto@sha256:…`) from the same week, never by the moving `pds-spaces-alpha` tag.
- The coordinator's DID document must contain `#atproto` (signing key; space credentials are signed with it), `#atproto_pds` (the space host), `#atproto_kem` (readers check its space data against it), `#hivemind_coordinator` (managing app of the managed spaces) and `#hivemind_attestation` (assignment signatures). For a did:plc account the PDS maintains the first three; for did:web they are copied from `com.atproto.identity.getRecommendedDidCredentials`.

### Upgrading

Upgrade once, deliberately, ideally to the first stable release:

1. Replace the version string in `package.json` (dependencies, devDependencies, overrides) and check whether the new snapshot pulls in `@atproto` packages that need an override.
2. Run `npm install`, then `npm run typecheck`.
3. Adapt the `AtprotoGateway` implementation. Nothing outside it should depend on alpha details.

## ADR-002: Lexicon namespace com.hivemind-network

Date: 2026-11-16. Status: accepted.

### Context

An NSID is a reversed domain plus a name, and the domain decides who may publish the lexicon: resolvers look up a DNS TXT record `_lexicon.<authority domain>` (the NSID without its last segment, reversed). Our lexicons used `network.hivemind.*`, i.e. the domain hivemind.network, which Hivemind does not own. Hivemind has registered hivemind-network.com.

### Decision

- Every lexicon of the open protocol (general records, shared defs, space types, coordinator methods, task types) uses `com.hivemind-network.*`, e.g. `com.hivemind-network.mobility.ride`.
- Internal-only lexicons keep `internal.hivemind.*`. The top-level `internal` root belongs to no domain and is never published; Bluesky does the same (`internal.bsky.*`).
- The coordinator's identity is planned as `did:web:hivemind-network.com`.
- TypeScript imports the generated namespace as `import * as hivemind from ".../generated/com/hivemind-network.js"`, because the hyphen rules out `com.hivemind-network` as a property path.
- Lexicon folders keep their paths; `npm run lex:build` places files by their `id`.

### Consequences

- To publish a lexicon group, add a TXT record such as `_lexicon.mobility.hivemind-network.com` with `did=<DID>` and put the schemas as `com.atproto.lexicon.schema` records (record key = NSID) into that DID's repo.
- `did:web:hivemind-network.com` requires serving `https://hivemind-network.com/.well-known/did.json`. Losing the domain would mean losing both the coordinator's identity and the lexicon authority.
- Nothing had been released, so no records under the old namespace need migrating.

## ADR-003: Repository layout with core, services and hivemind_sdk

Date: 2026-11-18. Status: accepted; what `core/` and `services/` mean is refined by ADR-004.

### Context

`protocol/` held the message types, interfaces and gateways at the top level, while the coordinator sat among the running services in `services/`. There was no single place that says: this is what every service builds on.

### Decision

- `core/` holds what the services build on: immutable type definitions, functions and configuration files, and every interface the services need to operate. It has two folders:
  - `core/protocol/` (was `protocol/`). Its `communication/` folder is split into `network/` (real atproto: `at_gateway_pds.ts`) and `in_memory/` (simulation).
  - `core/coordinator/` (was `services/coordinator/`).
- `services/` keeps the services that run on top of `core/` (`hivemind_pds/`, `matching_service/`).
- `hivemind_library/` is renamed `hivemind_sdk/`.

### Consequences

- Imports point toward `core/`: `services/`, `hivemind_sdk/`, `demo/`, `scripts/` and `tests/` import from it, and `core/` imports from none of them.
- Generated lexicon code moves to `core/protocol/generated/` (ignored by git). `tsconfig.json` and `biome.json` include `core/**` and `hivemind_sdk/**` instead of `protocol/**` and `hivemind_library/**`.
- Tests read the space policies from `core/protocol/type_definition/policy_types/`.

## ADR-004: core is what Hivemind runs and owns, services are swappable

Date: 2026-11-19. Status: accepted.

### Context

ADR-003 put the coordinator into `core/` but left the Hivemind PDS among the services, and `services/` had no rule for what belongs there. The coordinator also needed a place for its parameters, its rules and its running parts.

### Decision

- `core/` holds everything Hivemind runs and owns: `protocol/`, `coordinator/` and `hivemind_pds/` (moved from `services/`).
- `services/` holds parts the coordinator calls that could be swapped without anything else breaking: matching, routing, space operations, payments. Each implements an interface in `core/protocol/interfaces/internal/`. Only `core/coordinator/main.ts` imports from `services/`.
- The coordinator has five folders and an entry point: `config/` (parameters only), `library/` (functions only), `authentication/`, `data/`, `runtime/`, and `main.ts`.
- Parameters are config objects: a type plus a default object, passed into functions and read as `config.parameter` (style sheet, section 6). This holds for the whole repository. Biome reports static-only classes as errors.
- New internal interfaces for the swappable parts and the coordinator's methods: `RequestRouter`, `SpaceService`, `CoordinatorApi`, plus `BillingStore` and `CoordinatorStores` in `stores.ts`.
- The coordinator's database is SQLite through `node:sqlite` (built into Node.js 22.13 and later), behind the store interfaces; an in-memory implementation passes the same contract test.

### Consequences

- The coordinator is complete in `core/`, but `main()` cannot start until `services/` has implementations; tests start it with fake services.
- Geometry moves to the routing service; the demo keeps its own distance function.
- Adding `@atproto/lex-cbor` (same frozen version) for the attestation's DAG-CBOR encoding.
- The SQLite file (`data/coordinator.sqlite` by default) is ignored by git.

## ADR-005: Two intake spaces

Date: 2026-11-19. Status: accepted.

### Context

Requests and offers shared one intake space (`com.hivemind-network.space.intake`). A PDS grants access per space, not per collection, so any active agent could also write requests and any requester offers; only readers dropping records by role kept them apart. The space also mixed two streams the coordinator handles differently.

### Decision

- Two managed space types, both with key `main` and read by the coordinator only:
  - `com.hivemind-network.space.requestIntake`: active requesters write `requester.request`.
  - `com.hivemind-network.space.offerIntake`: active agents of active operators write `agent.offer`.
- `space_definition.ts` has `requestIntakeSpaceRef` and `offerIntakeSpaceRef` instead of `intakeSpaceRef`; the policies are `policy_types/request_intake.json` and `offer_intake.json`.
- The planned per-feed offers space is dropped: one offer intake serves all feeds.

### Consequences

- `checkUserAccess` grants write access per space type, so the PDS itself now keeps requesters out of the offer intake and agents out of the request intake.
- The SDK writes requests and offers to different addresses.
- `space.intake` and its policy are removed. Nothing had been released, so no records need migrating.

## ADR-006: The coordinator's DID entries are published, and checked at startup

Date: 2026-11-21. Status: accepted.

### Context

The managed spaces name `<coordinator DID>#hivemind_coordinator` as their managing app. Before a write lands, the space host's PDS looks that service up in the coordinator's DID document and asks it `checkUserAccess`; any failure there counts as a denial. Agents verify assignments with `#hivemind_attestation` from the same document. Neither entry was ever published: `buildDidDocument` existed, but nothing put its output anywhere. On a real PDS every write to an intake or feed space would have been refused and no assignment could have been verified. The tests used in-memory fakes that skip the PDS, so they passed. A CodeRabbit review flagged the missing attestation key, which led to this.

### Decision

- Production uses `did:web:hivemind-network.com`. `scripts/did_document.ts` builds the document from the PDS's recommended credentials plus both Hivemind entries. The team's web host serves it at `https://hivemind-network.com/.well-known/did.json`.
- Local development uses the did:plc that `@atproto/dev-env` creates. `core/hivemind_pds/start_local.ts` adds both entries with a PLC update through the PDS (`publishCoordinatorIdentity`).
- `main()` resolves the coordinator's DID, bypassing the cache, and refuses to start with `UnpublishedIdentityError` if either entry is missing or differs from the configured key and service URL.
- The attestation key is a P-256 key the team generates with `scripts/generate_attestation_key.ts` and keeps only in `HIVEMIND_ATTESTATION_KEY`.

### Consequences

- Rotating the attestation key or moving the XRPC server means republishing the document first. The startup check enforces that order.
- Assignments signed with an earlier key stop verifying once the document changes. That is acceptable for the demo; listing old keys under new fragments would fix it if needed.
- Whoever controls the hivemind-network.com web host controls the coordinator's identity. did:web has no rotation keys to recover with, unlike did:plc.
- PDSes cache DID documents: a refresh starts after an hour and an entry is kept at most a day (PDS defaults `didCacheStaleTTL` and `didCacheMaxTTL`). A republished document can take that long to reach them.
- The dev-env PLC directory serves P-256 keys in the older `EcdsaSecp256r1VerificationKey2019` encoding, did:web and plc.directory as `Multikey`. The check compares did:keys, so both pass.
- The did:web account itself is created once by hand, with a bootstrap key (`core/hivemind_pds/_hivemind_pds.md`).

## ADR-007: Task writes are stored first and retried until they succeed

Date: 2026-11-21. Status: accepted.

### Context

The task runner stored each step and then wrote to the spaces, but a failed space write was only repeated at the next restart, and an end phase not even then. The requester could keep seeing `assigned` after the ride had ended. A task ending in `noCoverage` could stay invisible, and one waiting for a selection could lose its deadline timer. A failed dispatch close stopped the ranking, and a crash between storing an assignment and counting it lost the count. CodeRabbit flagged these on PR #30. They share one cause: what the spaces show was never checked against what was stored.

### Decision

- `TaskRecord` gets `published`. Every phase change stores the task with `published: false`, then publishes it: task space, dispatches (open while collecting, closed afterwards), billing and the assignment, and the task state last. On success it stores `published: true`.
- A failed publish is tried again after `firstRetryDelayMs` (1 s), doubling up to `maxRetryDelayMs` (1 min). `TaskStore.listOpen()` also returns ended tasks that are not published, so `start()` finishes them after a restart. Running tasks are published again in full at every start.
- Deadlines are armed from the stored phase, independently of publishing.
- Billing counts per task ID (`BillingStore.recordAssignment(taskId, agent, month)`, table `billing_assignments`), in the month of the assignment's `issuedAt`.
- Every `SpaceService` write must be idempotent (`space_service.ts`).

### Consequences

- Participants can see a phase late, never a wrong one. A choose-mode requester whose options appear late has less time to select.
- Whoever implements `services/space_service/` must make every write repeatable, including closing a dispatch that is already closed.
- A space host that stays unreachable gets a retry every minute per affected task until it is back.
- Old SQLite files still open: their tasks count as published, and the earlier `billing_usage` table is no longer used, so its counts do not carry over. Nothing had been released.

## ADR-008: An agent holds at most one active task

Date: 2026-11-26. Status: proposed (PR #49).

### Context

Each task was ranked and assigned on its own, and nothing compared an agent's tasks with each other. Two requests in one region that close at about the same time usually rank the same nearest taxi first, so both were assigned to it; choose mode had the same gap when both requesters picked it. The taxi then held two signed assignments. It could serve the second ride late, with a pickup time that no longer held, or report it as failed, which ended that task without trying the next-best offer.

### Decision

- An agent holds at most one active task: from its assignment until the task reaches an end phase.
- The coordinator checks this as the last step before assigning and reserves the agent in the same step. The check and the reservation run without an `await` in between, so two tasks that close at the same moment cannot both take one agent.
- Auto mode assigns the best offer from a free agent. Choose mode leaves busy agents out of the options; if the selected agent took another task since, the next free option in ranked order is assigned. With no free agent, the task ends in `noOffers`.
- The reservations are kept in the coordinator's memory and rebuilt at start from the stored tasks in phase `assigned`, before any task resumes. If storing an assignment fails, the agent is freed once the stored task shows it unassigned; if that cannot be read either, it stays reserved until the next start.

### Consequences

- The first task to close gets the agent. The coordinator does not look for the best pairing of several tasks at once.
- The check assumes one coordinator process per coordinator DID. Several processes would need it in the database (at most one assigned task per agent).
- Agents may still offer on several tasks. An agent that wins one should withdraw its other open offers (K5); until then the coordinator skips them.
- In choose mode a requester can be assigned another agent than the one selected, when the selected one is busy.
- Tasks one agent can serve together (a robot carrying several parcels) would need a capacity per task type or per agent profile.

## ADR-009: An offer change is retried while it can still count

Date: 2026-11-26. Status: proposed (PR #49).

### Context

Before PR #49, an offer the coordinator failed to store was reported and lost until the next restart replayed the offer intake. PR #49 added retries, limited to three attempts within about three seconds, so a short database outage still lost offers. A later answer from the same agent for the same task supersedes a pending retry, tracked by arrival order.

### Decision

- An offer change that fails to store is tried again with the delays of ADR-007 (1 s, doubling up to 1 min) while it can still count. Offers and withdrawals only count while their task collects, and a task that was open when the change arrived stops collecting within `maxAnswerWindowMs` (10 min).
- So the retries end at the first attempt after the task stopped collecting, which then does nothing, and at the latest `maxAnswerWindowMs` after the change arrived. `TasksConfig.maxOfferStoreAttempts` is removed.
- Retries stay in memory. After a restart the coordinator replays the offer intake.

### Consequences

- A database outage shorter than the answer window loses no offers.
- An outage as long as the answer window reports one error per attempt, about fifteen per offer change.
