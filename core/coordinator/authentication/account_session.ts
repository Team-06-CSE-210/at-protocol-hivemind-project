import { AtpAgent } from "@atproto/api";
import type { IdentityConfig } from "../config/identity_config.js";

// Logs the coordinator's account in at its PDS (the Hivemind PDS). The session it returns backs
// the coordinator's gateway and space authority; the password comes from library/environment.ts.

export async function logInCoordinator(
	config: IdentityConfig,
	password: string,
): Promise<AtpAgent> {
	const agent = new AtpAgent({ service: config.pdsUrl });
	await agent.login({ identifier: config.accountIdentifier, password });
	return agent;
}
