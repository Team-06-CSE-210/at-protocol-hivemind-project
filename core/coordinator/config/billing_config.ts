// What operators pay for their agents.
// Used by: library/billing_rules.ts, runtime/billing.ts

export interface BillingConfig {
	// Currency of every amount below (ISO 4217)
	readonly currency: string;
	// Monthly fee per enrolled agent, in minor units
	readonly monthlyFeePerAgentMinor: number;
	// Assignments per agent and month that the monthly fee includes
	readonly includedAssignmentsPerAgent: number;
	// Fee per 1,000 assignments above the included ones, in minor units. Counted per 1,000
	// because a single assignment costs a fraction of a cent and amounts stay integers.
	readonly feePerThousandExtraAssignmentsMinor: number;
}

// Prototype pricing (architecture doc): $9.00 per agent and month, 1,000 assignments included,
// $0.002 per assignment above that, i.e. $2.00 per 1,000
export const DEFAULT_BILLING_CONFIG: BillingConfig = {
	currency: "USD",
	monthlyFeePerAgentMinor: 900,
	includedAssignmentsPerAgent: 1_000,
	feePerThousandExtraAssignmentsMinor: 200,
};
