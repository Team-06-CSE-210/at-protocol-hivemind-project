import { TID } from "@atproto/common-web";
import { l } from "@atproto/lex";
import * as hivemind from "../core/protocol/generated/com/hivemind-network.js";
import type { RequesterClientOptions } from "../core/protocol/interfaces/internal/client_lib.js";
import type { TaskId } from "../core/protocol/interfaces/internal/types.js";
import {
	createTaskId,
	requestIntakeSpaceRef,
} from "../core/protocol/protocol_config/space_definition.js";
import { rideTaskType } from "../core/protocol/type_definition/task_types/taxi_ride.js";

// Submit a taxi request from an active requester's account to the coordinator's request intake.
// The demo and the requester SDK can share this write step.

const REQUEST_COLLECTION = "com.hivemind-network.requester.request";
const RIDE_REQUEST_TYPE = "com.hivemind-network.mobility.ride#request";

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

	// Validate the full record before writing. The open payload union also needs a task-specific check.
	const taskId = createTaskId();
	const request = hivemind.requester.request.main.parse({
		$type: REQUEST_COLLECTION,
		taskId,
		payload,
		...(selectionMode === undefined ? {} : { selectionMode }),
		...(maxWaitMs === undefined ? {} : { maxWaitMs }),
		createdAt: l.toDatetimeString(new Date()),
	});
	if (request.payload.$type !== RIDE_REQUEST_TYPE) {
		throw new Error(`submitRequest: expected a ${RIDE_REQUEST_TYPE} payload`);
	}
	rideTaskType.parseRequest(request.payload);

	// The task ID identifies the task across spaces; the TID identifies this request record.
	const requestRkey = TID.nextStr();
	await gateway.putSpaceRecord(
		requestIntakeSpaceRef(coordinator),
		REQUEST_COLLECTION,
		requestRkey,
		l.asUnknown$TypedObject(request),
	);
	return { taskId, requestRkey };
}
