import type {
	AtprotoGateway,
	RecordChange,
} from "../protocol/interfaces/internal/atproto_gateway.js";
import type { AgentBehavior } from "../protocol/interfaces/internal/client_lib.js";
import {
	DISPATCH_COLLECTION,
	OFFER_COLLECTION,
	type OfferEnvelopeValidation,
	type OfferRoutingObserver,
	type OfferSendResult,
} from "../protocol/interfaces/internal/offer_routing.ts";
import type {
	AgentOffer,
	Did,
	Dispatch,
	SpaceRef,
	TaskId,
} from "../protocol/interfaces/internal/types.js";

export interface AgentOfferRouterOptions
	extends OfferRoutingObserver<OfferSendResult> {
	gateway: Pick<
		AtprotoGateway,
		"did" | "watchSpace" | "putSpaceRecord" | "deleteSpaceRecord"
	>;
	coordinator: Did;
	intakeSpace: SpaceRef;
	feedSpaces: readonly SpaceRef[];
	behavior: Pick<AgentBehavior, "onDispatch">;
	validation: OfferEnvelopeValidation;
	/** Return a fresh AT Protocol TID. The same key is reused after a failed write. */
	createRkey(): string;
	now?: () => number;
}

interface PendingOffer {
	dispatch: Dispatch;
	closed: boolean;
	sent: boolean;
	busy: boolean;
	rkey?: string;
	offer?: AgentOffer;
}

/**
 * The offer portion of an agent client. Assignment verification and execution are separate.
 * All communication goes through the supplied gateway; no simulated PDS is imported here.
 */
export class AgentOfferRouter {
	private readonly offers = new Map<TaskId, PendingOffer>();
	private readonly taskByDispatch = new Map<string, TaskId>();
	private readonly work = new Set<Promise<OfferSendResult>>();
	private readonly unwatch: Array<() => void> = [];
	private starting?: Promise<void>;
	private generation = 0;
	private stopped = false;

	private readonly options: AgentOfferRouterOptions;

	constructor(options: AgentOfferRouterOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.unwatch.length) return Promise.resolve();
		this.stopped = false;
		const generation = ++this.generation;
		this.starting = this.watchFeeds(generation).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async watchFeeds(generation: number): Promise<void> {
		try {
			for (const space of new Set(this.options.feedSpaces)) {
				const stop = await this.options.gateway.watchSpace(space, (change) => {
					if (generation !== this.generation) return;
					void this.handleChange(change)
						.then((result) => this.options.onResult?.(result, change))
						.catch((error: unknown) => this.options.onError(error, change));
				});
				if (generation !== this.generation) {
					stop();
					return;
				}
				this.unwatch.push(stop);
			}
		} catch (error) {
			this.stopped = true;
			++this.generation;
			for (const stop of this.unwatch.splice(0)) stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		++this.generation;
		for (const stop of this.unwatch.splice(0)) stop();
		await this.starting;
		await this.drain();
	}

	/** Wait for work already delivered by the gateway; useful for shutdown and tests. */
	async drain(): Promise<void> {
		while (this.work.size) await Promise.allSettled([...this.work]);
	}

	/** Also available to clients that already own a feed watcher. */
	handleChange(change: RecordChange): Promise<OfferSendResult> {
		const work = this.route(change);
		this.work.add(work);
		void work.then(
			() => this.work.delete(work),
			() => this.work.delete(work),
		);
		return work;
	}

	private async route(change: RecordChange): Promise<OfferSendResult> {
		if (
			this.stopped ||
			change.collection !== DISPATCH_COLLECTION ||
			change.author !== this.options.coordinator ||
			!change.space ||
			!this.options.feedSpaces.includes(change.space)
		) {
			return { status: "ignored", reason: "unrelatedRecord" };
		}

		const dispatchKey = `${change.space}/${change.rkey}`;
		if (change.action === "delete") {
			const taskId = this.taskByDispatch.get(dispatchKey);
			const pending = taskId && this.offers.get(taskId);
			// Coordinator deletion closes the call for offers. Assignment handling owns
			// finding the winner; a deletion alone must not trigger onLost().
			if (pending) pending.closed = true;
			return { status: "ignored", reason: "dispatchClosed" };
		}

		let dispatch: Dispatch;
		try {
			dispatch = this.options.validation.parseDispatch(change.record);
		} catch {
			return { status: "rejected", reason: "invalidDispatch" };
		}
		const previousTask = this.taskByDispatch.get(dispatchKey);
		if (previousTask && previousTask !== dispatch.taskId) {
			return { status: "rejected", reason: "dispatchTaskChanged" };
		}
		let pending = this.offers.get(dispatch.taskId);
		// The in-flight decision must see deadline updates, even when this update
		// is already expired or will otherwise be ignored because the task is busy.
		if (pending && !pending.closed && !pending.sent) {
			pending.dispatch = { ...pending.dispatch, respondBy: dispatch.respondBy };
		}
		if (!this.isOpen(dispatch)) {
			return { status: "ignored", reason: "deadlinePassed" };
		}
		this.taskByDispatch.set(dispatchKey, dispatch.taskId);
		if (pending?.closed || pending?.sent || pending?.busy) {
			return { status: "ignored", reason: "alreadyAnsweredOrClosed" };
		}
		if (!pending) {
			pending = { dispatch, closed: false, sent: false, busy: false };
			this.offers.set(dispatch.taskId, pending);
		}
		pending.busy = true;
		try {
			if (!pending.offer) {
				const answer = await this.options.behavior.onDispatch(pending.dispatch);
				const offer = this.options.validation.parseOffer({
					...answer,
					$type: OFFER_COLLECTION,
					taskId: dispatch.taskId,
					createdAt: new Date(this.now()).toISOString(),
				});
				if (offer.decision === "accept" && !offer.payload) {
					return { status: "rejected", reason: "acceptWithoutPayload" };
				}
				pending.offer = offer;
			}
			if (!pending.rkey) {
				const rkey = this.options.createRkey();
				if (!rkey) throw new Error("Offer record key must not be empty");
				pending.rkey = rkey;
			}
			// An operator's decision may take time. Recheck closure and the deadline
			// after it finishes, before making any write.
			if (this.stopped || pending.closed || !this.isOpen(pending.dispatch)) {
				return { status: "ignored", reason: "dispatchClosedOrExpired" };
			}
			const rkey = pending.rkey;
			if (!rkey) throw new Error("Offer record key must not be empty");
			await this.options.gateway.putSpaceRecord(
				this.options.intakeSpace,
				OFFER_COLLECTION,
				rkey,
				pending.offer,
			);
			pending.sent = true;
			return { status: "sent", offer: pending.offer, rkey };
		} finally {
			pending.busy = false;
		}
	}

	/** The main protocol withdraws an offer by deleting its record. */
	async withdraw(taskId: TaskId): Promise<void> {
		const pending = this.offers.get(taskId);
		if (!pending?.sent || !pending.rkey) return;
		await this.options.gateway.deleteSpaceRecord(
			this.options.intakeSpace,
			OFFER_COLLECTION,
			pending.rkey,
		);
		pending.closed = true;
		pending.sent = false;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private isOpen(dispatch: Dispatch): boolean {
		const deadline = Date.parse(dispatch.respondBy);
		return Number.isFinite(deadline) && this.now() < deadline;
	}
}
