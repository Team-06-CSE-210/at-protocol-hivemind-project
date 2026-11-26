// Timing of a task's lifecycle (interfaces/external/task_lifecycle.md).
// Used by: library/task_rules.ts, runtime/task_runner.ts

export interface TasksConfig {
	// Shortest answer window the coordinator uses; shorter feed windows are raised to it. It also
	// overrides a request's maxWaitMs, so keep it at or below the request lexicon's minimum for
	// maxWaitMs (50), or the requester's cap is no longer a cap
	readonly minAnswerWindowMs: number;
	// Longest answer window the coordinator uses; longer feed windows are cut to it
	readonly maxAnswerWindowMs: number;
	// Time the requester has to pick an option in choose mode
	readonly selectionWindowMs: number;
	// Delay before writes that failed (space writes, billing, storing an offer change) are tried
	// again; it doubles with every failed attempt, up to maxRetryDelayMs
	readonly firstRetryDelayMs: number;
	readonly maxRetryDelayMs: number;
}

// Answer-window bounds as in the feed declaration lexicon (answerWindowMs: 50 to 600,000)
export const DEFAULT_TASKS_CONFIG: TasksConfig = {
	minAnswerWindowMs: 50,
	maxAnswerWindowMs: 600_000,
	selectionWindowMs: 60_000,
	firstRetryDelayMs: 1_000,
	maxRetryDelayMs: 60_000,
};
