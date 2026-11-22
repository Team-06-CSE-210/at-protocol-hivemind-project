import assert from "node:assert/strict";
import { test } from "node:test";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import type {
	Nsid,
	SpaceRef,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import { requestIntakeSpaceRef } from "../../core/protocol/protocol_config/space_definition.js";
import { submitRequest } from "../../hivemind_sdk/hivemind_requester.js";

// Validate the SDK boundary before the request reaches either Gateway implementation.

const COORDINATOR = "did:plc:coordinator" as const;

const ride = {
	$type: "com.hivemind-network.mobility.ride#request",
	pickup: { latE7: 328_801_000, lonE7: -1_172_340_000 },
	dropoff: { latE7: 327_157_000, lonE7: -1_171_611_000 },
	passengers: 2,
};

// A Gateway that keeps every write instead of sending it
function recordingGateway() {
	const writes: Array<{
		space: SpaceRef;
		collection: Nsid;
		rkey: string;
		record: TypedObject;
	}> = [];
	return {
		writes,
		dependencies: {
			coordinator: COORDINATOR,
			gateway: {
				putSpaceRecord: async (
					space: SpaceRef,
					collection: Nsid,
					rkey: string,
					record: TypedObject,
				) => {
					writes.push({ space, collection, rkey, record });
				},
			},
		},
	};
}

test("submitRequest writes one request record into the coordinator's request intake", async () => {
	const { writes, dependencies } = recordingGateway();

	const { taskId, requestRkey } = await submitRequest(dependencies, ride, {
		selectionMode: "choose",
		maxWaitMs: 5_000,
	});

	assert.equal(writes.length, 1);
	const [write] = writes;
	assert.equal(write.space, requestIntakeSpaceRef(COORDINATOR));
	assert.equal(write.collection, "com.hivemind-network.requester.request");
	// The record key is a fresh TID; the task ID is a separate field the requester chose
	assert.equal(write.rkey, requestRkey);
	assert.match(
		requestRkey,
		/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/,
	);
	assert.notEqual(requestRkey, taskId);
	const record = hivemind.requester.request.main.parse(write.record);
	assert.equal(record.taskId, taskId);
	assert.deepEqual(record.payload, ride);
	assert.equal(record.selectionMode, "choose");
	assert.equal(record.maxWaitMs, 5_000);
});

test("submitRequest rejects an invalid ride or wait limit before writing", async () => {
	const { writes, dependencies } = recordingGateway();

	await assert.rejects(
		submitRequest(dependencies, { ...ride, passengers: 0 }),
		/passengers/,
	);
	await assert.rejects(
		submitRequest(dependencies, ride, { maxWaitMs: 49 }),
		/maxWaitMs/,
	);
	assert.equal(writes.length, 0);
});

test("submitRequest rejects a task type the coordinator does not support", async () => {
	const { writes, dependencies } = recordingGateway();

	await assert.rejects(
		submitRequest(dependencies, {
			$type: "com.example.delivery#request",
			parcel: "small",
		}),
		/unsupported task type com\.example\.delivery/,
	);
	assert.equal(writes.length, 0);
});
