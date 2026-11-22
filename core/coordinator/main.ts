import { pathToFileURL } from "node:url";
import { IdResolver } from "@atproto/identity";
import {
	PdsGateway,
	PdsSpaceAuthority,
} from "../protocol/communication/network/at_gateway_pds.js";
import type {
	AtprotoGateway,
	SpaceAuthority,
} from "../protocol/interfaces/internal/atproto_gateway.js";
import type { AttestationSigner } from "../protocol/interfaces/internal/attestation.js";
import type { CoordinatorApi } from "../protocol/interfaces/internal/coordinator_api.js";
import type { MatchingEngine } from "../protocol/interfaces/internal/matching_engine.js";
import type { RequestRouter } from "../protocol/interfaces/internal/request_router.js";
import type { SpaceService } from "../protocol/interfaces/internal/space_service.js";
import type { CoordinatorStores } from "../protocol/interfaces/internal/stores.js";
import type { Did } from "../protocol/interfaces/internal/types.js";
import { logInCoordinator } from "./authentication/account_session.js";
import { P256AttestationSigner } from "./authentication/attestation_signer.js";
import {
	attestationKeyId,
	identityProblems,
	UnpublishedIdentityError,
} from "./authentication/did_document.js";
import {
	type BillingConfig,
	DEFAULT_BILLING_CONFIG,
} from "./config/billing_config.js";
import { type DataConfig, DEFAULT_DATA_CONFIG } from "./config/data_config.js";
import {
	DEFAULT_ENVIRONMENT_CONFIG,
	type EnvironmentConfig,
} from "./config/environment_config.js";
import {
	DEFAULT_IDENTITY_CONFIG,
	type IdentityConfig,
} from "./config/identity_config.js";
import {
	DEFAULT_RUNTIME_CONFIG,
	type RuntimeConfig,
} from "./config/runtime_config.js";
import {
	DEFAULT_TASKS_CONFIG,
	type TasksConfig,
} from "./config/tasks_config.js";
import { openSqliteStores } from "./data/sqlite_stores.js";
import { type Clock, systemClock } from "./library/clock.js";
import { readSecrets } from "./library/environment.js";
import { CoordinatorApiHandlers } from "./runtime/api_handlers.js";
import { BillingRuntime } from "./runtime/billing.js";
import { PublicIndexer } from "./runtime/public_indexer.js";
import { TaskRunner } from "./runtime/task_runner.js";
import {
	type RunningXrpcServer,
	startXrpcServer,
} from "./runtime/xrpc_server.js";

// Entry point of the coordinator. startCoordinator() wires the parts from what it is given, so
// tests start it on the in-memory network; main() builds the real dependencies and starts it.
// This is the only file that chooses implementations, and the only one that may import from
// services/ (see services/_services.md).

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Configuration
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface CoordinatorConfigs {
	readonly identity: IdentityConfig;
	readonly tasks: TasksConfig;
	readonly billing: BillingConfig;
	readonly runtime: RuntimeConfig;
	readonly data: DataConfig;
	readonly environment: EnvironmentConfig;
}

export const DEFAULT_COORDINATOR_CONFIGS: CoordinatorConfigs = {
	identity: DEFAULT_IDENTITY_CONFIG,
	tasks: DEFAULT_TASKS_CONFIG,
	billing: DEFAULT_BILLING_CONFIG,
	runtime: DEFAULT_RUNTIME_CONFIG,
	data: DEFAULT_DATA_CONFIG,
	environment: DEFAULT_ENVIRONMENT_CONFIG,
};

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Wiring
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The swappable parts (services/); each one implements an interface in core/protocol/interfaces/internal
export interface CoordinatorServices {
	router: RequestRouter;
	matching: MatchingEngine;
	spaces: SpaceService;
}

export interface CoordinatorDependencies {
	coordinator: Did;
	gateway: AtprotoGateway;
	stores: CoordinatorStores;
	services: CoordinatorServices;
	signer: AttestationSigner;
	clock: Clock;
	onError?: (error: unknown) => void;
}

export interface RunningCoordinator {
	api: CoordinatorApi;
	billing: BillingRuntime;
	runner: TaskRunner;
	indexer: PublicIndexer;
	stop(): Promise<void>;
}

