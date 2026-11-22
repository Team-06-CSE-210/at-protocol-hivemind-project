import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	LocalSimGateway,
	LocalSimSpaceAuthority,
} from "../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../core/protocol/communication/in_memory/at_protocol_network.js";
import { SpaceAccessDeniedError } from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	Did,
	TypedObject,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	offerIntakeSpaceRef,
	requestIntakeSpaceRef,
	SPACE_TYPES,
} from "../../core/protocol/protocol_config/space_definition.js";
import {
	eventually,
	type GatewayWorld,
	loadPolicy,
	runGatewayContract,
} from "./gateway_contract.js";

const COORDINATOR = "did:example:coordinator" as Did;
const RIDER = "did:example:rider" as Did;
const TAXI = "did:example:taxi" as Did;
const COORDINATOR_SERVICE = `${COORDINATOR}#hivemind_coordinator`;

// Deliveries are queued as microtasks, so one timer turn is enough to settle
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function createWorld(network: AtProtocolNetwork): GatewayWorld {
	return {
		coordinator: {
			gateway: new LocalSimGateway(network, COORDINATOR),
			authority: new LocalSimSpaceAuthority(network, COORDINATOR),
		},
		rider: new LocalSimGateway(network, RIDER),
		taxi: new LocalSimGateway(network, TAXI),
		settle,
		close: async () => {},
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Shared contract
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

runGatewayContract("in-memory", async () =>
	createWorld(new AtProtocolNetwork()),
);

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// In-memory only: what the PDS test cannot set up yet
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// A managed space asks its managing app, i.e. the coordinator's checkUserAccess endpoint.
// On the real network that endpoint needs a reachable coordinator service, which does not exist yet.
describe("in-memory: managed spaces", () => {
	test("the managing app decides who may read and write", async () => {
		const network = new AtProtocolNetwork();
		const world = createWorld(network);

		// The coordinator lets agents write into its offer intake and nobody else read
		network.registerService(COORDINATOR_SERVICE, {
			checkUserAccess: async (_space, user, access) =>
				user === TAXI && access === "write",
		});
		const intake = await world.coordinator.authority.createSpace(
			SPACE_TYPES.offerIntake,
			"main",
			await loadPolicy("offer_intake.json", COORDINATOR),
		);
		assert.equal(intake, offerIntakeSpaceRef(COORDINATOR));

		const changes: string[] = [];
		await world.coordinator.gateway.watchSpace(intake, (change) =>
			changes.push(`${change.author} ${change.collection}`),
		);
		const record = {
			$type: "com.hivemind-network.test.record",
		} as unknown as TypedObject;
		await world.taxi.putSpaceRecord(
			intake,
			"com.hivemind-network.agent.offer",
			"a",
			record,
		);
		await world.rider.putSpaceRecord(
			intake,
			"com.hivemind-network.agent.offer",
			"b",
			record,
		);
		await settle();

		// The taxi's write arrives, the rider's stays hidden; neither may read
		assert.deepEqual(changes, [`${TAXI} com.hivemind-network.agent.offer`]);
		assert.equal(network.hiddenWrites.length, 1);
		assert.equal(network.hiddenWrites[0].author, RIDER);
		await assert.rejects(
			world.rider.watchSpace(intake, () => {}),
			SpaceAccessDeniedError,
		);
	});

	test("without a registered managing app nobody but the authority gets in", async () => {
		const network = new AtProtocolNetwork();
		const world = createWorld(network);
		const intake = await world.coordinator.authority.createSpace(
			SPACE_TYPES.requestIntake,
			"main",
			await loadPolicy("request_intake.json", COORDINATOR),
		);
		await assert.rejects(
			world.taxi.watchSpace(intake, () => {}),
			SpaceAccessDeniedError,
		);
	});
});

describe("in-memory: writes and procedures", () => {
	test("a write to a space that does not exist is accepted and hidden", async () => {
		const network = new AtProtocolNetwork();
		const world = createWorld(network);
		await world.rider.putSpaceRecord(
			requestIntakeSpaceRef(COORDINATOR),
			"com.hivemind-network.requester.request",
			"a",
			{ $type: "com.hivemind-network.test.record" } as unknown as TypedObject,
		);
		assert.equal(network.hiddenWrites.length, 1);
	});

	test("callProcedure reaches the registered service with the caller's DID", async () => {
		const network = new AtProtocolNetwork();
		const world = createWorld(network);
		network.registerService(COORDINATOR_SERVICE, {
			procedures: {
				"com.hivemind-network.coordinator.register": async (caller, input) => ({
					caller,
					input,
				}),
			},
		});
		const output = await world.rider.callProcedure(
			COORDINATOR_SERVICE as Did,
			"com.hivemind-network.coordinator.register",
			{ role: "requester" },
		);
		assert.deepEqual(output, { caller: RIDER, input: { role: "requester" } });
		await assert.rejects(
			world.rider.callProcedure(
				COORDINATOR_SERVICE as Did,
				"com.hivemind-network.coordinator.unknown",
				{},
			),
		);
	});

	test("deliveryDelayMs delays changes but keeps their order", async () => {
		const network = new AtProtocolNetwork({ deliveryDelayMs: 20 });
		const world = createWorld(network);
		const space = await world.coordinator.authority.createSpace(
			SPACE_TYPES.task,
			"delayed",
			await loadPolicy("task.json", COORDINATOR),
		);
		const actions: string[] = [];
		await world.coordinator.gateway.watchSpace(space, (change) =>
			actions.push(change.action),
		);
		const record = {
			$type: "com.hivemind-network.test.record",
		} as unknown as TypedObject;
		await world.coordinator.gateway.putSpaceRecord(
			space,
			"com.hivemind-network.test.record",
			"a",
			record,
		);
		await world.coordinator.gateway.putSpaceRecord(
			space,
			"com.hivemind-network.test.record",
			"a",
			record,
		);
		await world.coordinator.gateway.deleteSpaceRecord(
			space,
			"com.hivemind-network.test.record",
			"a",
		);
		assert.deepEqual(actions, []);
		await eventually(() =>
			assert.deepEqual(actions, ["create", "update", "delete"]),
		);
	});
});
