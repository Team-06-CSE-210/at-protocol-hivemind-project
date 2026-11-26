import { l } from "@atproto/lex";
import { createMemoryStores } from "../../core/coordinator/data/memory_stores.js";
import { ManualClock } from "../../core/coordinator/library/clock.js";
import { CoordinatorApiHandlers } from "../../core/coordinator/runtime/api_handlers.js";
import {
	LocalSimGateway,
	LocalSimSpaceAuthority,
} from "../../core/protocol/communication/in_memory/at_gateway_localsim.js";
import { AtProtocolNetwork } from "../../core/protocol/communication/in_memory/at_protocol_network.js";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import type { Dispatch } from "../../core/protocol/interfaces/internal/types.js";
import {
	feedKeyOf,
	feedSpaceRef,
	SPACE_TYPES,
} from "../../core/protocol/protocol_config/space_definition.js";
import { AtprotoSpaces } from "../../services/space_service/atproto_spaces.js";
import {
	COORDINATOR,
	DOWNTOWN_FEED,
	rideRequest,
	START,
	seedParticipants,
	TAXI_ONE,
	taskIdFor,
} from "../coordinator/fixtures.js";
import { loadPolicy } from "../gateway/gateway_contract.js";

// Real local gateways and coordinator access checks. Only the feed setup (S3) is done directly,
// because the feed part of SpaceService is still a placeholder on this develop branch.
export async function createOfferRoutingWorld() {
	const network = new AtProtocolNetwork();
	const coordinator = new LocalSimGateway(network, COORDINATOR);
	const taxi = new LocalSimGateway(network, TAXI_ONE);
	const authority = new LocalSimSpaceAuthority(network, COORDINATOR);
	const stores = createMemoryStores(COORDINATOR);
	const clock = new ManualClock(START);
	await seedParticipants(stores);
	const api = new CoordinatorApiHandlers({
		coordinator: COORDINATOR,
		stores,
		gateway: coordinator,
		indexer: { apply: (change) => stores.publicIndex.apply(change) },
		clock,
	});
	network.registerService(`${COORDINATOR}#hivemind_coordinator`, {
		checkUserAccess: api.checkUserAccess.bind(api),
	});
	const spaces = new AtprotoSpaces(
		authority,
		await loadPolicy("task.json", COORDINATOR),
		coordinator,
	);
	const offerPolicy = await loadPolicy("offer_intake.json", COORDINATOR);
	const intake = await spaces.setUpOfferIntake(offerPolicy);
	const feed = await feedSpaceRef(COORDINATOR, DOWNTOWN_FEED);
	await authority.createSpace(
		SPACE_TYPES.feed,
		await feedKeyOf(DOWNTOWN_FEED),
		await loadPolicy("feed.json", COORDINATOR),
	);
	const dispatch: Dispatch = {
		$type: "com.hivemind-network.coordinator.dispatch",
		taskId: taskIdFor("offerrouting"),
		payload: rideRequest(taskIdFor("offerrouting")).payload,
		respondBy: l.toDatetimeString(new Date(START.getTime() + 30_000)),
		createdAt: l.toDatetimeString(START),
	};
	const publish = (record: Dispatch = dispatch) =>
		coordinator.putSpaceRecord(
			feed,
			hivemind.coordinator.dispatch.$nsid,
			dispatch.taskId,
			l.asUnknown$TypedObject(record),
		);
	return {
		network,
		coordinator,
		taxi,
		authority,
		stores,
		clock,
		spaces,
		offerPolicy,
		intake,
		feed,
		dispatch,
		publish,
	};
}
