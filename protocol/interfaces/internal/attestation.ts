import type { Assignment, Attestation, Did } from './types.js'

/*
 * Signing and checking assignments. The rule both sides must follow is in the description of
 * com.hivemind-network.defs#attestation: ES256 over the DAG-CBOR encoding of the assignment without
 * its attestation field.
 */

/** Owner: coordinator. Holds the #hivemind_attestation key. */
export interface AttestationSigner {
  sign(assignment: Omit<Assignment, 'attestation'>): Promise<Attestation>
}

/** Owner: client library. An agent acts only if this returns true. */
export interface AttestationVerifier {
  /** True if the attestation verifies against the key of one of the trusted coordinators. */
  verify(assignment: Assignment, trustedCoordinators: Did[]): Promise<boolean>
}
