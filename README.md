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

## Running the demo locally

The taxi demo in steps. Steps marked **(tbd)** do not work yet; they say what they will do once the missing parts exist ([Missing parts](#missing-parts)). Steps 1 to 5 work today.

Run the commands in a bash shell from the repository root. Each long-running part gets its own terminal.

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

Run `npm ci` again whenever `package-lock.json` changes, and `npm run build` after every code change; everything below runs from `dist/`.

### 2. Run the tests (optional)

```
npm test
```

The tests start their own PDSes and make their own keys, so they need no secrets. `tests/coordinator/published_identity.test.ts` already plays a small part of the demo: a rider registers and writes a request, and the PDS asks the coordinator whether it may.

### 3. Make a local attestation key

Once is enough; you can reuse the key or make a new one whenever you like. Keep it outside the repository:

```
node dist/scripts/generate_attestation_key.js > ~/hivemind-attestation.key
chmod 600 ~/hivemind-attestation.key
```

The private key goes into the file. The terminal only shows the public `did:key`.

### 4. Set the secrets

In every terminal that starts the PDS or the coordinator. The first line waits for you to type a password (any one, nothing is shown) and press Enter; this keeps it out of your shell history:

```
read -rs HIVEMIND_ACCOUNT_PASSWORD && export HIVEMIND_ACCOUNT_PASSWORD
export HIVEMIND_ATTESTATION_KEY="$(cat ~/hivemind-attestation.key)"
```

Use the same password and key in both terminals.

### 5. Start the local Hivemind PDS (terminal 1)

```
node dist/core/hivemind_pds/start_local.js
```

It starts a PDS and a PLC directory, creates the coordinator's account (`coordinator.test`) and publishes its two DID entries: `#hivemind_coordinator` (pointing at `http://localhost:2590`) and `#hivemind_attestation` (the `did:key` from step 3). It prints the PDS and PLC URLs and the coordinator's DID; the next steps need them. Leave it running.

Every start is a new PDS with a new DID. Its data goes to a randomly named folder in `/tmp`, which is emptied on reboot.

### 6. Start the coordinator (terminal 2) (tbd)

`core/coordinator/main.ts` exists, but cannot start until `services/` is implemented, and has no way yet to take the local values from step 5 (account `coordinator.test`, the PDS and PLC URLs). Once it starts, it:

1. logs in as `coordinator.test` and checks that its DID document carries both entries (it refuses to start otherwise),
2. opens its SQLite store and starts watching the request and offer intakes and the public records (profiles, feed declarations),
3. listens on port 2590 for `register`, `setFeedMember` and the PDS's `checkUserAccess` calls.

### 7. Create the demo accounts (tbd)

On the local PDS, as `start_local.js` does for the coordinator:

| Account | Role |
| --- | --- |
| rider | requests rides |
| taxi operator | registers and is responsible for the vehicles |
| one per vehicle in `demo/autonomous_taxi/config/taxi_fleet.json` | the agents: `taxi-1`, `taxi-2`, `van-3` |
| feed owner | declares the zone the taxis serve |

### 8. Declare the zone (tbd)

The feed owner publishes a feed declaration for a zone (its coverage area). The coordinator indexes it; the zone's feed space is where it dispatches requests for that area.

### 9. Start the taxi fleet (terminal 3) (tbd)

1. The operator registers (`register` with role `operator`) and then registers each vehicle as its agent (role `agent`).
2. Each vehicle publishes its agent profile, naming the zones it serves.
3. The agent client (`hivemind_sdk/hivemind_agent.ts`, empty so far) runs one `TaxiBehavior` per vehicle (`demo/autonomous_taxi/simulation/taxi_behavior.ts`, exists). With `timeScale` 10 from the fleet config, a 10-minute ride takes one minute.

### 10. Request a ride (terminal 4) (tbd)

The rider registers (role `requester`) and writes a ride request into the request intake with the requester client (`hivemind_sdk/hivemind_requester.ts`, empty so far). Before the request lands, the PDS asks the coordinator whether the rider may write there. This part already works (step 2).

### 11. Watch the ride (tbd)

What happens next (`core/coordinator/_coordinator.md`, How a task runs):

1. The coordinator picks the zones covering the pickup and posts a coarsened copy of the request in each zone's feed space.
2. The taxis answer with offers in the offer intake before the deadline.
3. The coordinator ranks the offers and assigns the best one, signed with the attestation key.
4. The assigned taxi checks the signature against `#hivemind_attestation`, drives to the pickup and the dropoff, and reports the ride completed.

A map in `view/` (empty so far) will show the zones and the moving taxis; `TaxiBehavior` already reports every position (`onMove`).

### 12. Stop

1. Press Ctrl+C in each terminal: fleet, coordinator, then the PDS.
2. Clear the secrets (closing the terminals does the same):
   ```
   unset HIVEMIND_ACCOUNT_PASSWORD HIVEMIND_ATTESTATION_KEY
   ```

### Missing parts

| Part | Needed for | State |
| --- | --- | --- |
| `services/` | step 6 | stubs and placeholders; `selectServices` in `core/coordinator/main.ts` throws until they exist |
| local coordinator configuration | step 6 | `main()` only has the production defaults |
| demo setup (accounts, zone) | steps 7, 8 | not started |
| `hivemind_sdk/` | steps 9, 10, 11 | the requester, agent and organization clients are empty files; the agent needs an `AttestationVerifier` |
| demo runner | steps 9, 10 | nothing starts the fleet or sends a request yet |
| `view/` | step 11 | empty |

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
