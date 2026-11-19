import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ENVIRONMENT_CONFIG } from "../../../core/coordinator/config/environment_config.js";
import { ManualClock } from "../../../core/coordinator/library/clock.js";
import {
	MissingSecretError,
	readSecrets,
} from "../../../core/coordinator/library/environment.js";
import { START } from "../fixtures.js";

// The manual clock the tests rely on, and reading secrets from the environment.

describe("manual clock", () => {
	test("due timers run in deadline order, cancelled ones never", () => {
		const clock = new ManualClock(START);
		const fired: string[] = [];
		const at = (durationMs: number) => new Date(START.getTime() + durationMs);
		clock.setTimer(at(2_000), () => fired.push("second"));
		clock.setTimer(at(1_000), () => fired.push("first"));
		const cancel = clock.setTimer(at(1_500), () => fired.push("cancelled"));
		cancel();

		clock.advanceBy(1_000);
		assert.deepEqual(fired, ["first"]);
		clock.advanceBy(5_000);
		assert.deepEqual(fired, ["first", "second"]);
		assert.deepEqual(clock.now(), at(6_000));
		assert.equal(clock.pendingTimers, 0);
	});
});

describe("secrets", () => {
	test("are read from the variables the environment config names", () => {
		const secrets = readSecrets(DEFAULT_ENVIRONMENT_CONFIG, {
			HIVEMIND_ACCOUNT_PASSWORD: "password",
			HIVEMIND_ATTESTATION_KEY: "abcd",
		});
		assert.deepEqual(secrets, {
			accountPassword: "password",
			attestationKeyHex: "abcd",
		});
	});

	test("a missing one stops startup", () => {
		assert.throws(
			() =>
				readSecrets(DEFAULT_ENVIRONMENT_CONFIG, {
					HIVEMIND_ACCOUNT_PASSWORD: "password",
				}),
			MissingSecretError,
		);
	});
});
