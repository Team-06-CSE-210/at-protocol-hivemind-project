import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryStores } from "../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../core/coordinator/library/clock.js";
import { startCoordinator } from "../../core/coordinator/main.js";
import { toLocalSimService } from "../../core/coordinator/runtime/xrpc_server.js";
import { LocalSimGateway } from "../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../core/protocol/communication/in_memory/at_protocol_network.js";
import type {
	Did,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	COORDINATOR,
	DOWNTOWN_FEED,
	FakeSpaceService,
	FEED_OWNER,
	fakeMatching,
	fakeRouter,
	fakeSigner,
	feedDeclaration,
	RIDER,
	START,
} from "./fixtures.js";

// The coordinator as startCoordinator wires it, on the in-memory network: calls arrive through
// the network, public records through its firehose. Spaces stay fake until services/space_service exists.

const COORDINATOR_SERVICE = `${COORDINATOR}#hivemind_coordinator`;

// Deliveries on the in-memory network happen on the next microtask
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("startCoordinator", () => {
	test("sets up the intakes, indexes feeds and answers calls", async () => {
		const network = new AtProtocolNetwork();
		const spaces = new FakeSpaceService();
		const stores = createMemoryStores(COORDINATOR);
		const running = await startCoordinator({
			coordinator: COORDINATOR,
			gateway: new LocalSimGateway(network, COORDINATOR),
			stores,
			services: { router: fakeRouter, matching: fakeMatching, spaces },
			signer: fakeSigner,
			clock: new ManualClock(START),
		});
		network.registerService(
			COORDINATOR_SERVICE,
			toLocalSimService(running.api),
		);
		assert.equal(spaces.intakesSetUp, true);

		// 1. A feed declared on the network gets indexed and its space
		const feedOwner = new LocalSimGateway(network, FEED_OWNER);
		await feedOwner.putRecord(
			"com.hivemind-network.feed.declaration",
			"downtown",
			feedDeclaration() as unknown as TypedObject,
		);
		await settle();
		await running.indexer.settled();
		assert.equal(
			(await stores.publicIndex.getFeed(DOWNTOWN_FEED))?.owner,
			FEED_OWNER,
		);
		assert.ok(spaces.feedSpaces.has(DOWNTOWN_FEED));

		// 2. A rider registers through the network
		const rider = new LocalSimGateway(network, RIDER);
		const registration = (await rider.callProcedure(
			COORDINATOR_SERVICE as Did,
			"com.hivemind-network.coordinator.register",
			{ role: "requester" },
		)) as { status: string };
		assert.equal(registration.status, "active");

		await running.stop();
	});
});
