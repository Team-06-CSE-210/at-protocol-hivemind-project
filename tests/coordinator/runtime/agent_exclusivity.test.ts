import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_BILLING_CONFIG } from "../../../core/coordinator/config/billing_config.js";
import { DEFAULT_TASKS_CONFIG } from "../../../core/coordinator/config/tasks_config.js";
import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../../core/coordinator/library/clock.js";
import { BillingRuntime } from "../../../core/coordinator/runtime/billing.js";
import { TaskRunner } from "../../../core/coordinator/runtime/task_runner.js";
import type { CoordinatorStores } from "../../../core/protocol/interfaces/internal/stores.js";
import type {
	Did,
	TaskId,
} from "../../../core/protocol/interfaces/internal/types.js";
import {
	COORDINATOR,
	created,
	decline,
	FakeSpaceService,
	fakeMatching,
	fakeRouter,
	fakeSigner,
	RIDER,
	rideOffer,
	rideRequest,
	START,
	seedParticipants,
	TAXI_ONE,
	TAXI_TWO,
	taskIdFor,
} from "../fixtures.js";

// An agent holds at most one active task (ADR-008): the coordinator checks right before assigning
// that the agent is still free. Both seeded taxis answer every task, so collection ends early.
// The fake ranking puts the shorter pickup first: taxi one (60 s) before taxi two (300 s).

interface World {
	stores: CoordinatorStores;
	spaces: FakeSpaceService;
	clock: ManualClock;
	runner: TaskRunner;
	errors: unknown[];
}

