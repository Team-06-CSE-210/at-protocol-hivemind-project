import type {
	ComAtprotoManagedspacePolicy,
	ComAtprotoMemberspacePolicy,
} from "@atproto/api";
import type { AtUri, Did, Nsid, SpaceRef, TypedObject } from "./types.js";

/**
 * The only way Hivemind code talks to atproto. Hides login sessions, service auth, space
 * credentials (bound to a P-256 key, with every request signed), MAC checks on synced space
 * data, notification registration and catch-up.
 *
 * Implementations: one for a real PDS (the Spaces alpha pinned in package.json), one in memory
 * for tests.
 * Used by: the coordinator and the client library (one gateway per account).
 */
export interface AtprotoGateway {
	/** The account this gateway acts as. */
	readonly did: Did;

	/** Create or replace a record in the account's public repo. */
	putRecord(
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<AtUri>;
	deleteRecord(collection: Nsid, rkey: string): Promise<void>;
	/** Read one public record, e.g. an agent's profile. */
	getRecord(uri: AtUri): Promise<TypedObject | undefined>;

	/** Create or replace a record in the account's own repo inside a space. */
	putSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<void>;
	deleteSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
	): Promise<void>;

	/**
	 * Follow a space: onChange is called for every record already in it, then for every later
	 * create, update and delete, in space order. Resolves to a function that stops following.
	 * Rejects with SpaceAccessDeniedError if the account may not read the space; that is how an
	 * agent learns it did not win a task. An authority may answer a refusal as UserNotAuthorized,
	 * NotAuthorized or SpaceNotFound, so all three map to this error. A requester retries briefly
	 * on it, because its task space may not have been created yet.
	 */
	watchSpace(
		space: SpaceRef,
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	/** Follow public records of the given collections across the network (the firehose). */
	watchPublic(
		collections: Nsid[],
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	/** Call an XRPC procedure on a service (e.g. the coordinator) with service auth for this account. */
	callProcedure(service: Did, method: Nsid, input: unknown): Promise<unknown>;
}

/** The policies Hivemind spaces use, exactly as com.atproto.space.createSpace takes them. */
export type SpacePolicy =
	| (ComAtprotoManagedspacePolicy.Main & {
			$type: "com.atproto.managedspace.policy";
	  })
	| (ComAtprotoMemberspacePolicy.Main & {
			$type: "com.atproto.memberspace.policy";
	  });

/** Space administration. Only the coordinator has one, as the authority of every Hivemind space. */
export interface SpaceAuthority {
	/** Create a space under the coordinator's DID; the policy comes from type_definition/policy_types/. */
	createSpace(
		spaceType: Nsid,
		spaceKey: string,
		policy: SpacePolicy,
	): Promise<SpaceRef>;
	/** Memberspace only (task spaces). Managed spaces have no member list; the PDS answers PolicyMismatch. */
	putMember(
		space: SpaceRef,
		member: Did,
		access: { read: boolean; write: boolean },
	): Promise<void>;
	removeMember(space: SpaceRef, member: Did): Promise<void>;
}

/** One record change, in a space or in a public repo. */
export interface RecordChange {
	action: "create" | "update" | "delete";
	author: Did;
	collection: Nsid;
	rkey: string;
	/** Absent for deletes. */
	record?: TypedObject;
	/** Absent for public records. */
	space?: SpaceRef;
}

export class SpaceAccessDeniedError extends Error {}
