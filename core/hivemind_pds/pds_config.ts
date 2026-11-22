// Settings of the Hivemind PDS: the PDS Hivemind runs for its own coordinator account and for
// participants who have no PDS of their own. In production these become the PDS_* variables of
// pds.env.example; locally start_local.ts passes them to @atproto/dev-env.
// Secrets (admin password, JWT secret, PLC rotation key) are environment variables only.

export interface PdsConfig {
	// Public host name (PDS_HOSTNAME); handles of hosted accounts end in it
	readonly hostname: string;
	// Port the PDS listens on behind the reverse proxy (PDS_PORT)
	readonly port: number;
	// Accounts need an invite code (PDS_INVITE_REQUIRED); invites.ts creates them
	readonly inviteRequired: boolean;
	// PLC directory (PDS_DID_PLC_URL)
	readonly plcUrl: string;
	// The frozen Spaces alpha every package of this repository uses (ADR-001)
	readonly version: string;
	// Environment variable holding the admin password (PDS_ADMIN_PASSWORD on the PDS itself)
	readonly adminPasswordVariable: string;
}

// 2583 is the port the atproto PDS uses by default (packages/pds in bluesky-social/atproto)
export const DEFAULT_PDS_CONFIG: PdsConfig = {
	hostname: "pds.hivemind-network.com",
	port: 2_583,
	inviteRequired: true,
	plcUrl: "https://plc.directory",
	version: "0.0.0-spaces-alpha-20261105160032",
	adminPasswordVariable: "PDS_ADMIN_PASSWORD",
};
