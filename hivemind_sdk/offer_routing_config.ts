// Retry limits for an agent's offer write. A retry reuses its decision and record key.

export interface OfferRoutingConfig {
	// Limit attempts for key generation and Gateway writes for one dispatch delivery
	readonly maxWriteAttempts: number;
	// Wait between attempts; the dispatch deadline is checked again after waiting
	readonly retryDelayMs: number;
}

export const DEFAULT_OFFER_ROUTING_CONFIG: OfferRoutingConfig = {
	maxWriteAttempts: 3,
	retryDelayMs: 250,
};
