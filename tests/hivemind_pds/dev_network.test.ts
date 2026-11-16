/*
 * The local atproto network (services/hivemind_pds/dev_network.ts) and Spaces on it.
 *
 * Checks the PDS setup against the project docs: the Hivemind PDS is invite-only, the coordinator
 * is a did:web whose DID document carries the entries from ADR-001, and the task space policy from
 * protocol/type_definition/policy_types/task.json works across PDSes: the coordinator creates the
 * space on the Hivemind PDS, only members get a space credential, and the winning agent, whose
 * account lives on the operator PDS, can be added at assignment.
 *
 * The tests use only HivemindNetwork (URLs, coordinator account, invite codes), so they can run
 * unchanged against a network started some other way, e.g. in Docker.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startDevNetwork } from "../../services/hivemind_pds/dev_network.ts";
import type { DidDocument } from "../../services/hivemind_pds/did_document.ts";
import { generateP256Key } from "../../services/hivemind_pds/keys.ts";
import {
	ATTESTATION_KEY_ID,
	COORDINATOR_SERVICE_ID,
	COORDINATOR_SERVICE_TYPE,
	HIVEMIND_HANDLE_DOMAIN,
	type HivemindNetwork,
	OPERATOR_HANDLE_DOMAIN,
} from "../../services/hivemind_pds/network.ts";
import {
	expectOk,
	type Json,
	type XrpcReply,
	xrpc,
} from "../../services/hivemind_pds/xrpc.ts";

/* An account and the PDS that hosts it. */
type Account = { did: string; token: string; pdsUrl: string };

const taskSpaceType = JSON.parse(
	readFileSync(
		join(
			import.meta.dirname,
			"../../protocol/type_definition/policy_types/task.json",
		),
		"utf8",
	),
) as { spaceType: string; policy: Json };

