import assert from "node:assert/strict";
import { test } from "node:test";
import { l } from "@atproto/lex";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import { SpaceAccessDeniedError } from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type { OfferAnswer } from "../../core/protocol/interfaces/internal/client_lib.js";
import type { AgentOffer } from "../../core/protocol/interfaces/internal/types.js";
import {
	feedKeyOf,
	feedSpaceRef,
	SPACE_TYPES,
} from "../../core/protocol/protocol_config/space_definition.js";
import {
	AgentOfferRouter,
	type AgentOfferRouterDependencies,
} from "../../hivemind_sdk/hivemind_agent.js";
import {
	agentProfile,
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	FEED_OWNER,
	feedDeclaration,
	PRIVATE_FEED,
	rideOffer,
	START,
	TAXI_ONE,
} from "../coordinator/fixtures.js";
import { eventually, loadPolicy } from "../gateway/gateway_contract.js";
import { createOfferRoutingWorld } from "./offer_routing_world.js";

// Follow dispatches through LocalSimGateway; do not replace the Gateway with a recording fake.

async function harness(overrides: Partial<AgentOfferRouterDependencies> = {}) {
	const world = await createOfferRoutingWorld();
	const errors: unknown[] = [];
	const sent: AgentOffer[] = [];
	let decisions = 0;
	const dependencies: AgentOfferRouterDependencies = {
		gateway: world.taxi,
		coordinator: COORDINATOR,
		feeds: [DOWNTOWN_FEED],
		behavior: {
			onDispatch: async (dispatch) => {
				decisions++;
				const { payload } = rideOffer(dispatch.taskId, 180);
				assert.ok(payload);
				return {
					decision: "accept",
					payload,
				};
			},
		},
		now: () => world.clock.now(),
		onError: (error) => {
			errors.push(error);
		},
		onSent: (offer) => {
			sent.push(offer);
		},
		sleep: async () => {},
		...overrides,
	};
	const router = new AgentOfferRouter(dependencies);
	return {
		...world,
		dependencies,
		router,
		errors,
		sent,
		decisions: () => decisions,
	};
}

test("replays an existing dispatch, writes a validated offer, and ignores repeat deliveries", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	await world.publish();
	await world.router.start();
	await eventually(() => assert.equal(world.sent.length, 1));
	await world.publish();
	await world.router.settled();
	assert.equal(world.decisions(), 1);
	assert.equal(world.sent.length, 1);
	const received: AgentOffer[] = [];
	const stop = await world.spaces.watchOfferIntake((change) => {
		received.push(hivemind.agent.offer.main.parse(change.record));
	});
	t.after(stop);
	await eventually(() => assert.equal(received.length, 1));
	assert.equal(received[0].taskId, world.dispatch.taskId);
	assert.equal(received[0].decision, "accept");
	assert.deepEqual(world.errors, []);
	assert.deepEqual(world.network.hiddenWrites, []);
	await assert.rejects(
		world.taxi.watchSpace(world.intake, () => {}),
		SpaceAccessDeniedError,
	);
});

test("routes a decline and withdraws it by deleting the offer", async (t) => {
	const world = await harness({
		behavior: {
			onDispatch: async () => ({ decision: "decline", declineReason: "busy" }),
		},
	});
	t.after(() => world.router.stop());
	const actions: string[] = [];
	const stop = await world.spaces.watchOfferIntake((change) => {
		actions.push(change.action);
	});
	t.after(stop);
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(world.sent.length, 1));
	assert.equal(world.sent[0].decision, "decline");
	assert.equal(world.sent[0].declineReason, "busy");
	await world.router.withdraw(world.dispatch.taskId);
	await eventually(() => assert.deepEqual(actions, ["create", "delete"]));
});

