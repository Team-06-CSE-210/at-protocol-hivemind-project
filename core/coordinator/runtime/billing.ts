import type { CoordinatorStores } from "../../protocol/interfaces/internal/stores.js";
import type {
	Did,
	Registration,
} from "../../protocol/interfaces/internal/types.js";
import type { BillingConfig } from "../config/billing_config.js";
import {
	monthlyChargeMinor,
	monthOf,
	type PaymentEvent,
	statusAfterPaymentEvent,
} from "../library/billing_rules.js";

// Billing as the coordinator runs it: counts assignments, computes what an operator owes and
// applies payment outcomes to its status. Charging the operator is the payment service's job
// (services/payment_service/, later); it reports outcomes through applyPaymentEvent.

export type BillingStores = Pick<CoordinatorStores, "billing" | "participants">;

export class UnknownOperatorError extends Error {}

export class BillingRuntime {
	constructor(
		private readonly stores: BillingStores,
		private readonly config: BillingConfig,
	) {}

	// Called once per assignment; returns the agent's count for that month
	recordAssignment(agent: Did, at: Date): Promise<number> {
		return this.stores.billing.addAssignment(agent, monthOf(at));
	}

	// What an operator owes for a month (YYYY-MM): every agent it operates, in minor units of
	// config.currency
	async operatorChargeMinor(operator: Did, month: string): Promise<number> {
		const { billing, participants } = this.stores;
		const agents = (await participants.listByOperator(operator)).filter(
			(registration) => registration.role === "agent",
		);
		let totalMinor = 0;
		for (const { subject } of agents) {
			const assignmentCount = await billing.countAssignments(subject, month);
			totalMinor += monthlyChargeMinor(assignmentCount, this.config);
		}
		return totalMinor;
	}

	// A payment outcome for an operator; its agents follow its status (library/access_rules.ts)
	async applyPaymentEvent(
		operator: Did,
		event: PaymentEvent,
	): Promise<Registration> {
		const registration = await this.stores.participants.get(operator);
		if (registration?.role !== "operator") {
			throw new UnknownOperatorError(
				`${operator} is not a registered operator`,
			);
		}
		const updated = {
			...registration,
			status: statusAfterPaymentEvent(registration.status, event),
		};
		await this.stores.participants.put(updated);
		return updated;
	}
}
