import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AgentOfferRouter,
	type AgentOfferRouterOptions,
} from "../hivemind_library/hivemind_agent.ts";
import { SpaceAccessDeniedError } from "../protocol/interfaces/internal/atproto_gateway.ts";
import {
	DISPATCH_COLLECTION,
	OFFER_COLLECTION,
	type OfferIntakeResult,
} from "../protocol/interfaces/internal/offer_routing.ts";
import {
	OfferIntakeRouter,
	type OfferIntakeOptions,
} from "../services/coordinator/offer_intake.ts";
import { InMemoryGatewayNetwork, InMemoryTaskStore } from "./support/in_memory.ts";
import {
	AGENT,
	COORDINATOR,
	FEED,
	INTAKE,
	NOW,
	OFFER_PAYLOAD,
	OTHER_AGENT,
	SECOND_FEED,
	SECOND_TASK_ID,
	TASK_ID,
	dispatchChange,
	fixtureValidation,
	makeDispatch,
	makeOffer,
	makeTask,
	offerChange,
} from "./support/offer_fixtures.ts";

function setup() {
	const network = new InMemoryGatewayNetwork();
	network.createSpace(INTAKE, [COORDINATOR], [AGENT, OTHER_AGENT]);
	network.createSpace(FEED, [AGENT, OTHER_AGENT], [COORDINATOR]);
	network.createSpace(SECOND_FEED, [AGENT], [COORDINATOR]);
	const taskStore = new InMemoryTaskStore();
	const errors: unknown[] = [];
	const results: OfferIntakeResult[] = [];
	const senderOptions: AgentOfferRouterOptions = {
		gateway: network.gateway(AGENT),
		coordinator: COORDINATOR,
		intakeSpace: INTAKE,
		feedSpaces: [FEED, SECOND_FEED],
		behavior: {
			onDispatch: async () => ({ decision: "accept", payload: OFFER_PAYLOAD }),
		},
		validation: fixtureValidation,
		createRkey: () => "3m22222222223",
		now: () => NOW,
		onError: (error) => errors.push(error),
	};
	const intakeOptions: OfferIntakeOptions = {
		gateway: network.gateway(COORDINATOR),
		intakeSpace: INTAKE,
		taskStore,
		validation: fixtureValidation,
		isAgentEligible: async (agent, task) =>
			[AGENT, OTHER_AGENT].includes(agent) && task.matchedFeeds.length > 0,
		validatePayload: (payload) => {
			assert.equal(payload.$type, "network.hivemind.mobility.ride#offer");
		},
		now: () => NOW,
		onError: (error) => errors.push(error),
		onResult: (result) => results.push(result),
	};
	return { network, taskStore, senderOptions, intakeOptions, errors, results };
}

test("dispatch -> behavior -> private intake -> task store, using injected implementations", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const sender = new AgentOfferRouter(context.senderOptions);
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.start();
	await sender.start();
	try {
		await context.network
			.gateway(COORDINATOR)
			.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
		await sender.drain();
		await intake.drain();
		const task = await context.taskStore.get(TASK_ID);
		assert.ok(task);
		assert.equal(task?.offers.length, 1);
		assert.equal(task.offers[0].agent, AGENT);
		assert.deepEqual(task.offers[0].offer.payload, OFFER_PAYLOAD);
		assert.equal(task.offers[0].offer.taskId, TASK_ID);
		assert.equal(context.results[0]?.status, "stored");
		assert.deepEqual(context.errors, []);
		// Intake is not readable by competing agents or by the offer's author.
		await assert.rejects(
			context.network.gateway(OTHER_AGENT).watchSpace(INTAKE, () => {}),
			SpaceAccessDeniedError,
		);
		await assert.rejects(
			context.network.gateway(AGENT).watchSpace(INTAKE, () => {}),
			SpaceAccessDeniedError,
		);
	} finally {
		await sender.stop();
		await intake.stop();
	}
});

test("agent deduplicates the same task arriving through multiple feeds", async () => {
	const context = setup();
	let decisions = 0;
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	const results = await Promise.all([
		sender.handleChange(dispatchChange()),
		sender.handleChange(dispatchChange({ space: SECOND_FEED })),
	]);
	assert.equal(decisions, 1);
	assert.equal(results.filter((result) => result.status === "sent").length, 1);
});