for (const close of ["deadline update", "deletion", "stop"] as const) {
	test(`suppresses a pending decision after ${close}`, async (t) => {
		let finish: (answer: OfferAnswer) => void = () => {};
		let started = false;
		const decision = new Promise<OfferAnswer>((resolve) => {
			finish = resolve;
		});
		const world = await harness({
			behavior: {
				onDispatch: () => {
					started = true;
					return decision;
				},
			},
		});
		t.after(async () => {
			finish({ decision: "decline" });
			await world.router.stop();
		});
		await world.router.start();
		await world.publish();
		await eventually(() => assert.equal(started, true));
		let stopping: Promise<void> | undefined;
		if (close === "deadline update") {
			await world.publish({
				...world.dispatch,
				respondBy: l.toDatetimeString(START),
			});
		} else if (close === "deletion") {
			await world.coordinator.deleteSpaceRecord(
				world.feed,
				hivemind.coordinator.dispatch.$nsid,
				world.dispatch.taskId,
			);
		} else {
			stopping = world.router.stop();
		}
		finish({ decision: "decline" });
		await stopping;
		await world.router.settled();
		assert.equal(world.sent.length, 0);
		assert.deepEqual(world.errors, []);
	});
}

test("uses an extended deadline when an operator decision finishes after the original one", async (t) => {
	let finish: (answer: OfferAnswer) => void = () => {};
	let started = false;
	const decision = new Promise<OfferAnswer>((resolve) => {
		finish = resolve;
	});
	const world = await harness({
		behavior: {
			onDispatch: () => {
				started = true;
				return decision;
			},
		},
	});
	t.after(async () => {
		finish({ decision: "decline" });
		await world.router.stop();
	});
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(started, true));
	await world.publish({
		...world.dispatch,
		respondBy: l.toDatetimeString(new Date(START.getTime() + 60_000)),
	});
	world.clock.advanceBy(31_000);
	finish({ decision: "decline" });
	await world.router.settled();
	assert.equal(world.sent.length, 1);
});

test("automatically retries a failed write with the same decision and record key", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	const keys: string[] = [];
	world.dependencies.gateway = {
		watchSpace: world.taxi.watchSpace.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		putSpaceRecord: async (space, collection, rkey, record) => {
			keys.push(rkey);
			// Simulate a write that succeeded, but whose acknowledgement was lost
			await world.taxi.putSpaceRecord(space, collection, rkey, record);
			if (keys.length === 1) {
				throw new Error("lost write acknowledgement");
			}
		},
	};
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(world.sent.length, 1));
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
	assert.equal(world.decisions(), 1);
	assert.deepEqual(world.errors, []);
});

test("keeps the offer through failed and empty key generation", async (t) => {
	let attempts = 0;
	const world = await harness({
		createRkey: () => {
			attempts++;
			if (attempts === 1) {
				throw new Error("key generator unavailable");
			}
			return attempts === 2 ? "" : "3m5abcde23456";
		},
	});
	t.after(() => world.router.stop());
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(world.sent.length, 1));
	assert.equal(attempts, 3);
	assert.equal(world.decisions(), 1);
});

test("bounds failed writes and reports the failure", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	let attempts = 0;
	world.dependencies.gateway = {
		watchSpace: world.taxi.watchSpace.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		putSpaceRecord: async () => {
			attempts++;
			throw new Error("offline");
		},
	};
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(world.errors.length, 1));
	assert.equal(attempts, 3);
	assert.equal(world.decisions(), 1);
});

test("rechecks the deadline before retrying a failed write", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	let attempts = 0;
	world.dependencies.gateway = {
		watchSpace: world.taxi.watchSpace.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		putSpaceRecord: async () => {
			attempts++;
			throw new Error("offline");
		},
	};
	world.dependencies.sleep = async () => {
		world.clock.advanceBy(30_000);
	};
	await world.router.start();
	await world.publish();
	await eventually(() => assert.equal(attempts, 1));
	await world.router.settled();
	assert.equal(attempts, 1);
	assert.equal(world.sent.length, 0);
});

