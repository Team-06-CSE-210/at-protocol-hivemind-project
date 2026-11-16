import assert from "node:assert/strict";
import type { RecordChange } from "../../protocol/interfaces/internal/atproto_gateway.js";
import {
	DISPATCH_COLLECTION,
	OFFER_COLLECTION,
	type OfferEnvelopeValidation,
} from "../../protocol/interfaces/internal/offer_routing.ts";
import type { TaskRecord } from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentOffer,
	Dispatch,
	SpaceRef,
	TypedObject,
} from "../../protocol/interfaces/internal/types.js";

export const NOW = Date.parse("2026-11-15T12:00:00.000Z");
export const COORDINATOR = "did:web:hivemind.example";
export const AGENT = "did:web:taxi.example";
export const OTHER_AGENT = "did:web:other-taxi.example";
export const TASK_ID = "abcdefghijklmnopqrstuvwxyz";
export const SECOND_TASK_ID = "bcdefghijklmnopqrstuvwxyza2";
export const INTAKE: SpaceRef = `at://${COORDINATOR}/space/network.hivemind.space.intake/main`;
export const FEED: SpaceRef = `at://${COORDINATOR}/space/network.hivemind.space.feed/county`;
export const SECOND_FEED: SpaceRef = `at://${COORDINATOR}/space/network.hivemind.space.feed/city`;

export const REQUEST_PAYLOAD: TypedObject = {
	$type: "network.hivemind.mobility.ride#request",
	pickup: { latE7: 327330000, lonE7: -1171900000 },
	dropoff: { latE7: 327070000, lonE7: -1171570000 },
	passengers: 2,
};

export const OFFER_PAYLOAD: TypedObject = {
	$type: "network.hivemind.mobility.ride#offer",
	pickupEtaSeconds: 180,
	tripDurationSeconds: 600,
	tripDistanceMeters: 5000,
	price: { amountMinor: 1800, currency: "USD" },
	vehicle: { model: "Test taxi", seats: 4 },
};

export function makeDispatch(): Dispatch {
	return {
		$type: DISPATCH_COLLECTION,
		taskId: TASK_ID,
		payload: structuredClone(REQUEST_PAYLOAD),
		respondBy: new Date(NOW + 10_000).toISOString(),
		createdAt: new Date(NOW).toISOString(),
	};
}

export function makeOffer(): AgentOffer {
	return {
		$type: OFFER_COLLECTION,
		taskId: TASK_ID,
		decision: "accept",
		payload: structuredClone(OFFER_PAYLOAD),
		createdAt: new Date(NOW).toISOString(),
	};
}

export function makeTask(): TaskRecord {
	return {
		taskId: TASK_ID,
		requester: "did:web:rider.example",
		requestRkey: "3m22222222222",
		request: {
			$type: "network.hivemind.requester.request",
			taskId: TASK_ID,
			payload: structuredClone(REQUEST_PAYLOAD),
			selectionMode: "auto",
			createdAt: new Date(NOW).toISOString(),
		},
		matchedFeeds: [`at://${COORDINATOR}/network.hivemind.feed.declaration/county`],
		offers: [],
		state: {
			$type: "network.hivemind.coordinator.taskState",
			phase: "collecting",
			respondBy: new Date(NOW + 10_000).toISOString(),
			updatedAt: new Date(NOW).toISOString(),
		},
	};
}

export function offerChange(
	overrides: Partial<RecordChange> = {},
): RecordChange {
	return {
		action: "create",
		author: AGENT,
		collection: OFFER_COLLECTION,
		rkey: "3m22222222223",
		space: INTAKE,
		record: makeOffer(),
		...overrides,
	};
}

export function dispatchChange(
	overrides: Partial<RecordChange> = {},
): RecordChange {
	return {
		action: "create",
		author: COORDINATOR,
		collection: DISPATCH_COLLECTION,
		rkey: TASK_ID,
		space: FEED,
		record: makeDispatch(),
		...overrides,
	};
}

/**
 * Deliberately small validator doubles. These test the routing/validation boundary,
 * not Lexicon compliance. Application wiring must supply generated validators.
 */
export const fixtureValidation: OfferEnvelopeValidation = {
	parseDispatch(value) {
		assert.ok(value && typeof value === "object");
		const dispatch = value as Dispatch;
		assert.equal(dispatch.$type, DISPATCH_COLLECTION);
		assert.equal(typeof dispatch.taskId, "string");
		assert.ok(Number.isFinite(Date.parse(dispatch.respondBy)));
		assert.ok(dispatch.payload);
		return dispatch;
	},
	parseOffer(value) {
		assert.ok(value && typeof value === "object");
		const offer = value as AgentOffer;
		assert.equal(offer.$type, OFFER_COLLECTION);
		assert.equal(typeof offer.taskId, "string");
		assert.ok(["accept", "decline"].includes(offer.decision));
		assert.ok(Number.isFinite(Date.parse(offer.createdAt)));
		return offer;
	},
};
