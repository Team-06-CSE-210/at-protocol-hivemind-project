import type { Registration } from "../../protocol/interfaces/internal/types.js";
import type { BillingConfig } from "../config/billing_config.js";

// Pricing and payment status as functions. Charging is the payment service's job; these only say
// what is owed and what a payment outcome means for an operator.
// Used by: runtime/billing.ts

export type RegistrationStatus = Registration["status"];

// Outcomes the payment service reports for an operator's subscription
export type PaymentEvent =
	| "paymentSucceeded"
	| "paymentFailed"
	| "subscriptionCancelled";

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Billing periods
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Billing month of a moment, in UTC: "YYYY-MM"
export function monthOf(moment: Date): string {
	const year = moment.getUTCFullYear();
	const month = String(moment.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Amounts
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Fee for one agent's assignments above the included ones, rounded up to a whole minor unit
export function extraAssignmentFeeMinor(
	assignmentCount: number,
	config: BillingConfig,
): number {
	const extraAssignments = Math.max(
		0,
		assignmentCount - config.includedAssignmentsPerAgent,
	);
	return Math.ceil(
		(extraAssignments * config.feePerThousandExtraAssignmentsMinor) / 1_000,
	);
}

// What one agent costs its operator for a month
export function monthlyChargeMinor(
	assignmentCount: number,
	config: BillingConfig,
): number {
	return (
		config.monthlyFeePerAgentMinor +
		extraAssignmentFeeMinor(assignmentCount, config)
	);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Status
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// An operator's status after a payment outcome. A failed first payment keeps it pending; a failed
// or cancelled subscription suspends it, and with it all its agents (see access_rules.ts).
export function statusAfterPaymentEvent(
	current: RegistrationStatus,
	event: PaymentEvent,
): RegistrationStatus {
	switch (event) {
		case "paymentSucceeded": {
			return "active";
		}
		case "paymentFailed": {
			return current === "pendingPayment" ? "pendingPayment" : "suspended";
		}
		case "subscriptionCancelled": {
			return "suspended";
		}
	}
}
