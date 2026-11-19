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
| `scripts/` | build scripts (`build_lexicons.ts`) |
| `docs/` | decisions (`ADR.md`), conventions, the style sheet, glossary |

Every folder has an overview doc named `_<folder>.md`. Imports point toward `core/`, never out of it; only `core/coordinator/main.ts` imports from `services/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | installs the pinned atproto packages exactly as locked (ADR-001) |
| `npm test` | generates the lexicon code, builds, and runs every test, including the gateway contract against an in-process PDS |
| `npm run check` | Biome lint and format check |
| `npm run fix` | applies Biome's fixes |