describe("local atproto network", () => {
	let network: HivemindNetwork;
	let coordinator: Account;
	let rider: Account;
	let agent: Account;
	let taskSpace: string;
	const taskId = newTaskId();

	before(async () => {
		network = await startDevNetwork();
		const session = expectOk(
			await xrpc(network.hivemindPdsUrl, "com.atproto.server.createSession", {
				body: {
					identifier: network.coordinator.handle,
					password: network.coordinator.password,
				},
			}),
			"createSession (coordinator)",
		);
		coordinator = {
			did: network.coordinator.did,
			token: String(session.accessJwt),
			pdsUrl: network.hivemindPdsUrl,
		};
		rider = await createAccount(
			network.hivemindPdsUrl,
			"rider",
			HIVEMIND_HANDLE_DOMAIN,
			await network.createInviteCode(),
		);
		agent = await createAccount(
			network.operatorPdsUrl,
			"robotaxi",
			OPERATOR_HANDLE_DOMAIN,
		);
	});

	after(async () => {
		await network?.close();
	});

	test("both PDSes run the spaces alpha; only the Hivemind PDS needs invite codes", async () => {
		for (const [url, domain, inviteRequired] of [
			[network.hivemindPdsUrl, HIVEMIND_HANDLE_DOMAIN, true],
			[network.operatorPdsUrl, OPERATOR_HANDLE_DOMAIN, false],
		] as const) {
			const server = expectOk(
				await xrpc(url, "com.atproto.server.describeServer"),
				"describeServer",
			);
			assert.equal(server.spacesAlpha, true);
			assert.deepEqual(server.availableUserDomains, [domain]);
			assert.equal(server.inviteCodeRequired, inviteRequired);
		}
		const withoutInvite = await xrpc(
			network.hivemindPdsUrl,
			"com.atproto.server.createAccount",
			{
				body: {
					handle: `nobody${HIVEMIND_HANDLE_DOMAIN}`,
					email: "nobody@example.com",
					password: randomBytes(16).toString("hex"),
				},
			},
		);
		assert.equal(withoutInvite.status, 400);
		assert.equal(withoutInvite.body.error, "InvalidInviteCode");
	});

	test("the coordinator is a did:web whose document has the ADR-001 entries", async () => {
		assert.match(coordinator.did, /^did:web:localhost%3A\d+$/);
		const response = await fetch(
			`${network.coordinator.url}/.well-known/did.json`,
		);
		assert.equal(response.status, 200);
		const doc = (await response.json()) as DidDocument;
		const keys = new Map(
			doc.verificationMethod.map((m) => [
				m.id.slice(coordinator.did.length + 1),
				`did:key:${m.publicKeyMultibase}`,
			]),
		);
		const services = new Map(doc.service.map((s) => [s.id.slice(1), s]));

		// #atproto, #atproto_kem and #atproto_pds exactly as the PDS recommends them
		const recommended = expectOk(
			await xrpc(
				coordinator.pdsUrl,
				"com.atproto.identity.getRecommendedDidCredentials",
				{ token: coordinator.token },
			),
			"getRecommendedDidCredentials",
		) as { verificationMethods: Record<string, string> };
		assert.equal(keys.get("atproto"), recommended.verificationMethods.atproto);
		assert.equal(
			keys.get("atproto_kem"),
			recommended.verificationMethods.atproto_kem,
		);
		assert.equal(
			services.get("atproto_pds")?.serviceEndpoint,
			network.hivemindPdsUrl,
		);
		// Added by Hivemind
		assert.equal(
			keys.get(ATTESTATION_KEY_ID),
			network.coordinator.attestationKey.didKey,
		);
		assert.equal(
			services.get(COORDINATOR_SERVICE_ID)?.type,
			COORDINATOR_SERVICE_TYPE,
		);
		assert.equal(
			services.get(COORDINATOR_SERVICE_ID)?.serviceEndpoint,
			network.coordinator.url,
		);
	});

	test("the coordinator creates a task space with the project's task policy", async () => {
		const created = expectOk(
			await xrpc(coordinator.pdsUrl, "com.atproto.space.createSpace", {
				token: coordinator.token,
				body: {
					spaceType: taskSpaceType.spaceType,
					skey: taskId,
					policy: taskSpaceType.policy,
				},
			}),
			"createSpace",
		);
		taskSpace = String(created.uri);
		assert.equal(
			taskSpace,
			`at://${coordinator.did}/space/${taskSpaceType.spaceType}/${taskId}`,
		);
	});

	test("only members get a space credential", async () => {
		await putMember(coordinator, taskSpace, rider);

		const forRider = await requestCredential(rider, taskSpace);
		assert.equal(forRider.status, 200, JSON.stringify(forRider.body));
		assert.equal(typeof forRider.body.credential, "string");

		// Not a member yet. The alpha answers as if the space did not exist.
		const forAgent = await requestCredential(agent, taskSpace);
		assert.equal(forAgent.status, 400);
		assert.equal(forAgent.body.error, "SpaceNotFound");
	});

	test("at assignment the agent from the operator PDS is added and gets a credential", async () => {
		await putMember(coordinator, taskSpace, agent);

		const forAgent = await requestCredential(agent, taskSpace);
		assert.equal(forAgent.status, 200, JSON.stringify(forAgent.body));
	});

	/*
	 * How a participant gets a space credential: its own PDS signs a delegation token for the
	 * space, and the space host (the Hivemind PDS) exchanges it for a credential bound to a key the
	 * participant holds.
	 */
	async function requestCredential(
		member: Account,
		space: string,
	): Promise<XrpcReply> {
		const delegation = expectOk(
			await xrpc(member.pdsUrl, "com.atproto.space.getDelegationToken", {
				params: { space },
				token: member.token,
			}),
			"getDelegationToken",
		);
		return xrpc(
			network.hivemindPdsUrl,
			"com.atproto.space.getSpaceCredential",
			{
				body: {
					space,
					credentialKid: generateP256Key().didKey,
					delegationToken: String(delegation.token),
				},
			},
		);
	}
});

async function createAccount(
	pdsUrl: string,
	name: string,
	handleDomain: string,
	inviteCode?: string,
): Promise<Account> {
	const id = `${name}-${randomBytes(4).toString("hex")}`;
	const account = expectOk(
		await xrpc(pdsUrl, "com.atproto.server.createAccount", {
			body: {
				handle: `${id}${handleDomain}`,
				email: `${id}@example.com`,
				password: randomBytes(16).toString("hex"),
				...(inviteCode ? { inviteCode } : {}),
			},
		}),
		`createAccount (${name})`,
	);
	return {
		did: String(account.did),
		token: String(account.accessJwt),
		pdsUrl,
	};
}

async function putMember(owner: Account, space: string, member: Account) {
	expectOk(
		await xrpc(owner.pdsUrl, "com.atproto.memberspace.putMember", {
			token: owner.token,
			body: { space, did: member.did, read: true, write: true },
		}),
		"putMember",
	);
}

/* Task ID as in network.hivemind.defs#taskId: 128 random bits, lowercase base32. */
function newTaskId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let bits = "";
	for (const byte of randomBytes(16)) bits += byte.toString(2).padStart(8, "0");
	let out = "";
	for (let i = 0; i < bits.length; i += 5) {
		out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
	}
	return out;
}

test("close() deletes the PDS data directories", async () => {
	const network = await startDevNetwork();
	const directories = Object.values(network.dataDirectories);
	for (const directory of directories) {
		assert.ok(existsSync(`${directory}/account.sqlite`), directory);
	}
	await network.close();
	for (const directory of directories) {
		assert.equal(existsSync(directory), false, directory);
	}
});
