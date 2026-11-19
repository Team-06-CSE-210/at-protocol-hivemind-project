import { P256Keypair } from "@atproto/crypto";
import { encode } from "@atproto/lex-cbor";
import type { AttestationSigner } from "../../protocol/interfaces/internal/attestation.js";
import type {
	Assignment,
	Attestation,
} from "../../protocol/interfaces/internal/types.js";

// Signs assignments with the coordinator's #hivemind_attestation key, by the rule in
// com.hivemind-network.defs#attestation: ES256 (P-256, compact, low-S) over SHA-256 of the
// DAG-CBOR encoding of the assignment without its attestation field.
// The private key comes from library/environment.ts; its public half is in the DID document.

export type UnsignedAssignment = Omit<Assignment, "attestation">;

// DID URL of the signing key, e.g. did:web:hivemind-network.com#hivemind_attestation
export type AttestationKeyId = Attestation["keyId"];

// The exact bytes the attestation covers. The SDK's verifier must encode the same way.
export function attestedBytes(assignment: UnsignedAssignment): Uint8Array {
	return encode(assignment as Parameters<typeof encode>[0]);
}

export class P256AttestationSigner implements AttestationSigner {
	private constructor(
		private readonly keypair: P256Keypair,
		private readonly keyId: AttestationKeyId,
	) {}

	// privateKeyHex: the 32-byte P-256 private key, hex encoded
	static async fromPrivateKeyHex(
		privateKeyHex: string,
		keyId: AttestationKeyId,
	): Promise<P256AttestationSigner> {
		const keypair = await P256Keypair.import(privateKeyHex);
		return new P256AttestationSigner(keypair, keyId);
	}

	// did:key of the public half, for the DID document
	publicDidKey(): string {
		return this.keypair.did();
	}

	// P256Keypair.sign hashes with SHA-256 and returns a compact low-S signature
	async sign(assignment: UnsignedAssignment): Promise<Attestation> {
		const signature = await this.keypair.sign(attestedBytes(assignment));
		return { keyId: this.keyId, signature };
	}
}
