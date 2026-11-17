# Communication

The two implementations of `AtprotoGateway` and `SpaceAuthority` (`interfaces/internal/atproto_gateway.ts`). Everything above them (coordinator, client library, demo) only sees the interface and does not know which one it got.

| File | What it is | Used for |
| --- | --- | --- |
| `at_gateway_pds.ts` | `PdsGateway`, `PdsSpaceAuthority`: real PDS, PLC directory and firehose on the Spaces alpha pinned in `package.json` | the demo on a real network, `tests/gateway/pds_gateway.test.ts` (in-process PDS from `@atproto/dev-env`) |
| `in_memory/at_protocol_network.ts` | `AtProtocolNetwork`: every PDS, the space hosts and the firehose in one object | unit tests, quick local runs |
| `in_memory/at_gateway_localsim.ts` | `LocalSimGateway`, `LocalSimSpaceAuthority`: one per account, all on one `AtProtocolNetwork` | same |

`tests/gateway/gateway_contract.ts` runs the same tests against both, so they behave alike.

## Behaviour both implementations share

These follow from how the frozen alpha behaves and are tested on both:

- **Writes without access are accepted and stay invisible.** The writer's own PDS takes the write; the space host leaves the writer out, so no reader ever sees it. `putSpaceRecord` therefore never tells you a write was refused. (The in-memory network lists such writes in `hiddenWrites` for tests.)
- **Following a space replays it.** `watchSpace` first delivers every record already in the space as `create`, then new changes.
- **Order per writer, not across writers.** One writer's changes arrive in the order they were made; changes of different writers can interleave in any order.
- **Intermediate states may collapse.** The PDS gateway polls; a record changed several times between two polls arrives only in its latest state. Records must therefore describe a state (as `taskState` and `progress` do), not an event that must not be missed.
- **A refusal rejects `watchSpace`.** No access or no such space: `SpaceAccessDeniedError`. The alpha answers `SpaceNotFound` for both, so they cannot be told apart.
- **`watchPublic` is live only.** It delivers public records written after it started, no backfill.
- **Managed spaces have no member list.** `putMember` on one is refused; access is decided by the managing app.

## How the PDS gateway reads a space

1. Delegation token from the account's own PDS (`com.atproto.space.getDelegationToken`), which vouches that this app acts for the account. Works with an app-password session.
2. Space credential from the authority (`com.atproto.space.getSpaceCredential`), bound to a P-256 key the gateway creates and keeps. Valid 600 s; renewed a minute early.
3. Writer set from the space host (`com.atproto.space.listRepos`).
4. First sync of a writer: its whole repo as a STAR archive (`com.atproto.space.getRepo`), verified against the commit's MAC and set hash.
5. Later syncs: operations since the last revision (`com.atproto.space.listRepoOps`), the commit checked by MAC.

Requests after step 2 carry `Authorization: Atproto-Space-Credential …` and an HTTP signature by the bound key. The signature names the audience: the authority for step 3, the writer for steps 4 and 5, so a request cannot be replayed at another host. MACs are keyed to the writer's `#atproto_kem` key from its DID document, which proves the data comes from the writer's PDS.

With a `RevisionStore`, a watch resumes from the last synced revision after a restart instead of replaying the space.

## Limits of the current alpha

- **Everyone polls.** The space host can only notify services that have an endpoint in their DID document (`registerNotify`), so clients poll (`pollIntervalMs`, default 2 s).
- **Operations are not yet checked against the commit's set hash.** Step 5 trusts the operation list once the commit's MAC is valid; step 4 checks everything.
- **A shortened operation log is not handled yet.** The host keeps only recent operations. What `listRepoOps` answers when our last revision is older than what it kept is untested; restarting without a stored revision always works (step 4).
- **`callProcedure` is untested on a real PDS** because the coordinator has no HTTP server yet. It needs a service identifier with a fragment, e.g. `did:web:hivemind-network.com#hivemind_coordinator`; the account's PDS forwards the call (`atproto-proxy` header) with a service-auth token.
