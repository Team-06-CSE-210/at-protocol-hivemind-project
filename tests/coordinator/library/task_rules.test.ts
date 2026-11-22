import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_TASKS_CONFIG } from "../../../core/coordinator/config/tasks_config.js";
import {
	canChangePhase,
	clampAnswerWindow,
	everyEligibleAgentAnswered,
	isEndPhase,
	phaseAfterCollection,
	respondBy,
	selectBy,
} from "../../../core/coordinator/library/task_rules.js";
import { START, TAXI_ONE, TAXI_TWO } from "../fixtures.js";

// The lifecycle rules of task_lifecycle.md as functions.

const config = DEFAULT_TASKS_CONFIG;
const after = (durationMs: number) => new Date(START.getTime() + durationMs);

describe("task rules: phases", () => {
	test("only the changes task_lifecycle.md lists are allowed", () => {
		assert.equal(canChangePhase("collecting", "assigned"), true);
		assert.equal(canChangePhase("collecting", "failed"), true);
		assert.equal(canChangePhase("awaitingSelection", "expired"), true);
		assert.equal(canChangePhase("assigned", "cancelled"), true);
		assert.equal(canChangePhase("collecting", "completed"), false);
		assert.equal(canChangePhase("completed", "cancelled"), false);
		assert.equal(isEndPhase("noCoverage"), true);
		assert.equal(isEndPhase("assigned"), false);
	});

	test("collection leads to noOffers, a selection, or an assignment", () => {
		assert.equal(phaseAfterCollection("auto", 0), "noOffers");
		assert.equal(phaseAfterCollection("choose", 2), "awaitingSelection");
		assert.equal(phaseAfterCollection(undefined, 1), "assigned");
	});

	test("collection ends early only once every eligible agent answered", () => {
		const eligible = new Set([TAXI_ONE, TAXI_TWO]);
		assert.equal(
			everyEligibleAgentAnswered(eligible, new Set([TAXI_ONE])),
			false,
		);
		assert.equal(
			everyEligibleAgentAnswered(eligible, new Set([TAXI_TWO, TAXI_ONE])),
			true,
		);
		assert.equal(everyEligibleAgentAnswered(new Set(), new Set()), false);
	});
});

describe("task rules: deadlines", () => {
	test("respondBy uses the longest feed window, capped by maxWaitMs", () => {
		assert.deepEqual(
			respondBy(START, [5_000, 30_000], undefined, config),
			after(30_000),
		);
		assert.deepEqual(
			respondBy(START, [5_000, 30_000], 10_000, config),
			after(10_000),
		);
	});

	test("feed windows are kept within the coordinator's bounds", () => {
		assert.equal(clampAnswerWindow(10, config), config.minAnswerWindowMs);
		assert.equal(
			clampAnswerWindow(3_600_000, config),
			config.maxAnswerWindowMs,
		);
		assert.deepEqual(
			respondBy(START, [30_000], 1, config),
			after(config.minAnswerWindowMs),
		);
	});

	test("selectBy is the ranking time plus the selection window", () => {
		assert.deepEqual(selectBy(START, config), after(config.selectionWindowMs));
	});
});
