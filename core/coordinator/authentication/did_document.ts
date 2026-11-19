import type { Did } from "../../protocol/interfaces/internal/types.js";
import type { IdentityConfig } from "../config/identity_config.js";

// The coordinator's did:web document, served at https://<webDomain>/.well-known/did.json.
// It combines what the PDS recommends for the account (com.atproto.identity.
// getRecommendedDidCredentials) with what Hivemind adds: the attestation key and the
// coordinator service that managed spaces call for checkUserAccess.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The parts of getRecommendedDidCredentials' output a did:web uses (rotationKeys are PLC only)
export interface RecommendedCredentials {
	alsoKnownAs?: string[];
	verificationMethods?: Record<string, unknown>;
	services?: Record<string, unknown>;
}

interface VerificationMethod {
	id: string;
	type: "Multikey";
	controller: Did;
	publicKeyMultibase: string;
}

interface ServiceEntry {
	id: string;
	type: string;
	serviceEndpoint: string;
}

export interface DidDocument {
	"@context": string[];
	id: Did;
	alsoKnownAs: string[];
	verificationMethod: VerificationMethod[];
	service: ServiceEntry[];
}

// DID core and Multikey contexts, as atproto DID documents use them (atproto.com/specs/did)
const DID_CONTEXTS = [
	"https://www.w3.org/ns/did/v1",
	"https://w3id.org/security/multikey/v1",
];

// Service type of the coordinator entry; our own name, atproto only resolves the fragment
const COORDINATOR_SERVICE_TYPE = "HivemindCoordinator";

const DID_KEY_PREFIX = "did:key:";

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Building
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The production DID; locally the coordinator is whatever account it logs in as (a did:plc)
export function coordinatorDid(config: IdentityConfig): Did {
	return `did:web:${config.webDomain}`;
}

// DID URL of the attestation key; assignments name it as attestation.keyId
export function attestationKeyId(
	coordinator: Did,
	config: IdentityConfig,
): `${Did}#${string}` {
	return `${coordinator}#${config.attestationKeyFragment}`;
}

// Service identifier the managed spaces name as managing app, e.g.
// did:web:hivemind-network.com#hivemind_coordinator
export function coordinatorServiceId(
	coordinator: Did,
	config: IdentityConfig,
): `${Did}#${string}` {
	return `${coordinator}#${config.serviceFragment}`;
}

// attestationDidKey: did:key of the attestation key (P256AttestationSigner.publicDidKey)
export function buildDidDocument(
	config: IdentityConfig,
	recommended: RecommendedCredentials,
	attestationDidKey: string,
): DidDocument {
	const did = coordinatorDid(config);

	// 1. Keys: the PDS's (atproto, signs the repo and service tokens) and ours (attestation)
	const recommendedKeys = Object.entries(recommended.verificationMethods ?? {});
	const keyEntries: Array<[string, string]> = [
		...recommendedKeys.map(([fragment, didKey]): [string, string] => [
			fragment,
			String(didKey),
		]),
		[config.attestationKeyFragment, attestationDidKey],
	];
	const verificationMethod = keyEntries.map(([fragment, didKey]) => ({
		id: `${did}#${fragment}`,
		type: "Multikey" as const,
		controller: did,
		publicKeyMultibase: didKey.replace(DID_KEY_PREFIX, ""),
	}));

	// 2. Services: the PDS (atproto_pds) and the coordinator
	const recommendedServices = Object.entries(recommended.services ?? {}).map(
		([fragment, entry]) => {
			const { type, endpoint } = entry as { type: string; endpoint: string };
			return { id: `#${fragment}`, type, serviceEndpoint: endpoint };
		},
	);
	const service = [
		...recommendedServices,
		{
			id: `#${config.serviceFragment}`,
			type: COORDINATOR_SERVICE_TYPE,
			serviceEndpoint: config.serviceUrl,
		},
	];

	return {
		"@context": DID_CONTEXTS,
		id: did,
		alsoKnownAs: recommended.alsoKnownAs ?? [`at://${config.webDomain}`],
		verificationMethod,
		service,
	};
}
