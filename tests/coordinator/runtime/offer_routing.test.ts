import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { l } from "@atproto/lex";
import { DEFAULT_BILLING_CONFIG } from "../../../core/coordinator/config/billing_config.js";
import { DEFAULT_TASKS_CONFIG } from "../../../core/coordinator/config/tasks_config.js";
import { BillingRuntime } from "../../../core/coordinator/runtime/billing.js";
import { TaskRunner } from "../../../core/coordinator/runtime/task_runner.js";
import * as hivemind from "../../../core/protocol/generated/com/hivemind-network.js";
import type { RecordChange } from "../../../core/protocol/interfaces/internal/atproto_gateway.js";
import { AgentOfferRouter } from "../../../hivemind_sdk/hivemind_agent.js";
import { eventually } from "../../gateway/gateway_contract.js";
import { createOfferRoutingWorld } from "../../hivemind_sdk/offer_routing_world.js";
import {
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	FakeSpaceService,
	fakeMatching,
	fakeRouter,
	fakeSigner,
	OPERATOR,
	RIDER,
	registration,
	rideOffer,
	rideRequest,
	TAXI_ONE,
} from "../fixtures.js";

// K4 -> S2 -> existing TaskRunner collection, with the actual in-memory network, Gateway,
// coordinator access checks, generated validators, task-type validation and memory stores.
// Request/feed service operations outside offer routing still use their existing test fixtures.
test("routes a feed dispatch through the offer inbox into the coordinator, then withdraws it", async (t) => {
	const world = await createOfferRoutingWorld();
	const errors: unknown[] = [];
	const spaces = new FakeSpaceService();
	spaces.watchOfferIntake = world.spaces.watchOfferIntake.bind(world.spaces);
	const runner = new TaskRunner(
		{
			stores: world.stores,
			spaces,
			router: fakeRouter,
			matching: fakeMatching,
			signer: fakeSigner,
			billing: new BillingRuntime(world.stores, DEFAULT_BILLING_CONFIG),
			clock: world.clock,
			onError: (error) => {
				errors.push(error);
			},
		},
		DEFAULT_TASKS_CONFIG,
	);
	const agent = new AgentOfferRouter({
		gateway: world.taxi,
		coordinator: COORDINATOR,
		feeds: [DOWNTOWN_FEED],
		behavior: {
			onDispatch: async (dispatch) => {
				const { payload } = rideOffer(dispatch.taskId, 180);
				assert.ok(payload);
				return { decision: "accept", payload };
			},
		},
		now: () => world.clock.now(),
		onError: (error) => {
			errors.push(error);
		},
	});
	t.after(async () => {
		await agent.stop();
		await runner.stop();
	});
	await runner.start();
	await agent.start();
	spaces.pushRequest(
		created(RIDER, "3m5abcde23456", rideRequest(world.dispatch.taskId)),
	);
	await runner.settled();
	const dispatch = spaces.dispatches.get(
		`${DOWNTOWN_FEED} ${world.dispatch.taskId}`,
	);
	assert.ok(dispatch);
	await world.publish(dispatch);
	await eventually(async () => {
		const task = await world.stores.tasks.get(dispatch.taskId);
		assert.ok(task);
		assert.equal(task.offers.length, 1);
		assert.equal(task.offers[0].agent, TAXI_ONE);
		assert.equal(task.offers[0].offer.decision, "accept");
		// The other seeded taxi has not answered, so the coordinator keeps collecting
		assert.equal(task.state.phase, "collecting");
	});
	await agent.settled();
	await runner.settled();
	await agent.withdraw(dispatch.taskId);
	await eventually(async () =>
		assert.equal(
			(await world.stores.tasks.get(dispatch.taskId))?.offers.length,
			0,
		),
	);
	assert.deepEqual(errors, []);
	assert.deepEqual(world.network.hiddenWrites, []);
});

