import type { PdsConfig } from "./pds_config.js";

// Creates invite codes on the Hivemind PDS (com.atproto.server.createInviteCodes), which only the
// PDS admin may call: HTTP Basic auth with user "admin" and the admin password.

export interface InviteRequest {
	// How many codes
	codeCount: number;
	// How many accounts each code may create
	useCount: number;
}

interface CreateInviteCodesOutput {
	codes: Array<{ account: string; codes: string[] }>;
}

export async function createInviteCodes(
	pdsUrl: string,
	config: PdsConfig,
	request: InviteRequest,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
	// 1. The admin password, from the environment only
	const adminPassword = environment[config.adminPasswordVariable];
	if (adminPassword === undefined || adminPassword === "") {
		throw new Error(
			`Environment variable ${config.adminPasswordVariable} is not set`,
		);
	}

	// 2. The call
	const credentials = Buffer.from(`admin:${adminPassword}`).toString("base64");
	const response = await fetch(
		`${pdsUrl}/xrpc/com.atproto.server.createInviteCodes`,
		{
			method: "POST",
			headers: {
				authorization: `Basic ${credentials}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(request),
		},
	);
	if (!response.ok) {
		throw new Error(
			`createInviteCodes failed: ${response.status} ${await response.text()}`,
		);
	}

	// 3. All codes in one list
	const { codes } = (await response.json()) as CreateInviteCodesOutput;
	return codes.flatMap((entry) => entry.codes);
}
