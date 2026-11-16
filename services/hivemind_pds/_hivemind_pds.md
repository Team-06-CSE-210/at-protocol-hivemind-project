# hivemind_pds: hosting the PDS and Spaces

A local atproto network for development and tests, run inside one Node process with `@atproto/dev-env` (ADR-001). Its dependency tree is the pinned spaces alpha `0.0.0-spaces-alpha-20261105160032` from `package-lock.json`, the same one the 11.5 PDS image is built from.

| Part | Role in Hivemind | Identity / handles |
| --- | --- | --- |
| PLC directory | Resolves riders' and agents' `did:plc` to their DID documents | — |
| Hivemind PDS | Invite-only. Hosts the coordinator account, so it is the authority and host of every intake, feed and task space; riders get accounts here | `*.hivemind.test` |
| Operator PDS | A fleet operator's own PDS, open for sign-up; agents live here | `*.fleet.test` |
| Coordinator | `did:web:localhost%3A{port}`; its `did.json` is served at `http://localhost:{port}/.well-known/did.json`, the address `#hivemind_coordinator` points to | `coordinator.hivemind.test` |

The coordinator's DID document carries the five entries ADR-001 requires. `#atproto`, `#atproto_kem` and `#atproto_pds` are copied from `com.atproto.identity.getRecommendedDidCredentials`; Hivemind adds service `#hivemind_coordinator` (type `HivemindCoordinator`) and key `#hivemind_attestation` (P-256, signs assignments).

How the coordinator account is created is described at the top of `coordinator_account.ts`: a first `did.json` with a key it holds, `createAccount` with that DID, an invite code and a service auth token, then `getRecommendedDidCredentials`, the final `did.json` with the two Hivemind entries, and `activateAccount`.

## Files

| File | Purpose | Moves to Docker? |
| --- | --- | --- |
| `network.ts` | `HivemindNetwork`: what code and tests get (URLs, coordinator account, `createInviteCode()`, `close()`), plus the shared names (handle domains, `#hivemind_*` ids) | Yes, unchanged |
| `coordinator_account.ts` | `createCoordinatorAccount()`, `createInviteCode()`: only the PDS's HTTP API and admin password | Yes, unchanged |
| `did_document.ts` | `buildDidDocument()` for did:web, and `DidDocumentHost`, the place a did.json is published | Yes, unchanged |
| `keys.ts` | `generateP256Key()` with its did:key, `signEs256Jwt()` for the service auth token | Yes, unchanged |
| `xrpc.ts` | Minimal XRPC over fetch | Yes, unchanged |
| `did_web_host.ts` | Serves the coordinator's did.json on localhost until the coordinator service does | Replaced by the coordinator service |
| `dev_network.ts` | `startDevNetwork()`: the only file that uses dev-env. PLC and both PDSes in this process, temporary data directories (deleted by `close()`), the Windows directory-name fix | Replaced by containers |
| `../../scripts/dev_network.ts` | `npm run dev:network`: fixed ports (PLC 2582, Hivemind PDS 2583, operator PDS 2584, coordinator 2590) until Ctrl+C; prints the PDS data directories and writes them, the coordinator's login, attestation key and a 100-use invite code to `.env.network` (gitignored) | Replaced by a bootstrap script writing the same variables |
| `../../tests/hivemind_pds/dev_network.test.ts` | `npm test`: invite codes, the coordinator's DID document, the task space policy across both PDSes, cleanup | Yes; uses only `HivemindNetwork` |

## Moving to Docker later

Every host is `localhost` today: PDS addresses are `http://localhost:{port}`, and atproto fetches a did:web over plain HTTP only for localhost. Between containers that no longer holds. Each service then needs its own hostname (e.g. `pds.hivemind.test`, `coordinator.hivemind.test`) behind HTTPS with a local CA the PDSes trust (`NODE_EXTRA_CA_CERTS`), and the coordinator becomes `did:web:coordinator.hivemind.test`.
