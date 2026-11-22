import type {
	CoordinatorStores,
	IndexedFeed,
} from "../../protocol/interfaces/internal/stores.js";
import type { Did } from "../../protocol/interfaces/internal/types.js";
import {
	type FeedEligibilityFacts,
	isEligibleAgent,
	mayPostIntoFeed,
} from "../library/access_rules.js";

// Collects from the stores the facts library/access_rules.ts decides on. Shared by the access
// checks the PDS asks for (api_handlers.ts) and the coordinator's own checks (task_runner.ts), so
// both always give the same answer.

export type AccessStores = Pick<
	CoordinatorStores,
	"participants" | "feedMembers" | "publicIndex"
>;

export async function collectFeedEligibility(
	stores: AccessStores,
	agent: Did,
	feed: IndexedFeed,
): Promise<FeedEligibilityFacts> {
	const { participants, feedMembers, publicIndex } = stores;
	const agentRegistration = await participants.get(agent);
	const operatorRegistration =
		agentRegistration?.operator === undefined
			? undefined
			: await participants.get(agentRegistration.operator);
	return {
		agent,
		agentRegistration,
		operatorRegistration,
		agentProfile: await publicIndex.getAgentProfile(agent),
		feed,
		allowlisted: await feedMembers.isAllowed(feed.uri, agent),
	};
}

export async function agentMayReadFeed(
	stores: AccessStores,
	agent: Did,
	feed: IndexedFeed,
): Promise<boolean> {
	return isEligibleAgent(await collectFeedEligibility(stores, agent, feed));
}

export async function requesterMayPostIntoFeed(
	stores: AccessStores,
	requester: Did,
	feed: IndexedFeed,
): Promise<boolean> {
	const allowlisted = await stores.feedMembers.isAllowed(feed.uri, requester);
	return mayPostIntoFeed(feed, allowlisted);
}