test("ignores expired or invalid dispatches and rejects accepts without terms", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	await world.router.start();
	await world.publish({
		...world.dispatch,
		respondBy: l.toDatetimeString(START),
	});
	await world.coordinator.putSpaceRecord(
		world.feed,
		hivemind.coordinator.dispatch.$nsid,
		"invalid",
		l.asUnknown$TypedObject({ $type: hivemind.coordinator.dispatch.$nsid }),
	);
	await world.router.settled();
	assert.equal(world.decisions(), 0);
	world.dependencies.behavior = {
		onDispatch: async () => ({ decision: "accept" }) as OfferAnswer,
	};
	await world.publish();
	await eventually(() => assert.equal(world.errors.length, 1));
	assert.equal(world.sent.length, 0);
});

test("drops dispatches whose writer is not the configured coordinator", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	// Deliberately permit a rogue feed write to check the SDK's own author filter
	world.network.registerService(`${COORDINATOR}#hivemind_coordinator`, {
		checkUserAccess: async () => true,
	});
	await world.router.start();
	await world.taxi.putSpaceRecord(
		world.feed,
		hivemind.coordinator.dispatch.$nsid,
		world.dispatch.taskId,
		l.asUnknown$TypedObject(world.dispatch),
	);
	await world.router.settled();
	assert.equal(world.decisions(), 0);
	assert.equal(world.sent.length, 0);
});

test("withdraws a decision that is still pending before any offer is written", async (t) => {
	let finish: (answer: OfferAnswer) => void = () => {};
	let deciding = false;
	const decision = new Promise<OfferAnswer>((resolve) => {
		finish = resolve;
	});
	const world = await harness({
		behavior: {
			onDispatch: () => {
				deciding = true;
				return decision;
			},
		},
	});
	t.after(async () => {
		finish({ decision: "decline" });
		await world.router.stop();
	});
	await world.router.start();
	await world.publish();
	await eventually(() => assert.ok(deciding));
	await world.router.withdraw(world.dispatch.taskId);
	finish({ decision: "decline" });
	await world.router.settled();
	assert.equal(world.sent.length, 0);
});

test("withdraw waits for an in-flight write and removes the record it created", async (t) => {
	const world = await harness();
	let release: () => void = () => {};
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let writing = false;
	world.dependencies.gateway = {
		watchSpace: world.taxi.watchSpace.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		putSpaceRecord: async (...args) => {
			writing = true;
			await hold;
			await world.taxi.putSpaceRecord(...args);
		},
	};
	t.after(async () => {
		release();
		await world.router.stop();
	});
	await world.router.start();
	await world.publish();
	await eventually(() => assert.ok(writing));
	const withdrawing = world.router.withdraw(world.dispatch.taskId);
	release();
	await withdrawing;
	await world.router.settled();
	const remaining: unknown[] = [];
	const stop = await world.spaces.watchOfferIntake((change) => {
		remaining.push(change);
	});
	t.after(stop);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(remaining, []);
	assert.equal(world.sent.length, 0);
});

test("an operator cannot mutate the dispatch task ID or deadline used by the router", async (t) => {
	const world = await harness({
		behavior: {
			onDispatch: async (dispatch) => {
				dispatch.taskId = "anotheraaaaaaaaaaaaaaaaaaa";
				dispatch.respondBy = l.toDatetimeString(START);
				return { decision: "decline" };
			},
		},
	});
	t.after(() => world.router.stop());
	await world.router.start();
	await world.publish();
	await world.router.settled();
	assert.equal(world.sent.length, 1);
	assert.equal(world.sent[0].taskId, world.dispatch.taskId);
});

test("withdraw retries a temporary Gateway deletion failure", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	let attempts = 0;
	world.dependencies.gateway = {
		watchSpace: world.taxi.watchSpace.bind(world.taxi),
		putSpaceRecord: world.taxi.putSpaceRecord.bind(world.taxi),
		deleteSpaceRecord: async (...args) => {
			if (++attempts === 1) {
				throw new Error("temporary delete failure");
			}
			await world.taxi.deleteSpaceRecord(...args);
		},
	};
	await world.router.start();
	await world.publish();
	await world.router.settled();
	await world.router.withdraw(world.dispatch.taskId);
	assert.equal(attempts, 2);
	await world.publish();
	await world.router.settled();
	assert.equal(world.sent.length, 1);
});

