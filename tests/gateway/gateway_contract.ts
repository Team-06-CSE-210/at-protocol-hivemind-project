import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { l } from "@atproto/lex";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import {
	type AtprotoGateway,
	type RecordChange,
	SpaceAccessDeniedError,
	SpaceAlreadyExistsError,
	type SpaceAuthority,
	type SpacePolicy,
} from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	SpaceRef,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	createTaskId,
	SPACE_TYPES,
	taskSpaceRef,
} from "../../core/protocol/protocol_config/space_definition.js";

// What every AtprotoGateway must do, whatever is behind it. in_memory_gateway.test.ts and
// pds_gateway.test.ts run these same tests, so both implementations behave alike.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Test world
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Three accounts on one network: the coordinator (authority of every space), a rider, a taxi
export interface GatewayWorld {
	coordinator: { gateway: AtprotoGateway; authority: SpaceAuthority };
	rider: AtprotoGateway;
	taxi: AtprotoGateway;
	// Waits long enough for every change written so far to reach its watchers
	settle(): Promise<void>;
	close(): Promise<void>;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Contract
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export function runGatewayContract(
	name: string,
	createWorld: () => Promise<GatewayWorld>,
): void {
	describe(`${name}: gateway contract`, () => {
		let world: GatewayWorld;
		let coordinator: AtprotoGateway;
		let authority: SpaceAuthority;
		let rider: AtprotoGateway;
		let taxi: AtprotoGateway;
		const stopWatches: Array<() => void> = [];

		before(async () => {
			world = await createWorld();
			({ gateway: coordinator, authority } = world.coordinator);
			({ rider, taxi } = world);
		});

		after(async () => {
			for (const stop of stopWatches) {
				stop();
			}
			await world?.close();
		});

		// A task space with the rider as member, as the coordinator sets it up for a new task
		async function createTaskSpace(): Promise<SpaceRef> {
			const space = await authority.createSpace(
				SPACE_TYPES.task,
				createTaskId(),
				await loadPolicy("task.json", coordinator.did),
			);
			await authority.putMember(space, rider.did, { read: true, write: true });
			return space;
		}

		async function watch(
			gateway: AtprotoGateway,
			space: SpaceRef,
		): Promise<{ changes: RecordChange[]; stop: () => void }> {
			const changes: RecordChange[] = [];
			const stop = await gateway.watchSpace(space, (change) =>
				changes.push(change),
			);
			stopWatches.push(stop);
			return { changes, stop };
		}

		// * * * * * * * * * * * * * * * * * *
		// Public records
		// * * * * * * * * * * * * * * * * * *

		test("public records: put, read by another account, delete", async () => {
			const profile = agentProfile(taxi.did, "Taxi under test");
			const uri = await taxi.putRecord(
				"com.hivemind-network.agent.profile",
				"self",
				profile,
			);
			assert.equal(
				uri,
				`at://${taxi.did}/com.hivemind-network.agent.profile/self`,
			);
			assert.deepEqual(await coordinator.getRecord(uri), profile);

			await taxi.deleteRecord("com.hivemind-network.agent.profile", "self");
			assert.equal(await coordinator.getRecord(uri), undefined);
		});

		test("public records: watchPublic delivers new records of the chosen collections", async () => {
			const seen: RecordChange[] = [];
			const stop = await coordinator.watchPublic(
				["com.hivemind-network.agent.profile"],
				(change) => seen.push(change),
			);
			stopWatches.push(stop);

			// Live only: keep writing until the subscription is up and one write comes through
			let attempt = 0;
			await eventually(async () => {
				attempt += 1;
				await taxi.putRecord(
					"com.hivemind-network.agent.profile",
					"self",
					agentProfile(taxi.did, `Taxi ${attempt}`),
				);
				await world.settle();
				assert.ok(
					seen.some(
						(change) =>
							change.author === taxi.did &&
							change.collection === "com.hivemind-network.agent.profile" &&
							change.rkey === "self",
					),
				);
			});
			stop();
		});

		// * * * * * * * * * * * * * * * * * *
		// Spaces
		// * * * * * * * * * * * * * * * * * *

		test("createSpace returns the address space_definition.ts computes", async () => {
			const taskId = createTaskId();
			const space = await authority.createSpace(
				SPACE_TYPES.task,
				taskId,
				await loadPolicy("task.json", coordinator.did),
			);
			assert.equal(space, taskSpaceRef(coordinator.did, taskId));
		});

		test("creating an existing space rejects with SpaceAlreadyExistsError", async () => {
			const taskId = createTaskId();
			const policy = await loadPolicy("task.json", coordinator.did);
			await authority.createSpace(SPACE_TYPES.task, taskId, policy);
			await assert.rejects(
				authority.createSpace(SPACE_TYPES.task, taskId, policy),
				SpaceAlreadyExistsError,
			);
		});

		test("members and the authority see each other's records, with authors", async () => {
			const space = await createTaskSpace();

			// Written before the rider follows: arrives as part of the replay
			await coordinator.putSpaceRecord(
				space,
				"com.hivemind-network.coordinator.taskState",
				"self",
				taskState("collecting"),
			);
			const atCoordinator = await watch(coordinator, space);
			const atRider = await watch(rider, space);

			// Written while both follow: arrives as a live change
			await rider.putSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
				selection("opt-1"),
			);

			await eventually(() => {
				const taskStateAtRider = atRider.changes.find(
					(change) =>
						change.collection === "com.hivemind-network.coordinator.taskState",
				);
				assert.equal(taskStateAtRider?.author, coordinator.did);
				assert.equal(taskStateAtRider?.space, space);
				assert.equal(taskStateAtRider?.action, "create");
				const selectionAtCoordinator = atCoordinator.changes.find(
					(change) =>
						change.collection === "com.hivemind-network.requester.selection",
				);
				assert.equal(selectionAtCoordinator?.author, rider.did);
				assert.equal(selectionAtCoordinator?.action, "create");
				assert.deepEqual(selectionAtCoordinator?.record, selection("opt-1"));
			});
		});

		test("non-members cannot follow a space", async () => {
			const space = await createTaskSpace();
			await assert.rejects(
				taxi.watchSpace(space, () => {}),
				SpaceAccessDeniedError,
			);
		});

		test("writes without access are accepted but never reach readers", async () => {
			const space = await createTaskSpace();
			const atCoordinator = await watch(coordinator, space);

			// The taxi is not a member (yet): its PDS accepts the write anyway
			await taxi.putSpaceRecord(
				space,
				"com.hivemind-network.agent.progress",
				"self",
				progress("enRoute"),
			);

			// A later write by a member shows the space has been synced past the taxi's write
			await rider.putSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
				selection("opt-1"),
			);
			await eventually(() => {
				assert.ok(
					atCoordinator.changes.some((change) => change.author === rider.did),
				);
			});
			await world.settle();
			assert.ok(
				atCoordinator.changes.every((change) => change.author !== taxi.did),
			);
		});

		test("one writer's changes arrive in order: create, update, delete", async () => {
			const space = await createTaskSpace();
			const atCoordinator = await watch(coordinator, space);
			const fromRider = () =>
				atCoordinator.changes.filter((change) => change.author === rider.did);

			// Each step waits until it has arrived: with polling, quick successive changes
			// of one record may collapse into its latest state
			await rider.putSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
				selection("opt-1"),
			);
			await eventually(() => assert.equal(fromRider().length, 1));
			await rider.putSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
				selection("opt-2"),
			);
			await eventually(() => assert.equal(fromRider().length, 2));
			await rider.deleteSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
			);
			await eventually(() => assert.equal(fromRider().length, 3));

