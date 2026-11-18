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

Date: 2026-11-18. Status: accepted.

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

