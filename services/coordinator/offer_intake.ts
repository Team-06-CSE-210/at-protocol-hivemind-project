import type {
	AtprotoGateway,
	RecordChange,
} from "../../protocol/interfaces/internal/atproto_gateway.js";
import {
	OFFER_COLLECTION,
	type OfferEligibility,
	type OfferEnvelopeValidation,
	type OfferIntakeResult,
	type OfferPayloadValidation,
	type OfferRoutingObserver,
} from "../../protocol/interfaces/internal/offer_routing.ts";
import type {
	TaskRecord,
	TaskStore,
} from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentOffer,
	SpaceRef,
} from "../../protocol/interfaces/internal/types.js";

const MAX_STORE_WRITE_ATTEMPTS = 3;
const STORE_WRITE_RETRY_DELAY_MS = 25;

export interface OfferIntakeOptions
	extends OfferRoutingObserver<OfferIntakeResult> {
	gateway: Pick<AtprotoGateway, "watchSpace">;
	intakeSpace: SpaceRef;
	taskStore: TaskStore;
	validation: Pick<OfferEnvelopeValidation, "parseOffer">;
	isAgentEligible: OfferEligibility;
	validatePayload: OfferPayloadValidation;
	now?: () => number;
}

/** Collects responses; ranking and task state transitions belong to the task manager. */
export class OfferIntakeRouter {
	private pending: Promise<void> = Promise.resolve();
	private unwatch?: () => void;
	private starting?: Promise<void>;
	private generation = 0;

	private readonly options: OfferIntakeOptions;

	constructor(options: OfferIntakeOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.unwatch) return Promise.resolve();
		const generation = ++this.generation;
		this.starting = this.options.gateway
			.watchSpace(this.options.intakeSpace, (change) => {
				if (generation !== this.generation) return;
				void this.handleChange(change)
					.then((result) => this.options.onResult?.(result, change))
					.catch((error: unknown) => this.options.onError(error, change));
			})
			.then((stop) => {
				if (generation === this.generation) this.unwatch = stop;
				else stop();
			})
			.finally(() => {
				this.starting = undefined;
			});
		return this.starting;
	}

	async stop(): Promise<void> {
		++this.generation;
		this.unwatch?.();
		this.unwatch = undefined;
		await this.starting;
		await this.drain();
	}

	drain(): Promise<void> {
		return this.pending;
	}

	/** Serialize read-modify-write operations so simultaneous agents do not overwrite offers. */
	handleChange(change: RecordChange): Promise<OfferIntakeResult> {
		const result = this.pending.then(() => this.route(change));
		// A failed store/gateway call must reject its caller, but not poison the queue.
		this.pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async route(change: RecordChange): Promise<OfferIntakeResult> {
		if (
			change.space !== this.options.intakeSpace ||
			change.collection !== OFFER_COLLECTION
		) {
			return { status: "ignored", reason: "unrelatedRecord" };
		}
		if (change.action === "delete") return this.withdraw(change);

		let offer: AgentOffer;
		try {
			offer = this.options.validation.parseOffer(change.record);
		} catch {
			return { status: "rejected", reason: "invalidOffer" };
		}
		if (offer.decision === "accept" && !offer.payload) {
			return { status: "rejected", reason: "acceptWithoutPayload" };
		}
		const task = await this.options.taskStore.get(offer.taskId);
		if (!task) return { status: "rejected", reason: "unknownTask" };
		if (!this.isCollecting(task)) {
			return { status: "rejected", reason: "collectionClosed" };
		}
		const previous = await this.options.taskStore.findByRecord(
			change.author,
			OFFER_COLLECTION,
			change.rkey,
		);
		if (previous && previous.taskId !== task.taskId) {
			return { status: "rejected", reason: "offerTaskChanged" };
		}
		if (task.offers.some((entry) => entry.agent === change.author)) {
			return { status: "ignored", reason: "alreadyAnswered" };
		}
		if (!(await this.options.isAgentEligible(change.author, task))) {
			return { status: "rejected", reason: "agentNotEligible" };
		}
		if (offer.decision === "accept" && offer.payload) {
			try {
				await this.options.validatePayload(offer.payload, task.request.payload);
			} catch {
				return { status: "rejected", reason: "invalidPayload" };
			}
		}

		// Recover failed writes within this delivery: watchSpace does not promise
		// to replay a notification when an async consumer fails. Read fresh state
		// before each attempt, including when a write committed before reporting an error.
		for (let attempt = 1; ; attempt++) {
			const current = await this.options.taskStore.get(task.taskId);
			if (!current || !this.isCollecting(current)) {
				return { status: "rejected", reason: "collectionClosed" };
			}
			if (current.offers.some((entry) => entry.agent === change.author)) {
				return { status: "ignored", reason: "alreadyAnswered" };
			}
			try {
				await this.options.taskStore.put({
					...current,
					offers: [
						...current.offers,
						{ agent: change.author, rkey: change.rkey, offer },
					],
				});
				return { status: "stored", taskId: current.taskId, agent: change.author };
			} catch (error) {
				if (attempt >= MAX_STORE_WRITE_ATTEMPTS) throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, STORE_WRITE_RETRY_DELAY_MS * attempt),
				);
			}
		}
	}

	private async withdraw(change: RecordChange): Promise<OfferIntakeResult> {
		const task = await this.options.taskStore.findByRecord(
			change.author,
			OFFER_COLLECTION,
			change.rkey,
		);
		if (!task) return { status: "ignored", reason: "unknownOffer" };
		if (!this.isCollecting(task)) {
			return { status: "rejected", reason: "collectionClosed" };
		}
		await this.options.taskStore.put({
			...task,
			offers: task.offers.filter(
				(entry) => entry.agent !== change.author || entry.rkey !== change.rkey,
			),
		});
		return { status: "withdrawn", taskId: task.taskId, agent: change.author };
	}

	private isCollecting(task: TaskRecord): boolean {
		const deadline = Date.parse(task.state.respondBy ?? "");
		return (
			task.state.phase === "collecting" &&
			Number.isFinite(deadline) &&
			(this.options.now ?? Date.now)() < deadline
		);
	}
}
