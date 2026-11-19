import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_BILLING_CONFIG } from "../../../core/coordinator/config/billing_config.js";
import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../../core/coordinator/library/clock.js";
import { CoordinatorApiHandlers } from "../../../core/coordinator/runtime/api_handlers.js";
import { BillingRuntime } from "../../../core/coordinator/runtime/billing.js";
import { CoordinatorApiError } from "../../../core/protocol/interfaces/internal/coordinator_api.js";
import type { CoordinatorStores } from "../../../core/protocol/interfaces/internal/stores.js";
import type {
	AtUri,
	TypedObject,
} from "../../../core/protocol/interfaces/internal/types.js";
import {
	feedSpaceRef,
	offerIntakeSpaceRef,
	requestIntakeSpaceRef,
	taskSpaceRef,
} from "../../../core/protocol/protocol_config/space_definition.js";
import {
	agentProfile,
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	FEED_OWNER,
	feedDeclaration,
	OPERATOR,
	PRIVATE_FEED,
	RIDER,
	registration,
	START,
	STRANGER,
	TAXI_ONE,
	taskIdFor,
} from "../fixtures.js";

// register, setFeedMember and checkUserAccess as the coordinator answers them, and the payment
// outcomes that make an operator (and with it its agents) active.

function setUp(publicRecords = new Map<AtUri, object>()) {
	const stores: CoordinatorStores = createMemoryStores(COORDINATOR);
	const api = new CoordinatorApiHandlers({
		coordinator: COORDINATOR,
		stores,
		// Records in participants' repos that the index has not seen
		gateway: {
			getRecord: async (uri) =>
				publicRecords.get(uri) as TypedObject | undefined,
		},
		clock: new ManualClock(START),
	});
	const billing = new BillingRuntime(stores, DEFAULT_BILLING_CONFIG);
	return { stores, api, billing, publicRecords };
}

const PROFILE_URI =
	`at://${TAXI_ONE}/com.hivemind-network.agent.profile/self` as AtUri;