test("agent sends declines as well as accepted offers", async () => {
	const context = setup();
	context.senderOptions.behavior.onDispatch = async () => ({
		decision: "decline",
		declineReason: "busy",
	});
	const result = await new AgentOfferRouter(context.senderOptions).handleChange(
		dispatchChange(),
	);
	assert.equal(result.status, "sent");
	if (result.status === "sent") {
		assert.equal(result.offer.decision, "decline");
		assert.equal(result.offer.declineReason, "busy");
		assert.equal(result.offer.payload, undefined);
	}
});

test("agent ignores untrusted authors, unrelated spaces, and expired dispatches", async () => {
	const context = setup();
	let decisions = 0;
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	const expired = { ...makeDispatch(), respondBy: new Date(NOW).toISOString() };
	for (const change of [
		dispatchChange({ author: OTHER_AGENT }),
		dispatchChange({ space: INTAKE }),
		dispatchChange({ record: expired }),
	]) {
		assert.equal((await sender.handleChange(change)).status, "ignored");
	}
	assert.equal(decisions, 0);
});

test("agent rechecks the deadline after the behavior finishes", async () => {
	const context = setup();
	let now = NOW;
	context.senderOptions.now = () => now;
	context.senderOptions.behavior.onDispatch = async () => {
		now += 20_000;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const result = await new AgentOfferRouter(context.senderOptions).handleChange(
		dispatchChange(),
	);
	assert.deepEqual(result, {
		status: "ignored",
		reason: "dispatchClosedOrExpired",
	});
});

test("pending agent decision applies shorter deadlines, including expired updates", async () => {
	for (const updateAt of [NOW, NOW + 2_000]) {
		const context = setup();
		const decision = Promise.withResolvers<void>();
		let now = NOW;
		let decisions = 0;
		const writes: unknown[] = [];
		const unwatch = await context.network
			.gateway(COORDINATOR)
			.watchSpace(INTAKE, (change) => writes.push(change));
		context.senderOptions.now = () => now;
		context.senderOptions.behavior.onDispatch = async () => {
			decisions++;
			await decision.promise;
			return { decision: "accept", payload: OFFER_PAYLOAD };
		};
		const sender = new AgentOfferRouter(context.senderOptions);
		const pending = sender.handleChange(dispatchChange());
		now = updateAt;
		const update = await sender.handleChange(
			dispatchChange({
				action: "update",
				record: { ...makeDispatch(), respondBy: new Date(NOW + 1_000).toISOString() },
			}),
		);
		assert.equal(update.status, "ignored");
		now = NOW + 2_000;
		decision.resolve();
		assert.deepEqual(await pending, {
			status: "ignored",
			reason: "dispatchClosedOrExpired",
		});
		assert.equal(decisions, 1);
		assert.equal(writes.length, 0);
		unwatch();
	}
});

test("pending agent decision uses the latest extended deadline", async () => {
	const context = setup();
	const decision = Promise.withResolvers<void>();
	let now = NOW;
	let decisions = 0;
	context.senderOptions.now = () => now;
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		await decision.promise;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	const pending = sender.handleChange(dispatchChange());
	for (const deadline of [NOW + 1_000, NOW + 20_000]) {
		if (deadline === NOW + 20_000) now = NOW + 12_000;
		const update = await sender.handleChange(
			dispatchChange({
				action: "update",
				record: { ...makeDispatch(), respondBy: new Date(deadline).toISOString() },
			}),
		);
		assert.equal(update.status, "ignored");
	}
	decision.resolve();
	assert.equal((await pending).status, "sent");
	assert.equal(decisions, 1);
});

test("deadline updates do not reopen a closed dispatch during evaluation", async () => {
	const context = setup();
	const decision = Promise.withResolvers<void>();
	context.senderOptions.behavior.onDispatch = async () => {
		await decision.promise;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	const pending = sender.handleChange(dispatchChange());
	await sender.handleChange(dispatchChange({ action: "delete", record: undefined }));
	assert.deepEqual(
		await sender.handleChange(
			dispatchChange({
				action: "update",
				record: { ...makeDispatch(), respondBy: new Date(NOW + 20_000).toISOString() },
			}),
		),
		{ status: "ignored", reason: "alreadyAnsweredOrClosed" },
	);
	decision.resolve();
	assert.deepEqual(await pending, {
		status: "ignored",
		reason: "dispatchClosedOrExpired",
	});
});

test("deadline updates do not resend an already-sent offer", async () => {
	const context = setup();
	let decisions = 0;
	const writes: unknown[] = [];
	const unwatch = await context.network
		.gateway(COORDINATOR)
		.watchSpace(INTAKE, (change) => writes.push(change));
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	assert.equal((await sender.handleChange(dispatchChange())).status, "sent");
	assert.deepEqual(
		await sender.handleChange(
			dispatchChange({
				action: "update",
				record: { ...makeDispatch(), respondBy: new Date(NOW + 20_000).toISOString() },
			}),
		),
		{ status: "ignored", reason: "alreadyAnsweredOrClosed" },
	);
	assert.equal(decisions, 1);
	assert.equal(writes.length, 1);
	unwatch();
});

test("deleting a dispatch while the behavior is evaluating prevents the offer write", async () => {
	const context = setup();
	const decision = Promise.withResolvers<void>();
	context.senderOptions.behavior.onDispatch = async () => {
		await decision.promise;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	const pending = sender.handleChange(dispatchChange());
	await sender.handleChange(
		dispatchChange({ action: "delete", record: undefined }),
	);
	decision.resolve();
	assert.equal((await pending).status, "ignored");
});

test("a failed write can be retried with the same offer/key, without another decision", async () => {
	const context = setup();
	const gateway = context.senderOptions.gateway;
	const keys: string[] = [];
	let decisions = 0;
	let keyCalls = 0;
	context.senderOptions.createRkey = () => {
		keyCalls++;
		return "3m22222222223";
	};
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	context.senderOptions.gateway = {
		...gateway,
		putSpaceRecord: async (space, collection, rkey, record) => {
			keys.push(rkey);
			if (keys.length === 1) throw new Error("temporary transport failure");
			await gateway.putSpaceRecord(space, collection, rkey, record);
		},
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	await assert.rejects(sender.handleChange(dispatchChange()), /transport failure/);
	assert.equal((await sender.handleChange(dispatchChange())).status, "sent");
	assert.equal(decisions, 1);
	assert.equal(keyCalls, 1);
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
});

test("intake collects simultaneous agents without overwriting an offer", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const intake = new OfferIntakeRouter(context.intakeOptions);
	const results = await Promise.all([
		intake.handleChange(offerChange()),
		intake.handleChange(offerChange({ author: OTHER_AGENT })),
	]);
	assert.ok(results.every((result) => result.status === "stored"));
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 2);
});

test("intake uses the authenticated change author and rejects an ineligible agent", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	context.intakeOptions.isAgentEligible = async (agent) => agent === AGENT;
	const result = await new OfferIntakeRouter(context.intakeOptions).handleChange(
		offerChange({ author: OTHER_AGENT, record: { ...makeOffer(), agent: AGENT } }),
	);
	assert.deepEqual(result, { status: "rejected", reason: "agentNotEligible" });
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 0);
});

