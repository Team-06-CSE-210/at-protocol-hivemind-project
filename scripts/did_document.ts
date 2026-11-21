/*
 * Builds the coordinator's did:web document for production (ADR-006).
 *
 * Logs in as the coordinator account, takes the keys and services the Hivemind PDS keeps for
 * it (com.atproto.identity.getRecommendedDidCredentials), adds #hivemind_attestation and
 * #hivemind_coordinator, and writes the result. The team's web host then serves it at
 * https://<webDomain>/.well-known/did.json. Run it again after rotating the attestation key or
 * moving the coordinator's XRPC server; the coordinator refuses to start until both entries
 * match (core/coordinator/main.ts).
 *
 * Both secrets come from the environment (core/coordinator/config/environment_config.ts):
 *   HIVEMIND_ACCOUNT_PASSWORD=... HIVEMIND_ATTESTATION_KEY=... \
 *   node dist/scripts/did_document.js [output file, default: stdout]
 *
 * Run with: npm run build && node dist/scripts/did_document.js did.json
 */
import { writeFileSync } from "node:fs";
import { P256Keypair } from "@atproto/crypto";
import { logInCoordinator } from "../core/coordinator/authentication/account_session.js";
import {
	buildDidDocument,
	coordinatorDid,
	type DidCredentials,
} from "../core/coordinator/authentication/did_document.js";
import { DEFAULT_ENVIRONMENT_CONFIG } from "../core/coordinator/config/environment_config.js";
import { DEFAULT_IDENTITY_CONFIG } from "../core/coordinator/config/identity_config.js";
import { readSecrets } from "../core/coordinator/library/environment.js";

const identity = DEFAULT_IDENTITY_CONFIG;
const outputPath = process.argv[2];

// 1. Secrets, and the account the document is for
const { accountPassword, attestationKeyHex } = readSecrets(
	DEFAULT_ENVIRONMENT_CONFIG,
);
const agent = await logInCoordinator(identity, accountPassword);
const expected = coordinatorDid(identity);
if (agent.assertDid !== expected) {
	throw new Error(
		`Logged in as ${agent.assertDid}, but the document is for ${expected}`,
	);
}

// 2. The PDS's entries plus Hivemind's
const attestationKey = await P256Keypair.import(attestationKeyHex);
const { data: recommended } =
	await agent.com.atproto.identity.getRecommendedDidCredentials();
const document = buildDidDocument(
	identity,
	recommended as DidCredentials,
	attestationKey.did(),
);

// 3. Out: public keys and URLs only, nothing secret
const json = `${JSON.stringify(document, null, "\t")}\n`;
if (outputPath === undefined) {
	process.stdout.write(json);
} else {
	writeFileSync(outputPath, json);
	console.error(
		`Wrote ${outputPath}; serve it at https://${identity.webDomain}/.well-known/did.json`,
	);
}
