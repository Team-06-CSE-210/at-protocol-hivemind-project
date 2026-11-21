import { getDidKeyFromMultibase } from "@atproto/identity";
import type { Did } from "../../protocol/interfaces/internal/types.js";
import type { IdentityConfig } from "../config/identity_config.js";

// The coordinator's DID document (ADR-001, ADR-006). Besides what the PDS maintains for the account
// (#atproto, #atproto_kem, #atproto_pds), it must carry two entries of Hivemind's own:
// -> #hivemind_attestation: the public key agents verify assignments with
// -> #hivemind_coordinator: the service a PDS calls for checkUserAccess on the managed spaces
//
// Production (did:web): buildDidDocument() makes the document served at
// https://<webDomain>/.well-known/did.json (scripts/did_document.ts).
// Locally (did:plc): core/hivemind_pds/start_local.ts adds the entries with a PLC update.
// Either way, identityProblems() checks the published document (main.ts at startup).

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface ServiceCredential {
	type: string;
	endpoint: string;
}

// Keys and services keyed by fragment, as com.atproto.identity.getRecommendedDidCredentials
// returns them and as a PLC operation takes them
export interface DidCredentials {
	rotationKeys?: string[];
	alsoKnownAs?: string[];
	verificationMethods?: Record<string, unknown>;
	services?: Record<string, unknown>;
}

export interface HivemindDidEntries {
	verificationMethods: Record<string, string>;
	services: Record<string, ServiceCredential>;
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

// The parts of a resolved DID document the check reads (did:plc and did:web alike)
export interface ResolvedDidDocument {
	verificationMethod?: Array<{
		id: string;
		type?: string;
		publicKeyMultibase?: string;
	}>;
	service?: Array<{ id: string; serviceEndpoint?: unknown }>;
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
// Identifiers
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

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Hivemind's entries
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// attestationDidKey: did:key of the attestation key (P256AttestationSigner.publicDidKey)
export function hivemindDidEntries(
	config: IdentityConfig,
	attestationDidKey: string,
): HivemindDidEntries {
	return {
		verificationMethods: { [config.attestationKeyFragment]: attestationDidKey },
		services: {
			[config.serviceFragment]: {
				type: COORDINATOR_SERVICE_TYPE,
				endpoint: config.serviceUrl,
			},
		},
	};
}

// The PDS's credentials with Hivemind's entries added. A PLC update replaces the whole key and
// service lists, so the PDS's own entries must be passed along.
export function withHivemindEntries(
	credentials: DidCredentials,
	entries: HivemindDidEntries,
): DidCredentials {
	return {
		...credentials,
		verificationMethods: {
			...credentials.verificationMethods,
			...entries.verificationMethods,
		},
		services: { ...credentials.services, ...entries.services },
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// The did:web document
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// recommended: com.atproto.identity.getRecommendedDidCredentials of the coordinator's account
export function buildDidDocument(
	config: IdentityConfig,
	recommended: DidCredentials,
	attestationDidKey: string,
): DidDocument {
	const did = coordinatorDid(config);
	const { verificationMethods, services, alsoKnownAs } = withHivemindEntries(
		recommended,
		hivemindDidEntries(config, attestationDidKey),
	);

	// 1. Keys: the PDS's (atproto signs the repo and service tokens) and ours (attestation)
	const verificationMethod = Object.entries(verificationMethods ?? {}).map(
		([fragment, didKey]) => ({
			id: `${did}#${fragment}`,
			type: "Multikey" as const,
			controller: did,
			publicKeyMultibase: String(didKey).replace(DID_KEY_PREFIX, ""),
		}),
	);

	// 2. Services: the PDS (atproto_pds) and the coordinator
	const service = Object.entries(services ?? {}).map(([fragment, entry]) => {
		const { type, endpoint } = entry as ServiceCredential;
		return { id: `#${fragment}`, type, serviceEndpoint: endpoint };
	});

	return {
		"@context": DID_CONTEXTS,
		id: did,
		alsoKnownAs: alsoKnownAs ?? [`at://${config.webDomain}`],
		verificationMethod,
		service,
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Checking the published document
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The coordinator refuses to start with an incomplete DID document (main.ts)
export class UnpublishedIdentityError extends Error {
	constructor(
		readonly coordinator: Did,
		readonly problems: string[],
	) {
		super(
			`The DID document of ${coordinator} is not ready: ${problems.join("; ")}. ` +
				"Publish it first (core/coordinator/_coordinator.md, Identity).",
		);
	}
}

// Entry ids are "#fragment" or "<did>#fragment", depending on the DID method
function hasFragment(id: string, fragment: string): boolean {
	return id.endsWith(`#${fragment}`);
}

// A published key as did:key. Keys appear as Multikey (did:web, plc.directory) or in the older
// EcdsaSecp256r1VerificationKey2019 form (dev-env's PLC directory), so the encodings differ.
function publishedDidKey(
	method: NonNullable<ResolvedDidDocument["verificationMethod"]>[number],
): string | undefined {
	const { type, publicKeyMultibase } = method;
	if (type === undefined || publicKeyMultibase === undefined) {
		return undefined;
	}
	try {
		return getDidKeyFromMultibase({ type, publicKeyMultibase });
	} catch {
		return undefined;
	}
}

// What is missing or outdated in the published document; empty when both entries match
export function identityProblems(
	document: ResolvedDidDocument | null | undefined,
	config: IdentityConfig,
	attestationDidKey: string,
): string[] {
	if (document == null) {
		return ["the DID document could not be resolved"];
	}
	const problems: string[] = [];

	// 1. The attestation key: present, and the key the coordinator signs with
	const attestationKey = (document.verificationMethod ?? []).find(({ id }) =>
		hasFragment(id, config.attestationKeyFragment),
	);
	if (attestationKey === undefined) {
		problems.push(`#${config.attestationKeyFragment} is missing`);
	} else if (publishedDidKey(attestationKey) !== attestationDidKey) {
		problems.push(
			`#${config.attestationKeyFragment} is not the key in the environment (rotated without republishing?)`,
		);
	}

	// 2. The coordinator service: present, and pointing at this coordinator
	const coordinatorService = (document.service ?? []).find(({ id }) =>
		hasFragment(id, config.serviceFragment),
	);
	if (coordinatorService === undefined) {
		problems.push(`#${config.serviceFragment} is missing`);
	} else if (coordinatorService.serviceEndpoint !== config.serviceUrl) {
		problems.push(
			`#${config.serviceFragment} points to ${String(coordinatorService.serviceEndpoint)}, not ${config.serviceUrl}`,
		);
	}
	return problems;
}