test("intake ignores records outside intake or in another collection", async () => {
	const context = setup();
	const intake = new OfferIntakeRouter(context.intakeOptions);
	for (const change of [
		offerChange({ space: FEED }),
		offerChange({ collection: "network.hivemind.requester.request" }),
	]) {
		assert.equal((await intake.handleChange(change)).status, "ignored");
	}
});

test("unknown tasks, invalid records, missing terms, and invalid payloads are rejected", async () => {
	const context = setup();
	const intake = new OfferIntakeRouter(context.intakeOptions);
	assert.deepEqual(await intake.handleChange(offerChange()), {
		status: "rejected",
		reason: "unknownTask",
	});
	await context.taskStore.put(makeTask());
	assert.deepEqual(
		await intake.handleChange(
			offerChange({ record: { ...makeOffer(), decision: "unknown" } }),
		),
		{ status: "rejected", reason: "invalidOffer" },
	);
	assert.deepEqual(
		await intake.handleChange(
			offerChange({ record: { ...makeOffer(), payload: undefined } }),
		),
		{ status: "rejected", reason: "acceptWithoutPayload" },
	);
	assert.deepEqual(
		await intake.handleChange(
			offerChange({
				record: { ...makeOffer(), payload: { $type: "example.invalid#offer" } },
			}),
		),
		{ status: "rejected", reason: "invalidPayload" },
	);
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 0);
});

test("intake stores declines without running task-specific payload validation", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	context.intakeOptions.validatePayload = () => {
		throw new Error("must not be called for a decline");
	};
	const result = await new OfferIntakeRouter(context.intakeOptions).handleChange(
		offerChange({
			record: {
				$type: OFFER_COLLECTION,
				taskId: TASK_ID,
				decision: "decline",
				declineReason: "busy",
				createdAt: new Date(NOW).toISOString(),
			},
		}),
	);
	assert.equal(result.status, "stored");
});

