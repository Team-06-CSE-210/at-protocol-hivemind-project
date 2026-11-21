import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { AtpAgent } from "@atproto/api";
import { P256Keypair } from "@atproto/crypto";
import { IdResolver } from "@atproto/identity";
import {
	identityProblems,
	UnpublishedIdentityError,
} from "../../core/coordinator/authentication/did_document.js";
import type { IdentityConfig } from "../../core/coordinator/config/identity_config.js";
import { createMemoryStores } from "../../core/coordinator/data/memory_stores.js";
import { systemClock } from "../../core/coordinator/library/clock.js";
import {
	type CoordinatorConfigs,
	DEFAULT_COORDINATOR_CONFIGS,
	main,
} from "../../core/coordinator/main.js";
import { CoordinatorApiHandlers } from "../../core/coordinator/runtime/api_handlers.js";
import {
	type RunningXrpcServer,
	startXrpcServer,
} from "../../core/coordinator/runtime/xrpc_server.js";
import {
	type LocalHivemindPds,
	startLocalHivemindPds,
} from "../../core/hivemind_pds/start_local.js";
import {
	PdsGateway,
	PdsSpaceAuthority,
} from "../../core/protocol/communication/network/at_gateway_pds.js";
import type { RecordChange } from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type { CoordinatorApi } from "../../core/protocol/interfaces/internal/coordinator_api.js";
import type {
	Did,
	SpaceRef,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	INTAKE_SPACE_KEY,
	SPACE_TYPES,
} from "../../core/protocol/protocol_config/space_definition.js";
import { eventually, loadPolicy } from "../gateway/gateway_contract.js";
import { rideRequest, taskIdFor } from "./fixtures.js";

// The coordinator's DID entries on a real PDS and PLC directory (@atproto/dev-env, frozen Spaces
// alpha): the coordinator refuses to start without them, and with them the PDS reaches the
// coordinator's XRPC server to decide who may write to a managed space. About half a minute.

const PASSWORD = "password";
const REGISTER = "com.hivemind-network.coordinator.register";
const REQUEST = "com.hivemind-network.requester.request";
// Polling fast keeps the test short; the default is 2 s
const POLL_INTERVAL_MS = 100;

// The variables main() reads the secrets from; test names, so nothing real is touched
const TEST_ENVIRONMENT = {
	accountPasswordVariable: "HIVEMIND_TEST_ACCOUNT_PASSWORD",
	attestationKeyVariable: "HIVEMIND_TEST_ATTESTATION_KEY",
};

async function attestationKey(): Promise<{ hex: string; didKey: string }> {
	const keypair = await P256Keypair.create({ exportable: true });
	return {
		hex: Buffer.from(await keypair.export()).toString("hex"),
		didKey: keypair.did(),
	};
}

// The production identity config, pointed at the local PDS
function localIdentity(
	local: LocalHivemindPds,
	serviceUrl: string,
): IdentityConfig {
	return {
		...DEFAULT_COORDINATOR_CONFIGS.identity,
		accountIdentifier: "coordinator.test",
		pdsUrl: local.pdsUrl,
		plcUrl: local.plcUrl,
		serviceUrl,
	};
}

async function createAccount(
	local: LocalHivemindPds,
	name: string,
): Promise<AtpAgent> {
	const agent = new AtpAgent({ service: local.pdsUrl });
	await agent.createAccount({
		handle: `${name}.test`,
		email: `${name}@test.invalid`,
		password: PASSWORD,
	});
	return agent;
}

describe("coordinator identity: not yet published", () => {
	let local: LocalHivemindPds;
	let dataFolder: string;

	before(async () => {
		local = await startLocalHivemindPds(PASSWORD);
		dataFolder = mkdtempSync(path.join(tmpdir(), "hivemind-identity-"));
	});

	after(async () => {
		delete process.env[TEST_ENVIRONMENT.accountPasswordVariable];
		delete process.env[TEST_ENVIRONMENT.attestationKeyVariable];
		await local?.close();
		rmSync(dataFolder, { recursive: true, force: true });
	});

	test("the coordinator refuses to start, naming both missing entries", {
		timeout: 60_000,
	}, async () => {
		const key = await attestationKey();
		process.env[TEST_ENVIRONMENT.accountPasswordVariable] = PASSWORD;
		process.env[TEST_ENVIRONMENT.attestationKeyVariable] = key.hex;
		const configs: CoordinatorConfigs = {
			...DEFAULT_COORDINATOR_CONFIGS,
			identity: localIdentity(local, "http://localhost:2590"),
			runtime: { ...DEFAULT_COORDINATOR_CONFIGS.runtime, xrpcPort: 0 },
			data: { databasePath: path.join(dataFolder, "coordinator.sqlite") },
			environment: TEST_ENVIRONMENT,
		};

		await assert.rejects(main(configs), (error) => {
			assert.ok(error instanceof UnpublishedIdentityError);
			assert.equal(error.coordinator, local.coordinatorDid);
			assert.equal(error.problems.length, 2);
			return true;
		});
	});
});