async function startRunner(
	stores: CoordinatorStores,
	spaces: FakeSpaceService,
	clock: ManualClock,
): Promise<World> {
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

async function seededWorld(): Promise<World> {
	const stores = createMemoryStores(COORDINATOR);
	await seedParticipants(stores);
	return startRunner(stores, new FakeSpaceService(), new ManualClock(START));
}

// Record keys only need to be unique per author
let nextKey = 0;
function key(): string {
	nextKey++;
	return `3m5abcde2${String(nextKey).padStart(4, "2")}`;
}

function request(world: World, taskId: TaskId, mode: "auto" | "choose"): void {
	world.spaces.pushRequest(created(RIDER, key(), rideRequest(taskId, mode)));
}

function offer(world: World, agent: Did, taskId: TaskId, etaSeconds: number) {
	world.spaces.pushOffer(created(agent, key(), rideOffer(taskId, etaSeconds)));
}

async function settle(world: World): Promise<void> {
	await world.runner.settled();
	assert.deepEqual(world.errors, []);
}

function assignedAgent(world: World, taskId: TaskId): Did | undefined {
	return world.spaces.assignments.get(taskId)?.agent;
}

describe("one active task per agent", () => {
	test("an agent best for two tasks that close together is assigned to only one", async () => {
		const world = await seededWorld();
		const first = taskIdFor("closetogether");
		const second = taskIdFor("closetogetherb");
		request(world, first, "auto");
		request(world, second, "auto");
		await settle(world);
		// Taxi one is closer for both; its offers arrive first, so both tasks close at once when
		// taxi two's arrive
		offer(world, TAXI_ONE, first, 60);
		offer(world, TAXI_ONE, second, 60);
		offer(world, TAXI_TWO, first, 300);
		offer(world, TAXI_TWO, second, 300);
		await settle(world);

		assert.equal(world.spaces.phaseOf(first), "assigned");
		assert.equal(world.spaces.phaseOf(second), "assigned");
		assert.equal(assignedAgent(world, first), TAXI_ONE);
		assert.equal(assignedAgent(world, second), TAXI_TWO);
	});

	test("with every offering agent busy, the task ends in noOffers", async () => {
		const world = await seededWorld();
		const first = taskIdFor("allbusy");
		const second = taskIdFor("allbusyb");
		request(world, first, "auto");
		await settle(world);
		offer(world, TAXI_ONE, first, 60);
		world.spaces.pushOffer(created(TAXI_TWO, key(), decline(first)));
		await settle(world);
		assert.equal(assignedAgent(world, first), TAXI_ONE);

		request(world, second, "auto");
		await settle(world);
		offer(world, TAXI_ONE, second, 60);
		world.spaces.pushOffer(created(TAXI_TWO, key(), decline(second)));
		await settle(world);
		assert.equal(world.spaces.phaseOf(second), "noOffers");
		assert.equal(assignedAgent(world, second), undefined);
	});

	test("once its task ends, the agent can be assigned again", async () => {
		const world = await seededWorld();
		const first = taskIdFor("freeagain");
		const second = taskIdFor("freeagainb");
		request(world, first, "auto");
		await settle(world);
		offer(world, TAXI_ONE, first, 60);
		offer(world, TAXI_TWO, first, 300);
		await settle(world);
		assert.equal(assignedAgent(world, first), TAXI_ONE);

		// Taxi one completes the first ride
		world.spaces.pushTaskSpace(
			first,
			created(TAXI_ONE, key(), {
				$type: "com.hivemind-network.agent.progress",
				status: "completed",
				createdAt: "2026-11-19T12:10:00.000Z",
			}),
		);
		await settle(world);
		assert.equal(world.spaces.phaseOf(first), "completed");

		request(world, second, "auto");
		await settle(world);
		offer(world, TAXI_ONE, second, 60);
		offer(world, TAXI_TWO, second, 300);
		await settle(world);
		assert.equal(assignedAgent(world, second), TAXI_ONE);
	});

	test("choose mode offers only free agents, and a chosen agent that became busy falls back", async () => {
		const world = await seededWorld();
		const chooser = taskIdFor("chooser");
		const auto = taskIdFor("chooserauto");
		const later = taskIdFor("chooserlater");

		// The rider of the first task sees both taxis
		request(world, chooser, "choose");
		await settle(world);
		offer(world, TAXI_ONE, chooser, 60);
		offer(world, TAXI_TWO, chooser, 300);
		await settle(world);
		const options = world.spaces.lastState(chooser)?.options ?? [];
		assert.deepEqual(
			options.map(({ agent }) => agent),
			[TAXI_ONE, TAXI_TWO],
		);

		// Meanwhile an auto task takes taxi one
		request(world, auto, "auto");
		await settle(world);
		offer(world, TAXI_ONE, auto, 60);
		offer(world, TAXI_TWO, auto, 300);
		await settle(world);
		assert.equal(assignedAgent(world, auto), TAXI_ONE);

		// A later choose task no longer offers taxi one
		request(world, later, "choose");
		await settle(world);
		offer(world, TAXI_ONE, later, 60);
		offer(world, TAXI_TWO, later, 300);
		await settle(world);
		assert.deepEqual(
			world.spaces.lastState(later)?.options?.map(({ agent }) => agent),
			[TAXI_TWO],
		);

		// The first rider picks taxi one, which is busy now: the next free option is assigned
		world.spaces.pushTaskSpace(
			chooser,
			created(RIDER, "self", {
				$type: "com.hivemind-network.requester.selection",
				optionId: options[0].optionId,
				createdAt: "2026-11-19T12:00:05.000Z",
			}),
		);
		await settle(world);
		assert.equal(world.spaces.phaseOf(chooser), "assigned");
		assert.equal(assignedAgent(world, chooser), TAXI_TWO);
	});

	test("an assignment that fails to store leaves the agent free", async () => {
		const world = await seededWorld();
		const first = taskIdFor("failedassign");
		const second = taskIdFor("failedassignb");
		const put = world.stores.tasks.put.bind(world.stores.tasks);
		let failAssignment = true;
		world.stores.tasks.put = async (task) => {
			if (failAssignment && task.state.phase === "assigned") {
				failAssignment = false;
				throw new Error("temporary database failure");
			}
			await put(task);
		};
		request(world, first, "auto");
		await settle(world);
		offer(world, TAXI_ONE, first, 60);
		offer(world, TAXI_TWO, first, 300);
		await world.runner.settled();
		assert.equal(world.errors.length, 1);
		assert.equal(assignedAgent(world, first), undefined);
		world.errors.length = 0;

		request(world, second, "auto");
		await settle(world);
		offer(world, TAXI_ONE, second, 60);
		offer(world, TAXI_TWO, second, 300);
		await settle(world);
		assert.equal(assignedAgent(world, second), TAXI_ONE);
	});

	test("after a restart, an agent's assigned task still occupies it", async () => {
		const world = await seededWorld();
		const first = taskIdFor("restart");
		const second = taskIdFor("restartb");
		request(world, first, "auto");
		await settle(world);
		offer(world, TAXI_ONE, first, 60);
		offer(world, TAXI_TWO, first, 300);
		await settle(world);
		assert.equal(assignedAgent(world, first), TAXI_ONE);
		await world.runner.stop();

		// A new coordinator process on the same stores
		const restarted = await startRunner(
			world.stores,
			world.spaces,
			world.clock,
		);
		request(restarted, second, "auto");
		await settle(restarted);
		offer(restarted, TAXI_ONE, second, 60);
		offer(restarted, TAXI_TWO, second, 300);
		await settle(restarted);
		assert.equal(assignedAgent(restarted, second), TAXI_TWO);
		await restarted.runner.stop();
	});
});
