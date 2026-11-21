import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_BILLING_CONFIG } from "../../../core/coordinator/config/billing_config.js";
import { DEFAULT_TASKS_CONFIG } from "../../../core/coordinator/config/tasks_config.js";
import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { monthOf } from "../../../core/coordinator/library/billing_rules.js";
import { ManualClock } from "../../../core/coordinator/library/clock.js";
import { BillingRuntime } from "../../../core/coordinator/runtime/billing.js";
import { TaskRunner } from "../../../core/coordinator/runtime/task_runner.js";
import type { CoordinatorStores } from "../../../core/protocol/interfaces/internal/stores.js";
import {
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	decline,
	deleted,
	FakeSpaceService,
	fakeMatching,
	fakeRouter,
	fakeSigner,
	RIDER,
	rideOffer,
	rideRequest,
	START,
	STRANGER,
	seedParticipants,
	TAXI_ONE,
	TAXI_TWO,
	taskIdFor,
} from "../fixtures.js";

// The task lifecycle (core/protocol/interfaces/external/task_lifecycle.md) with fake services and
// a manual clock: every phase, every deadline, and resuming after a restart.

const REQUEST = "com.hivemind-network.requester.request";

interface Harness {
	stores: CoordinatorStores;
	spaces: FakeSpaceService;
	clock: ManualClock;
	runner: TaskRunner;
	errors: unknown[];
}

async function startHarness(
	stores: CoordinatorStores = createMemoryStores(COORDINATOR),
	spaces = new FakeSpaceService(),
	clock = new ManualClock(START),
): Promise<Harness> {
	const errors: unknown[] = [];
	const runner = new TaskRunner(
		{
			stores,
			spaces,
			router: fakeRouter,
			matching: fakeMatching,
			signer: fakeSigner,
			billing: new BillingRuntime(stores, DEFAULT_BILLING_CONFIG),
			clock,
			onError: (error) => errors.push(error),
		},
		DEFAULT_TASKS_CONFIG,
	);
	await runner.start();
	return { stores, spaces, clock, runner, errors };
}

async function seededHarness(): Promise<Harness> {
	const stores = createMemoryStores(COORDINATOR);
	await seedParticipants(stores);
	return startHarness(stores);
}

// Moves the clock and lets the steps the timers queued run
async function advance(harness: Harness, durationMs: number): Promise<void> {
	harness.clock.advanceBy(durationMs);
	await harness.runner.settled();
}

