import type { AccessKind } from "../../protocol/interfaces/internal/coordinator_api.js";
import type { IndexedFeed } from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentProfile,
	Did,
	Registration,
} from "../../protocol/interfaces/internal/types.js";

// Who may read and write which Hivemind space: the roles of type_definition/policy_types/ as
// functions. The handlers collect the facts from the stores; these functions only decide.
// Used by: runtime/api_handlers.ts (checkUserAccess), runtime/task_runner.ts (routing, offers)

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Roles
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// requester: a registered requester with status active
export function isActiveRequester(
	registration: Registration | undefined,
): boolean {
	return registration?.role === "requester" && registration.status === "active";
}

// operator: a registered operator with status active (paid up)
export function isActiveOperator(
	registration: Registration | undefined,
): boolean {
	return registration?.role === "operator" && registration.status === "active";
}

// agent: a registered agent with status active whose operator is active
export function isActiveAgent(
	agentRegistration: Registration | undefined,
	operatorRegistration: Registration | undefined,
): boolean {
	return (
		agentRegistration?.role === "agent" &&
		agentRegistration.status === "active" &&
		agentRegistration.operator === operatorRegistration?.subject &&
		isActiveOperator(operatorRegistration)
	);
}

export interface FeedEligibilityFacts {
	agent: Did;
	agentRegistration: Registration | undefined;
	operatorRegistration: Registration | undefined;
	agentProfile: AgentProfile | undefined;
	feed: IndexedFeed;
	// Whether the agent is on the feed's allowlist; only asked for private feeds
	allowlisted: boolean;
}

// eligibleAgent: an active agent that lists the feed in its profile, still names its registered
// operator there, supports one of the feed's task types and, for a private feed, is allowlisted
export function isEligibleAgent(facts: FeedEligibilityFacts): boolean {
	const {
		agentRegistration,
		operatorRegistration,
		agentProfile,
		feed,
		allowlisted,
	} = facts;
	if (!isActiveAgent(agentRegistration, operatorRegistration)) {
		return false;
	}
	if (agentProfile === undefined) {
		return false;
	}
	if (agentProfile.operator !== agentRegistration?.operator) {
		return false;
	}
	if (!(agentProfile.feeds ?? []).includes(feed.uri)) {
		return false;
	}
	const supportsTaskType = agentProfile.taskTypes.some((taskType) =>
		feed.declaration.taskTypes.includes(taskType),
	);
	if (!supportsTaskType) {
		return false;
	}
	return !isPrivateFeed(feed) || allowlisted;
}

// access defaults to public, as in the feed declaration lexicon
export function isPrivateFeed(feed: IndexedFeed): boolean {
	return feed.declaration.access === "private";
}

// A requester's request goes to a private feed only if the requester is allowlisted
export function mayPostIntoFeed(
	feed: IndexedFeed,
	allowlisted: boolean,
): boolean {
	return !isPrivateFeed(feed) || allowlisted;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Managed spaces
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The managed spaces checkUserAccess is asked about. Task spaces are member spaces: the PDS checks
// their member list itself and never asks.
export type ManagedSpaceAccessQuestion =
	| {
			space: "requestIntake";
			access: AccessKind;
			userRegistration: Registration | undefined;
	  }
	| {
			space: "offerIntake";
			access: AccessKind;
			userRegistration: Registration | undefined;
			operatorRegistration: Registration | undefined;
	  }
	| { space: "feed"; access: AccessKind; eligibility: FeedEligibilityFacts }
	| { space: "unknown"; access: AccessKind };

// Nobody but the coordinator reads the intakes, and nobody but the coordinator writes to a feed
// space; the coordinator is the authority and never asks about itself
export function decideManagedSpaceAccess(
	question: ManagedSpaceAccessQuestion,
): boolean {
	switch (question.space) {
		case "requestIntake": {
			return (
				question.access === "write" &&
				isActiveRequester(question.userRegistration)
			);
		}
		case "offerIntake": {
			return (
				question.access === "write" &&
				isActiveAgent(question.userRegistration, question.operatorRegistration)
			);
		}
		case "feed": {
			return (
				question.access === "read" && isEligibleAgent(question.eligibility)
			);
		}
		default: {
			return false;
		}
	}
}
