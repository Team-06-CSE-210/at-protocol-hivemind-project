# at-protocol-hivemind-project

## Repository layout

| Folder | What it holds |
| --- | --- |
| `core/` | what the services build on: type definitions, functions, configuration and interfaces (see `core/_core.md`) |
| `core/protocol/` | message types, policies, task types, interfaces and the atproto gateways |
| `core/coordinator/` | the coordinator's definitions, functions and configuration |
| `services/` | the services that run on top of `core/`: `hivemind_pds/`, `matching_service/` |
| `hivemind_sdk/` | the SDK requesters, agents and organizations use to take part |
| `demo/` | the autonomous taxi demo |
| `view/` | empty so far |
| `tests/` | tests, in folders named after what they test |
| `scripts/` | build scripts (`build_lexicons.ts`) |
| `docs/` | decisions (`ADR.md`), conventions, the style sheet, glossary |

Every folder has an overview doc named `_<folder>.md`. Imports point toward `core/`, never out of it.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | installs the pinned atproto packages (ADR-001) |
| `npm test` | generates the lexicon code, builds, and runs every test, including the gateway contract against an in-process PDS |
| `npm run check` | Biome lint and format check |
| `npm run fix` | applies Biome's fixes |
