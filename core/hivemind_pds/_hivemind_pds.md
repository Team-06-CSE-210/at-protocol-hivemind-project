# Hivemind PDS

The PDS Hivemind runs itself. It hosts the coordinator's account, under which every Hivemind space lives (the coordinator is the authority of every space), and accounts of participants who have no PDS of their own. Participants with their own PDS never touch it.

It is a stock atproto PDS on the frozen Spaces alpha (ADR-001); nothing here changes how a PDS works.

| File | Contents |
| --- | --- |
| `pds_config.ts` | Its settings as a config object (`PdsConfig`, `DEFAULT_PDS_CONFIG`). |
| `pds.env.example` | The same settings as the PDS's environment, for the production server. Secrets stay empty here. |
| `invites.ts` | Creates invite codes; accounts need one because `inviteRequired` is on. |
| `start_local.ts` | Development only: a PDS and PLC directory in one process via `@atproto/dev-env`, with the coordinator account and its DID entries (ADR-006). |

This folder is small, so its settings live in `pds_config.ts` instead of a `config/` folder (style sheet, section 6).

## Secrets

The admin password, JWT secret and PLC rotation key exist only as environment variables on the server. The coordinator's account password and attestation key are the coordinator's (`core/coordinator/config/environment_config.ts`).

## The coordinator's account in production

The coordinator is `did:web:hivemind-network.com`. This PDS build only accepts a DID it did not create when the request is signed by that DID, so the account is set up once by hand:

1. Generate a bootstrap key and serve a first `did.json` with it as `#atproto`, and the PDS as `#atproto_pds`.
2. Serve the DID at `https://hivemind-network.com/.well-known/atproto-did`, so the handle `hivemind-network.com` resolves to it.
3. Call `com.atproto.server.createAccount` with `did`, handle, email, password and invite code. Authorize it with a service-auth token signed by the bootstrap key: `iss` is the coordinator's DID, `aud` the PDS's DID, `lxm` is `com.atproto.server.createAccount`. The account starts deactivated.
4. Run `scripts/did_document.ts` (it logs in and reads the PDS's keys) and serve its output as the new `did.json`. This replaces the bootstrap key.
5. Call `com.atproto.server.activateAccount` as the account.

Steps 1 to 3 and 5 follow the PDS code (`api/com/atproto/server/createAccount.js` of the frozen alpha). They have not been run against a deployed PDS yet.
