import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import {
	buildDidDocument,
	type DidCredentials,
	hivemindDidEntries,
	identityProblems,
	type ResolvedDidDocument,
	withHivemindEntries,
} from "../../../core/coordinator/authentication/did_document.js";
import { DEFAULT_IDENTITY_CONFIG } from "../../../core/coordinator/config/identity_config.js";

// The coordinator's DID entries (ADR-006): what is added to the PDS's, and how a published
// document is checked at startup.

const identity = DEFAULT_IDENTITY_CONFIG;
const PDS_URL = "https://pds.hivemind-network.com";

let attestationDidKey: string;
let otherAttestationDidKey: string;
// As com.atproto.identity.getRecommendedDidCredentials returns them
let recommended: DidCredentials;

before(async () => {
	attestationDidKey = (await P256Keypair.create()).did();
	otherAttestationDidKey = (await P256Keypair.create()).did();
	recommended = {
		alsoKnownAs: ["at://hivemind-network.com"],
		rotationKeys: [(await Secp256k1Keypair.create()).did()],
		verificationMethods: {
			atproto: (await Secp256k1Keypair.create()).did(),
			atproto_kem: (await P256Keypair.create()).did(),
		},
		services: {
			atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: PDS_URL },
		},
	};
});

// A resolved document with key ids that carry the DID and service ids that do not, as some PLC
// directories serve them. The older key encoding of dev-env's PLC directory is covered by
// tests/coordinator/published_identity.test.ts.
function resolvedDocument(
	attestationKey: string | undefined,
	serviceEndpoint: string | undefined,
): ResolvedDidDocument {
	const did = "did:plc:coordinator";
	return {
		verificationMethod: [
			{
				id: `${did}#atproto`,
				type: "Multikey",
				publicKeyMultibase: "zQ3shAtprotoKey",
			},
			...(attestationKey === undefined
				? []
				: [
						{
							id: `${did}#hivemind_attestation`,
							type: "Multikey",
							publicKeyMultibase: attestationKey.replace("did:key:", ""),
						},
					]),
		],
		service: [
			{ id: "#atproto_pds", serviceEndpoint: PDS_URL },
			...(serviceEndpoint === undefined
				? []
				: [{ id: "#hivemind_coordinator", serviceEndpoint }]),
		],
	};
}

describe("DID entries", () => {
	test("Hivemind adds the attestation key and the coordinator service", () => {
		assert.deepEqual(hivemindDidEntries(identity, attestationDidKey), {
			verificationMethods: { hivemind_attestation: attestationDidKey },
			services: {
				hivemind_coordinator: {
					type: "HivemindCoordinator",
					endpoint: identity.serviceUrl,
				},
			},
		});
	});

	test("the PDS's entries are kept, as a PLC update replaces the whole lists", () => {
		const merged = withHivemindEntries(
			recommended,
			hivemindDidEntries(identity, attestationDidKey),
		);
		assert.deepEqual(Object.keys(merged.verificationMethods ?? {}).sort(), [
			"atproto",
			"atproto_kem",
			"hivemind_attestation",
		]);
		assert.deepEqual(Object.keys(merged.services ?? {}).sort(), [
			"atproto_pds",
			"hivemind_coordinator",
		]);
		assert.deepEqual(merged.rotationKeys, recommended.rotationKeys);
		// The input stays as it was
		assert.equal(Object.keys(recommended.verificationMethods ?? {}).length, 2);
	});

	test("the did:web document carries every entry as Multikey and service", () => {
		const document = buildDidDocument(identity, recommended, attestationDidKey);
		assert.equal(document.id, "did:web:hivemind-network.com");
		assert.deepEqual(document.alsoKnownAs, ["at://hivemind-network.com"]);

		const attestation = document.verificationMethod.find(
			({ id }) => id === "did:web:hivemind-network.com#hivemind_attestation",
		);
		assert.ok(attestation);
		assert.equal(attestation.type, "Multikey");
		assert.equal(attestation.controller, "did:web:hivemind-network.com");
		assert.equal(
			attestation.publicKeyMultibase,
			attestationDidKey.replace("did:key:", ""),
		);
		assert.deepEqual(document.service.map(({ id }) => id).sort(), [
			"#atproto_pds",
			"#hivemind_coordinator",
		]);
		assert.deepEqual(
			identityProblems(document, identity, attestationDidKey),
			[],
		);
	});
});

describe("checking the published document", () => {
	test("a complete document has no problems", () => {
		assert.deepEqual(
			identityProblems(
				resolvedDocument(attestationDidKey, identity.serviceUrl),
				identity,
				attestationDidKey,
			),
			[],
		);
	});

	test("a document the coordinator cannot resolve is one problem", () => {
		assert.equal(identityProblems(null, identity, attestationDidKey).length, 1);
	});

	test("a document with only the PDS's entries misses both of ours", () => {
		const problems = identityProblems(
			resolvedDocument(undefined, undefined),
			identity,
			attestationDidKey,
		);
		assert.equal(problems.length, 2);
		assert.match(problems[0] ?? "", /#hivemind_attestation is missing/);
		assert.match(problems[1] ?? "", /#hivemind_coordinator is missing/);
	});

	test("a rotated attestation key that was not republished is a problem", () => {
		const problems = identityProblems(
			resolvedDocument(otherAttestationDidKey, identity.serviceUrl),
			identity,
			attestationDidKey,
		);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /#hivemind_attestation/);
	});

	test("a coordinator service pointing elsewhere is a problem", () => {
		const problems = identityProblems(
			resolvedDocument(attestationDidKey, "https://old.example.com"),
			identity,
			attestationDidKey,
		);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /old\.example\.com/);
	});
});
