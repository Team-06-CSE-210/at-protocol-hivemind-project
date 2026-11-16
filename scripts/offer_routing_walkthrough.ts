import { AgentOfferRouter } from "../hivemind_library/hivemind_agent.ts";
import {
	DISPATCH_COLLECTION,
	type OfferEnvelopeValidation,
	type OfferPayloadValidation,
} from "../protocol/interfaces/internal/offer_routing.ts";
import { OfferIntakeRouter } from "../services/coordinator/offer_intake.ts";
import {
	InMemoryGatewayNetwork,
	InMemoryTaskStore,
} from "../tests/support/in_memory.ts";
import {
	AGENT,
	COORDINATOR,
	FEED,
	INTAKE,
	NOW,
	OFFER_PAYLOAD,
	TASK_ID,
	makeDispatch,
	makeTask,
} from "../tests/support/offer_fixtures.ts";

/** Same offer routers in both demos; only the injected validators change. */
export async function runOfferRoutingWalkthrough(options: {
	validation: OfferEnvelopeValidation;
	validatePayload: OfferPayloadValidation;
	validationLabel: string;
}): Promise<void> {
	console.log("\nOFFER ROUTING DEMO");
	console.log(`Validation: ${options.validationLabel}`);
	console.log("Gateway and storage: in-memory test implementations\n");

	const network = new InMemoryGatewayNetwork();
	network.createSpace(INTAKE, [COORDINATOR], [AGENT]);
	network.createSpace(FEED, [AGENT], [COORDINATOR]);
	const taskStore = new InMemoryTaskStore();
	await taskStore.put(makeTask());
	console.log(`[1] Task created: ${TASK_ID}`);
	console.log("    Status: collecting offers; response window: 10 seconds.");

	const failures: unknown[] = [];
	const onError = (error: unknown) => failures.push(error);
	const intake = new OfferIntakeRouter({
		gateway: network.gateway(COORDINATOR),
		intakeSpace: INTAKE,
		taskStore,
		validation: options.validation,
		isAgentEligible: async (agent, task) =>
			agent === AGENT && task.matchedFeeds.length > 0,
		validatePayload: options.validatePayload,
		now: () => NOW,
		onError,
		onResult: (result) => {
			if (result.status === "stored") {
				console.log("[5] Coordinator checked the offer and stored it against the task.");
			} else {
				console.log("    Intake result:", result);
			}
		},
	});
	const agentGateway = network.gateway(AGENT);
	const agent = new AgentOfferRouter({
		gateway: {
			...agentGateway,
			putSpaceRecord: async (space, collection, rkey, record) => {
				console.log("[4] Agent writes its offer into the intake space through the gateway.");
				await agentGateway.putSpaceRecord(space, collection, rkey, record);
			},
		},
		coordinator: COORDINATOR,
		intakeSpace: INTAKE,
		feedSpaces: [FEED],
		behavior: {
			onDispatch: async () => {
				console.log("[3] Taxi receives the dispatch and accepts.");
				console.log("    Sample terms: $18.00, pickup in 3 minutes, 4 seats.");
				return { decision: "accept", payload: OFFER_PAYLOAD };
			},
		},
		validation: options.validation,
		createRkey: () => "3m22222222223",
		now: () => NOW,
		onError,
	});

	await intake.start();
	try {
		await agent.start();
		console.log("[2] Coordinator publishes a dispatch into the county feed space.");
		await network
			.gateway(COORDINATOR)
			.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
		await agent.drain();
		await intake.drain();
		if (failures.length) throw new AggregateError(failures, "Offer routing failed");
		const task = await taskStore.get(TASK_ID);
		if (task?.offers.length !== 1) throw new Error("Expected one collected offer");
		console.log(`\nPASS: ${task.offers.length} offer stored for ${task.taskId}.`);
		console.log("    Author:", task.offers[0].agent);
		console.log("    Decision:", task.offers[0].offer.decision);
		console.log("    Terms:", JSON.stringify(task.offers[0].offer.payload, null, 2));
		console.log("\nThis demo stops at collection. Ranking and assignment are separate.\n");
	} finally {
		await agent.stop();
		await intake.stop();
	}
}