			assert.deepEqual(
				fromRider().map((change) => change.action),
				["create", "update", "delete"],
			);
			const [created, updated, deleted] = fromRider();
			assert.deepEqual(created.record, selection("opt-1"));
			assert.deepEqual(updated.record, selection("opt-2"));
			assert.equal(deleted.record, undefined);
		});

		test("stop() ends deliveries", async () => {
			const space = await createTaskSpace();
			const atCoordinator = await watch(coordinator, space);
			atCoordinator.stop();

			await rider.putSpaceRecord(
				space,
				"com.hivemind-network.requester.selection",
				"self",
				selection("opt-1"),
			);
			await world.settle();
			assert.equal(atCoordinator.changes.length, 0);
		});

		test("managed spaces have no member list", async () => {
			const space = await authority.createSpace(
				SPACE_TYPES.requestIntake,
				`test${Date.now()}`,
				await loadPolicy("request_intake.json", coordinator.did),
			);
			await assert.rejects(
				authority.putMember(space, rider.did, { read: true, write: true }),
			);
		});
	});
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The policy object of a file in core/protocol/type_definition/policy_types, for one coordinator.
// Tests run from the project root (npm test), so paths are relative to it.
export async function loadPolicy(
	fileName: string,
	coordinatorDid: string,
): Promise<SpacePolicy> {
	const text = await readFile(
		path.join(
			process.cwd(),
			"core/protocol/type_definition/policy_types",
			fileName,
		),
		"utf8",
	);
	const { policy } = JSON.parse(
		text.replaceAll("{coordinator}", coordinatorDid),
	);
	return policy as SpacePolicy;
}

// Retries a check until it passes or the time is up; then fails with the check's last error
export async function eventually(
	check: () => void | Promise<void>,
	timeoutMs = 15_000,
	intervalMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() > deadline) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
}

// Fixed timestamps keep records comparable with deepEqual
const FIXED_TIME = l.toDatetimeString(new Date("2026-11-05T12:00:00Z"));

function agentProfile(operator: string, displayName: string): TypedObject {
	return l.asUnknown$TypedObject(
		hivemind.agent.profile.main.build({
			displayName,
			operator: operator as l.DidString,
			taskTypes: ["com.hivemind-network.mobility.ride"],
			createdAt: FIXED_TIME,
		}),
	);
}

function taskState(phase: "collecting" | "assigned"): TypedObject {
	return l.asUnknown$TypedObject(
		hivemind.coordinator.taskState.main.build({
			phase,
			updatedAt: FIXED_TIME,
		}),
	);
}

function selection(optionId: string): TypedObject {
	return l.asUnknown$TypedObject(
		hivemind.requester.selection.main.build({
			optionId,
			createdAt: FIXED_TIME,
		}),
	);
}

function progress(status: "enRoute" | "arrived"): TypedObject {
	return l.asUnknown$TypedObject(
		hivemind.agent.progress.main.build({
			status,
			createdAt: FIXED_TIME,
		}),
	);
}
