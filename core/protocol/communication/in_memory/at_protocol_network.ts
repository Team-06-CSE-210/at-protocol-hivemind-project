import {
	type RecordChange,
	SpaceAccessDeniedError,
	type SpacePolicy,
} from "../../interfaces/internal/atproto_gateway.js";
import type {
	AtUri,
	Did,
	Nsid,
	SpaceRef,
	TypedObject,
} from "../../interfaces/internal/types.js";
import { formatSpaceRef } from "../../protocol_config/space_definition.js";

// Stands in for every PDS, the space hosts and the firehose at once, inside one process.
// Each account talks to it through its own LocalSimGateway (at_gateway_localsim.ts).
//
// It copies the behaviour the frozen alpha showed in tests, so code written against it also
// works against a real PDS:
// - a write without write access is accepted but never reaches readers
// - following a space replays its current records, then delivers new changes
// - managed spaces ask their managing app; member spaces check the member list
// It leaves out everything the gateway hides: DIDs, credentials, signatures, MACs, network errors.

export type ProcedureHandler = (
	caller: Did,
	input: unknown,
) => Promise<unknown>;

// A service registered under its service identifier, e.g. did:web:hivemind-network.com#hivemind_coordinator
export interface LocalSimService {
	// Answers access checks of the managed spaces that name this service as managing app
	checkUserAccess?(
		space: SpaceRef,
		user: Did,
		access: "read" | "write",
	): Promise<boolean>;
	// XRPC procedures, by method NSID
	procedures?: Record<string, ProcedureHandler>;
}

// Same answer as the PDS gives for putMember on a managed space
export class PolicyMismatchError extends Error {}

type ChangeListener = (change: RecordChange) => void;

interface StoredSpace {
	authority: Did;
	policy: SpacePolicy;
	members: Map<Did, { read: boolean; write: boolean }>;
	// Each writer's records in the space, by "collection/rkey"
	recordsByWriter: Map<Did, Map<string, TypedObject>>;
	listeners: Set<ChangeListener>;
}

interface PublicListener {
	collections: Set<Nsid>;
	onChange: ChangeListener;
}

export interface AtProtocolNetworkOptions {
	// Delay every delivery, to make timing visible in the demo. Default: next microtask.
	deliveryDelayMs?: number;
}

export class AtProtocolNetwork {
	// Writes that readers never see because the writer had no write access or the space does not
	// exist. Tests look here; a real space host just leaves such writers out.
	readonly hiddenWrites: RecordChange[] = [];

	private readonly publicRecords = new Map<string, TypedObject>();
	private readonly publicListeners = new Set<PublicListener>();
	private readonly spaces = new Map<SpaceRef, StoredSpace>();
	private readonly services = new Map<string, LocalSimService>();

	constructor(private readonly options: AtProtocolNetworkOptions = {}) {}

	registerService(serviceId: string, service: LocalSimService): void {
		this.services.set(serviceId, service);
	}

	// * * * * * * * * * * * * * * * * * *
	// Public repos
	// * * * * * * * * * * * * * * * * * *

	putPublicRecord(
		author: Did,
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): AtUri {
		const uri = publicUri(author, collection, rkey);
		const action = this.publicRecords.has(uri) ? "update" : "create";
		this.publicRecords.set(uri, structuredClone(record));
		this.notifyPublic({ action, author, collection, rkey, record });
		return uri;
	}

	deletePublicRecord(author: Did, collection: Nsid, rkey: string): void {
		// Like the PDS: deleting a record that does not exist is fine and emits nothing
		if (this.publicRecords.delete(publicUri(author, collection, rkey))) {
			this.notifyPublic({ action: "delete", author, collection, rkey });
		}
	}

	getPublicRecord(uri: AtUri): TypedObject | undefined {
		const record = this.publicRecords.get(uri);
		return record === undefined ? undefined : structuredClone(record);
	}

	// Live only, like a firehose subscription without a cursor: no replay of existing records
	watchPublic(collections: Nsid[], onChange: ChangeListener): () => void {
		const listener = { collections: new Set(collections), onChange };
		this.publicListeners.add(listener);
		return () => {
			this.publicListeners.delete(listener);
		};
	}

	// * * * * * * * * * * * * * * * * * *
	// Spaces: administration
	// * * * * * * * * * * * * * * * * * *

	createSpace(
		authority: Did,
		spaceType: Nsid,
		spaceKey: string,
		policy: SpacePolicy,
	): SpaceRef {
		const space = formatSpaceRef(authority, spaceType, spaceKey);
		if (this.spaces.has(space)) {
			throw new Error(`Space already exists: ${space}`);
		}
		this.spaces.set(space, {
			authority,
			policy: structuredClone(policy),
			members: new Map(),
			recordsByWriter: new Map(),
			listeners: new Set(),
		});
		return space;
	}

	putMember(
		caller: Did,
		space: SpaceRef,
		member: Did,
		access: { read: boolean; write: boolean },
	): void {
		this.memberSpaceOf(caller, space).members.set(member, { ...access });
	}

	removeMember(caller: Did, space: SpaceRef, member: Did): void {
		this.memberSpaceOf(caller, space).members.delete(member);
	}

	// * * * * * * * * * * * * * * * * * *
	// Spaces: writing and following
	// * * * * * * * * * * * * * * * * * *

