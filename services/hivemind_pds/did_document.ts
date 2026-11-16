/*
 * DID documents for did:web accounts.
 *
 * A did:plc document lives in the PLC directory and the PDS keeps it up to date. A did:web
 * document is a JSON file its owner serves at https://{domain}/.well-known/did.json, so the
 * coordinator (did:web, glossary) writes its own. This module builds one from the same maps PLC
 * uses: verification methods as did:key by fragment, services by fragment.
 */

export type ServiceEntry = { type: string; endpoint: string };

export type DidDocumentData = {
	did: string;
	/* e.g. ["at://coordinator.hivemind.test"] */
	alsoKnownAs: string[];
	/* By fragment, e.g. { atproto: "did:key:z…", hivemind_attestation: "did:key:z…" } */
	verificationMethods: Record<string, string>;
	/* By fragment, e.g. { atproto_pds: { type, endpoint } } */
	services: Record<string, ServiceEntry>;
};

/* Where a did:web document is published: dev-env's did_web_host.ts now, the coordinator later. */
export type DidDocumentHost = {
	did: string;
	/* The https (or, for localhost, http) origin that serves /.well-known/did.json */
	url: string;
	setDocument(document: DidDocument): void;
};

export type DidDocument = {
	"@context": string[];
	id: string;
	alsoKnownAs: string[];
	verificationMethod: {
		id: string;
		type: "Multikey";
		controller: string;
		publicKeyMultibase: string;
	}[];
	service: { id: string; type: string; serviceEndpoint: string }[];
};

export function buildDidDocument(data: DidDocumentData): DidDocument {
	return {
		"@context": [
			"https://www.w3.org/ns/did/v1",
			"https://w3id.org/security/multikey/v1",
		],
		id: data.did,
		alsoKnownAs: data.alsoKnownAs,
		verificationMethod: Object.entries(data.verificationMethods).map(
			([fragment, didKey]) => ({
				id: `${data.did}#${fragment}`,
				type: "Multikey",
				controller: data.did,
				publicKeyMultibase: didKey.replace(/^did:key:/, ""),
			}),
		),
		service: Object.entries(data.services).map(([fragment, service]) => ({
			id: `#${fragment}`,
			type: service.type,
			serviceEndpoint: service.endpoint,
		})),
	};
}
