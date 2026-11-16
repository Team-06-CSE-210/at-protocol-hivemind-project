/*
 * Starts the Hivemind network for development and tests with @atproto/dev-env, all inside this Node
 * process (ADR-001): one PLC directory, two spaces-alpha PDSes and the coordinator's did.json.
 *
 *   Hivemind PDS  invite-only. Hosts the coordinator account, so it is the authority and host of
 *                 every intake, feed and task space. Riders get their accounts here.
 *   Operator PDS  a fleet operator's own PDS, open for sign-up. Agents live here.
 *   Coordinator   did:web:localhost%3A{port}; its did.json is served on that port.
 *
 * Only this file knows about dev-env. Everything it returns is a HivemindNetwork (network.ts), and
 * the coordinator account is created over HTTP (coordinator_account.ts), as it would be against a
 * PDS in Docker.
 *
 * Each PDS keeps its files in a new temporary directory (account.sqlite, sequencer.sqlite,
 * did_cache.sqlite, actors/) plus one for blobs; PLC keeps its log in memory. close() deletes the
 * directories, so every start begins empty.
 */
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
	ADMIN_PASSWORD,
	mockNetworkUtilities,
	TestPds,
	TestPlc,
} from "@atproto/dev-env";
import {
	createCoordinatorAccount,
	createInviteCode,
	type PdsAdmin,
} from "./coordinator_account.ts";
import { type DidWebHost, startDidWebHost } from "./did_web_host.ts";
import {
	HIVEMIND_HANDLE_DOMAIN,
	type HivemindNetwork,
	OPERATOR_HANDLE_DOMAIN,
} from "./network.ts";

export type DevNetworkOptions = {
	/* Fixed ports. Left out, each server takes a free port (what tests want). */
	plcPort?: number;
	hivemindPdsPort?: number;
	operatorPdsPort?: number;
	/* Port of the coordinator's address, which is also part of its did:web. */
	coordinatorPort?: number;
};

export type DevNetwork = HivemindNetwork & {
	/* Where each PDS keeps its files while the network runs. Deleted by close(). */
	dataDirectories: { hivemindPds: string; operatorPds: string };
};

export async function startDevNetwork(
	options: DevNetworkOptions = {},
): Promise<DevNetwork> {
	const plc = await TestPlc.create(withoutUndefined({ port: options.plcPort }));
	const pdses: TestPds[] = [];
	let didWebHost: DidWebHost | undefined;
	const close = async () => {
		const directories = pdses.flatMap(dataLocations);
		await Promise.allSettled(pdses.map((pds) => pds.close()));
		await didWebHost?.close();
		await plc.close();
		await Promise.allSettled(
			directories.map((directory) =>
				rm(directory, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 200,
				}),
			),
		);
	};
	try {
		const hivemindPds = await TestPds.create(
			withoutUndefined({
				didPlcUrl: plc.url,
				port: options.hivemindPdsPort,
				hostname: "localhost",
				serviceHandleDomains: [HIVEMIND_HANDLE_DOMAIN],
				inviteRequired: true,
			}),
		);
		pdses.push(hivemindPds);
		allowDidDirectoriesOnWindows(hivemindPds);
		const operatorPds = await TestPds.create(
			withoutUndefined({
				didPlcUrl: plc.url,
				port: options.operatorPdsPort,
				hostname: "localhost",
				serviceHandleDomains: [OPERATOR_HANDLE_DOMAIN],
				inviteRequired: false,
			}),
		);
		pdses.push(operatorPds);
		allowDidDirectoriesOnWindows(operatorPds);
		// Handles and PDS addresses resolve against the two local servers instead of DNS/HTTPS.
		mockNetworkUtilities(pdses);

		const hivemindAdmin: PdsAdmin = {
			url: hivemindPds.url,
			adminPassword: ADMIN_PASSWORD,
		};
		didWebHost = await startDidWebHost(options.coordinatorPort);
		const coordinator = await createCoordinatorAccount(
			hivemindAdmin,
			didWebHost,
		);

		return {
			plcUrl: plc.url,
			hivemindPdsUrl: hivemindPds.url,
			operatorPdsUrl: operatorPds.url,
			coordinator,
			createInviteCode: (useCount = 1) =>
				createInviteCode(hivemindAdmin, useCount),
			dataDirectories: {
				hivemindPds: dataLocations(hivemindPds)[0],
				operatorPds: dataLocations(operatorPds)[0],
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

/* The PDS's data directory (parent of actors/), then its blob directory. */
function dataLocations(pds: TestPds): string[] {
	const { actorStore, blobstore } = pds.ctx.cfg;
	const locations = [dirname(actorStore.directory)];
	if (blobstore.provider === "disk") locations.push(blobstore.location);
	return locations;
}

/*
 * The PDS keeps each account's data in a directory named after its DID (actors/{hash}/{did}), and
 * DIDs contain ":", which Windows does not allow in file names. On Windows only, ":" becomes "_"
 * in those directory names. Nothing the PDS does over the network changes, and on Linux and macOS
 * (and in the 11.5 PDS image) the PDS runs unmodified. Blob storage has the same limit; Hivemind
 * stores no blobs yet.
 */
function allowDidDirectoriesOnWindows(pds: TestPds): void {
	if (process.platform !== "win32") return;
	const store = pds.ctx.actorStore;
	const getLocation = store.getLocation.bind(store);
	store.getLocation = (did: string) => getLocation(did.replaceAll(":", "_"));
}

/* dev-env spreads the config over its defaults, so an explicit `port: undefined` would win. */
function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;
}
