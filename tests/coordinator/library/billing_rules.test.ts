import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_BILLING_CONFIG } from "../../../core/coordinator/config/billing_config.js";
import {
	extraAssignmentFeeMinor,
	monthlyChargeMinor,
	monthOf,
	statusAfterPaymentEvent,
} from "../../../core/coordinator/library/billing_rules.js";

// Prototype pricing: $9.00 per agent and month, 1,000 assignments included, $2.00 per 1,000 more.

const config = DEFAULT_BILLING_CONFIG;

describe("billing rules", () => {
	test("billing months are UTC", () => {
		assert.equal(monthOf(new Date("2026-11-30T23:30:00-08:00")), "2026-12");
		assert.equal(monthOf(new Date("2026-01-01T00:00:00Z")), "2026-01");
	});

	test("assignments above the included ones cost a fraction of a cent each, rounded up", () => {
		assert.equal(extraAssignmentFeeMinor(1_000, config), 0);
		assert.equal(extraAssignmentFeeMinor(1_001, config), 1);
		assert.equal(extraAssignmentFeeMinor(3_000, config), 400);
		assert.equal(monthlyChargeMinor(0, config), 900);
		assert.equal(monthlyChargeMinor(2_000, config), 1_100);
	});

	test("payment outcomes set the operator's status", () => {
		assert.equal(
			statusAfterPaymentEvent("pendingPayment", "paymentSucceeded"),
			"active",
		);
		assert.equal(
			statusAfterPaymentEvent("pendingPayment", "paymentFailed"),
			"pendingPayment",
		);
		assert.equal(
			statusAfterPaymentEvent("active", "paymentFailed"),
			"suspended",
		);
		assert.equal(
			statusAfterPaymentEvent("active", "subscriptionCancelled"),
			"suspended",
		);
		assert.equal(
			statusAfterPaymentEvent("suspended", "paymentSucceeded"),
			"active",
		);
	});
});
