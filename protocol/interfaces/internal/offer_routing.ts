import type { RecordChange } from "./atproto_gateway.js";
import type { TaskRecord } from "./stores.js";
import type { AgentOffer, Did, Dispatch, TypedObject } from "./types.js";

/** Supply the generated Lexicon validators here; routing owns no schema definitions. */
export interface OfferEnvelopeValidation {
	parseDispatch(value: unknown): Dispatch;
	parseOffer(value: unknown): AgentOffer;
}

/** Includes registration, operator standing, feed subscription and private-feed access. */
export type OfferEligibility = (agent: Did, task: TaskRecord) => Promise<boolean>;

/** Select the task type from request.$type, then call its parseOffer implementation. */
export type OfferPayloadValidation = (
	payload: TypedObject,
	request: TypedObject,
) => void | Promise<void>;

export interface OfferRoutingObserver<Result> {
	/** Required so background watcher failures are never silently discarded. */
	onError(error: unknown, change: RecordChange): void;
	onResult?(result: Result, change: RecordChange): void;
}

export type OfferSendResult =
	| { status: "sent"; offer: AgentOffer; rkey: string }
	| { status: "ignored"; reason: string }
	| { status: "rejected"; reason: string };

export type OfferIntakeResult =
	| { status: "stored" | "withdrawn"; taskId: string; agent: Did }
	| { status: "ignored" | "rejected"; reason: string };

export const OFFER_COLLECTION = "network.hivemind.agent.offer";
export const DISPATCH_COLLECTION = "network.hivemind.coordinator.dispatch";
