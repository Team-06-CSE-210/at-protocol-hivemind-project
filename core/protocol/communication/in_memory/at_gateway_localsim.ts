import type {
	AtprotoGateway,
	RecordChange,
	SpaceAuthority,
	SpacePolicy,
} from "../../interfaces/internal/atproto_gateway.js";
import type {
	AtUri,
	Did,
	Nsid,
	SpaceRef,
	TypedObject,
} from "../../interfaces/internal/types.js";
import type { AtProtocolNetwork } from "./at_protocol_network.js";

// In-memory gateway: one instance per account, all connected to the same AtProtocolNetwork.
// For unit tests and quick local runs. The behaviour rules live in at_protocol_network.ts.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Atproto Gateway
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class LocalSimGateway implements AtprotoGateway {
	constructor(
		private readonly network: AtProtocolNetwork,
		readonly did: Did,
	) {}

	// * * * * * * * * * * * * * * * * * *
	// PDS Interaction
	// * * * * * * * * * * * * * * * * * *

	async putRecord(
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<AtUri> {
		return this.network.putPublicRecord(this.did, collection, rkey, record);
	}

	async deleteRecord(collection: Nsid, rkey: string): Promise<void> {
		this.network.deletePublicRecord(this.did, collection, rkey);
	}

	async getRecord(uri: AtUri): Promise<TypedObject | undefined> {
		return this.network.getPublicRecord(uri);
	}

	// * * * * * * * * * * * * * * * * * *
	// Space Interaction
	// * * * * * * * * * * * * * * * * * *

	async putSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<void> {
		await this.network.writeSpaceRecord(
			this.did,
			space,
			collection,
			rkey,
			record,
		);
	}

	async deleteSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
	): Promise<void> {
		await this.network.writeSpaceRecord(
			this.did,
			space,
			collection,
			rkey,
			undefined,
		);
	}

	async watchSpace(
		space: SpaceRef,
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		return this.network.watchSpace(this.did, space, onChange);
	}

	async watchPublic(
		collections: Nsid[],
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		return this.network.watchPublic(collections, onChange);
	}

	// `service` is a service identifier, e.g. did:web:hivemind-network.com#hivemind_coordinator
	async callProcedure(
		service: Did,
		method: Nsid,
		input: unknown,
	): Promise<unknown> {
		return this.network.callProcedure(this.did, service, method, input);
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Authority
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class LocalSimSpaceAuthority implements SpaceAuthority {
	constructor(
		private readonly network: AtProtocolNetwork,
		readonly did: Did,
	) {}

	async createSpace(
		spaceType: Nsid,
		spaceKey: string,
		policy: SpacePolicy,
	): Promise<SpaceRef> {
		return this.network.createSpace(this.did, spaceType, spaceKey, policy);
	}

	async putMember(
		space: SpaceRef,
		member: Did,
		access: { read: boolean; write: boolean },
	): Promise<void> {
		this.network.putMember(this.did, space, member, access);
	}

	async removeMember(space: SpaceRef, member: Did): Promise<void> {
		this.network.removeMember(this.did, space, member);
	}
}