async function rejectsWith(promise: Promise<unknown>, name: string) {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof CoordinatorApiError);
		assert.equal(error.error, name);
		return true;
	});
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// register
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("register", () => {
	test("a requester is active at once, and registering again changes nothing", async () => {
		const { api } = setUp();
		const first = await api.register(RIDER, { role: "requester" });
		assert.equal(first.status, "active");
		assert.deepEqual(await api.register(RIDER, { role: "requester" }), first);
		await rejectsWith(
			api.register(RIDER, { role: "operator" }),
			"RoleConflict",
		);
	});

	test("an operator enrolls its agents only once it has paid", async () => {
		const { api, billing, publicRecords } = setUp();
		publicRecords.set(PROFILE_URI, agentProfile());

		assert.equal(
			(await api.register(OPERATOR, { role: "operator" })).status,
			"pendingPayment",
		);
		await rejectsWith(
			api.register(OPERATOR, { role: "agent", subject: TAXI_ONE }),
			"NotOperator",
		);

		await billing.applyPaymentEvent(OPERATOR, "paymentSucceeded");
		const agent = await api.register(OPERATOR, {
			role: "agent",
			subject: TAXI_ONE,
		});
		assert.equal(agent.status, "active");
		assert.equal(agent.operator, OPERATOR);
	});

	test("an agent whose profile names another operator cannot be enrolled", async () => {
		const { api, stores, publicRecords } = setUp();
		await stores.participants.put(registration(STRANGER, "operator"));
		publicRecords.set(PROFILE_URI, agentProfile());
		await rejectsWith(
			api.register(STRANGER, { role: "agent", subject: TAXI_ONE }),
			"OperatorMismatch",
		);
		await rejectsWith(
			api.register(STRANGER, { role: "agent" }),
			"InvalidRequest",
		);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// setFeedMember
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("setFeedMember", () => {
	test("only the feed's owner changes its allowlist, and only for registered participants", async () => {
		const { api, stores, publicRecords } = setUp();
		// The index has not seen the feed yet; the handler reads it from the owner's repo
		publicRecords.set(PRIVATE_FEED, feedDeclaration("private"));
		await stores.participants.put(registration(RIDER, "requester"));
		const member = { feed: PRIVATE_FEED, subject: RIDER, allowed: true };

		await rejectsWith(api.setFeedMember(STRANGER, member), "NotFeedOwner");
		await rejectsWith(
			api.setFeedMember(FEED_OWNER, { ...member, subject: STRANGER }),
			"SubjectNotRegistered",
		);
		await rejectsWith(
			api.setFeedMember(FEED_OWNER, {
				...member,
				feed: `at://${FEED_OWNER}/com.hivemind-network.feed.declaration/none`,
			}),
			"FeedNotFound",
		);

		await api.setFeedMember(FEED_OWNER, member);
		assert.equal(await stores.feedMembers.isAllowed(PRIVATE_FEED, RIDER), true);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// checkUserAccess
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("checkUserAccess", () => {
	async function seeded() {
		const context = setUp();
		const { stores } = context;
		await stores.participants.put(registration(RIDER, "requester"));
		await stores.participants.put(registration(OPERATOR, "operator"));
		await stores.participants.put(registration(TAXI_ONE, "agent"));
		await stores.publicIndex.apply(
			created(FEED_OWNER, "downtown", feedDeclaration()),
		);
		await stores.publicIndex.apply(
			created(FEED_OWNER, "private", feedDeclaration("private")),
		);
		await stores.publicIndex.apply(
			created(TAXI_ONE, "self", agentProfile([DOWNTOWN_FEED, PRIVATE_FEED])),
		);
		return context;
	}

	test("requesters write the request intake, agents the offer intake; nobody reads either", async () => {
		const { api } = await seeded();
		const requestIntake = requestIntakeSpaceRef(COORDINATOR);
		const offerIntake = offerIntakeSpaceRef(COORDINATOR);

		assert.equal(
			await api.checkUserAccess(requestIntake, RIDER, "write"),
			true,
		);
		assert.equal(
			await api.checkUserAccess(requestIntake, TAXI_ONE, "write"),
			false,
		);
		assert.equal(
			await api.checkUserAccess(requestIntake, RIDER, "read"),
			false,
		);
		assert.equal(
			await api.checkUserAccess(offerIntake, TAXI_ONE, "write"),
			true,
		);
		assert.equal(await api.checkUserAccess(offerIntake, RIDER, "write"), false);
		assert.equal(
			await api.checkUserAccess(offerIntake, TAXI_ONE, "read"),
			false,
		);
	});

	test("eligible agents read a feed space; private feeds need the allowlist", async () => {
		const { api, stores } = await seeded();
		const publicFeed = await feedSpaceRef(COORDINATOR, DOWNTOWN_FEED);
		const privateFeed = await feedSpaceRef(COORDINATOR, PRIVATE_FEED);

		assert.equal(await api.checkUserAccess(publicFeed, TAXI_ONE, "read"), true);
		assert.equal(
			await api.checkUserAccess(publicFeed, TAXI_ONE, "write"),
			false,
		);
		assert.equal(await api.checkUserAccess(publicFeed, RIDER, "read"), false);
		assert.equal(
			await api.checkUserAccess(privateFeed, TAXI_ONE, "read"),
			false,
		);

		await stores.feedMembers.set({
			feed: PRIVATE_FEED,
			subject: TAXI_ONE,
			allowed: true,
		});
		assert.equal(
			await api.checkUserAccess(privateFeed, TAXI_ONE, "read"),
			true,
		);
	});

	test("a suspended operator takes its agents out", async () => {
		const { api, billing } = await seeded();
		const publicFeed = await feedSpaceRef(COORDINATOR, DOWNTOWN_FEED);
		await billing.applyPaymentEvent(OPERATOR, "paymentFailed");
		assert.equal(
			await api.checkUserAccess(publicFeed, TAXI_ONE, "read"),
			false,
		);
		assert.equal(
			await api.checkUserAccess(
				offerIntakeSpaceRef(COORDINATOR),
				TAXI_ONE,
				"write",
			),
			false,
		);
	});

	test("spaces of other authorities and task spaces are never granted here", async () => {
		const { api } = await seeded();
		assert.equal(
			await api.checkUserAccess(
				requestIntakeSpaceRef("did:plc:other"),
				RIDER,
				"write",
			),
			false,
		);
		assert.equal(
			await api.checkUserAccess(
				taskSpaceRef(COORDINATOR, taskIdFor("x")),
				RIDER,
				"read",
			),
			false,
		);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Billing
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("billing runtime", () => {
	test("an operator owes the monthly fee per agent plus assignments above the included ones", async () => {
		const { stores, billing } = setUp();
		await stores.participants.put(registration(OPERATOR, "operator"));
		await stores.participants.put(registration(TAXI_ONE, "agent"));
		for (let assignment = 0; assignment < 1_001; assignment++) {
			await billing.recordAssignment(TAXI_ONE, START);
		}
		// $9.00 + 1 extra assignment at $2.00 per 1,000, rounded up to a cent
		assert.equal(await billing.operatorChargeMinor(OPERATOR, "2026-11"), 901);
	});
});
