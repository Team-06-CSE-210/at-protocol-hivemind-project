import type * as hivemind from "../../generated/com/hivemind-network.js";
import type { Did, FeedMember, Registration, SpaceRef } from "./types.js";

// What the coordinator answers when it is called, once the caller is known.
// Implemented by: core/coordinator/runtime/api_handlers.ts
// Carried by: core/coordinator/runtime/xrpc_server.ts (HTTP) and the in-memory network (tests)
//
// The methods themselves are defined in interfaces/external/coordinator/ (Hivemind's) and by
// atproto (checkUserAccess). When a handler runs, the caller's DID is already verified.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export type RegisterInput = hivemind.coordinator.register.$InputBody;

export type AccessKind = "read" | "write";

// A refusal the method's lexicon declares; `error` is its name, e.g. NotOperator
export class CoordinatorApiError extends Error {
	constructor(
		readonly error: string,
		message?: string,
	) {
		super(message ?? error);
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Coordinator API
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface CoordinatorApi {
	// com.hivemind-network.coordinator.register: register the caller or an agent it operates
	// -> idempotent, so it doubles as the status check
	register(caller: Did, input: RegisterInput): Promise<Registration>;

	// com.hivemind-network.coordinator.setFeedMember: change a private feed's allowlist
	setFeedMember(caller: Did, input: FeedMember): Promise<void>;

	// com.atproto.managedspace.checkUserAccess: the space authority asks before every read
	// credential and every write in a managed space (both intakes and all feed spaces)
	checkUserAccess(
		space: SpaceRef,
		user: Did,
		access: AccessKind,
	): Promise<boolean>;
}
