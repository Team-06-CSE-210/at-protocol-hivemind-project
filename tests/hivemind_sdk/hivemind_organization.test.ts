import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BILLING_CONFIG } from "../../core/coordinator/config/billing_config.js";
import { createMemoryStores } from "../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../core/coordinator/library/clock.js";
import { CoordinatorApiHandlers } from "../../core/coordinator/runtime/api_handlers.js";
import { BillingRuntime } from "../../core/coordinator/runtime/billing.js";
import { PublicIndexer } from "../../core/coordinator/runtime/public_indexer.js";
import { LocalSimGateway } from "../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../core/protocol/communication/in_memory/at_protocol_network.js";
import type { AgentClientOptions } from "../../core/protocol/interfaces/internal/client_lib.js";
import type { RegisterInput } from "../../core/protocol/interfaces/internal/coordinator_api.js";
import { HivemindAgent } from "../../hivemind_sdk/hivemind_agent.js";
import { HivemindOrganization } from "../../hivemind_sdk/hivemind_organization.js";
import {
	COORDINATOR,
	DOWNTOWN_FEED,
	FakeSpaceService,
	OPERATOR,
	START,
	TAXI_ONE,
} from "../coordinator/fixtures.js";
import { eventually } from "../gateway/gateway_contract.js";

test("an active operator can enroll an agent after its profile is published and indexed", async (t) => {
	const network = new AtProtocolNetwork();
	const stores = createMemoryStores(COORDINATOR);
	const coordinatorGateway = new LocalSimGateway(network, COORDINATOR);
	const indexer = new PublicIndexer({
		gateway: coordinatorGateway,
		publicIndex: stores.publicIndex,
		spaces: new FakeSpaceService(),
	});
	const api = new CoordinatorApiHandlers({
		coordinator: COORDINATOR,
		gateway: coordinatorGateway,
		stores,
		indexer,
		clock: new ManualClock(START),
	});
	const billing = new BillingRuntime(stores, DEFAULT_BILLING_CONFIG);

	network.registerService(COORDINATOR, {
		procedures: {
			"com.hivemind-network.coordinator.register": (caller, input) =>
				api.register(caller, input as RegisterInput),
		},
	});

	await indexer.start();
	t.after(() => indexer.stop());

	const organization = new HivemindOrganization({
		gateway: new LocalSimGateway(network, OPERATOR),
		coordinator: COORDINATOR,
	});
	const profile: AgentClientOptions["profile"] = {
		displayName: "Test taxi",
		operator: OPERATOR,
		taskTypes: ["com.hivemind-network.mobility.ride"],
		feeds: [DOWNTOWN_FEED],
	};
	const agent = new HivemindAgent({
		gateway: new LocalSimGateway(network, TAXI_ONE),
		coordinator: COORDINATOR,
		profile,
		trustedCoordinators: [COORDINATOR],
		behavior: {
			onDispatch: async () => ({ decision: "decline" }),
			onAssignment: async () => {},
		},
	});

	const initialRegistration = await organization.registerAsOperator();
	assert.equal(initialRegistration.subject, OPERATOR);
	assert.equal(initialRegistration.role, "operator");
	assert.equal(initialRegistration.status, "pendingPayment");

	await billing.applyPaymentEvent(OPERATOR, "paymentSucceeded");
	assert.equal((await organization.registerAsOperator()).status, "active");

	await agent.start();

	// Check that the firehose indexed the profile before enrollment reads it.
	await eventually(async () => {
		const indexedProfile = await stores.publicIndex.getAgentProfile(TAXI_ONE);
		assert.ok(indexedProfile);
		assert.equal(indexedProfile.operator, profile.operator);
		assert.deepEqual(indexedProfile.taskTypes, profile.taskTypes);
		assert.deepEqual(indexedProfile.feeds, profile.feeds);
	});

	const agentRegistration = await organization.enrollAgent(TAXI_ONE);
	assert.equal(agentRegistration.subject, TAXI_ONE);
	assert.equal(agentRegistration.role, "agent");
	assert.equal(agentRegistration.operator, OPERATOR);
	assert.equal(agentRegistration.status, "active");
	assert.deepEqual(await stores.participants.get(TAXI_ONE), agentRegistration);
});