describe("coordinator identity: published with a PLC update", () => {
	let local: LocalHivemindPds;
	let server: RunningXrpcServer;
	let identity: IdentityConfig;
	let attestationDidKey: string;
	let didResolver: IdResolver;
	let intake: SpaceRef;
	// What the coordinator saw in its request intake, and the access decisions it was asked for
	const intakeChanges: RecordChange[] = [];
	const decisions: Array<{ user: Did; allowed: boolean }> = [];
	const stopWatches: Array<() => void> = [];

	before(async () => {
		local = await startLocalHivemindPds(PASSWORD);
		const coordinator = local.coordinatorDid;
		didResolver = new IdResolver({ plcUrl: local.plcUrl });

		// 1. The coordinator's XRPC server, recording each access decision it makes
		const handlers = new CoordinatorApiHandlers({
			coordinator,
			stores: createMemoryStores(coordinator),
			gateway: { getRecord: async () => undefined },
			clock: systemClock,
		});
		const api: CoordinatorApi = {
			register: (caller, input) => handlers.register(caller, input),
			setFeedMember: (caller, input) => handlers.setFeedMember(caller, input),
			checkUserAccess: async (space, user, access) => {
				const allowed = await handlers.checkUserAccess(space, user, access);
				decisions.push({ user, allowed });
				return allowed;
			},
		};
		server = await startXrpcServer({
			api,
			coordinator,
			serviceFragment: DEFAULT_COORDINATOR_CONFIGS.identity.serviceFragment,
			resolveSigningKey: (did, forceRefresh) =>
				didResolver.did.resolveAtprotoKey(did, forceRefresh),
			clock: systemClock,
			// Any free port
			port: 0,
		});

		// 2. Its DID entries, pointing at that server
		identity = localIdentity(local, `http://localhost:${server.port}`);
		attestationDidKey = (await attestationKey()).didKey;
		await local.publishCoordinatorIdentity(
			attestationDidKey,
			identity.serviceUrl,
		);

		// 3. The request intake, watched as the coordinator watches it
		intake = await new PdsSpaceAuthority(local.coordinatorAgent).createSpace(
			SPACE_TYPES.requestIntake,
			INTAKE_SPACE_KEY,
			await loadPolicy("request_intake.json", coordinator),
		);
		const gateway = new PdsGateway({
			agent: local.coordinatorAgent,
			didResolver,
			firehoseService: local.pdsUrl.replace(/^http/, "ws"),
			pollIntervalMs: POLL_INTERVAL_MS,
			onError: (error) => console.error("Background error:", error),
		});
		stopWatches.push(
			await gateway.watchSpace(intake, (change) => intakeChanges.push(change)),
		);
	});

	after(async () => {
		for (const stop of stopWatches) {
			stop();
		}
		await server?.close();
		await local?.close();
	});

	// A request written into the account's own repo; its PDS then notifies the intake's host
	async function writeRequest(agent: AtpAgent, name: string): Promise<void> {
		await agent.com.atproto.space.putRecord({
			space: intake,
			repo: agent.assertDid,
			collection: REQUEST,
			rkey: name,
			record: rideRequest(taskIdFor(name)),
		});
	}

	test("the PLC directory serves both entries", async () => {
		const published = await didResolver.did.resolve(local.coordinatorDid, true);
		assert.deepEqual(
			identityProblems(published, identity, attestationDidKey),
			[],
		);
	});

	test("a registered requester's request reaches the coordinator", async () => {
		// 1. The rider registers, with a service token its PDS issues
		const rider = await createAccount(local, "rider");
		const { data } = await rider.com.atproto.server.getServiceAuth({
			aud: local.coordinatorDid,
			lxm: REGISTER,
		});
		const response = await fetch(
			`http://127.0.0.1:${server.port}/xrpc/${REGISTER}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${data.token}`,
				},
				body: JSON.stringify({ role: "requester" }),
			},
		);
		assert.equal(response.status, 200);

		// 2. Its request: the PDS asks the coordinator, which allows it
		await writeRequest(rider, "rider-request");
		await eventually(() => {
			assert.ok(
				decisions.some(
					({ user, allowed }) => user === rider.assertDid && allowed,
				),
			);
			assert.ok(
				intakeChanges.some(
					(change) =>
						change.author === rider.assertDid &&
						change.rkey === "rider-request",
				),
			);
		});
	});

	test("an unregistered account's request is refused", async () => {
		const stranger = await createAccount(local, "stranger");
		await writeRequest(stranger, "stranger-request");

		// The PDS asked, the coordinator said no, and the request never shows up in the intake
		await eventually(() => {
			assert.ok(
				decisions.some(
					({ user, allowed }) => user === stranger.assertDid && !allowed,
				),
			);
		});
		await new Promise((resolve) => setTimeout(resolve, 4 * POLL_INTERVAL_MS));
		assert.ok(
			!intakeChanges.some((change) => change.author === stranger.assertDid),
		);
	});
});
