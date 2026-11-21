import { pathToFileURL } from "node:url";
import { AtpAgent } from "@atproto/api";
import { P256Keypair } from "@atproto/crypto";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import {
	type DidCredentials,
	hivemindDidEntries,
	withHivemindEntries,
} from "../coordinator/authentication/did_document.js";
import { DEFAULT_ENVIRONMENT_CONFIG } from "../coordinator/config/environment_config.js";
import { DEFAULT_IDENTITY_CONFIG } from "../coordinator/config/identity_config.js";
import { DEFAULT_RUNTIME_CONFIG } from "../coordinator/config/runtime_config.js";
import { readSecrets } from "../coordinator/library/environment.js";
import type { Did } from "../protocol/interfaces/internal/types.js";

// Development only: a Hivemind PDS and a PLC directory in this process (@atproto/dev-env, on the
// frozen Spaces alpha), with the coordinator's account and its DID entries (ADR-006). Production
// runs the official PDS with pds.env.example instead. Stops with Ctrl+C; nothing is kept.
//
// Run: HIVEMIND_ACCOUNT_PASSWORD=<choose one> HIVEMIND_ATTESTATION_KEY=<hex> \
//      node dist/core/hivemind_pds/start_local.js
// A key for local use: node dist/scripts/generate_attestation_key.js

// Handle of the coordinator account; dev-env PDSes serve handles under .test
const LOCAL_COORDINATOR_HANDLE = "coordinator.test";

export interface LocalHivemindPds {
	pdsUrl: string;
	plcUrl: string;
	coordinatorDid: Did;
	// The coordinator account's session
	coordinatorAgent: AtpAgent;
	// Adds #hivemind_attestation and #hivemind_coordinator to the coordinator's did:plc.
	// serviceUrl: where the coordinator's XRPC server listens, e.g. http://localhost:2590
	publishCoordinatorIdentity(
		attestationDidKey: string,
		serviceUrl: string,
	): Promise<void>;
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
	const coordinatorDid = agent.assertDid;

	// 3. Publishing the DID entries: a PLC update, as dev-env's own service-profile.ts makes one
	const publishCoordinatorIdentity = async (
		attestationDidKey: string,
		serviceUrl: string,
	) => {
		// What the PDS maintains for the account (an update replaces the lists), plus our entries
		const { data: recommended } =
			await agent.com.atproto.identity.getRecommendedDidCredentials();
		const identity = { ...DEFAULT_IDENTITY_CONFIG, serviceUrl };
		const credentials = withHivemindEntries(
			recommended as DidCredentials,
			hivemindDidEntries(identity, attestationDidKey),
		);

		// The update needs the email token the PDS sends out; dev-env sends no mail, so it is
		// read from the PDS's database
		await agent.com.atproto.identity.requestPlcOperationSignature();
		const { token } = await network.pds.ctx.accountManager.db.db
			.selectFrom("email_token")
			.select("token")
			.where("did", "=", coordinatorDid)
			.where("purpose", "=", "plc_operation")
			.executeTakeFirstOrThrow();

		// The PDS signs with its rotation key, the PLC directory applies the operation
		const { data } = await agent.com.atproto.identity.signPlcOperation({
			token,
			...credentials,
		});
		await agent.com.atproto.identity.submitPlcOperation({
			operation: data.operation,
		});
	};

	return {
		pdsUrl: network.pds.url,
		plcUrl: network.plc.url,
		coordinatorDid,
		coordinatorAgent: agent,
		publishCoordinatorIdentity,
		close: () => network.close(),
	};
}

async function runFromCommandLine(): Promise<void> {
	// 1. Both secrets from the environment; the attestation key's public half goes into the DID
	const { accountPassword, attestationKeyHex } = readSecrets(
		DEFAULT_ENVIRONMENT_CONFIG,
	);
	const attestationKey = await P256Keypair.import(attestationKeyHex);
	const serviceUrl = `http://localhost:${DEFAULT_RUNTIME_CONFIG.xrpcPort}`;

	// 2. PDS, account and DID entries
	const local = await startLocalHivemindPds(accountPassword);
	await local.publishCoordinatorIdentity(attestationKey.did(), serviceUrl);

	// 3. What the coordinator's identity config needs to point at this PDS
	console.log(`PDS:         ${local.pdsUrl}`);
	console.log(`PLC:         ${local.plcUrl}`);
	console.log(
		`Coordinator: ${local.coordinatorDid} (${LOCAL_COORDINATOR_HANDLE})`,
	);
	console.log(`Service:     ${serviceUrl} (#hivemind_coordinator)`);
	console.log(`Attestation: ${attestationKey.did()} (#hivemind_attestation)`);
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
