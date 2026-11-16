# Interfaces

Every interface uses the message types in `type_definition/msg_types/` and defines none of its own.

## external/: between participants and the coordinator

Defined as lexicons, so any language can implement them.

| Interface | Kind | Called by |
| --- | --- | --- |
| `com.hivemind-network.coordinator.register` | XRPC procedure | requesters, operators (for themselves and their agents) |
| `com.hivemind-network.coordinator.setFeedMember` | XRPC procedure | owners of private feeds |
| `task_lifecycle.md` | action, carried by records in spaces | requester, agents, coordinator |

Everything else participants do is writing records into spaces (see `type_definition/policy_types/`). The coordinator also implements atproto's own Spaces callbacks (`com.atproto.managedspace.checkUserAccess`, the `notifyWrite` receiver); atproto defines those, so they are not repeated here.

All coordinator methods use atproto service auth: a short-lived token from the caller's PDS, valid for one method. There are no API keys.

## internal/: between modules of our own code

Defined as TypeScript interfaces, because lexicons describe data and HTTP methods, not function calls or callbacks. An internal interface exists wherever an implementation can be swapped (fake or real, JSON file or database, TypeScript or Java) or a different team member plugs in.

| File | Interfaces | Implemented by | Used by |
| --- | --- | --- | --- |
| `types.ts` | readable names for the generated message types | (generated) | all files below |
| `task_type_module.ts` | `TaskTypeModule` | one module per application | coordinator |
| `matching_engine.ts` | `MatchingEngine` | coordinator (later possibly a Java service) | coordinator |
| `stores.ts` | `ParticipantStore`, `FeedMemberStore`, `TaskStore`, `PublicRecordIndex`, `RevisionStore` | data_handling | coordinator, gateways |
| `atproto_gateway.ts` | `AtprotoGateway`, `SpaceAuthority` | `protocol/communication/at_gateway_pds.ts` (real PDS), `protocol/communication/in_memory/at_gateway_localsim.ts` (in-memory) | coordinator, client library |
| `attestation.ts` | `AttestationSigner`, `AttestationVerifier` | coordinator, client library | coordinator, agents |
| `client_lib.ts` | `AgentBehavior`, `AgentClient`, `RequesterClient`, `OrganizationClient` | client library (operators implement `AgentBehavior`) | demo, view, operators |

If an internal interface ever crosses a process boundary (e.g. the matching engine as a Java service), it gets an XRPC lexicon under `internal.hivemind.*` built from the same message types.

## Where the TypeScript types come from

`npm run lex:build` (`scripts/build_lexicons.ts`, which runs `lex build` from `@atproto/lex`) turns all lexicons into TypeScript in `protocol/generated/`: types plus validators. `npm run typecheck` and `npm run build` run it first. That folder is build output, ignored by git and not edited by hand. At runtime the generated validators check incoming records and method inputs; the types themselves only exist at compile time.