	// record === undefined deletes. Never throws for missing access, like the writer's own PDS.
	async writeSpaceRecord(
		writer: Did,
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
		record: TypedObject | undefined,
	): Promise<void> {
		const stored = this.spaces.get(space);
		const allowed =
			stored !== undefined && (await this.mayAccess(space, writer, "write"));

		// Without access the write stays invisible to every reader
		if (!stored || !allowed) {
			this.hiddenWrites.push({
				action: record === undefined ? "delete" : "create",
				author: writer,
				collection,
				rkey,
				record,
				space,
			});
			return;
		}

		// Apply the write to the writer's repo inside the space
		const records =
			stored.recordsByWriter.get(writer) ?? new Map<string, TypedObject>();
		stored.recordsByWriter.set(writer, records);
		const path = `${collection}/${rkey}`;
		const existed = records.has(path);
		if (record === undefined) {
			if (!existed) {
				return;
			}
			records.delete(path);
		} else {
			records.set(path, structuredClone(record));
		}

		// Tell everyone following the space
		const change: RecordChange = {
			action: record === undefined ? "delete" : existed ? "update" : "create",
			author: writer,
			collection,
			rkey,
			record,
			space,
		};
		for (const listener of stored.listeners) {
			this.deliver(listener, change);
		}
	}

	async watchSpace(
		reader: Did,
		space: SpaceRef,
		onChange: ChangeListener,
	): Promise<() => void> {
		// Refuse like the authority: a missing space and a refusal look the same
		const stored = this.spaces.get(space);
		if (!stored || !(await this.mayAccess(space, reader, "read"))) {
			throw new SpaceAccessDeniedError(
				stored ? "UserNotAuthorized" : "SpaceNotFound",
			);
		}

		// Replay the current records of every writer, as a first sync with getRepo would.
		// Track delivery itself, including simulated latency, before resolving the watch.
		const replay: Promise<void>[] = [];
		for (const [writer, records] of stored.recordsByWriter) {
			for (const [path, record] of records) {
				const [collection, rkey] = splitPath(path);
				replay.push(
					new Promise<void>((resolve, reject) => {
						this.deliver(
							(change) => {
								try {
									onChange(change);
									resolve();
								} catch (error) {
									reject(error);
								}
							},
							{
								action: "create",
								author: writer,
								collection,
								rkey,
								record,
								space,
							},
						);
					}),
				);
			}
		}

		// Subscribe before waiting so writes during replay are not missed. Deliveries queued
		// above still precede live changes, preserving each writer's order.
		stored.listeners.add(onChange);
		try {
			await Promise.all(replay);
		} catch (error) {
			stored.listeners.delete(onChange);
			throw error;
		}
		return () => {
			stored.listeners.delete(onChange);
		};
	}

	async mayAccess(
		space: SpaceRef,
		user: Did,
		access: "read" | "write",
	): Promise<boolean> {
		const stored = this.spaces.get(space);
		if (!stored) {
			return false;
		}
		// The authority may always read and write its own spaces
		if (user === stored.authority) {
			return true;
		}
		// Managed space: the managing app decides every access live
		if (stored.policy.$type === "com.atproto.managedspace.policy") {
			const managingApp = this.services.get(stored.policy.managingApp);
			return (
				(await managingApp?.checkUserAccess?.(space, user, access)) ?? false
			);
		}
		// Member space: public flags first, then the member list
		if (access === "read" && stored.policy.publicRead) {
			return true;
		}
		if (access === "write" && stored.policy.publicWrite) {
			return true;
		}
		return stored.members.get(user)?.[access] ?? false;
	}

	// * * * * * * * * * * * * * * * * * *
	// Procedures
	// * * * * * * * * * * * * * * * * * *

	// The caller counts as authenticated: in the real network, service auth proves its DID
	async callProcedure(
		caller: Did,
		service: string,
		method: Nsid,
		input: unknown,
	): Promise<unknown> {
		const handler = this.services.get(service)?.procedures?.[method];
		if (!handler) {
			throw new Error(`No procedure ${method} at ${service}`);
		}
		return handler(caller, structuredClone(input));
	}

	// * * * * * * * * * * * * * * * * * *
	// Helpers
	// * * * * * * * * * * * * * * * * * *

	private memberSpaceOf(caller: Did, space: SpaceRef): StoredSpace {
		const stored = this.spaces.get(space);
		if (!stored || stored.authority !== caller) {
			throw new SpaceAccessDeniedError("Only the authority manages members");
		}
		if (stored.policy.$type !== "com.atproto.memberspace.policy") {
			throw new PolicyMismatchError("Managed spaces have no member list");
		}
		return stored;
	}

	private notifyPublic(change: RecordChange): void {
		for (const listener of this.publicListeners) {
			if (listener.collections.has(change.collection)) {
				this.deliver(listener.onChange, change);
			}
		}
	}

	// Asynchronous on purpose, so no code relies on getting changes synchronously.
	// Both queueMicrotask and equal setTimeout delays keep the order of deliveries.
	private deliver(listener: ChangeListener, change: RecordChange): void {
		const copy = structuredClone(change);
		if (this.options.deliveryDelayMs) {
			setTimeout(() => listener(copy), this.options.deliveryDelayMs);
		} else {
			queueMicrotask(() => listener(copy));
		}
	}
}

function publicUri(author: Did, collection: Nsid, rkey: string): AtUri {
	return `at://${author}/${collection}/${rkey}` as AtUri;
}

function splitPath(path: string): [Nsid, string] {
	const separator = path.lastIndexOf("/");
	return [path.slice(0, separator) as Nsid, path.slice(separator + 1)];
}
