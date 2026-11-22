import type { CoordinatorStores } from "../../protocol/interfaces/internal/stores.js";
import type {
	Did,
	Registration,
	TaskId,
} from "../../protocol/interfaces/internal/types.js";
import type { BillingConfig } from "../config/billing_config.js";
import {
	isBilledForMonth,
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

	// Counts a task's assignment in the month it was issued; repeating it for the same task
	// changes nothing (the task runner repeats it until its writes succeed)
	recordAssignment(taskId: TaskId, agent: Did, issuedAt: Date): Promise<void> {
		return this.stores.billing.recordAssignment(
			taskId,
			agent,
			monthOf(issuedAt),
		);
	}

	// What an operator owes for a month (YYYY-MM): every agent it operates that was registered by
	// the end of that month, in minor units of config.currency
	async operatorChargeMinor(operator: Did, month: string): Promise<number> {
		const { billing, participants } = this.stores;
		const agents = (await participants.listByOperator(operator)).filter(
			(registration) => isBilledForMonth(registration, month),
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
