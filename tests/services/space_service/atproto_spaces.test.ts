import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { l } from "@atproto/lex";
import {
	LocalSimGateway,
	LocalSimSpaceAuthority,
} from "../../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../../core/protocol/communication/in_memory/at_protocol_network.js";
import * as hivemind from "../../../core/protocol/generated/com/hivemind-network.js";
import {
	type RecordChange,
	SpaceAccessDeniedError,
} from "../../../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	Assignment,
	Did,
} from "../../../core/protocol/interfaces/internal/types.js";
import { AtprotoSpaces } from "../../../services/space_service/atproto_spaces.js";
import { rideOffer, rideRequest } from "../../coordinator/fixtures.js";
import { eventually, loadPolicy } from "../../gateway/gateway_contract.js";
import { createOfferRoutingWorld } from "../../hivemind_sdk/offer_routing_world.js";

// AtprotoSpaces on the in-memory network: task spaces (S6) and the offer intake (S2). How the
// coordinator uses them is tested in tests/coordinator/runtime/ (task_runner, offer_routing).

const COORDINATOR = "did:example:coordinator" as Did;
const RIDER = "did:example:rider" as Did;
const TAXI = "did:example:taxi" as Did;

// The coordinator's gateway and space authority, a rider and a taxi on one in-memory network
function taskSpaceWorld() {
	const network = new AtProtocolNetwork();
	return {
		network,
		gateway: new LocalSimGateway(network, COORDINATOR),
		authority: new LocalSimSpaceAuthority(network, COORDINATOR),
		rider: new LocalSimGateway(network, RIDER),
		taxi: new LocalSimGateway(network, TAXI),
	};
}

describe("AtprotoSpaces: task spaces", () => {
	test("creating the same task space twice preserves requester access", async () => {
		const world = taskSpaceWorld();
		const { authority, gateway } = world;
		const policy = await loadPolicy("task.json", gateway.did);
		const spaces = new AtprotoSpaces(authority, policy, gateway);

		const taskId = "3m5abcde23456";
		const space = await spaces.createTaskSpace(taskId, world.rider.did);
		// Simulate the coordinator retrying after the first call succeeded
		// The second call should return the same space and preserve rider access
		const retriedSpace = await spaces.createTaskSpace(taskId, world.rider.did);

		assert.equal(retriedSpace, space);

		// A successful subscription is enough to check read access here
		const stopWatching = await world.rider.watchSpace(space, () => {});
		stopWatching();

		await assert.rejects(
			world.taxi.watchSpace(space, () => {}),
			SpaceAccessDeniedError,
		);
	});
	test("rider sees the latest state and only the assigned taxi can read the assignment", async () => {
		const world = taskSpaceWorld();
		const { network } = world;
		const { authority, gateway } = world;
		const spaces = new AtprotoSpaces(
			authority,
			await loadPolicy("task.json", gateway.did),
			gateway,
		);

		const taskId = "3m5abcde23456";
		const space = await spaces.createTaskSpace(taskId, world.rider.did);
		const otherTaxi = new LocalSimGateway(network, "did:example:other-taxi");
		const request = rideRequest(taskId);
		const offer = rideOffer(taskId, 120);
		assert.ok(offer.payload);

		await spaces.writeTaskState(taskId, {
			$type: "com.hivemind-network.coordinator.taskState",
			phase: "collecting",
			updatedAt: request.createdAt,
		});

		const assignment: Assignment = {
			$type: "com.hivemind-network.coordinator.assignment",
			taskId,
			agent: world.taxi.did,
			requester: world.rider.did,
			request: request.payload,
			terms: offer.payload,
			issuedAt: offer.createdAt,
			// These fixture bytes let us check that the attestation survives the
			// write and read. Signature verification is outside this test's scope
			attestation: {
				keyId: `${gateway.did}#hivemind_attestation`,
				signature: new Uint8Array([9, 8, 7]),
			},
		};
		await spaces.assign(taskId, assignment);

		const latestState = {
			$type: "com.hivemind-network.coordinator.taskState",
			phase: "assigned",
			assignedAgent: world.taxi.did,
			updatedAt: offer.createdAt,
		} as const;
		await spaces.writeTaskState(taskId, latestState);

		// Subscribe after both state writes. A rider who joins late should see
		// only "assigned" at "self", and the assigned taxi should receive the
		// assignment that was already published
		const riderStates: unknown[] = [];
		const taxiAssignments: unknown[] = [];
		const stopRider = await world.rider.watchSpace(space, (change) => {
			if (change.collection === latestState.$type && change.rkey === "self") {
				riderStates.push(change.record);
			}
		});
		const stopTaxi = await world.taxi.watchSpace(space, (change) => {
			if (change.collection === assignment.$type && change.rkey === "self") {
				taxiAssignments.push(change.record);
			}
		});

		try {
			await eventually(() => {
				assert.deepEqual(riderStates, [latestState]);
				assert.deepEqual(taxiAssignments, [assignment]);
			});
			await assert.rejects(
				// Check that assigning one taxi leaves the space closed to other taxis
				otherTaxi.watchSpace(space, () => {}),
				SpaceAccessDeniedError,
			);
		} finally {
			stopRider();
			stopTaxi();
		}
	});
});

describe("AtprotoSpaces: offer intake", () => {
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
		await world.taxi.deleteSpaceRecord(
			world.intake,
			collection,
			"3m5abcde23456",
		);
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
});
