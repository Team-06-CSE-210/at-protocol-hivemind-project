# Core

What the services build on: immutable type definitions, functions and configuration, and every interface the services need to operate. `services/`, `hivemind_sdk/`, `demo/` and `tests/` import from here; nothing in `core/` imports from them (ADR-003 in `docs/ADR.md`).

| Folder | What it holds |
| --- | --- |
| `protocol/type_definition/` | message types (lexicons), space policies and task type modules |
| `protocol/interfaces/` | every interface, external (lexicons) and internal (TypeScript) |
| `protocol/protocol_config/` | space addresses and the rules for their keys |
| `protocol/communication/network/` | the atproto gateway for real infrastructure (PDS, PLC directory, firehose) |
| `protocol/communication/in_memory/` | the same gateway simulated in one process, for tests and local runs |
| `coordinator/` | the coordinator's definitions, functions and configuration (empty so far) |

`npm run lex:build` generates TypeScript from the lexicons into `protocol/generated/` (build output, not committed).
