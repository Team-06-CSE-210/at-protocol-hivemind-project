import { TID } from "@atproto/common-web";
import { l } from "@atproto/lex";
import * as hivemind from "../core/protocol/generated/com/hivemind-network.js";
import type { RequesterClientOptions } from "../core/protocol/interfaces/internal/client_lib.js";
import type { TaskId } from "../core/protocol/interfaces/internal/types.js";
import {
	createTaskId,
	requestIntakeSpaceRef,
} from "../core/protocol/protocol_config/space_definition.js";
import {
	moduleForPayload,
	taskTypeOf,
} from "../core/protocol/type_definition/task_types/task_index.js";

// Submit a request from an active requester's account to the coordinator's request intake.
// The demo and the requester SDK can share this write step.

type SubmitRequestOptions = {
	selectionMode?: "auto" | "choose";
	maxWaitMs?: number;
};

type SubmittedRequest = {
	taskId: TaskId;
	requestRkey: string;
};

// Resolve when the Gateway write completes. The coordinator observes the request separately.
export async function submitRequest(
	dependencies: Omit<RequesterClientOptions, "gateway"> & {
		gateway: Pick<RequesterClientOptions["gateway"], "putSpaceRecord">;
	},
	payload: unknown,
	options: SubmitRequestOptions = {},
): Promise<SubmittedRequest> {
	const { gateway, coordinator } = dependencies;
	const { selectionMode, maxWaitMs } = options;

	// Match the SDK's two selection modes; Lexicon knownValues are open to future values.
	if (
		selectionMode !== undefined &&
		selectionMode !== "auto" &&
		selectionMode !== "choose"
	) {
		throw new Error("submitRequest: selectionMode must be auto or choose");
	}

	// Validate the full record before writing. The open payload union also needs the checks of its
	// task type, which the task type's module adds (e.g. pickup and dropoff differ for a ride).
	const taskId = createTaskId();
	const request = hivemind.requester.request.main.parse({
		$type: hivemind.requester.request.$nsid,
		taskId,
		payload,
		...(selectionMode === undefined ? {} : { selectionMode }),
		...(maxWaitMs === undefined ? {} : { maxWaitMs }),
		createdAt: l.toDatetimeString(new Date()),
	});
	const taskTypeModule = moduleForPayload(request.payload);
	if (taskTypeModule === undefined) {
		throw new Error(
			`submitRequest: unsupported task type ${taskTypeOf(request.payload)}`,
		);
	}
	taskTypeModule.parseRequest(request.payload);

	// The task ID identifies the task across spaces; the TID identifies this request record.
	const requestRkey = TID.nextStr();
	await gateway.putSpaceRecord(
		requestIntakeSpaceRef(coordinator),
		hivemind.requester.request.$nsid,
		requestRkey,
		l.asUnknown$TypedObject(request),
	);
	return { taskId, requestRkey };
}
