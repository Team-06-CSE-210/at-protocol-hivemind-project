// Placeholder: AtprotoSpaces, implements SpaceService (core/protocol/interfaces/internal/space_service.ts)
// on atproto Spaces, with the coordinator's gateway and space authority, and the policies in
// core/protocol/type_definition/policy_types/.

import { l } from "@atproto/lex";
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
	SPACE_TYPES,
	taskSpaceRef,
} from "../../core/protocol/protocol_config/space_definition.js";

export class AtprotoSpaces
	implements
		Pick<
			SpaceService,
			"createTaskSpace" | "writeTaskState" | "assign" | "watchTaskSpace"
		>
{
	constructor(
		private readonly authority: SpaceAuthority,
		private readonly taskPolicy: SpacePolicy,
		private readonly gateway: AtprotoGateway,
	) {}

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
		const collection = "com.hivemind-network.coordinator.assignment";

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
		const collection = "com.hivemind-network.coordinator.taskState";

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
