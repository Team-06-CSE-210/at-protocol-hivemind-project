# Core

Everything Hivemind runs and owns: the protocol, the coordinator and the Hivemind PDS, with every interface the services need to operate (ADR-003 and ADR-004 in `docs/ADR.md`). `services/`, `hivemind_sdk/`, `demo/` and `tests/` import from here. Nothing in `core/` imports from them, with one exception: `coordinator/main.ts` selects the service implementations.

| Folder | What it holds |
| --- | --- |
| `protocol/type_definition/` | message types (lexicons), space policies and task type modules |
| `protocol/interfaces/` | every interface, external (lexicons) and internal (TypeScript) |
| `protocol/protocol_config/` | space addresses and the rules for their keys |
| `protocol/communication/network/` | the atproto gateway for real infrastructure (PDS, PLC directory, firehose) |
| `protocol/communication/in_memory/` | the same gateway simulated in one process, for tests and local runs |
| `coordinator/` | the coordinator: config objects, library functions, authentication, storage, runtime and its entry point `main.ts` (see `coordinator/_coordinator.md`) |
| `hivemind_pds/` | settings and tools for the PDS Hivemind runs itself (see `hivemind_pds/_hivemind_pds.md`) |

`npm run lex:build` generates TypeScript from the lexicons into `protocol/generated/` (build output, not committed).