test("intake rejects expired, closed, and missing-deadline tasks", async () => {
	for (const state of [
		{ phase: "collecting", respondBy: new Date(NOW).toISOString() },
		{ phase: "assigned", respondBy: new Date(NOW + 10_000).toISOString() },
		{ phase: "collecting", respondBy: undefined },
	]) {
		const context = setup();
		const task = makeTask();
		Object.assign(task.state, state);
		await context.taskStore.put(task);
		const result = await new OfferIntakeRouter(context.intakeOptions).handleChange(
			offerChange(),
		);
		assert.deepEqual(result, { status: "rejected", reason: "collectionClosed" });
	}
});

test("intake rechecks closure after asynchronous eligibility checks", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	context.intakeOptions.isAgentEligible = async () => {
		const closed = makeTask();
		closed.state.phase = "assigned";
		await context.taskStore.put(closed);
		return true;
	};
	const result = await new OfferIntakeRouter(context.intakeOptions).handleChange(
		offerChange(),
	);
	assert.deepEqual(result, { status: "rejected", reason: "collectionClosed" });
});

test("replayed records and extra records from the same agent do not duplicate offers", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const intake = new OfferIntakeRouter(context.intakeOptions);
	assert.equal((await intake.handleChange(offerChange())).status, "stored");
	assert.equal((await intake.handleChange(offerChange())).status, "ignored");
	assert.equal(
		(await intake.handleChange(offerChange({ rkey: "3m22222222224" }))).status,
		"ignored",
	);
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
});

test("an existing offer record cannot be moved to another task", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const second = makeTask();
	second.taskId = SECOND_TASK_ID;
	second.request.taskId = SECOND_TASK_ID;
	await context.taskStore.put(second);
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.handleChange(offerChange());
	const result = await intake.handleChange(
		offerChange({
			action: "update",
			record: { ...makeOffer(), taskId: SECOND_TASK_ID },
		}),
	);
	assert.deepEqual(result, { status: "rejected", reason: "offerTaskChanged" });
	assert.equal((await context.taskStore.get(SECOND_TASK_ID))?.offers.length, 0);
});

test("deleting the author's offer withdraws it, and repeated deletes are harmless", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const sender = new AgentOfferRouter(context.senderOptions);
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.start();
	try {
		await sender.handleChange(dispatchChange());
		await intake.drain();
		await sender.withdraw(TASK_ID);
		await intake.drain();
		assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 0);
		assert.equal(context.results.at(-1)?.status, "withdrawn");
		assert.equal(
			(
				await intake.handleChange(
					offerChange({ action: "delete", record: undefined }),
				)
			).status,
			"ignored",
		);
	} finally {
		await intake.stop();
	}
});

test("one agent cannot withdraw another agent's offer", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.handleChange(offerChange());
	await intake.handleChange(
		offerChange({ action: "delete", author: OTHER_AGENT, record: undefined }),
	);
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
});

test("withdrawal after collection closes does not change the ranked input", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.handleChange(offerChange());
	const task = await context.taskStore.get(TASK_ID);
	assert.ok(task);
	task.state.phase = "awaitingSelection";
	await context.taskStore.put(task);
	const result = await intake.handleChange(
		offerChange({ action: "delete", record: undefined }),
	);
	assert.deepEqual(result, { status: "rejected", reason: "collectionClosed" });
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
});

test("watchers process existing records on startup, stop cleanly, and restart idempotently", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	await context.network
		.gateway(COORDINATOR)
		.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
	const sender = new AgentOfferRouter(context.senderOptions);
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await Promise.all([sender.start(), sender.start()]);
	await sender.drain();
	await intake.start();
	await intake.drain();
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
	await sender.stop();
	await intake.stop();
	await sender.start();
	await intake.start();
	await sender.drain();
	await intake.drain();
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
	await sender.stop();
	await intake.stop();
});

test("exhausted store retries reject the caller without breaking later intake processing", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const store = context.taskStore;
	let failures = 0;
	context.intakeOptions.taskStore = {
		get: (id) => store.get(id),
		findByRecord: (author, collection, rkey) =>
			store.findByRecord(author, collection, rkey),
		listOpen: () => store.listOpen(),
		put: async (task) => {
			if (++failures <= 3) {
				throw new Error("temporary storage failure");
			}
			await store.put(task);
		},
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await assert.rejects(intake.handleChange(offerChange()), /storage failure/);
	assert.equal((await intake.handleChange(offerChange())).status, "stored");
});

