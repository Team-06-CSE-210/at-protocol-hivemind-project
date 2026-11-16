import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentOfferRouter } from "../../hivemind_library/hivemind_agent.ts";
import { network as lexicons } from "../../protocol/generated/index.js";
import { DISPATCH_COLLECTION } from "../../protocol/interfaces/internal/offer_routing.ts";
import type { TypedObject } from "../../protocol/interfaces/internal/types.js";
import { lexiconOfferValidation } from "../../protocol/offer_validation.ts";
import { OfferIntakeRouter } from "../../services/coordinator/offer_intake.ts";
import { InMemoryGatewayNetwork, InMemoryTaskStore } from "../support/in_memory.ts";
import {
	AGENT,
	COORDINATOR,
	FEED,
	INTAKE,
	NOW,
	OFFER_PAYLOAD,
	TASK_ID,
	makeDispatch,
	makeOffer,
	makeTask,
	offerChange,
} from "../support/offer_fixtures.ts";

test("generated validators accept the main-repo dispatch and offer shapes", () => {
	assert.deepEqual(lexiconOfferValidation.parseDispatch(makeDispatch()), makeDispatch());
	assert.deepEqual(lexiconOfferValidation.parseOffer(makeOffer()), makeOffer());
});

test("generated offer validation rejects invalid decisions, task IDs, dates and snapshots", () => {
	for (const invalid of [
		{ ...makeOffer(), decision: "maybe" },
		{ ...makeOffer(), taskId: "short" },
		{ ...makeOffer(), createdAt: "yesterday" },
		{ ...makeOffer(), snapshot: { batteryPercent: 101 } },
	]) {
		assert.throws(() => lexiconOfferValidation.parseOffer(invalid));
	}
});

test("generated dispatch validation rejects missing deadlines and mistyped payloads", () => {
	assert.throws(() =>
		lexiconOfferValidation.parseDispatch({ ...makeDispatch(), respondBy: undefined }),
	);
	assert.throws(() =>
		lexiconOfferValidation.parseDispatch({ ...makeDispatch(), payload: {} }),
	);
});

function validateRideOffer(payload: TypedObject, request: TypedObject): void {
	const ride = lexicons.hivemind.mobility.ride.request.$validate(request);
	const terms = lexicons.hivemind.mobility.ride.offer.$validate(payload);
	if (terms.vehicle.seats < ride.passengers) throw new Error("Not enough seats");
}

test("open offer payloads receive task-specific schema validation", () => {
	const invalidPayload: TypedObject = {
		$type: "network.hivemind.mobility.ride#offer",
	};
	// The generic envelope only establishes that this is a typed payload. The ride
	// validator is responsible for the required price, vehicle and duration fields.
	assert.doesNotThrow(() =>
		lexiconOfferValidation.parseOffer({ ...makeOffer(), payload: invalidPayload }),
	);
	assert.throws(() => validateRideOffer(invalidPayload, makeTask().request.payload));
});

test("generated validators plug into the full dispatch-to-intake routing flow", async () => {
	const network = new InMemoryGatewayNetwork();
	network.createSpace(INTAKE, [COORDINATOR], [AGENT]);
	network.createSpace(FEED, [AGENT], [COORDINATOR]);
	const taskStore = new InMemoryTaskStore();
	await taskStore.put(makeTask());
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	const intake = new OfferIntakeRouter({
		gateway: network.gateway(COORDINATOR),
		intakeSpace: INTAKE,
		taskStore,
		validation: lexiconOfferValidation,
		isAgentEligible: async (agent) => agent === AGENT,
		validatePayload: validateRideOffer,
		now: () => NOW,
		onError,
	});
	const sender = new AgentOfferRouter({
		gateway: network.gateway(AGENT),
		coordinator: COORDINATOR,
		intakeSpace: INTAKE,
		feedSpaces: [FEED],
		behavior: {
			onDispatch: async () => ({ decision: "accept", payload: OFFER_PAYLOAD }),
		},
		validation: lexiconOfferValidation,
		createRkey: () => "3m22222222223",
		now: () => NOW,
		onError,
	});
	await intake.start();
	try {
		await sender.start();
		await network
			.gateway(COORDINATOR)
			.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
		await sender.drain();
		await intake.drain();
		const task = await taskStore.get(TASK_ID);
		assert.ok(task);
		assert.equal(task.offers.length, 1);
		assert.equal(task.offers[0].agent, AGENT);
		assert.deepEqual(task.offers[0].offer.payload, OFFER_PAYLOAD);
		assert.deepEqual(errors, []);
	} finally {
		await sender.stop();
		await intake.stop();
	}
});

test("intake enforces accepted terms and task payload rules beyond envelope validation", async () => {
	const taskStore = new InMemoryTaskStore();
	await taskStore.put(makeTask());
	const intake = new OfferIntakeRouter({
		gateway: new InMemoryGatewayNetwork().gateway(COORDINATOR),
		intakeSpace: INTAKE,
		taskStore,
		validation: lexiconOfferValidation,
		isAgentEligible: async () => true,
		validatePayload: validateRideOffer,
		now: () => NOW,
		onError: (error) => {
			throw error;
		},
	});
	assert.deepEqual(
		await intake.handleChange(
			offerChange({ record: { ...makeOffer(), payload: undefined } }),
		),
		{ status: "rejected", reason: "acceptWithoutPayload" },
	);
	assert.deepEqual(
		await intake.handleChange(
			offerChange({
				record: {
					...makeOffer(),
					payload: {
						...OFFER_PAYLOAD,
						vehicle: { model: "Small taxi", seats: 1 },
					},
				},
			}),
		),
		{ status: "rejected", reason: "invalidPayload" },
	);
	assert.equal((await taskStore.get(TASK_ID))?.offers.length, 0);
});
