/*
 * Starts the local atproto network (PLC, Hivemind PDS, operator PDS and the coordinator's did:web
 * document) on fixed ports and keeps it running until Ctrl+C. Writes the coordinator's login, its
 * attestation key and an invite code for the Hivemind PDS to .env.network (gitignored), so that
 * other processes, e.g. the coordinator or the demo, can load them with
 * `node --env-file=.env.network …`.
 *
 * The PDS files live in temporary directories, printed below and written to .env.network; they
 * are deleted on Ctrl+C, so a restart begins with an empty network.
 *
 * Run with: npm run dev:network
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevNetwork } from "../services/hivemind_pds/dev_network.ts";

const envFile = join(import.meta.dirname, "..", ".env.network");

const network = await startDevNetwork({
	plcPort: 2582,
	hivemindPdsPort: 2583,
	operatorPdsPort: 2584,
	coordinatorPort: 2590,
}).catch((error) => {
	// e.g. a port is still taken by an earlier run that did not stop
	console.error(error);
	process.exit(1);
});
const { coordinator } = network;
const inviteCode = await network.createInviteCode(100);

writeFileSync(
	envFile,
	[
		"# Written by `npm run dev:network`. Valid only while that process runs.",
		`PLC_URL=${network.plcUrl}`,
		`PDS_URL=${network.hivemindPdsUrl}`,
		`OPERATOR_PDS_URL=${network.operatorPdsUrl}`,
		`PDS_INVITE_CODE=${inviteCode}`,
		`COORDINATOR_DID=${coordinator.did}`,
		`COORDINATOR_URL=${coordinator.url}`,
		`COORDINATOR_HANDLE=${coordinator.handle}`,
		`COORDINATOR_PASSWORD=${coordinator.password}`,
		`ATTESTATION_KEY_JWK=${JSON.stringify(coordinator.attestationKey.privateJwk)}`,
		`HIVEMIND_PDS_DATA=${network.dataDirectories.hivemindPds}`,
		`OPERATOR_PDS_DATA=${network.dataDirectories.operatorPds}`,
		"",
	].join("\n"),
);

console.log(`Local atproto network is up.
  PLC           ${network.plcUrl}
  Hivemind PDS  ${network.hivemindPdsUrl}   handles *.hivemind.test, invite code ${inviteCode} (100 uses)
  Operator PDS  ${network.operatorPdsUrl}   handles *.fleet.test, no invite needed
  Coordinator   ${coordinator.did}  (${coordinator.handle})
                did.json  ${coordinator.url}/.well-known/did.json
                #hivemind_attestation  ${coordinator.attestationKey.didKey}
PDS files (deleted on Ctrl+C):
  Hivemind PDS  ${network.dataDirectories.hivemindPds}
  Operator PDS  ${network.dataDirectories.operatorPds}
Login, attestation key, invite code and these paths written to .env.network. Press Ctrl+C to stop.`);

let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	await network.close();
	process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
