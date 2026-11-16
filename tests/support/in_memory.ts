import {
	SpaceAccessDeniedError,
	type AtprotoGateway,
	type RecordChange,
} from "../../protocol/interfaces/internal/atproto_gateway.ts";
import { OFFER_COLLECTION } from "../../protocol/interfaces/internal/offer_routing.ts";
import type {
	TaskRecord,
	TaskStore,
} from "../../protocol/interfaces/internal/stores.js";
import type {
	AtUri,
	Did,
	Nsid,
	SpaceRef,
	TaskId,
	TypedObject,
} from "../../protocol/interfaces/internal/types.js";

interface MemorySpace {
	readers: Set<Did>;
	writers: Set<Did>;
	records: Map<string, RecordChange>;
	watchers: Set<{ did: Did; listener: (change: RecordChange) => void }>;
}

/** Test double, not an implementation of the AT Protocol or its authentication. */
export class InMemoryGatewayNetwork {
	private readonly spaces = new Map<SpaceRef, MemorySpace>();
	private readonly publicRecords = new Map<AtUri, TypedObject>();
	private readonly publicWatchers = new Set<{
		collections: Nsid[];
		listener: (change: RecordChange) => void;
	}>();

	createSpace(space: SpaceRef, readers: Did[], writers: Did[]): void {
		if (this.spaces.has(space)) throw new Error(`Space already exists: ${space}`);
		this.spaces.set(space, {
			readers: new Set(readers),
			writers: new Set(writers),
			records: new Map(),
			watchers: new Set(),
		});
	}

	/** Every change author is derived from this account, never from record content. */
	gateway(did: Did): AtprotoGateway {
		return {
			did,
			putRecord: async (collection, rkey, record) => {
				const uri: AtUri = `at://${did}/${collection}/${rkey}`;
				const action = this.publicRecords.has(uri) ? "update" : "create";
				this.publicRecords.set(uri, structuredClone(record));
				this.emitPublic({ action, author: did, collection, rkey, record });
				return uri;
			},
			deleteRecord: async (collection, rkey) => {
				if (this.publicRecords.delete(`at://${did}/${collection}/${rkey}`)) {
					this.emitPublic({ action: "delete", author: did, collection, rkey });
				}
			},
			getRecord: async (uri) => structuredClone(this.publicRecords.get(uri)),
			putSpaceRecord: async (spaceRef, collection, rkey, record) => {
				const space = this.requireAccess(spaceRef, did, "write");
				const key = `${did}/${collection}/${rkey}`;
				const change: RecordChange = {
					action: space.records.has(key) ? "update" : "create",
					author: did,
					collection,
					rkey,
					record: structuredClone(record),
					space: spaceRef,
				};
				space.records.set(key, change);
				this.emit(space, change);
			},
			deleteSpaceRecord: async (spaceRef, collection, rkey) => {
				const space = this.requireAccess(spaceRef, did, "write");
				if (space.records.delete(`${did}/${collection}/${rkey}`)) {
					this.emit(space, {
						action: "delete",
						author: did,
						collection,
						rkey,
						space: spaceRef,
					});
				}
			},
			watchSpace: async (spaceRef, listener) => {
				const space = this.requireAccess(spaceRef, did, "read");
				const watcher = { did, listener };
				space.watchers.add(watcher);
				try {
					for (const change of space.records.values()) {
						listener(structuredClone({ ...change, action: "create" }));
					}
				} catch (error) {
					space.watchers.delete(watcher);
					throw error;
				}
				return () => space.watchers.delete(watcher);
			},
			watchPublic: async (collections, listener) => {
				const watcher = { collections, listener };
				this.publicWatchers.add(watcher);
				return () => this.publicWatchers.delete(watcher);
			},
			callProcedure: async () => {
				throw new Error("This test network has no registered XRPC procedures");
			},
		};
	}

	private requireAccess(spaceRef: SpaceRef, did: Did, access: "read" | "write") {
		const space = this.spaces.get(spaceRef);
		if (!space || !(access === "read" ? space.readers : space.writers).has(did)) {
			throw new SpaceAccessDeniedError(`${did} may not ${access} ${spaceRef}`);
		}
		return space;
	}

	private emit(space: MemorySpace, change: RecordChange): void {
		for (const { did, listener } of space.watchers) {
			if (space.readers.has(did)) listener(structuredClone(change));
		}
	}

	private emitPublic(change: RecordChange): void {
		for (const { collections, listener } of this.publicWatchers) {
			if (collections.includes(change.collection)) listener(structuredClone(change));
		}
	}
}

const TERMINAL_PHASES = new Set([
	"completed",
	"cancelled",
	"failed",
	"noCoverage",
	"noOffers",
	"expired",
]);

export class InMemoryTaskStore implements TaskStore {
	private readonly tasks = new Map<TaskId, TaskRecord>();

	async get(taskId: TaskId): Promise<TaskRecord | undefined> {
		return structuredClone(this.tasks.get(taskId));
	}

	async put(task: TaskRecord): Promise<void> {
		this.tasks.set(task.taskId, structuredClone(task));
	}

	async findByRecord(
		author: Did,
		collection: Nsid,
		rkey: string,
	): Promise<TaskRecord | undefined> {
		for (const task of this.tasks.values()) {
			const isRequest =
				collection === "network.hivemind.requester.request" &&
				task.requester === author &&
				task.requestRkey === rkey;
			const isOffer =
				collection === OFFER_COLLECTION &&
				task.offers.some((entry) => entry.agent === author && entry.rkey === rkey);
			if (isRequest || isOffer) return structuredClone(task);
		}
		return undefined;
	}

	async listOpen(): Promise<TaskRecord[]> {
		return structuredClone(
			[...this.tasks.values()].filter(
				(task) => !TERMINAL_PHASES.has(task.state.phase),
			),
		);
	}
}
