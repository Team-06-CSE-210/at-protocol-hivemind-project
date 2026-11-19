import { pathToFileURL } from "node:url";
import { AtpAgent } from "@atproto/api";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { DEFAULT_ENVIRONMENT_CONFIG } from "../coordinator/config/environment_config.js";

// Development only: a Hivemind PDS and a PLC directory in this process (@atproto/dev-env, on the
// frozen Spaces alpha), with the coordinator's account. Production runs the official PDS with
// pds.env.example instead. Stops with Ctrl+C; nothing is kept.
//
// Run: HIVEMIND_ACCOUNT_PASSWORD=<choose one> node dist/core/hivemind_pds/start_local.js

// Handle of the coordinator account; dev-env PDSes serve handles under .test
const LOCAL_COORDINATOR_HANDLE = "coordinator.test";

export interface LocalHivemindPds {
	pdsUrl: string;
	plcUrl: string;
	coordinatorDid: string;
	close(): Promise<void>;
}

export async function startLocalHivemindPds(
	coordinatorPassword: string,
): Promise<LocalHivemindPds> {
	// 1. PDS and PLC directory
	const network = await TestNetworkNoAppView.create({});

	// 2. The coordinator's account, with the password the coordinator will log in with
	const agent = new AtpAgent({ service: network.pds.url });
	await agent.createAccount({
		handle: LOCAL_COORDINATOR_HANDLE,
		email: "coordinator@test.invalid",
		password: coordinatorPassword,
	});

	return {
		pdsUrl: network.pds.url,
		plcUrl: network.plc.url,
		coordinatorDid: agent.assertDid,
		close: () => network.close(),
	};
}

async function runFromCommandLine(): Promise<void> {
	const variable = DEFAULT_ENVIRONMENT_CONFIG.accountPasswordVariable;
	const password = process.env[variable];
	if (password === undefined || password === "") {
		throw new Error(
			`Set ${variable} to the password the coordinator account should get`,
		);
	}
	const local = await startLocalHivemindPds(password);

	// What the coordinator's identity config needs to point at this PDS
	console.log(`PDS:         ${local.pdsUrl}`);
	console.log(`PLC:         ${local.plcUrl}`);
	console.log(
		`Coordinator: ${local.coordinatorDid} (${LOCAL_COORDINATOR_HANDLE})`,
	);
	process.once("SIGINT", () => {
		local.close().then(() => process.exit(0));
	});
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runFromCommandLine().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
