import type { TaskTypeModule } from "../../interfaces/internal/task_type_module.js";
import type { Nsid, TypedObject } from "../../interfaces/internal/types.js";
import { rideTaskType } from "./taxi_ride.js";

// Registry of every task type the coordinator supports. A new application plugs in here
// (see _task_types.md).

export type AnyTaskTypeModule = TaskTypeModule<unknown, unknown>;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Registered task types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

const registeredModules: AnyTaskTypeModule[] = [rideTaskType];

export const taskTypeModules: ReadonlyMap<Nsid, AnyTaskTypeModule> = new Map(
	registeredModules.map((module) => [module.taskType, module]),
);

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Lookup
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The task type of a payload is the NSID of its $type, without the #fragment
export function taskTypeOf(payload: TypedObject): Nsid {
	const [taskType] = payload.$type.split("#");
	return taskType as Nsid;
}

// Undefined means the coordinator does not support this task type
export function moduleForPayload(
	payload: TypedObject,
): AnyTaskTypeModule | undefined {
	return taskTypeModules.get(taskTypeOf(payload));
}
