import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { TID } from "@atproto/common-web";
import { l } from "@atproto/lex";
import {
	LocalSimGateway,
	LocalSimSpaceAuthority,
} from "../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../core/protocol/communication/in_memory/at_protocol_network.js";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import { SpaceAccessDeniedError } from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	Nsid,
	SpaceRef,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	requestIntakeSpaceRef,
	SPACE_TYPES,
	taskSpaceRef,
} from "../../core/protocol/protocol_config/space_definition.js";
import {
	HivemindRequester,
	submitRequest,
} from "../../hivemind_sdk/hivemind_requester.js";
import {
	COORDINATOR,
	RIDER,
	registration,
	rideOffer,
	rideRequest,
	TAXI_ONE,
	TAXI_TWO,
	taskIdFor,
} from "../coordinator/fixtures.js";
import { loadPolicy } from "../gateway/gateway_contract.js";

// Validate the SDK boundary before the request reaches either Gateway implementation.

test("submitRequest rejects an invalid ride or wait limit before writing", async () => {
	let writes = 0;
	const dependencies = {
		coordinator: "did:plc:coordinator" as const,
		gateway: {
			putSpaceRecord: async () => {
				writes += 1;
			},
		},
	};
	const ride = {
		$type: "com.hivemind-network.mobility.ride#request",
		pickup: { latE7: 328_801_000, lonE7: -1_172_340_000 },
		dropoff: { latE7: 327_157_000, lonE7: -1_171_611_000 },
		passengers: 2,
	};

	await assert.rejects(
		submitRequest(dependencies, { ...ride, passengers: 0 }),
		/passengers/,
	);
	await assert.rejects(
		submitRequest(dependencies, ride, { maxWaitMs: 49 }),
		/maxWaitMs/,
	);
	assert.equal(writes, 0);
});

const REQUEST = "com.hivemind-network.requester.request";
const STATE = "com.hivemind-network.coordinator.taskState";
const ASSIGNMENT = "com.hivemind-network.coordinator.assignment";
const PROGRESS = "com.hivemind-network.agent.progress";
const SELECTION = "com.hivemind-network.requester.selection";
const payload = rideRequest(taskIdFor("test")).payload;
const timestamp = () => l.toDatetimeString(new Date());

async function writeRecord(
	gateway: LocalSimGateway,
	space: SpaceRef,
	key: string,
	record: { $type: Nsid; [field: string]: unknown },
): Promise<void> {
	await gateway.putSpaceRecord(
		space,
		record.$type,
		key,
		l.asUnknown$TypedObject(record),
	);
}

async function startRide(t: TestContext, mode: "auto" | "choose") {
	const network = new AtProtocolNetwork();
	const coordinator = new LocalSimGateway(network, COORDINATOR);
	const authority = new LocalSimSpaceAuthority(network, COORDINATOR);
	const rider = new LocalSimGateway(network, RIDER);
	const taxi = new LocalSimGateway(network, TAXI_ONE);
	const other = new LocalSimGateway(network, TAXI_TWO);
	network.registerService(`${COORDINATOR}#hivemind_coordinator`, {
		checkUserAccess: async (_space, did, access) =>
			did === RIDER && access === "write",
		procedures: {
			"com.hivemind-network.coordinator.register": async (did, input) => {
				assert.deepEqual(input, { role: "requester" });
				return registration(did, "requester");
			},
		},
	});
	const intake = await authority.createSpace(
		SPACE_TYPES.requestIntake,
		"main",
		await loadPolicy("request_intake.json", COORDINATOR),
	);
	const taskPolicy = await loadPolicy("task.json", COORDINATOR);

	const put = rider.putSpaceRecord.bind(rider);
	const writes = t.mock.method(
		rider,
		"putSpaceRecord",
		async (...args: Parameters<typeof put>) => {
			await put(...args);
			const [, collection, , record] = args;
			if (collection === REQUEST) {
				const { taskId } = hivemind.requester.request.main.parse(record);
				const space = await authority.createSpace(
					SPACE_TYPES.task,
					taskId,
					taskPolicy,
				);
				await writeRecord(coordinator, space, "self", {
					$type: STATE,
					phase: "collecting",
					updatedAt: timestamp(),
				});
			}
		},
	);

	// The space already has a state, but the first follow must wait for membership.
	const watch = rider.watchSpace.bind(rider);
	const stops = t.mock.fn();
	const watches = t.mock.method(
		rider,
		"watchSpace",
		async (...args: Parameters<typeof watch>) => {
			try {
				const stop = await watch(...args);
				return () => {
					stop();
					stops();
				};
			} catch (error) {
				assert.ok(error instanceof SpaceAccessDeniedError);
				assert.equal(watches.mock.callCount(), 1);
				await authority.putMember(args[0], RIDER, { read: true, write: true });
				throw error;
			}
		},
	);
	const deletes = t.mock.method(rider, "deleteSpaceRecord");
	const requester = new HivemindRequester({
		coordinator: COORDINATOR,
		gateway: rider,
	});
	assert.equal((await requester.register()).subject, RIDER);
	const task = await requester.request(payload, { selectionMode: mode });
	t.after(() => task.close());
	await task.ready;
	assert.equal(watches.mock.callCount(), 2);
	assert.equal(
		writes.mock.calls[0].arguments[0],
		requestIntakeSpaceRef(COORDINATOR),
	);
	const space = taskSpaceRef(COORDINATOR, task.taskId);
	assert.equal(watches.mock.calls[1].arguments[0], space);
	const terms = rideOffer(task.taskId, 120).payload;
	assert.ok(terms);
	return {
		task,
		space,
		intake,
		writes,
		deletes,
		stops,
		coordinator,
		authority,
		taxi,
		other,
		terms,
	};
}

