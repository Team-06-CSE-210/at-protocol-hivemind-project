import { setTimeout as sleep } from "node:timers/promises";
import { TID } from "@atproto/common-web";
import { l } from "@atproto/lex";
import * as hivemind from "../core/protocol/generated/com/hivemind-network.js";
import type {
	AtprotoGateway,
	RecordChange,
} from "../core/protocol/interfaces/internal/atproto_gateway.js";
import type { AgentBehavior } from "../core/protocol/interfaces/internal/client_lib.js";
import type {
	AgentOffer,
	AtUri,
	Did,
	Dispatch,
	SpaceRef,
	TaskId,
} from "../core/protocol/interfaces/internal/types.js";
import {
	feedSpaceRef,
	offerIntakeSpaceRef,
} from "../core/protocol/protocol_config/space_definition.js";
import {
	moduleForPayload,
	taskTypeOf,
} from "../core/protocol/type_definition/task_types/task_index.js";
import {
	DEFAULT_OFFER_ROUTING_CONFIG,
	type OfferRoutingConfig,
} from "./offer_routing_config.js";

// The offer portion of AgentClient (K4): follow feed spaces, ask the operator's behavior once
// per task, and write its answer into the coordinator's offer intake. Onboarding and assignment
// execution plug in separately. Only AtprotoGateway is used, so either implementation fits.

export interface AgentOfferRouterDependencies {
	// Use the agent's account to follow feeds and write or withdraw an offer
	gateway: Pick<
		AtprotoGateway,
		"watchSpace" | "putSpaceRecord" | "deleteSpaceRecord"
	>;
	// Trust dispatches from this coordinator, which also owns the offer intake
	coordinator: Did;
	// Follow the declarations listed in the agent's profile; onboarding publishes that profile
	feeds: readonly AtUri[];
	// Ask the operator to accept with terms, or decline with a reason
	behavior: Pick<AgentBehavior, "onDispatch">;
	// Report background failures after the bounded write retries are exhausted
	onError(error: unknown, change: RecordChange): void;
	// Observe completed Gateway writes; this is not an acknowledgement from the coordinator
	onSent?(offer: AgentOffer, rkey: string): void;
	// Inject time, record keys and retry waits for deterministic tests
	now?: () => Date;
	createRkey?: () => string;
	sleep?: (delayMs: number) => Promise<unknown>;
}

interface PendingOffer {
	dispatch: Dispatch;
	closed: boolean;
	sent: boolean;
	busy: boolean;
	offer?: AgentOffer;
	rkey?: string;
	write?: Promise<void>;
}

export class AgentOfferRouter {
	private readonly offers = new Map<TaskId, PendingOffer>();
	private readonly taskByDispatch = new Map<string, TaskId>();
	// The dispatches of each task that are not deleted yet; a task can arrive through several feeds
	private readonly dispatchesByTask = new Map<TaskId, Set<string>>();
	private readonly feedSpaces = new Set<SpaceRef>();
	private readonly work = new Set<Promise<void>>();
	private readonly unwatch: Array<() => void> = [];
	private starting?: Promise<void>;
	private stopping?: Promise<void>;
	private generation = 0;
	private stopped = true;
	private readonly dependencies: AgentOfferRouterDependencies;
	private readonly config: OfferRoutingConfig;

	constructor(
		dependencies: AgentOfferRouterDependencies,
		config: OfferRoutingConfig = DEFAULT_OFFER_ROUTING_CONFIG,
	) {
		if (
			!Number.isInteger(config.maxWriteAttempts) ||
			config.maxWriteAttempts < 1 ||
			!Number.isFinite(config.retryDelayMs) ||
			config.retryDelayMs < 0
		) {
			throw new Error("AgentOfferRouter: invalid write retry configuration");
		}
		this.dependencies = dependencies;
		this.config = config;
	}

