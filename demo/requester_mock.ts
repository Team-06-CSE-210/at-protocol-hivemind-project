/**
 * Standalone requester mock for learning the request and callback flow.
 *
 * Locations and IDs are simplified demo values. The mock Gateway logs writes
 * and delivers TaskState objects directly; it does not implement real PDS
 * communication, protocol records, or RecordChange validation.
 */
import { deepStrictEqual, strictEqual } from "node:assert";

// Demo data types.
type TaskState = {
	phase: "collecting" | "assigned" | "completed";
};

type StateListener = (state: TaskState) => void;

type DemoRideRequest = {
	pickup: string;
	dropoff: string;
	passengers: number;
};

type SpaceSubscription = {
	space: string;
	onChange: StateListener;
};

// Mock Gateway: store subscriptions and inject state changes manually.
let spaceListeners: SpaceSubscription[] = [];

async function putSpaceRecord(
	space: string,
	collection: string,
	rkey: string,
	record: DemoRideRequest,
): Promise<void> {
	console.log("Mock Gateway received write:", {
		space,
		collection,
		rkey,
		record,
	});
}

async function watchSpace(
	space: string,
	onChange: StateListener,
): Promise<() => void> {
	console.log("Mock Gateway starts listening:", space);

	const subscription: SpaceSubscription = {
		space: space,
		onChange: onChange,
	};
	spaceListeners.push(subscription);

	return function stopWatching(): void {
		spaceListeners = spaceListeners.filter((item) => item !== subscription);
	};
}

function mockStateChange(space: string, state: TaskState): void {
	console.log(`Mock Gateway state [${space}]: ${state.phase}`);

	for (const subscription of spaceListeners) {
		if (subscription.space !== space) {
			continue;
		}
		subscription.onChange(state);
	}
}

const gateway = {
	putSpaceRecord: putSpaceRecord,
	watchSpace: watchSpace,
};

// Requester: each call owns its state, UI listeners, and task handle.
let nextTaskNumber = 1;

async function request(payload: DemoRideRequest) {
	const taskId = `demo-task-${nextTaskNumber}`;
	nextTaskNumber += 1;

	let currentState: TaskState | undefined;
	let listeners: StateListener[] = [];

	function registerStateListener(listener: StateListener): () => void {
		listeners.push(listener);

		return function stopListening(): void {
			listeners = listeners.filter((item) => item !== listener);
		};
	}

	function receiveState(state: TaskState): void {
		currentState = state;
		for (const listener of listeners) {
			listener(state);
		}
	}

	// Local convenience method; not part of the current protocol TaskHandle.
	function getState(): TaskState | undefined {
		return currentState;
	}

	const task = {
		taskId: taskId,
		onState: registerStateListener,
		getState: getState,
	};

	console.log("Received request:", payload);
	await gateway.putSpaceRecord(
		"intake-demo",
		"network.hivemind.requester.request",
		`request-${taskId}`,
		payload,
	);

	const stopWatching = await gateway.watchSpace(task.taskId, receiveState);

	// Finishing the task stops the Gateway subscription, even if the UI left.
	task.onState((state) => {
		if (state.phase === "completed") {
			stopWatching();
		}
	});

	return task;
}

const requester = {
	request: request,
};

// Demo checks: run two tasks and verify notifications and cleanup.
function showState(state: TaskState): void {
	console.log(`Current phase: ${state.phase}`);
}

const myTask = await requester.request({
	pickup: "UCSD",
	dropoff: "Downtown",
	passengers: 2,
});

const secondTask = await requester.request({
	pickup: "Downtown",
	dropoff: "UCSD",
	passengers: 1,
});

strictEqual(myTask === secondTask, false);
strictEqual(myTask.taskId === secondTask.taskId, false);
strictEqual(myTask.getState(), undefined);
strictEqual(secondTask.getState(), undefined);
strictEqual(spaceListeners.length, 2);

const displayedPhases: string[] = [];
const stopListening = myTask.onState((state) => {
	displayedPhases.push(state.phase);
	showState(state);
});

// Update the second subscription first: a mismatched first entry must be skipped.
mockStateChange(secondTask.taskId, { phase: "collecting" });
strictEqual(myTask.getState(), undefined);
deepStrictEqual(secondTask.getState(), { phase: "collecting" });

mockStateChange(myTask.taskId, { phase: "collecting" });
deepStrictEqual(myTask.getState(), { phase: "collecting" });

mockStateChange(myTask.taskId, { phase: "assigned" });
deepStrictEqual(myTask.getState(), { phase: "assigned" });
deepStrictEqual(secondTask.getState(), { phase: "collecting" });
deepStrictEqual(displayedPhases, ["collecting", "assigned"]);

// Leaving the UI stops its notifications, while task state continues updating.
stopListening();
mockStateChange(myTask.taskId, { phase: "completed" });
deepStrictEqual(myTask.getState(), { phase: "completed" });
deepStrictEqual(displayedPhases, ["collecting", "assigned"]);
deepStrictEqual(secondTask.getState(), { phase: "collecting" });
strictEqual(spaceListeners.length, 1);

mockStateChange(secondTask.taskId, { phase: "assigned" });
mockStateChange(secondTask.taskId, { phase: "completed" });
deepStrictEqual(secondTask.getState(), { phase: "completed" });
deepStrictEqual(myTask.getState(), { phase: "completed" });
strictEqual(spaceListeners.length, 0);

console.log("First task:", myTask.taskId, myTask.getState());
console.log("Second task:", secondTask.taskId, secondTask.getState());
console.log("Remaining Gateway subscriptions:", spaceListeners.length);
console.log("Requester mock demo passed.");