test("follows collecting, assignment and completion across separately synced writers", async (t) => {
	const { task, space, stops, coordinator, authority, taxi, other, terms } =
		await startRide(t, "auto");
	const phases: string[] = [];
	const agents: string[] = [];
	const progress: string[] = [];
	task.onState(({ phase }) => phases.push(phase));
	task.onAssignment(({ agent }) => agents.push(agent));
	task.onProgress(({ status }) => progress.push(status));
	assert.deepEqual(phases, ["collecting"]);

	for (const agent of [taxi, other]) {
		await authority.putMember(space, agent.did, { read: true, write: true });
	}
	await writeRecord(other, space, "self", {
		$type: STATE,
		phase: "cancelled",
		updatedAt: timestamp(),
	});
	await writeRecord(other, space, TID.nextStr(), {
		$type: PROGRESS,
		status: "failed",
		createdAt: timestamp(),
	});
	await writeRecord(taxi, space, TID.nextStr(), {
		$type: PROGRESS,
		status: "enRoute",
		createdAt: timestamp(),
	});
	await setImmediate();
	assert.deepEqual(phases, ["collecting"]);
	assert.deepEqual(progress, []);

	await writeRecord(coordinator, space, "self", {
		$type: ASSIGNMENT,
		taskId: task.taskId,
		requester: RIDER,
		agent: TAXI_ONE,
		request: payload,
		terms,
		issuedAt: timestamp(),
		attestation: {
			keyId: `${COORDINATOR}#hivemind_attestation`,
			signature: new Uint8Array([1]),
		},
	});
	for (const phase of ["assigned", "completed"]) {
		await writeRecord(coordinator, space, "self", {
			$type: STATE,
			phase,
			assignedAgent: TAXI_ONE,
			updatedAt: timestamp(),
		});
	}
	await setImmediate();
	assert.deepEqual(agents, [TAXI_ONE]);
	assert.deepEqual(phases, ["collecting", "assigned", "completed"]);
	assert.deepEqual(progress, ["enRoute"]);
	assert.equal(stops.mock.callCount(), 0);

	await writeRecord(taxi, space, TID.nextStr(), {
		$type: PROGRESS,
		status: "completed",
		createdAt: timestamp(),
	});
	await setImmediate();
	assert.deepEqual(progress, ["enRoute", "completed"]);
	assert.equal(stops.mock.callCount(), 1);
	task.onProgress(({ status }) => assert.equal(status, "completed"));
});

test("selects an offered option before the deadline and follows cancellation", async (t) => {
	const { task, space, intake, writes, deletes, stops, coordinator, terms } =
		await startRide(t, "choose");
	const received: string[][] = [];
	const unsubscribe = task.onState(({ options }) =>
		received.push(options?.map(({ optionId }) => optionId) ?? []),
	);
	const publishOptions = async (selectBy: string) => {
		await writeRecord(coordinator, space, "self", {
			$type: STATE,
			phase: "awaitingSelection",
			options: [
				{ optionId: "option-1", agent: TAXI_ONE, score: 1000, terms },
				{ optionId: "option-2", agent: TAXI_TWO, score: 700, terms },
			],
			selectBy,
			updatedAt: timestamp(),
		});
		await setImmediate();
	};
	await publishOptions("2099-01-01T12:00:00.000Z");
	assert.deepEqual(received, [[], ["option-1", "option-2"]]);
	await assert.rejects(task.select("unknown"), /Unknown option/);
	await task.select("option-2");
	const [, collection, key, selection] = writes.mock.calls[1].arguments;
	assert.equal(writes.mock.calls[1].arguments[0], space);
	assert.equal(collection, SELECTION);
	assert.equal(key, "self");
	assert.equal(
		hivemind.requester.selection.main.parse(selection).optionId,
		"option-2",
	);

	unsubscribe();
	await publishOptions("2000-01-01T12:00:00.000Z");
	await assert.rejects(task.select("option-1"), /deadline/);
	assert.equal(writes.mock.callCount(), 2);

	const phases: string[] = [];
	task.onState(({ phase }) => phases.push(phase));
	await Promise.all([task.cancel(), task.cancel()]);
	const requestRkey = writes.mock.calls[0].arguments[2];
	assert.equal(deletes.mock.callCount(), 1);
	assert.deepEqual(deletes.mock.calls[0].arguments, [
		intake,
		REQUEST,
		requestRkey,
	]);
	await writeRecord(coordinator, space, "self", {
		$type: STATE,
		phase: "cancelled",
		updatedAt: timestamp(),
	});
	await setImmediate();
	assert.deepEqual(phases, ["awaitingSelection", "cancelled"]);
	assert.equal(received.length, 2);
	assert.equal(stops.mock.callCount(), 1);
});

test("can cancel before the task space is available", async (t) => {
	const gateway = new LocalSimGateway(new AtProtocolNetwork(), RIDER);
	const writes = t.mock.method(gateway, "putSpaceRecord", async () => {});
	const deletes = t.mock.method(gateway, "deleteSpaceRecord", async () => {});
	const watches = t.mock.method(gateway, "watchSpace", async () => {
		throw new SpaceAccessDeniedError("SpaceNotFound");
	});
	const requester = new HivemindRequester({
		coordinator: COORDINATOR,
		gateway,
	});
	const task = await requester.request(payload);
	t.after(() => task.close());
	await task.cancel();
	const [intake, collection, key] = writes.mock.calls[0].arguments;
	assert.deepEqual(deletes.mock.calls[0].arguments, [intake, collection, key]);
	task.close();
	await task.ready;
	assert.equal(watches.mock.callCount(), 1);
});
