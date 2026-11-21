import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../../core/coordinator/library/clock.js";
import { CoordinatorApiHandlers } from "../../../core/coordinator/runtime/api_handlers.js";
import { PublicIndexer } from "../../../core/coordinator/runtime/public_indexer.js";
import {
	type RunningXrpcServer,
	startXrpcServer,
	type XrpcServerOptions,
} from "../../../core/coordinator/runtime/xrpc_server.js";
import type { Did } from "../../../core/protocol/interfaces/internal/types.js";
import { requestIntakeSpaceRef } from "../../../core/protocol/protocol_config/space_definition.js";
import { epochSeconds, serviceJwt } from "../authentication/service_jwt.js";
import { COORDINATOR, FakeSpaceService, RIDER, START } from "../fixtures.js";

// The coordinator's XRPC server over real HTTP: authentication, input checks, error mapping.

const REGISTER = "com.hivemind-network.coordinator.register";
const CHECK_USER_ACCESS = "com.atproto.managedspace.checkUserAccess";

let server: RunningXrpcServer;
const keys = new Map<Did, Secp256k1Keypair>();

const clock = new ManualClock(START);

function serverOptions(): XrpcServerOptions {
	const stores = createMemoryStores(COORDINATOR);
	return {
		api: new CoordinatorApiHandlers({
			coordinator: COORDINATOR,
			stores,
			gateway: { getRecord: async () => undefined },
			indexer: new PublicIndexer({
				gateway: { watchPublic: async () => () => {} },
				publicIndex: stores.publicIndex,
				spaces: new FakeSpaceService(),
			}),
			clock,
		}),
		coordinator: COORDINATOR,
		serviceFragment: "hivemind_coordinator",
		resolveSigningKey: async (did) => keys.get(did)?.did() ?? "",
		clock,
		// Any free port
		port: 0,
	};
}

before(async () => {
	keys.set(RIDER, await Secp256k1Keypair.create());
	keys.set(COORDINATOR, await Secp256k1Keypair.create());
	server = await startXrpcServer(serverOptions());
});

after(() => server.close());

async function tokenFor(caller: Did, method: string): Promise<string> {
	const keypair = keys.get(caller);
	assert.ok(keypair);
	return serviceJwt(keypair, {
		iss: caller,
		aud: COORDINATOR,
		lxm: method,
		exp: epochSeconds(START) + 60,
	});
}

async function call(path: string, init: RequestInit = {}) {
	const response = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

async function register(caller: Did, input: object, token?: string) {
	return call(`/xrpc/${REGISTER}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token ?? (await tokenFor(caller, REGISTER))}`,
		},
		body: JSON.stringify(input),
	});
}

describe("XRPC server", () => {
	test("register answers an authenticated call with the registration", async () => {
		const { status, body } = await register(RIDER, { role: "requester" });
		assert.equal(status, 200);
		assert.equal(body.subject, RIDER);
		assert.equal(body.status, "active");
	});

	test("refusals keep the lexicon's error names", async () => {
		const unauthenticated = await call(`/xrpc/${REGISTER}`, {
			method: "POST",
			body: "{}",
		});
		assert.equal(unauthenticated.status, 401);
		assert.equal(unauthenticated.body.error, "AuthMissing");

		const wrongMethod = await register(
			RIDER,
			{ role: "requester" },
			await tokenFor(RIDER, CHECK_USER_ACCESS),
		);
		assert.equal(wrongMethod.status, 401);
		assert.equal(wrongMethod.body.error, "BadJwtLexiconMethod");

		const invalidInput = await register(RIDER, { subject: RIDER });
		assert.equal(invalidInput.status, 400);
		assert.equal(invalidInput.body.error, "InvalidRequest");

		// The rider is a requester (registering again changes nothing), so operator conflicts
		assert.equal((await register(RIDER, { role: "requester" })).status, 200);
		const conflict = await register(RIDER, { role: "operator" });
		assert.equal(conflict.status, 400);
		assert.equal(conflict.body.error, "RoleConflict");

		const unknown = await call("/xrpc/com.example.unknown");
		assert.equal(unknown.status, 501);
	});

	test("checkUserAccess is answered for the coordinator's own PDS only", async () => {
		// The rider must be an active requester; registering again changes nothing
		const registration = await register(RIDER, { role: "requester" });
		assert.equal(registration.status, 200);

		const query = new URLSearchParams({
			space: requestIntakeSpaceRef(COORDINATOR),
			user: RIDER,
			access: "write",
		});
		const ask = async (caller: Did) =>
			call(`/xrpc/${CHECK_USER_ACCESS}?${query}`, {
				headers: {
					authorization: `Bearer ${await tokenFor(caller, CHECK_USER_ACCESS)}`,
				},
			});

		const fromRider = await ask(RIDER);
		assert.equal(fromRider.status, 403);

		const fromAuthority = await ask(COORDINATOR);
		assert.equal(fromAuthority.status, 200);
		assert.deepEqual(fromAuthority.body, { authorized: true });
	});

	test("the scheme name Bearer is matched in any case", async () => {
		const token = await tokenFor(RIDER, REGISTER);
		const response = await call(`/xrpc/${REGISTER}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `bearer ${token}`,
			},
			body: JSON.stringify({ role: "requester" }),
		});
		assert.equal(response.status, 200);
	});

	test("a port in use fails the start instead of crashing the process", async () => {
		await assert.rejects(
			startXrpcServer({ ...serverOptions(), port: server.port }),
			(error: NodeJS.ErrnoException) => {
				assert.equal(error.code, "EADDRINUSE");
				return true;
			},
		);
	});
});
