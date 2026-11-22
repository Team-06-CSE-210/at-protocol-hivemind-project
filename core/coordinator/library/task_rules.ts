import type { Did } from "../../protocol/interfaces/internal/types.js";
import type { TasksConfig } from "../config/tasks_config.js";

// The rules of the task lifecycle as functions (core/protocol/interfaces/external/task_lifecycle.md).
// Used by: runtime/task_runner.ts

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Phases
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export type TaskPhase =
	| "collecting"
	| "awaitingSelection"
	| "assigned"
	| "completed"
	| "failed"
	| "cancelled"
	| "noCoverage"
	| "noOffers"
	| "expired";

// Once a task reaches one of these, nobody writes to its space any more
export const END_PHASES: ReadonlySet<string> = new Set<TaskPhase>([
	"completed",
	"failed",
	"cancelled",
	"noCoverage",
	"noOffers",
	"expired",
]);

// Every phase change task_lifecycle.md allows; cancelling is possible until an end phase
const NEXT_PHASES: Readonly<Record<string, readonly TaskPhase[]>> = {
	collecting: [
		"awaitingSelection",
		"assigned",
		"noOffers",
		"failed",
		"cancelled",
	],
	awaitingSelection: ["assigned", "expired", "cancelled"],
	assigned: ["completed", "failed", "cancelled"],
};

export function isEndPhase(phase: string): boolean {
	return END_PHASES.has(phase);
}

export function canChangePhase(from: string, to: TaskPhase): boolean {
	return NEXT_PHASES[from]?.includes(to) ?? false;
}

// Where collecting leads when it ends: no accepted offer, the requester picks, or the best wins.
// selectionMode defaults to auto, as in the request lexicon.
export function phaseAfterCollection(
	selectionMode: string | undefined,
	acceptedOfferCount: number,
): TaskPhase {
	if (acceptedOfferCount === 0) {
		return "noOffers";
	}
	return selectionMode === "choose" ? "awaitingSelection" : "assigned";
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Deadlines
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// A feed's answer window within the coordinator's bounds
export function clampAnswerWindow(
	answerWindowMs: number,
	config: TasksConfig,
): number {
	return Math.min(
		config.maxAnswerWindowMs,
		Math.max(config.minAnswerWindowMs, answerWindowMs),
	);
}

// respondBy = dispatch time + the longest answer window among the matched feeds, capped by the
// request's maxWaitMs
export function respondBy(
	dispatchedAt: Date,
	feedAnswerWindowsMs: readonly number[],
	maxWaitMs: number | undefined,
	config: TasksConfig,
): Date {
	const longestWindowMs = Math.max(
		config.minAnswerWindowMs,
		...feedAnswerWindowsMs.map((windowMs) =>
			clampAnswerWindow(windowMs, config),
		),
	);
	const windowMs =
		maxWaitMs === undefined
			? longestWindowMs
			: Math.max(
					config.minAnswerWindowMs,
					Math.min(longestWindowMs, maxWaitMs),
				);
	return new Date(dispatchedAt.getTime() + windowMs);
}

// Delay before the next attempt at writes that failed: doubling from firstRetryDelayMs, at most
// maxRetryDelayMs. failedAttempts counts the failures so far (1 after the first)
export function retryDelayMs(
	failedAttempts: number,
	config: TasksConfig,
): number {
	const exponent = Math.max(0, failedAttempts - 1);
	return Math.min(
		config.maxRetryDelayMs,
		config.firstRetryDelayMs * 2 ** exponent,
	);
}

// selectBy = ranking time + the selection window (choose mode)
export function selectBy(rankedAt: Date, config: TasksConfig): Date {
	return new Date(rankedAt.getTime() + config.selectionWindowMs);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Collection
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Collection ends early once every eligible agent has answered, with an offer or a decline
export function everyEligibleAgentAnswered(
	eligibleAgents: ReadonlySet<Did>,
	answeredAgents: ReadonlySet<Did>,
): boolean {
	if (eligibleAgents.size === 0) {
		return false;
	}
	for (const agent of eligibleAgents) {
		if (!answeredAgents.has(agent)) {
			return false;
		}
	}
	return true;
}