test("offer inbox setup is repeatable and watches replay, updates and deletions of offers only", async (t) => {
	const world = await createOfferRoutingWorld();
	assert.equal(
		await world.spaces.setUpOfferIntake(world.offerPolicy),
		world.intake,
	);
	const offer = rideOffer(world.dispatch.taskId, 180);
	const collection = hivemind.agent.offer.$nsid;
	await world.taxi.putSpaceRecord(
		world.intake,
		collection,
		"3m5abcde23456",
		l.asUnknown$TypedObject(offer),
	);
	const changes: RecordChange[] = [];
	const stop = await world.spaces.watchOfferIntake((change) => {
		changes.push(change);
	});
	t.after(stop);
	await eventually(() => assert.equal(changes.length, 1));
	assert.equal(changes[0].action, "create");
	await world.taxi.putSpaceRecord(
		world.intake,
		collection,
		"3m5abcde23456",
		l.asUnknown$TypedObject({ ...offer, decision: "decline" }),
	);
	await world.taxi.deleteSpaceRecord(world.intake, collection, "3m5abcde23456");
	await world.taxi.putSpaceRecord(
		world.intake,
		"com.example.unrelated",
		"unrelated",
		l.asUnknown$TypedObject({ $type: "com.example.unrelated" }),
	);
	await eventually(() =>
		assert.deepEqual(
			changes.map((change) => change.action),
			["create", "update", "delete"],
		),
	);
	stop();
	await world.taxi.putSpaceRecord(
		world.intake,
		collection,
		"3m5abcde23456",
		l.asUnknown$TypedObject(offer),
	);
	// A timer turn flushes the local network's queued deliveries
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(changes.length, 3);
});

// Open a collecting task; the second seeded taxi keeps collection open after the first answers.
async function collectingHarness(t: TestContext) {
	const world = await createOfferRoutingWorld();
	const errors: unknown[] = [];
	const spaces = new FakeSpaceService();
	spaces.watchOfferIntake = world.spaces.watchOfferIntake.bind(world.spaces);
	const runner = new TaskRunner(
		{
			stores: world.stores,
			spaces,
			router: fakeRouter,
			matching: fakeMatching,
			signer: fakeSigner,
			billing: new BillingRuntime(world.stores, DEFAULT_BILLING_CONFIG),
			clock: world.clock,
			onError: (error) => {
				errors.push(error);
			},
		},
		DEFAULT_TASKS_CONFIG,
	);
	t.after(() => runner.stop());
	await runner.start();
	spaces.pushRequest(
		created(RIDER, "3m5abcde23456", rideRequest(world.dispatch.taskId)),
	);
	await runner.settled();
	const sendOffer = async (offer = rideOffer(world.dispatch.taskId, 180)) => {
		await world.taxi.putSpaceRecord(
			world.intake,
			hivemind.agent.offer.$nsid,
			"3m5abcde23457",
			l.asUnknown$TypedObject(offer),
		);
		await runner.settled();
	};
	return { ...world, runner, errors, sendOffer };
}

test("coordinator rejects an offer at the exact collection deadline even before its timer runs", async (t) => {
	const world = await collectingHarness(t);
	const task = await world.stores.tasks.get(world.dispatch.taskId);
	assert.ok(task?.state.respondBy);
	// Advance the observed time without running timers, as can happen while the event loop is busy
	world.clock.now = () => new Date(task.state.respondBy ?? "");
	await world.sendOffer();
	assert.equal(
		(await world.stores.tasks.get(world.dispatch.taskId))?.offers.length,
		0,
	);
});

test("coordinator automatically retries a failed offer storage operation", async (t) => {
	const world = await collectingHarness(t);
	const put = world.stores.tasks.put.bind(world.stores.tasks);
	let attempts = 0;
	world.stores.tasks.put = async (task) => {
		if (task.offers.length > 0 && ++attempts === 1) {
			throw new Error("temporary database failure");
		}
		await put(task);
	};
	await world.sendOffer();
	assert.equal(world.errors.length, 1);
	world.clock.advanceBy(DEFAULT_TASKS_CONFIG.firstRetryDelayMs);
	await world.runner.settled();
	assert.equal(
		(await world.stores.tasks.get(world.dispatch.taskId))?.offers.length,
		1,
	);
	assert.equal(attempts, 2);
});

