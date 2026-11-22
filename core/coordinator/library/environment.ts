import type { EnvironmentConfig } from "../config/environment_config.js";

// Reads the coordinator's secrets from the environment variables that config/environment_config.ts
// names. Called once at startup; a missing secret stops the coordinator before it touches anything.

export interface CoordinatorSecrets {
	readonly accountPassword: string;
	readonly attestationKeyHex: string;
}

export class MissingSecretError extends Error {}

export function readSecrets(
	config: EnvironmentConfig,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): CoordinatorSecrets {
	return {
		accountPassword: requireVariable(
			environment,
			config.accountPasswordVariable,
		),
		attestationKeyHex: requireVariable(
			environment,
			config.attestationKeyVariable,
		),
	};
}

function requireVariable(
	environment: Readonly<Record<string, string | undefined>>,
	name: string,
): string {
	const value = environment[name];
	if (value === undefined || value === "") {
		throw new MissingSecretError(`Environment variable ${name} is not set`);
	}
	return value;
}