test("a partial subscription failure releases every previously opened feed watch", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	let stopped = 0;
	world.dependencies.feeds = [
		DOWNTOWN_FEED,
		"at://did:plc:missing/com.hivemind-network.feed.declaration/missing",
	];
	world.dependencies.gateway = {
		putSpaceRecord: world.taxi.putSpaceRecord.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		watchSpace: async (...args) => {
			const stop = await world.taxi.watchSpace(...args);
			return () => {
				stopped++;
				stop();
			};
		},
	};
	await assert.rejects(world.router.start(), SpaceAccessDeniedError);
	assert.equal(stopped, 1);
	await world.publish();
	await world.router.settled();
	assert.equal(world.decisions(), 0);
});

test("concurrent starts and repeated feeds produce one subscription and one decision", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	world.dependencies.feeds = [DOWNTOWN_FEED, DOWNTOWN_FEED];
	let watches = 0;
	world.dependencies.gateway = {
		putSpaceRecord: world.taxi.putSpaceRecord.bind(world.taxi),
		deleteSpaceRecord: world.taxi.deleteSpaceRecord.bind(world.taxi),
		watchSpace: async (...args) => {
			watches++;
			return world.taxi.watchSpace(...args);
		},
	};
	await Promise.all([world.router.start(), world.router.start()]);
	await Promise.all([world.publish(), world.publish()]);
	await world.router.settled();
	assert.equal(watches, 1);
	assert.equal(world.decisions(), 1);
	assert.equal(world.sent.length, 1);
});

test("a concurrent restart waits for the previous stop to finish", async (t) => {
	let finish: (answer: OfferAnswer) => void = () => {};
	let deciding = false;
	const decision = new Promise<OfferAnswer>((resolve) => {
		finish = resolve;
	});
	const world = await harness({
		behavior: {
			onDispatch: () => {
				deciding = true;
				return decision;
			},
		},
	});
	t.after(async () => {
		finish({ decision: "decline" });
		await world.router.stop();
	});
	await world.router.start();
	await world.publish();
	await eventually(() => assert.ok(deciding));
	const stopping = world.router.stop();
	let restarted = false;
	const starting = world.router.start().then(() => {
		restarted = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(restarted, false);
	finish({ decision: "decline" });
	await Promise.all([stopping, starting]);
	await world.router.settled();
	assert.equal(restarted, true);
	assert.equal(world.sent.length, 1);
});

test("the same task arriving through two different feed spaces produces one offer", async (t) => {
	const world = await harness();
	t.after(() => world.router.stop());
	await world.stores.publicIndex.apply(
		created(FEED_OWNER, "private", feedDeclaration()),
	);
	await world.stores.publicIndex.apply(
		created(TAXI_ONE, "self", agentProfile([DOWNTOWN_FEED, PRIVATE_FEED])),
	);
	await world.authority.createSpace(
		SPACE_TYPES.feed,
		await feedKeyOf(PRIVATE_FEED),
		await loadPolicy("feed.json", COORDINATOR),
	);
	world.dependencies.feeds = [DOWNTOWN_FEED, PRIVATE_FEED];
	await world.router.start();
	await Promise.all([
		world.publish(),
		world.coordinator.putSpaceRecord(
			await feedSpaceRef(COORDINATOR, PRIVATE_FEED),
			hivemind.coordinator.dispatch.$nsid,
			world.dispatch.taskId,
			l.asUnknown$TypedObject(world.dispatch),
		),
	]);
	await world.router.settled();
	assert.equal(world.decisions(), 1);
	assert.equal(world.sent.length, 1);
	assert.deepEqual(world.errors, []);
});
