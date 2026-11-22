// Names of the environment variables that hold the coordinator's secrets. The secrets themselves
// never appear in code or config; library/environment.ts reads them at startup.
// Used by: main.ts

export interface EnvironmentConfig {
	// Password (or app password) of the coordinator's account
	readonly accountPasswordVariable: string;
	// Private key (hex) of the P-256 key that signs assignments
	readonly attestationKeyVariable: string;
}

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
	accountPasswordVariable: "HIVEMIND_ACCOUNT_PASSWORD",
	attestationKeyVariable: "HIVEMIND_ATTESTATION_KEY",
};
