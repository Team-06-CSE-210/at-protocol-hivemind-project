# Hivemind PDS

The PDS Hivemind runs itself. It hosts the coordinator's account, under which every Hivemind space lives (the coordinator is the authority of every space), and accounts of participants who have no PDS of their own. Participants with their own PDS never touch it.

It is a stock atproto PDS on the frozen Spaces alpha (ADR-001); nothing here changes how a PDS works.

| File | Contents |
| --- | --- |
| `pds_config.ts` | Its settings as a config object (`PdsConfig`, `DEFAULT_PDS_CONFIG`). |
| `pds.env.example` | The same settings as the PDS's environment, for the production server. Secrets stay empty here. |
| `invites.ts` | Creates invite codes; accounts need one because `inviteRequired` is on. |
| `start_local.ts` | Development only: a PDS and PLC directory in one process via `@atproto/dev-env`, with the coordinator account created. |

This folder is small, so its settings live in `pds_config.ts` instead of a `config/` folder (style sheet, section 6).

## Secrets

The admin password, JWT secret and PLC rotation key exist only as environment variables on the server. The coordinator's account password and attestation key are the coordinator's (`core/coordinator/config/environment_config.ts`).
