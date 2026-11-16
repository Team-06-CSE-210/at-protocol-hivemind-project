/*
 * What Hivemind code and tests need to know about the atproto network they run on, independent of
 * how that network is started. Today startDevNetwork() (dev-env, one process) provides it; a Docker
 * setup can later provide the same values from environment variables, and the tests stay as they are.
 */
import type { P256Key } from "./keys.ts";

export const HIVEMIND_HANDLE_DOMAIN = ".hivemind.test";
export const OPERATOR_HANDLE_DOMAIN = ".fleet.test";
export const COORDINATOR_HANDLE = `coordinator${HIVEMIND_HANDLE_DOMAIN}`;
export const COORDINATOR_SERVICE_ID = "hivemind_coordinator";
export const COORDINATOR_SERVICE_TYPE = "HivemindCoordinator";
export const ATTESTATION_KEY_ID = "hivemind_attestation";

export type CoordinatorAccount = {
	/* did:web, e.g. did:web:localhost%3A2590 */
	did: string;
	handle: string;
	password: string;
	/* Serves did.json now, the coordinator API later (#hivemind_coordinator). */
	url: string;
	attestationKey: P256Key;
};

export type HivemindNetwork = {
	plcUrl: string;
	/* Invite-only; hosts the coordinator, its spaces and the riders. */
	hivemindPdsUrl: string;
	/* A fleet operator's own PDS; hosts the agents. */
	operatorPdsUrl: string;
	coordinator: CoordinatorAccount;
	/* An invite code for the Hivemind PDS. */
	createInviteCode(useCount?: number): Promise<string>;
	close(): Promise<void>;
};