for (const change of [
	"updated",
	"deleted",
	"replaced",
	"expired",
	"suspended",
	"stopped",
] as const) {
	test(`a failed offer write respects a task or offer that was ${change} before retry`, async (t) => {
		const world = await collectingHarness(t);
		const put = world.stores.tasks.put.bind(world.stores.tasks);
		let attempts = 0;
		world.stores.tasks.put = async (task) => {
			if (task.offers.length > 0 && ++attempts === 1) {
				throw new Error("temporary database failure");
			}
			await put(task);
		};
		await world.sendOffer();
		if (change === "updated") {
			await world.sendOffer(rideOffer(world.dispatch.taskId, 90));
		} else if (change === "deleted") {
			await world.taxi.deleteSpaceRecord(
				world.intake,
				hivemind.agent.offer.$nsid,
				"3m5abcde23457",
			);
		} else if (change === "replaced") {
			await world.taxi.putSpaceRecord(
				world.intake,
				hivemind.agent.offer.$nsid,
				"3m5abcde23458",
				l.asUnknown$TypedObject(rideOffer(world.dispatch.taskId, 90)),
			);
		} else if (change === "expired") {
			world.clock.advanceBy(30_000);
		} else if (change === "suspended") {
			await world.stores.participants.put(
				registration(OPERATOR, "operator", "suspended"),
			);
		} else {
			await world.runner.stop();
		}
		await world.runner.settled();
		world.clock.advanceBy(DEFAULT_TASKS_CONFIG.firstRetryDelayMs);
		await world.runner.settled();
		const task = await world.stores.tasks.get(world.dispatch.taskId);
		assert.ok(task);
		if (change === "updated" || change === "replaced") {
			assert.equal(task.offers.length, 1);
			assert.deepEqual(
				task.offers[0].offer.payload,
				rideOffer(world.dispatch.taskId, 90).payload,
			);
		} else {
			assert.equal(task.offers.length, 0);
		}
	});
}

test("coordinator bounds storage retries and cancels their timers after exhaustion", async (t) => {
	const world = await collectingHarness(t);
	const put = world.stores.tasks.put.bind(world.stores.tasks);
	let attempts = 0;
	world.stores.tasks.put = async (task) => {
		if (task.offers.length > 0) {
			attempts++;
			throw new Error("database offline");
		}
		await put(task);
	};
	await world.sendOffer();
	for (const delay of [1_000, 2_000, 4_000]) {
		world.clock.advanceBy(delay);
		await world.runner.settled();
	}
	assert.equal(attempts, DEFAULT_TASKS_CONFIG.maxOfferStoreAttempts);
	assert.equal(world.errors.length, attempts);
	// Only the task's collection deadline remains
	assert.equal(world.clock.pendingTimers, 1);
});

test("coordinator retries a failed offer withdrawal without restoring the offer", async (t) => {
	const world = await collectingHarness(t);
	await world.sendOffer();
	const put = world.stores.tasks.put.bind(world.stores.tasks);
	let attempts = 0;
	world.stores.tasks.put = async (task) => {
		if (task.offers.length === 0 && ++attempts === 1) {
			throw new Error("temporary deletion failure");
		}
		await put(task);
	};
	await world.taxi.deleteSpaceRecord(
		world.intake,
		hivemind.agent.offer.$nsid,
		"3m5abcde23457",
	);
	await world.runner.settled();
	world.clock.advanceBy(DEFAULT_TASKS_CONFIG.firstRetryDelayMs);
	await world.runner.settled();
	assert.equal(
		(await world.stores.tasks.get(world.dispatch.taskId))?.offers.length,
		0,
	);
	assert.equal(attempts, 2);
});
