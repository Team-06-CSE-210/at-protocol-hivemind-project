# at-protocol-hivemind-project

## Repository layout

| Folder | What it holds |
| --- | --- |
| `core/` | everything Hivemind runs and owns (see `core/_core.md`) |
| `core/protocol/` | message types, policies, task types, interfaces and the atproto gateways |
| `core/coordinator/` | the coordinator: config, library, authentication, data, runtime, `main.ts` |
| `core/hivemind_pds/` | settings and tools for the Hivemind PDS |
| `services/` | swappable parts the coordinator calls: `matching_service/`, `routing_service/`, `space_service/`, `payment_service/` (see `services/_services.md`) |
| `hivemind_sdk/` | the SDK requesters, agents and organizations use to take part |
| `demo/` | the autonomous taxi demo |
| `view/` | empty so far |
| `tests/` | tests, in folders named after what they test |
| `scripts/` | build scripts (`build_lexicons.ts`) and identity tools (`generate_attestation_key.ts`, `did_document.ts`) |
| `docs/` | decisions (`ADR.md`), conventions, the style sheet, glossary |

Every folder has an overview doc named `_<folder>.md`. Imports point toward `core/`, never out of it; only `core/coordinator/main.ts` imports from `services/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | installs the pinned atproto packages exactly as locked (ADR-001) |
| `npm run build` | generates the lexicon code and compiles everything to `dist/` |
| `npm test` | builds, then runs every test, including the gateway contract and the coordinator's identity against an in-process PDS |
| `npm run typecheck` | generates the lexicon code and type-checks without writing `dist/` |
| `npm run check` | Biome lint and format check |
| `npm run fix` | applies Biome's fixes |

## Running locally

The full taxi demo does not run yet (see [Not there yet](#not-there-yet)). What runs today: the tests, and a local Hivemind PDS with the coordinator's account and DID entries.

The commands assume a bash shell, run from the repository root.

### 1. Install and build

1. Use Node.js 24 (`.nvmrc`; with nvm: `nvm use`).
2. Install the pinned packages:
   ```
   npm ci
   ```
3. Build:
   ```
   npm run build
   ```

Run `npm ci` again whenever `package-lock.json` changes, and `npm run build` after every code change; the scripts below run from `dist/`.

### 2. Run the tests

```
npm test
```

The tests start their own PDSes and make their own keys. They need no secrets.

### 3. Start the local Hivemind PDS

1. Make a local attestation key, outside the repository. Once is enough; you can reuse it or make a new one whenever you like:
   ```
   node dist/scripts/generate_attestation_key.js > ~/hivemind-attestation.key
   chmod 600 ~/hivemind-attestation.key
   ```
   The private key goes into the file. The terminal only shows the public `did:key`.
2. Set both secrets in the terminal you start the PDS from. The first line waits for you to type a password (any one, nothing is shown) and press Enter; this keeps it out of your shell history:
   ```
   read -rs HIVEMIND_ACCOUNT_PASSWORD && export HIVEMIND_ACCOUNT_PASSWORD
   export HIVEMIND_ATTESTATION_KEY="$(cat ~/hivemind-attestation.key)"
   ```
3. Start the PDS:
   ```
   node dist/core/hivemind_pds/start_local.js
   ```
   It prints the PDS and PLC directory URLs, the coordinator's DID (`coordinator.test`) and the two entries it published in that DID: `#hivemind_coordinator` and `#hivemind_attestation`. The `Attestation:` line shows the same `did:key` as step 1.
4. Stop it with Ctrl+C. Every start is a new PDS with a new DID. Its data goes to a randomly named folder in `/tmp`, which is emptied on reboot.
5. When you are done, clear the secrets (closing the terminal does the same):
   ```
   unset HIVEMIND_ACCOUNT_PASSWORD HIVEMIND_ATTESTATION_KEY
   ```

### Not there yet

These are missing before the taxi demo runs end to end:

| Part | State |
| --- | --- |
| `services/` | stubs and placeholders. Until they are implemented, `core/coordinator/main.ts` cannot start a coordinator (`selectServices` throws). |
| `hivemind_sdk/` | the requester, agent and organization clients are empty files |
| `demo/autonomous_taxi/` | the taxi behaviour exists (`simulation/taxi_behavior.ts`); nothing starts the fleet yet |
| `view/` | empty |

## Keys and passwords

The coordinator has two secrets, both read from environment variables only (`core/coordinator/config/environment_config.ts`):

| Variable | What it is |
| --- | --- |
| `HIVEMIND_ACCOUNT_PASSWORD` | password of the coordinator's account on the Hivemind PDS |
| `HIVEMIND_ATTESTATION_KEY` | private P-256 key (hex) that signs assignments; its public half is published in the coordinator's DID document |

Locally:

- Any password and any key work. Every teammate uses their own; nothing is shared.
- `start_local.js` publishes the key it is started with. After changing the key, restart it. The coordinator must use the same key, or it refuses to start.

Always:

- Never commit a key or password. Keep key files outside the repository; `.env` files are ignored by git.
- Never paste the private key into chat, issues or a shared screen. What the scripts print (URLs, DIDs, the `did:key`) is public.
- Don't put the secrets in `~/.bashrc` or type them on the command line, where your shell history keeps them.

In production the key is generated once on the server or in the team's secret store, never on a laptop. Publishing it, rotating it and setting up the coordinator's did:web account are described in ADR-006 (`docs/ADR.md`) and in `core/hivemind_pds/_hivemind_pds.md`.
