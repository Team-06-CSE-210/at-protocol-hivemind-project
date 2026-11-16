/*
 * Creates the coordinator's account on the Hivemind PDS with its own did:web. Uses only the PDS's
 * HTTP API and its admin password, so it works the same against dev-env and a PDS in Docker.
 *
 * This is how atproto brings an existing DID to a PDS:
 *   1. publish a first did.json with a key we hold, so we can prove we control the DID;
 *   2. createAccount with that DID, an invite code and a service auth token signed by that key;
 *      the PDS creates the account deactivated, with a signing key and a MAC key of its own;
 *   3. ask the PDS which keys and services the document must show
 *      (getRecommendedDidCredentials), add the two Hivemind entries and publish the document;
 *   4. activateAccount: the PDS checks that the document names it and its signing key.
 */
import { randomBytes } from "node:crypto";
import {
	buildDidDocument,
	type DidDocumentHost,
	type ServiceEntry,
} from "./did_document.ts";
import { generateP256Key, signEs256Jwt } from "./keys.ts";
import {
	ATTESTATION_KEY_ID,
	COORDINATOR_HANDLE,
	COORDINATOR_SERVICE_ID,
	COORDINATOR_SERVICE_TYPE,
	type CoordinatorAccount,
	HIVEMIND_HANDLE_DOMAIN,
} from "./network.ts";
import { expectOk, xrpc } from "./xrpc.ts";

/* A PDS we administer: its address and admin password (PDS_ADMIN_PASSWORD). */
export type PdsAdmin = { url: string; adminPassword: string };

export async function createInviteCode(
	pds: PdsAdmin,
	useCount = 1,
): Promise<string> {
	const reply = await xrpc(pds.url, "com.atproto.server.createInviteCode", {
		body: { useCount },
		headers: {
			authorization: `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString("base64")}`,
		},
	});
	return String(expectOk(reply, "createInviteCode").code);
}

export async function createCoordinatorAccount(
	pds: PdsAdmin,
	host: DidDocumentHost,
): Promise<CoordinatorAccount> {
	const { did, url } = host;

	// 1. A first did.json with a key we hold
	const setupKey = generateP256Key();
	host.setDocument(
		buildDidDocument({
			did,
			alsoKnownAs: [`at://${COORDINATOR_HANDLE}`],
			verificationMethods: { atproto: setupKey.didKey },
			services: {},
		}),
	);

	// 2. createAccount, proving control of the DID with a service auth token
	const server = expectOk(
		await xrpc(pds.url, "com.atproto.server.describeServer"),
		"describeServer",
	);
	const now = Math.floor(Date.now() / 1000);
	const password = randomBytes(16).toString("hex");
	const account = expectOk(
		await xrpc(pds.url, "com.atproto.server.createAccount", {
			token: signEs256Jwt(setupKey, {
				iss: did,
				aud: server.did,
				lxm: "com.atproto.server.createAccount",
				iat: now,
				exp: now + 60,
				jti: randomBytes(16).toString("hex"),
			}),
			body: {
				did,
				handle: COORDINATOR_HANDLE,
				email: `coordinator@${HIVEMIND_HANDLE_DOMAIN.slice(1)}`,
				password,
				inviteCode: await createInviteCode(pds),
			},
		}),
		"createAccount (coordinator)",
	);
	const token = String(account.accessJwt);

	// 3. The final did.json: what the PDS recommends plus the two Hivemind entries
	const recommended = expectOk(
		await xrpc(pds.url, "com.atproto.identity.getRecommendedDidCredentials", {
			token,
		}),
		"getRecommendedDidCredentials",
	) as {
		alsoKnownAs: string[];
		verificationMethods: Record<string, string>;
		services: Record<string, ServiceEntry>;
	};
	const attestationKey = generateP256Key();
	host.setDocument(
		buildDidDocument({
			did,
			alsoKnownAs: recommended.alsoKnownAs,
			verificationMethods: {
				...recommended.verificationMethods,
				[ATTESTATION_KEY_ID]: attestationKey.didKey,
			},
			services: {
				...recommended.services,
				[COORDINATOR_SERVICE_ID]: {
					type: COORDINATOR_SERVICE_TYPE,
					endpoint: url,
				},
			},
		}),
	);

	// 4. activateAccount: the PDS re-reads did.json and checks it
	expectOk(
		await xrpc(pds.url, "com.atproto.server.activateAccount", {
			method: "POST",
			token,
		}),
		"activateAccount (coordinator)",
	);

	return { did, handle: COORDINATOR_HANDLE, password, url, attestationKey };
}
