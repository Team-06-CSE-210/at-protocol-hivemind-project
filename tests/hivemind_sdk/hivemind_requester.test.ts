import assert from "node:assert/strict";
import { test } from "node:test";
import { submitRequest } from "../../hivemind_sdk/hivemind_requester.js";

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
