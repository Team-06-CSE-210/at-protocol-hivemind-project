// Who the coordinator is on the network and where it can be reached.
// Used by: main.ts, authentication/, runtime/xrpc_server.ts

export interface IdentityConfig {
	// Handle or DID the coordinator's account logs in with
	readonly accountIdentifier: string;
	// URL of the PDS that hosts the coordinator's account (the Hivemind PDS)
	readonly pdsUrl: string;
	// PLC directory used to resolve did:plc identities
	readonly plcUrl: string;
	// Domain of the coordinator's did:web; its DID document is served at
	// https://<webDomain>/.well-known/did.json
	readonly webDomain: string;
	// Public URL of the coordinator's XRPC server, as named in the DID document
	readonly serviceUrl: string;
	// Fragment of the coordinator service in the DID document; the managed spaces name
	// <did>#<serviceFragment> as their managing app
	readonly serviceFragment: string;
	// Fragment of the key that signs assignments
	readonly attestationKeyFragment: string;
}

// Planned production values; local runs override pdsUrl, plcUrl and accountIdentifier
export const DEFAULT_IDENTITY_CONFIG: IdentityConfig = {
	accountIdentifier: "hivemind-network.com",
	pdsUrl: "https://pds.hivemind-network.com",
	plcUrl: "https://plc.directory",
	webDomain: "hivemind-network.com",
	serviceUrl: "https://coordinator.hivemind-network.com",
	serviceFragment: "hivemind_coordinator",
	attestationKeyFragment: "hivemind_attestation",
};
