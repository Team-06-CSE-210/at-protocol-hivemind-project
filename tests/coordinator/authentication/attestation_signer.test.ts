import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { P256Keypair, verifySignature } from "@atproto/crypto";
import {
	attestedBytes,
	P256AttestationSigner,
	type UnsignedAssignment,
} from "../../../core/coordinator/authentication/attestation_signer.js";
import {
	attestationKeyId,
	buildDidDocument,
	coordinatorServiceId,
} from "../../../core/coordinator/authentication/did_document.js";
import { DEFAULT_IDENTITY_CONFIG } from "../../../core/coordinator/config/identity_config.js";
import type { TypedObject } from "../../../core/protocol/interfaces/internal/types.js";
import {
	COORDINATOR,
	RIDER,
	rideOffer,
	rideRequest,
	TAXI_ONE,
	taskIdFor,
} from "../fixtures.js";

// The attestation rule (com.hivemind-network.defs#attestation) and the DID document that
// publishes the key.

const taskId = taskIdFor("attested");
const unsigned: UnsignedAssignment = {
	$type: "com.hivemind-network.coordinator.assignment",
	taskId,
	agent: TAXI_ONE,
	requester: RIDER,
	request: rideRequest(taskId).payload,
	terms: rideOffer(taskId, 120).payload as TypedObject,
	issuedAt: "2026-11-19T12:00:05.000Z",
};

async function newSigner() {
	const keypair = await P256Keypair.create({ exportable: true });
	const privateKeyHex = Buffer.from(await keypair.export()).toString("hex");
	const keyId = attestationKeyId(COORDINATOR, DEFAULT_IDENTITY_CONFIG);
	return P256AttestationSigner.fromPrivateKeyHex(privateKeyHex, keyId);
}

describe("attestation signer", () => {
	test("signs the DAG-CBOR bytes of the assignment with the published key", async () => {
		const signer = await newSigner();
		const attestation = await signer.sign(unsigned);

		assert.equal(attestation.keyId, `${COORDINATOR}#hivemind_attestation`);
		const valid = await verifySignature(
			signer.publicDidKey(),
			attestedBytes(unsigned),
			attestation.signature,
		);
		assert.equal(valid, true);
	});

	test("a changed assignment no longer matches the signature", async () => {
		const signer = await newSigner();
		const { signature } = await signer.sign(unsigned);
		const tampered = { ...unsigned, agent: "did:plc:someoneelse" as const };
		assert.equal(
			await verifySignature(
				signer.publicDidKey(),
				attestedBytes(tampered),
				signature,
			),
			false,
		);
	});
});

describe("DID document", () => {
	test("adds the attestation key and the coordinator service to the PDS's credentials", async () => {
		const signer = await newSigner();
		const document = buildDidDocument(
			DEFAULT_IDENTITY_CONFIG,
			{
				alsoKnownAs: ["at://hivemind-network.com"],
				verificationMethods: { atproto: "did:key:zQ3shatproto" },
				services: {
					atproto_pds: {
						type: "AtprotoPersonalDataServer",
						endpoint: "https://pds.hivemind-network.com",
					},
				},
			},
			signer.publicDidKey(),
		);

		assert.equal(document.id, "did:web:hivemind-network.com");
		assert.deepEqual(
			document.verificationMethod.map(({ id }) => id),
			[
				"did:web:hivemind-network.com#atproto",
				"did:web:hivemind-network.com#hivemind_attestation",
			],
		);
		assert.equal(
			document.verificationMethod[1].publicKeyMultibase,
			signer.publicDidKey().replace("did:key:", ""),
		);
		assert.deepEqual(document.service.at(-1), {
			id: "#hivemind_coordinator",
			type: "HivemindCoordinator",
			serviceEndpoint: "https://coordinator.hivemind-network.com",
		});
		assert.equal(
			coordinatorServiceId(document.id, DEFAULT_IDENTITY_CONFIG),
			"did:web:hivemind-network.com#hivemind_coordinator",
		);
	});
});