test("a background offer automatically recovers from a failed store write", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const put = context.taskStore.put.bind(context.taskStore);
	let attempts = 0;
	context.taskStore.put = async (task) => {
		if (++attempts === 1) throw new Error("temporary storage failure");
		await put(task);
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.start();
	try {
		// Deliver exactly one notification. The router must recover without a second
		// gateway event, manual handleChange call, or watcher restart.
		await context.network
			.gateway(AGENT)
			.putSpaceRecord(INTAKE, OFFER_COLLECTION, "3m22222222223", makeOffer());
		await intake.drain();
		assert.equal(attempts, 2);
		assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
		assert.equal(context.results[0]?.status, "stored");
		assert.deepEqual(context.errors, []);
	} finally {
		await intake.stop();
	}
});

test("background store retries are bounded and report exhaustion once", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const failure = new Error("persistent storage failure");
	let attempts = 0;
	context.taskStore.put = async () => {
		attempts++;
		throw failure;
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await intake.start();
	try {
		await context.network
			.gateway(AGENT)
			.putSpaceRecord(INTAKE, OFFER_COLLECTION, "3m22222222223", makeOffer());
		await intake.drain();
		await Promise.resolve();
		assert.equal(attempts, 3);
		assert.deepEqual(context.errors, [failure]);
		assert.deepEqual(context.results, []);
		assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 0);
	} finally {
		await intake.stop();
	}
});

test("a store retry stops if collection closes or its deadline passes", async () => {
	for (const closeBy of ["phase", "deadline"]) {
		const context = setup();
		await context.taskStore.put(makeTask());
		const put = context.taskStore.put.bind(context.taskStore);
		let attempts = 0;
		context.taskStore.put = async () => {
			attempts++;
			const task = makeTask();
			if (closeBy === "phase") task.state.phase = "assigned";
			else task.state.respondBy = new Date(NOW).toISOString();
			await put(task);
			throw new Error("storage failed while collection closed");
		};
		const intake = new OfferIntakeRouter(context.intakeOptions);
		assert.deepEqual(await intake.handleChange(offerChange()), {
			status: "rejected",
			reason: "collectionClosed",
		});
		assert.equal(attempts, 1);
		assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 0);
	}
});

test("a write committed before an error is not duplicated on automatic retry", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const put = context.taskStore.put.bind(context.taskStore);
	let attempts = 0;
	context.taskStore.put = async (task) => {
		attempts++;
		await put(task);
		throw new Error("write committed but acknowledgement failed");
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	assert.deepEqual(await intake.handleChange(offerChange()), {
		status: "ignored",
		reason: "alreadyAnswered",
	});
	assert.equal(attempts, 1);
	assert.equal((await context.taskStore.get(TASK_ID))?.offers.length, 1);
});

