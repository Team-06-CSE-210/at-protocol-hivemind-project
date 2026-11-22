import type {
	ComAtprotoManagedspacePolicy,
	ComAtprotoMemberspacePolicy,
} from "@atproto/api";
import type { AtUri, Did, Nsid, SpaceRef, TypedObject } from "./types.js";

// The only way our Hivemind Application direclty interfaces with atproto

// Contains TWO main implementations: one for real atproto PDSes and one in-memory variant for local tests
// Used by: the coordinator and the SDK in hivemind_sdk/ (one gateway instance per account)

// Hides login sessions, service authentication, space credentials (bound to P-256 key, with every request signed)
// MAC checks on synced space data, notification registration and catch-up

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Atproto Gateway
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface AtprotoGateway {
	// the DID of the account
	readonly did: Did;

	// * * * * * * * * * * * * * * * * * *
	// PDS Interaction
	// * * * * * * * * * * * * * * * * * *

	// Write or replace record on the account repo (PDS)
	putRecord(
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<AtUri>;

	// Delete record from an account repo (PDS)
	deleteRecord(collection: Nsid, rkey: string): Promise<void>;

	// read record from a profile (user or agent)
	getRecord(uri: AtUri): Promise<TypedObject | undefined>;

	// * * * * * * * * * * * * * * * * * *
	// Space Interaction
	// * * * * * * * * * * * * * * * * * *

	// Create or replace a record on the account's repo inside an atproto space
	putSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<void>;

	// Delete a record from a space
	deleteSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
	): Promise<void>;

	// Following a space -> onChange called for every record already in it
	// -> later changes arrive in order per writer (not across writers); if a record changes
	//    several times between two syncs, only its latest state may arrive
	// -> returns SpaceAccessDeniedError if account may not read the space
	// -> this method is used for notifying an agent that it did not win a task
	// Further error msg deliverable by an authority: UserNotAuthorized, NotAuthorized, SpaceNotFound
	watchSpace(
		space: SpaceRef,
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	// Follow public records by collection identifier (the firehose)
	watchPublic(
		collections: Nsid[],
		onChange: (change: RecordChange) => void,
	): Promise<() => void>;

	// Call XRPC procedure on a service (e.g. the coordinator) with service auth for this account
	callProcedure(service: Did, method: Nsid, input: unknown): Promise<unknown>;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Policies
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The policies Hivemind spaces use, exactly as com.atproto.space.createSpace takes them.
export type SpacePolicy =
	| (ComAtprotoManagedspacePolicy.Main & {
			$type: "com.atproto.managedspace.policy";
	  })
	| (ComAtprotoMemberspacePolicy.Main & {
			$type: "com.atproto.memberspace.policy";
	  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Authority
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Space administration. Only the coordinator has one, as the authority of every Hivemind space.
export interface SpaceAuthority {
	// Create a space under the coordinator's DID; the policy comes from type_definition/policy_types/.
	createSpace(
		spaceType: Nsid,
		spaceKey: string,
		policy: SpacePolicy,
	): Promise<SpaceRef>;

	// Add Member to a Memberspace (only works for this type) -> Used for task spaces.
	// Managed spaces have no member list; the PDS answers PolicyMismatch.
	putMember(
		space: SpaceRef,
		member: Did,
		access: { read: boolean; write: boolean },
	): Promise<void>;
	removeMember(space: SpaceRef, member: Did): Promise<void>;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Record Change
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// One record change, in a space or in a public repo.
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
