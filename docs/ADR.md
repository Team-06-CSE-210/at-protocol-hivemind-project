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
