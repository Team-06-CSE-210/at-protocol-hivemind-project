import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type FeedEligibilityFacts,
	isEligibleAgent,
	mayPostIntoFeed,
} from "../../../core/coordinator/library/access_rules.js";
import {
	agentProfile,
	feedDeclaration,
	indexedFeed,
	OPERATOR,
	PRIVATE_FEED,
	registration,
	STRANGER,
	TAXI_ONE,
} from "../fixtures.js";

// The eligibleAgent role of policy_types/_policy_types.md, piece by piece.

function facts(
	overrides: Partial<FeedEligibilityFacts> = {},
): FeedEligibilityFacts {
	return {
		agent: TAXI_ONE,
		agentRegistration: registration(TAXI_ONE, "agent"),
		operatorRegistration: registration(OPERATOR, "operator"),
		agentProfile: agentProfile(),
		feed: indexedFeed(),
		allowlisted: false,
		...overrides,
	};
}

describe("access rules: eligible agents", () => {
	test("an active agent listing the feed with a matching task type is eligible", () => {
		assert.equal(isEligibleAgent(facts()), true);
	});

	test("each missing condition takes eligibility away", () => {
		assert.equal(
			isEligibleAgent(
				facts({
					agentRegistration: registration(TAXI_ONE, "agent", "suspended"),
				}),
			),
			false,
		);
		assert.equal(
			isEligibleAgent(
				facts({
					operatorRegistration: registration(
						OPERATOR,
						"operator",
						"pendingPayment",
					),
				}),
			),
			false,
		);
		assert.equal(
			isEligibleAgent(
				facts({ agentProfile: { ...agentProfile(), operator: STRANGER } }),
			),
			false,
		);
		assert.equal(
			isEligibleAgent(facts({ agentProfile: agentProfile([]) })),
			false,
		);
		assert.equal(
			isEligibleAgent(
				facts({
					agentProfile: { ...agentProfile(), taskTypes: ["com.example.other"] },
				}),
			),
			false,
		);
	});

	test("private feeds need the allowlist, for agents and requesters alike", () => {
		const privateFeed = indexedFeed(PRIVATE_FEED, feedDeclaration("private"));
		const listing = agentProfile([PRIVATE_FEED]);
		assert.equal(
			isEligibleAgent(facts({ feed: privateFeed, agentProfile: listing })),
			false,
		);
		assert.equal(
			isEligibleAgent(
				facts({ feed: privateFeed, agentProfile: listing, allowlisted: true }),
			),
			true,
		);
		assert.equal(mayPostIntoFeed(privateFeed, false), false);
		assert.equal(mayPostIntoFeed(indexedFeed(), false), true);
	});
});
