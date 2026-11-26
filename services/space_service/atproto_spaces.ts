// AtprotoSpaces: SpaceService (core/protocol/interfaces/internal/space_service.ts) on atproto
// Spaces, with the coordinator's gateway and space authority, and the policies in
// core/protocol/type_definition/policy_types/.
// Task spaces (S6) and the offer intake (S2) are implemented; the request intake (S1) and feed
// spaces (S3) follow, and then the class implements all of SpaceService.

import { l } from "@atproto/lex";
import * as hivemind from "../../core/protocol/generated/com/hivemind-network.js";
import {
	type AtprotoGateway,
	type RecordChange,
	SpaceAlreadyExistsError,
	type SpaceAuthority,
	type SpacePolicy,
} from "../../core/protocol/interfaces/internal/atproto_gateway.js";
import type { SpaceService } from "../../core/protocol/interfaces/internal/space_service.js";
import type {
	Assignment,
	Did,
	SpaceRef,
	TaskId,
	TaskState,
} from "../../core/protocol/interfaces/internal/types.js";
import {
	INTAKE_SPACE_KEY,
	offerIntakeSpaceRef,
	SPACE_TYPES,
	taskSpaceRef,
} from "../../core/protocol/protocol_config/space_definition.js";

export class AtprotoSpaces
	implements
		Pick<
			SpaceService,
			| "createTaskSpace"
			| "writeTaskState"
			| "assign"
			| "watchTaskSpace"
			| "watchOfferIntake"
		>
{
	constructor(
		private readonly authority: SpaceAuthority,
		private readonly taskPolicy: SpacePolicy,
		private readonly gateway: AtprotoGateway,
	) {}

	// Create the offer inbox before following it; setUpIntakes can call this alongside S1
	async setUpOfferIntake(policy: SpacePolicy): Promise<SpaceRef> {
		const space = offerIntakeSpaceRef(this.gateway.did);
		if (
			policy.$type !== "com.atproto.managedspace.policy" ||
			policy.managingApp !== `${this.gateway.did}#hivemind_coordinator`
		) {
			throw new Error(
				"setUpOfferIntake: expected the coordinator's managed-space policy",
			);
		}
		try {
			await this.authority.createSpace(
				SPACE_TYPES.offerIntake,
				INTAKE_SPACE_KEY,
				policy,
			);
		} catch (error) {
			if (!(error instanceof SpaceAlreadyExistsError)) {
				throw error;
			}
		}
		return space;
	}

	// Deliver existing and later offers to TaskRunner; it owns validation and collection rules
	watchOfferIntake(
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		const space = offerIntakeSpaceRef(this.gateway.did);
		return this.gateway.watchSpace(space, (change) => {
			// Access is per space, so unrelated collections can also arrive here
			if (
				change.space === space &&
				change.collection === hivemind.agent.offer.$nsid
			) {
				onChange(change);
			}
		});
	}

	async createTaskSpace(taskId: TaskId, requester: Did): Promise<SpaceRef> {
		const space = taskSpaceRef(this.gateway.did, taskId);

		try {
			await this.authority.createSpace(
				SPACE_TYPES.task,
				taskId,
				this.taskPolicy,
			);
		} catch (error) {
			// The coordinator may retry after creating the space but before adding the requester.
			if (!(error instanceof SpaceAlreadyExistsError)) {
				throw error;
			}
		}

		await this.authority.putMember(space, requester, {
			read: true,
			write: true,
		});

		return space;
	}

	async assign(taskId: TaskId, assignment: Assignment): Promise<void> {
		const space = taskSpaceRef(this.gateway.did, taskId);
		const collection = hivemind.coordinator.assignment.$nsid;

		await this.authority.putMember(space, assignment.agent, {
			read: true,
			write: true,
		});

		await this.gateway.putSpaceRecord(
			space,
			collection,
			"self",
			l.asUnknown$TypedObject({ ...assignment, $type: collection }),
		);
	}

	async writeTaskState(taskId: TaskId, state: TaskState): Promise<void> {
		const space = taskSpaceRef(this.gateway.did, taskId);
		const collection = hivemind.coordinator.taskState.$nsid;

		await this.gateway.putSpaceRecord(
			space,
			collection,
			"self",
			l.asUnknown$TypedObject({ ...state, $type: collection }),
		);
	}

	watchTaskSpace(
		taskId: TaskId,
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		const space = taskSpaceRef(this.gateway.did, taskId);
		return this.gateway.watchSpace(space, onChange);
	}
}