async function settle(harness: Harness): Promise<void> {
	await harness.runner.settled();
	assert.deepEqual(harness.errors, []);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Collecting and assigning
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: auto mode", () => {
	test("dispatches, ends early once both taxis answered, and assigns the best offer", async () => {
		const harness = await seededHarness();
		const { spaces, stores } = harness;
		const taskId = taskIdFor("auto");

		// 1. The request opens the task: task space, collecting, one dispatch per feed
		spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		await settle(harness);
		assert.equal(spaces.taskSpaces.get(taskId), RIDER);
		assert.equal(spaces.phaseOf(taskId), "collecting");
		const dispatch = spaces.dispatches.get(`${DOWNTOWN_FEED} ${taskId}`);
		assert.ok(dispatch);
		// Agents see the coarsened request only
		const coarsened = dispatch.payload as unknown as {
			pickup: { uncertaintyMeters: number };
		};
		assert.ok(coarsened.pickup.uncertaintyMeters > 0);

		// 2. Both eligible taxis answer: collection ends without waiting for respondBy
		spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		spaces.pushOffer(created(TAXI_TWO, "o2", rideOffer(taskId, 120)));
		await settle(harness);

		// 3. The faster pickup wins; the dispatch is closed and the assignment counted
		assert.equal(spaces.phaseOf(taskId), "assigned");
		assert.equal(spaces.lastState(taskId)?.assignedAgent, TAXI_TWO);
		const assignment = spaces.assignments.get(taskId);
		assert.equal(assignment?.agent, TAXI_TWO);
		assert.equal(assignment?.requester, RIDER);
		assert.deepEqual(
			assignment?.attestation.signature,
			new Uint8Array([1, 2, 3]),
		);
		assert.equal(spaces.dispatches.size, 0);
		assert.equal(
			await stores.billing.countAssignments(TAXI_TWO, monthOf(START)),
			1,
		);
	});

	test("without a covering feed the task ends in noCoverage", async () => {
		const harness = await startHarness();
		await harness.stores.participants.put({
			subject: RIDER,
			role: "requester",
			status: "active",
			registeredAt: "2026-11-19T12:00:00.000Z",
		});
		const taskId = taskIdFor("nocoverage");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		await settle(harness);
		assert.equal(harness.spaces.taskSpaces.get(taskId), RIDER);
		assert.equal(harness.spaces.phaseOf(taskId), "noCoverage");
		assert.equal(harness.spaces.dispatches.size, 0);
	});

	test("respondBy closes collection with the offers that arrived", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("deadline");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "collecting");

		// The feed's answer window is 30 s
		await advance(harness, 30_000);
		assert.equal(harness.spaces.phaseOf(taskId), "assigned");
		assert.equal(harness.spaces.assignments.get(taskId)?.agent, TAXI_ONE);

		// An offer after respondBy changes nothing
		harness.spaces.pushOffer(created(TAXI_TWO, "o2", rideOffer(taskId, 10)));
		await settle(harness);
		assert.equal(harness.spaces.assignments.get(taskId)?.agent, TAXI_ONE);
	});

	test("only declines end in noOffers", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("declines");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", decline(taskId)));
		harness.spaces.pushOffer(created(TAXI_TWO, "o2", decline(taskId)));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "noOffers");
		assert.equal(harness.spaces.assignments.size, 0);
	});

	test("offers from unregistered agents and requests from unregistered requesters are dropped", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("strangers");

		harness.spaces.pushRequest(
			created(STRANGER, "r1", rideRequest(taskIdFor("other"))),
		);
		harness.spaces.pushRequest(created(RIDER, "r2", rideRequest(taskId)));
		harness.spaces.pushOffer(created(STRANGER, "o1", rideOffer(taskId, 1)));
		await settle(harness);

		assert.equal(harness.spaces.taskSpaces.has(taskIdFor("other")), false);
		const task = await harness.stores.tasks.get(taskId);
		assert.deepEqual(task?.offers, []);
	});

	test("a later offer from the same agent replaces its first one, a deleted one is withdrawn", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("replace");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o2", rideOffer(taskId, 200)));
		await settle(harness);
		let task = await harness.stores.tasks.get(taskId);
		assert.deepEqual(
			task?.offers.map(({ rkey }) => rkey),
			["o2"],
		);

		harness.spaces.pushOffer(
			deleted(TAXI_ONE, "com.hivemind-network.agent.offer", "o2"),
		);
		await settle(harness);
		task = await harness.stores.tasks.get(taskId);
		assert.deepEqual(task?.offers, []);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Choose mode
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: choose mode", () => {
	async function awaitingSelection(name: string) {
		const harness = await seededHarness();
		const taskId = taskIdFor(name);
		harness.spaces.pushRequest(
			created(RIDER, "r1", rideRequest(taskId, "choose")),
		);
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		harness.spaces.pushOffer(created(TAXI_TWO, "o2", rideOffer(taskId, 120)));
		await settle(harness);
		return { harness, taskId };
	}

	test("the requester sees ranked options with headlines and picks one", async () => {
		const { harness, taskId } = await awaitingSelection("choose");
		const state = harness.spaces.lastState(taskId);
		assert.equal(state?.phase, "awaitingSelection");
		assert.deepEqual(
			state?.options?.map(({ agent }) => agent),
			[TAXI_TWO, TAXI_ONE],
		);
		assert.equal(state?.options?.[0].headline, "Pickup in 2 min · $14.50");
		assert.ok(state?.selectBy);

		// Picking the second-ranked option assigns it
		const chosen = state?.options?.[1].optionId ?? "";
		const selection = {
			$type: "com.hivemind-network.requester.selection",
			optionId: chosen,
			createdAt: "2026-11-19T12:00:05.000Z",
		};
		harness.spaces.pushTaskSpace(taskId, created(STRANGER, "self", selection));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "awaitingSelection");

		harness.spaces.pushTaskSpace(taskId, created(RIDER, "self", selection));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "assigned");
		assert.equal(harness.spaces.assignments.get(taskId)?.agent, TAXI_ONE);
	});

	test("no selection before selectBy ends in expired", async () => {
		const { harness, taskId } = await awaitingSelection("expire");
		await advance(harness, DEFAULT_TASKS_CONFIG.selectionWindowMs);
		assert.equal(harness.spaces.phaseOf(taskId), "expired");
		assert.equal(harness.spaces.isWatched(taskId), false);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// End phases
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: end phases", () => {
	test("deleting the request cancels the task and closes its dispatches", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("cancel");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		await settle(harness);

		harness.spaces.pushRequest(deleted(RIDER, REQUEST, "r1"));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "cancelled");
		assert.deepEqual(harness.spaces.closedDispatches, [
			`${DOWNTOWN_FEED} ${taskId}`,
		]);
		assert.equal(harness.clock.pendingTimers, 0);
	});

	test("only the assigned agent's progress completes the task", async () => {
		const harness = await seededHarness();
		const taskId = taskIdFor("complete");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		harness.spaces.pushOffer(created(TAXI_TWO, "o2", decline(taskId)));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "assigned");

		const progress = (status: string) => ({
			$type: "com.hivemind-network.agent.progress",
			status,
			createdAt: "2026-11-19T12:10:00.000Z",
		});
		harness.spaces.pushTaskSpace(
			taskId,
			created(TAXI_TWO, "p1", progress("completed")),
		);
		harness.spaces.pushTaskSpace(
			taskId,
			created(TAXI_ONE, "p2", progress("enRoute")),
		);
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "assigned");

		harness.spaces.pushTaskSpace(
			taskId,
			created(TAXI_ONE, "p3", progress("completed")),
		);
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(taskId), "completed");
		assert.equal(harness.spaces.lastState(taskId)?.assignedAgent, TAXI_ONE);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Restart
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: restart", () => {
	test("a collecting task resumes with its dispatch and deadline", async () => {
		const first = await seededHarness();
		const taskId = taskIdFor("resume");
		first.spaces.pushRequest(created(RIDER, "r1", rideRequest(taskId)));
		first.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(taskId, 300)));
		await settle(first);
		await first.runner.stop();

		// Same stores, new process: the dispatch is written again and respondBy still applies
		const second = await startHarness(
			first.stores,
			new FakeSpaceService(),
			first.clock,
		);
		await settle(second);
		assert.equal(second.spaces.phaseOf(taskId), "collecting");
		assert.ok(second.spaces.dispatches.has(`${DOWNTOWN_FEED} ${taskId}`));

		await advance(second, 30_000);
		assert.equal(second.spaces.phaseOf(taskId), "assigned");
		assert.equal(second.spaces.assignments.get(taskId)?.agent, TAXI_ONE);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Record identity
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: record identity", () => {
	test("changing a request record to a new task ID opens no second task", async () => {
		const harness = await seededHarness();
		const first = taskIdFor("first");
		const second = taskIdFor("second");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(first)));
		await settle(harness);

		harness.spaces.pushRequest({
			...created(RIDER, "r1", rideRequest(second)),
			action: "update",
		});
		await settle(harness);
		assert.equal(await harness.stores.tasks.get(second), undefined);
		assert.equal(harness.spaces.taskSpaces.has(second), false);

		// Deleting the record still cancels the task it opened
		harness.spaces.pushRequest(deleted(RIDER, REQUEST, "r1"));
		await settle(harness);
		assert.equal(harness.spaces.phaseOf(first), "cancelled");
	});

	test("an offer record cannot move to another task", async () => {
		const harness = await seededHarness();
		const first = taskIdFor("offerone");
		const second = taskIdFor("offertwo");
		harness.spaces.pushRequest(created(RIDER, "r1", rideRequest(first)));
		harness.spaces.pushRequest(created(RIDER, "r2", rideRequest(second)));
		harness.spaces.pushOffer(created(TAXI_ONE, "o1", rideOffer(first, 300)));
		await settle(harness);

		harness.spaces.pushOffer({
			...created(TAXI_ONE, "o1", rideOffer(second, 120)),
			action: "update",
		});
		await settle(harness);
		assert.deepEqual((await harness.stores.tasks.get(second))?.offers, []);
		assert.equal((await harness.stores.tasks.get(first))?.offers.length, 1);
	});
});

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Failed start
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

describe("task runner: failed start", () => {
	test("a failed start leaves no intake subscribed", async () => {
		const spaces = new FakeSpaceService();
		spaces.watchOfferIntake = async () => {
			throw new Error("offer intake unreachable");
		};
		await assert.rejects(
			startHarness(createMemoryStores(COORDINATOR), spaces),
			/offer intake unreachable/,
		);
		assert.equal(spaces.watchedIntakes(), 0);
	});
});