test("an automatic retry preserves other answers written after the first failure", async () => {
	const context = setup();
	await context.taskStore.put(makeTask());
	const put = context.taskStore.put.bind(context.taskStore);
	let attempts = 0;
	context.taskStore.put = async (task) => {
		if (++attempts === 1) {
			const updated = makeTask();
			updated.offers.push({
				agent: OTHER_AGENT,
				rkey: "3m22222222224",
				offer: makeOffer(),
			});
			await put(updated);
			throw new Error("temporary storage failure");
		}
		await put(task);
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	assert.equal((await intake.handleChange(offerChange())).status, "stored");
	const task = await context.taskStore.get(TASK_ID);
	assert.deepEqual(task?.offers.map((entry) => entry.agent), [OTHER_AGENT, AGENT]);
	assert.equal(attempts, 2);
});

test("background failures are reported through the injected observer", async () => {
	const context = setup();
	context.senderOptions.behavior.onDispatch = async () => {
		throw new Error("decision service unavailable");
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	await sender.start();
	await context.network
		.gateway(COORDINATOR)
		.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
	await sender.drain();
	assert.match(String(context.errors[0]), /decision service unavailable/);
	await sender.stop();
});

test("an invalid dispatch is rejected before calling the behavior", async () => {
	const context = setup();
	let called = false;
	context.senderOptions.behavior.onDispatch = async () => {
		called = true;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const result = await new AgentOfferRouter(context.senderOptions).handleChange(
		dispatchChange({ record: { $type: "example.invalid#dispatch" } }),
	);
	assert.deepEqual(result, { status: "rejected", reason: "invalidDispatch" });
	assert.equal(called, false);
});

test("a failure generating a record key retries without requesting another offer", async () => {
	const context = setup();
	let calls = 0;
	let decisions = 0;
	let now = NOW;
	context.senderOptions.now = () => now;
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	context.senderOptions.createRkey = () => {
		if (++calls === 1) throw new Error("TID generator unavailable");
		return "3m22222222223";
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	await assert.rejects(sender.handleChange(dispatchChange()), /TID generator/);
	now += 1_000;
	const result = await sender.handleChange(dispatchChange());
	assert.equal(result.status, "sent");
	assert.equal(decisions, 1);
	assert.equal(calls, 2);
	if (result.status === "sent") {
		assert.equal(result.offer.createdAt, new Date(NOW).toISOString());
	}
});

test("an empty record key is rejected and retried without requesting another offer", async () => {
	const context = setup();
	let calls = 0;
	let decisions = 0;
	const writes: unknown[] = [];
	const unwatch = await context.network
		.gateway(COORDINATOR)
		.watchSpace(INTAKE, (change) => writes.push(change));
	context.senderOptions.behavior.onDispatch = async () => {
		decisions++;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	context.senderOptions.createRkey = () => (++calls === 1 ? "" : "3m22222222223");
	const sender = new AgentOfferRouter(context.senderOptions);
	await assert.rejects(sender.handleChange(dispatchChange()), /key must not be empty/);
	assert.equal(writes.length, 0);
	assert.equal((await sender.handleChange(dispatchChange())).status, "sent");
	assert.equal(decisions, 1);
	assert.equal(calls, 2);
	assert.equal(writes.length, 1);
	unwatch();
});

test("an unauthorized writer cannot put an offer in the intake space", async () => {
	const context = setup();
	await assert.rejects(
		context.network
			.gateway("did:web:unregistered.example")
			.putSpaceRecord(INTAKE, OFFER_COLLECTION, "3m22222222223", makeOffer()),
		SpaceAccessDeniedError,
	);
});

test("stopping an agent during evaluation prevents its pending write", async () => {
	const context = setup();
	const decision = Promise.withResolvers<void>();
	context.senderOptions.behavior.onDispatch = async () => {
		await decision.promise;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	await sender.start();
	await context.network
		.gateway(COORDINATOR)
		.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
	const stopping = sender.stop();
	decision.resolve();
	await stopping;
	const offers: unknown[] = [];
	const unwatch = await context.network
		.gateway(COORDINATOR)
		.watchSpace(INTAKE, (change) => offers.push(change));
	unwatch();
	assert.equal(offers.length, 0);
});

test("a partially failed feed subscription cleans up earlier watchers", async () => {
	const context = setup();
	let called = false;
	context.senderOptions.feedSpaces = [FEED, INTAKE];
	context.senderOptions.behavior.onDispatch = async () => {
		called = true;
		return { decision: "accept", payload: OFFER_PAYLOAD };
	};
	const sender = new AgentOfferRouter(context.senderOptions);
	await assert.rejects(sender.start(), SpaceAccessDeniedError);
	await context.network
		.gateway(COORDINATOR)
		.putSpaceRecord(FEED, DISPATCH_COLLECTION, TASK_ID, makeDispatch());
	await sender.drain();
	assert.equal(called, false);
});

test("a failed put does not mutate a task returned by reference from a store adapter", async () => {
	const context = setup();
	const task = makeTask();
	context.intakeOptions.taskStore = {
		get: async () => task,
		findByRecord: async () => undefined,
		listOpen: async () => [task],
		put: async () => {
			throw new Error("write failed");
		},
	};
	const intake = new OfferIntakeRouter(context.intakeOptions);
	await assert.rejects(intake.handleChange(offerChange()), /write failed/);
	assert.equal(task.offers.length, 0);

	task.offers.push({
		agent: AGENT,
		rkey: "3m22222222223",
		offer: makeOffer(),
	});
	context.intakeOptions.taskStore.findByRecord = async () => task;
	await assert.rejects(
		intake.handleChange(offerChange({ action: "delete", record: undefined })),
		/write failed/,
	);
	assert.equal(task.offers.length, 1);
});
