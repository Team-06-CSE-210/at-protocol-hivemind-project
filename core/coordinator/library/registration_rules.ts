import {
	CoordinatorApiError,
	type RegisterInput,
} from "../../protocol/interfaces/internal/coordinator_api.js";
import type { IndexedFeed } from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentProfile,
	Datetime,
	Did,
	Registration,
} from "../../protocol/interfaces/internal/types.js";
import { isActiveOperator } from "./access_rules.js";

// The rules of com.hivemind-network.coordinator.register and .setFeedMember
// (core/protocol/interfaces/external/coordinator/). Refusals throw CoordinatorApiError with the
// error name the lexicon declares; InvalidRequest is the XRPC name for malformed input.
// Used by: runtime/api_handlers.ts

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Registration
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface RegistrationFacts {
	caller: Did;
	input: RegisterInput;
	// Current registration of the DID being registered (the caller, or the agent for role agent)
	existing: Registration | undefined;
	// Role agent only: the caller's registration and the agent's public profile
	callerRegistration: Registration | undefined;
	agentProfile: AgentProfile | undefined;
	now: Datetime;
}

// Status a new registration starts with: operators wait for their first payment
const INITIAL_STATUS = {
	requester: "active",
	operator: "pendingPayment",
	agent: "active",
} as const;

// The registration to store and return. Registering again returns the existing registration
// unchanged, so the method doubles as the status check.
export function decideRegistration(facts: RegistrationFacts): Registration {
	const { role } = facts.input;
	switch (role) {
		// The lexicon's role is an open string, so each known role is passed on as its literal
		case "requester": {
			return decideOwnRegistration(facts, "requester");
		}
		case "operator": {
			return decideOwnRegistration(facts, "operator");
		}
		case "agent": {
			return decideAgentRegistration(facts);
		}
		default: {
			throw new CoordinatorApiError("InvalidRequest", `Unknown role: ${role}`);
		}
	}
}

// Requesters and operators always register the caller; a subject in the input is ignored
function decideOwnRegistration(
	facts: RegistrationFacts,
	role: "requester" | "operator",
): Registration {
	const { caller, existing, now } = facts;
	if (existing !== undefined) {
		return keepIfSameRole(existing, role);
	}
	return {
		subject: caller,
		role,
		status: INITIAL_STATUS[role],
		registeredAt: now,
	};
}

function decideAgentRegistration(facts: RegistrationFacts): Registration {
	const { caller, input, existing, callerRegistration, agentProfile, now } =
		facts;
	const { subject } = input;
	if (subject === undefined) {
		throw new CoordinatorApiError(
			"InvalidRequest",
			"Role agent needs the agent's DID as subject",
		);
	}
	if (!isActiveOperator(callerRegistration)) {
		throw new CoordinatorApiError("NotOperator");
	}
	// The agent's own public profile must name the caller, so nobody enrolls someone else's agent
	if (agentProfile?.operator !== caller) {
		throw new CoordinatorApiError("OperatorMismatch");
	}
	if (existing !== undefined) {
		const registration = keepIfSameRole(existing, "agent");
		if (registration.operator !== caller) {
			throw new CoordinatorApiError("OperatorMismatch");
		}
		return registration;
	}
	return {
		subject,
		role: "agent",
		status: INITIAL_STATUS.agent,
		operator: caller,
		registeredAt: now,
	};
}

function keepIfSameRole(existing: Registration, role: string): Registration {
	if (existing.role !== role) {
		throw new CoordinatorApiError(
			"RoleConflict",
			`Already registered as ${existing.role}`,
		);
	}
	return existing;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Feed allowlists
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface FeedMemberFacts {
	caller: Did;
	// The feed as the public-record index knows it; undefined if no declaration names us
	feed: IndexedFeed | undefined;
	subjectRegistration: Registration | undefined;
}

// Throws if the caller may not change this allowlist entry
export function checkFeedMemberChange(facts: FeedMemberFacts): void {
	const { caller, feed, subjectRegistration } = facts;
	if (feed === undefined) {
		throw new CoordinatorApiError("FeedNotFound");
	}
	if (feed.owner !== caller) {
		throw new CoordinatorApiError("NotFeedOwner");
	}
	const role = subjectRegistration?.role;
	if (role !== "requester" && role !== "agent") {
		throw new CoordinatorApiError("SubjectNotRegistered");
	}
}
