/*
 * Generates a P-256 key for signing assignments (#hivemind_attestation, ADR-006).
 *
 * Prints the private key (hex) on stdout and its did:key on stderr, so the private key can go
 * straight into a secret store without passing through a terminal log:
 *   node dist/scripts/generate_attestation_key.js > attestation.key
 * Store it as HIVEMIND_ATTESTATION_KEY; never commit it. The did:key is the public half that
 * the DID document publishes. A new key needs a new DID document (scripts/did_document.ts).
 *
 * Run with: npm run build && node dist/scripts/generate_attestation_key.js
 */
import { P256Keypair } from "@atproto/crypto";

const keypair = await P256Keypair.create({ exportable: true });
const privateKeyHex = Buffer.from(await keypair.export()).toString("hex");

process.stdout.write(`${privateKeyHex}\n`);
process.stderr.write(`Public key (did:key): ${keypair.did()}\n`);