	// Follow each feed once, including the records already in it
	start(): Promise<void> {
		if (this.stopping) {
			return this.stopping.then(() => this.start());
		}
		if (this.starting) {
			return this.starting;
		}
		if (!this.stopped) {
			return Promise.resolve();
		}
		this.stopped = false;
		const generation = ++this.generation;
		this.starting = this.watchFeeds(generation).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	// Drop subscriptions and wait for any decision or write already in progress
	stop(): Promise<void> {
		if (this.stopping) {
			return this.stopping;
		}
		this.stopped = true;
		++this.generation;
		for (const stop of this.unwatch.splice(0)) {
			stop();
		}
		this.stopping = (async () => {
			await Promise.allSettled([this.starting]);
			await this.settled();
		})().finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}

	// Tasks kept in memory: open dispatches, and decisions or writes still running
	get trackedTasks(): number {
		return new Set([...this.offers.keys(), ...this.dispatchesByTask.keys()])
			.size;
	}

	// Wait for work already delivered by the Gateway, for shutdown and local tests
	async settled(): Promise<void> {
		while (this.work.size > 0) {
			await Promise.allSettled([...this.work]);
		}
	}

	// Withdraw by deleting the agent's own offer record; the coordinator observes the deletion
	async withdraw(taskId: TaskId): Promise<void> {
		const pending = this.offers.get(taskId);
		if (!pending) {
			return;
		}
		// Stop a pending decision or retry before waiting for a write already sent to the Gateway
		pending.closed = true;
		await pending.write?.catch(() => {});
		if (!pending.rkey) {
			return;
		}
		// A rejected write may still have persisted; deleting the same key is safe in either case
		for (let attempt = 1; attempt <= this.config.maxWriteAttempts; attempt++) {
			try {
				await this.dependencies.gateway.deleteSpaceRecord(
					offerIntakeSpaceRef(this.dependencies.coordinator),
					hivemind.agent.offer.$nsid,
					pending.rkey,
				);
				break;
			} catch (error) {
				if (attempt === this.config.maxWriteAttempts) {
					throw error;
				}
				await (this.dependencies.sleep ?? sleep)(this.config.retryDelayMs);
			}
		}
		pending.sent = false;
	}

	// Resolve declaration addresses and release every earlier watch if a later one fails
	private async watchFeeds(generation: number): Promise<void> {
		try {
			for (const feed of new Set(this.dependencies.feeds)) {
				const space = await feedSpaceRef(this.dependencies.coordinator, feed);
				if (generation !== this.generation) {
					return;
				}
				this.feedSpaces.add(space);
				const stop = await this.dependencies.gateway.watchSpace(
					space,
					(change) => {
						if (generation !== this.generation) {
							return;
						}
						const work = this.route(change);
						this.work.add(work);
						void work.then(
							() => this.work.delete(work),
							(error: unknown) => {
								this.work.delete(work);
								this.dependencies.onError(error, change);
							},
						);
					},
				);
				if (generation !== this.generation) {
					stop();
					return;
				}
				this.unwatch.push(stop);
			}
		} catch (error) {
			this.stopped = true;
			++this.generation;
			for (const stop of this.unwatch.splice(0)) {
				stop();
			}
			throw error;
		}
	}

	// Accept only coordinator dispatches from a followed feed; updates can shorten a deadline
	private async route(change: RecordChange): Promise<void> {
		if (
			this.stopped ||
			change.collection !== hivemind.coordinator.dispatch.$nsid ||
			change.author !== this.dependencies.coordinator ||
			!change.space ||
			!this.feedSpaces.has(change.space)
		) {
			return;
		}
		const dispatchKey = `${change.space}/${change.rkey}`;
		if (change.action === "delete") {
			const taskId = this.taskByDispatch.get(dispatchKey);
			if (taskId === undefined) {
				return;
			}
			const pending = this.offers.get(taskId);
			if (pending) {
				pending.closed = true;
			}
			// The coordinator deletes dispatches when collection ends; they do not come back
			this.taskByDispatch.delete(dispatchKey);
			this.dispatchesByTask.get(taskId)?.delete(dispatchKey);
			this.forgetIfClosed(taskId);
			return;
		}
		const parsed = hivemind.coordinator.dispatch.main.safeParse(change.record);
		if (!parsed.success) {
			return;
		}
		const dispatch = parsed.value;
		const previousTask = this.taskByDispatch.get(dispatchKey);
		if (previousTask && previousTask !== dispatch.taskId) {
			return;
		}
		this.taskByDispatch.set(dispatchKey, dispatch.taskId);
		const dispatches =
			this.dispatchesByTask.get(dispatch.taskId) ?? new Set<string>();
		dispatches.add(dispatchKey);
		this.dispatchesByTask.set(dispatch.taskId, dispatches);
		let pending = this.offers.get(dispatch.taskId);
		if (pending?.closed || pending?.sent) {
			return;
		}
		// An operator may still be deciding when the coordinator updates respondBy
		if (pending) {
			pending.dispatch = { ...pending.dispatch, respondBy: dispatch.respondBy };
		}
		if (pending?.busy || !this.isOpen(dispatch)) {
			return;
		}
		if (!pending) {
			pending = { dispatch, closed: false, sent: false, busy: false };
			this.offers.set(dispatch.taskId, pending);
		}
		pending.busy = true;
		try {
			if (!pending.offer) {
				const answer = await this.dependencies.behavior.onDispatch(
					structuredClone(pending.dispatch),
				);
				const offer = hivemind.agent.offer.main.parse(
					structuredClone({
						...answer,
						$type: hivemind.agent.offer.$nsid,
						taskId: dispatch.taskId,
						createdAt: l.toDatetimeString(this.now()),
					}),
				);
				if (offer.decision === "accept") {
					if (offer.payload === undefined) {
						throw new Error(
							"AgentOfferRouter: an accepted offer needs a payload",
						);
					}
					// The coordinator checks accepted terms with the task type's module and drops
					// those that fail without telling the agent. Check them here against the dispatch
					// (coarsening keeps what the checks read), so a refused answer is reported
					// through onError and not written
					const taskTypeModule = moduleForPayload(pending.dispatch.payload);
					if (taskTypeModule === undefined) {
						throw new Error(
							`AgentOfferRouter: unsupported task type ${taskTypeOf(pending.dispatch.payload)}`,
						);
					}
					taskTypeModule.parseOffer(
						l.asUnknown$TypedObject(offer.payload),
						pending.dispatch.payload,
					);
				}
				// Keep the decision even if generating a record key or writing fails
				pending.offer = offer;
			}
			await this.writeOffer(pending, pending.offer);
		} finally {
			pending.busy = false;
			this.forgetIfClosed(dispatch.taskId);
		}
	}

	// Forget a task once all its dispatches are deleted and no decision or write is running, so a
	// long-running agent keeps state only for open dispatches. Nothing is lost: a deleted dispatch
	// does not come back, and a withdrawal after collection would change nothing
	private forgetIfClosed(taskId: TaskId): void {
		if (
			(this.dispatchesByTask.get(taskId)?.size ?? 0) > 0 ||
			this.offers.get(taskId)?.busy
		) {
			return;
		}
		this.dispatchesByTask.delete(taskId);
		this.offers.delete(taskId);
	}

	// Retry with the same terms and key, while the latest dispatch is still open
	private async writeOffer(
		pending: PendingOffer,
		offer: AgentOffer,
	): Promise<void> {
		for (let attempt = 1; attempt <= this.config.maxWriteAttempts; attempt++) {
			if (this.stopped || pending.closed || !this.isOpen(pending.dispatch)) {
				return;
			}
			try {
				if (!pending.rkey) {
					const rkey = (
						this.dependencies.createRkey ?? (() => TID.nextStr())
					)();
					if (!rkey) {
						throw new Error(
							"AgentOfferRouter: offer record key must not be empty",
						);
					}
					pending.rkey = rkey;
				}
				pending.write = this.dependencies.gateway.putSpaceRecord(
					offerIntakeSpaceRef(this.dependencies.coordinator),
					hivemind.agent.offer.$nsid,
					pending.rkey,
					l.asUnknown$TypedObject(offer),
				);
				await pending.write;
			} catch (error) {
				if (pending.closed || this.stopped) {
					return;
				}
				if (attempt === this.config.maxWriteAttempts) {
					throw error;
				}
				await (this.dependencies.sleep ?? sleep)(this.config.retryDelayMs);
				continue;
			}
			if (pending.closed) {
				return;
			}
			pending.sent = true;
			if (pending.rkey) {
				this.dependencies.onSent?.(structuredClone(offer), pending.rkey);
			}
			return;
		}
	}

	// Read the injected clock or real time
	private now(): Date {
		return (this.dependencies.now ?? (() => new Date()))();
	}

	// Refuse writes at or after respondBy, including after a slow decision or retry wait
	private isOpen(dispatch: Dispatch): boolean {
		return this.now().getTime() < Date.parse(dispatch.respondBy);
	}
}