export async function startCoordinator(
	dependencies: CoordinatorDependencies,
	configs: CoordinatorConfigs = DEFAULT_COORDINATOR_CONFIGS,
): Promise<RunningCoordinator> {
	const { coordinator, gateway, stores, services, signer, clock, onError } =
		dependencies;
	const { spaces, router, matching } = services;

	// 1. The answers to calls; available before anything else, the PDS asks while spaces are set up.
	//    Records the handlers read fresh go through the indexer, which follows the firehose later
	const indexer = new PublicIndexer({
		gateway,
		publicIndex: stores.publicIndex,
		spaces,
		onError,
	});
	const api = new CoordinatorApiHandlers({
		coordinator,
		stores,
		gateway,
		indexer,
		clock,
	});
	const billing = new BillingRuntime(stores, configs.billing);

	// 2. The intakes, then the feeds and their spaces
	await spaces.setUpIntakes();
	await indexer.start();

	// 3. The tasks: open ones resume, then both intakes are followed.
	//    If that fails, the indexer stops too, so no firehose subscription is left open
	const runner = new TaskRunner(
		{ stores, spaces, router, matching, signer, billing, clock, onError },
		configs.tasks,
	);
	try {
		await runner.start();
	} catch (error) {
		await indexer.stop();
		throw error;
	}

	return {
		api,
		billing,
		runner,
		indexer,
		stop: async () => {
			await runner.stop();
			await indexer.stop();
		},
	};
}

// Matching is implemented; routing and spaces are still placeholders, so the real coordinator
// cannot start yet. Tests pass service implementations to startCoordinator.
interface ServiceContext {
	coordinator: Did;
	gateway: AtprotoGateway;
	authority: SpaceAuthority;
}

function selectServices(_context: ServiceContext): CoordinatorServices {
	// Once services/ has implementations, construct them here, e.g.
	// router: new CoverageRouting(), matching: new WeightedRanking(),
	// spaces: new AtprotoSpaces(context)
	throw new Error(
		"Routing and space services are not implemented yet (see services/_services.md)",
	);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Running on the network
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export async function main(
	configs: CoordinatorConfigs = DEFAULT_COORDINATOR_CONFIGS,
): Promise<void> {
	const { identity, runtime, data, environment } = configs;

	// 1. Secrets and the coordinator's session at the Hivemind PDS
	const { accountPassword, attestationKeyHex } = readSecrets(environment);
	const agent = await logInCoordinator(identity, accountPassword);
	// did:web:<webDomain> in production, a did:plc on a local PDS
	const coordinator = agent.assertDid;

	// 2. The attestation key, and the DID document that must publish it with the coordinator
	// service: without them agents cannot verify assignments, and PDSes deny every write to the
	// managed spaces (their checkUserAccess call has nowhere to go)
	const signer = await P256AttestationSigner.fromPrivateKeyHex(
		attestationKeyHex,
		attestationKeyId(coordinator, identity),
	);
	const didResolver = new IdResolver({ plcUrl: identity.plcUrl });
	const published = await didResolver.did.resolve(coordinator, true);
	const problems = identityProblems(published, identity, signer.publicDidKey());
	if (problems.length > 0) {
		throw new UnpublishedIdentityError(coordinator, problems);
	}

	// 3. Storage and network access
	const stores = openSqliteStores(data, coordinator);
	const gateway = new PdsGateway({
		agent,
		didResolver,
		firehoseService: runtime.firehoseUrl,
		revisionStore: stores.revisions,
		pollIntervalMs: runtime.spacePollIntervalMs,
		onError: (error) => console.error(error),
	});
	const authority = new PdsSpaceAuthority(agent);

	// 4. The services, the coordinator and its XRPC server
	const services = selectServices({ coordinator, gateway, authority });
	const running = await startCoordinator(
		{ coordinator, gateway, stores, services, signer, clock: systemClock },
		configs,
	);
	// A server that cannot listen (port in use) stops what already runs
	let server: RunningXrpcServer;
	try {
		server = await startXrpcServer({
			api: running.api,
			coordinator,
			serviceFragment: identity.serviceFragment,
			resolveSigningKey: (did, forceRefresh) =>
				didResolver.did.resolveAtprotoKey(did, forceRefresh),
			clock: systemClock,
			port: runtime.xrpcPort,
		});
	} catch (error) {
		await running.stop();
		stores.close();
		throw error;
	}
	console.log(`Coordinator ${coordinator} listening on port ${server.port}`);

	// 5. Stop cleanly on Ctrl+C or a stop signal
	const shutDown = async () => {
		await server.close();
		await running.stop();
		stores.close();
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			shutDown().then(
				() => process.exit(0),
				(error) => {
					console.error(error);
					process.exit(1);
				},
			);
		});
	}
}

// Runs when started directly: node dist/core/coordinator/main.js
if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
