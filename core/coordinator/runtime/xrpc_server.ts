import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalSimService } from "../../protocol/communication/in_memory/at_protocol_network.js";
import * as hivemind from "../../protocol/generated/com/hivemind-network.js";
import {
	type AccessKind,
	type CoordinatorApi,
	CoordinatorApiError,
} from "../../protocol/interfaces/internal/coordinator_api.js";
import type {
	Did,
	Nsid,
	SpaceRef,
} from "../../protocol/interfaces/internal/types.js";
import type { DidDocument } from "../authentication/did_document.js";
import {
	type ResolveSigningKey,
	ServiceAuthError,
	verifyServiceAuth,
} from "../authentication/service_auth.js";
import type { Clock } from "../library/clock.js";

// Carries the CoordinatorApi over HTTP as XRPC (atproto.com/specs/xrpc), and over the in-memory
// network for tests. Every call is authenticated with service auth before a handler runs.
//
// POST /xrpc/com.hivemind-network.coordinator.register        participants, via their PDS
// POST /xrpc/com.hivemind-network.coordinator.setFeedMember   feed owners, via their PDS
// GET  /xrpc/com.atproto.managedspace.checkUserAccess         the coordinator's own PDS only
// GET  /.well-known/did.json                                  when a DID document is given

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface XrpcServerOptions {
	api: CoordinatorApi;
	coordinator: Did;
	serviceFragment: string;
	resolveSigningKey: ResolveSigningKey;
	clock: Clock;
	port: number;
	// Served at /.well-known/did.json if the coordinator also answers for its did:web domain
	didDocument?: DidDocument;
}

export interface RunningXrpcServer {
	readonly port: number;
	close(): Promise<void>;
}

const METHODS = {
	register: "com.hivemind-network.coordinator.register",
	setFeedMember: "com.hivemind-network.coordinator.setFeedMember",
	checkUserAccess: "com.atproto.managedspace.checkUserAccess",
} as const satisfies Record<string, Nsid>;

// Larger than any input the two procedures take
const MAX_BODY_BYTES = 64 * 1024;

// An answer with an XRPC error body: {"error": <name>, "message": <text>}
class XrpcFailure extends Error {
	constructor(
		readonly status: number,
		readonly error: string,
		message: string,
	) {
		super(message);
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// HTTP
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export async function startXrpcServer(
	options: XrpcServerOptions,
): Promise<RunningXrpcServer> {
	const server: Server = createServer((request, response) => {
		route(options, request)
			.then((body) => sendJson(response, 200, body))
			.catch((error: unknown) => sendFailure(response, error));
	});
	// A port in use rejects here instead of surfacing as an unhandled "error" event
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

async function route(
	options: XrpcServerOptions,
	request: IncomingMessage,
): Promise<unknown> {
	const { api, coordinator } = options;
	const url = new URL(request.url ?? "/", "http://coordinator.invalid");
	const method = request.method ?? "GET";

	// 1. The DID document
	if (
		url.pathname === "/.well-known/did.json" &&
		options.didDocument !== undefined
	) {
		return options.didDocument;
	}

	// 2. Procedures: authenticated caller, then the input checked against the lexicon
	if (method === "POST" && url.pathname === `/xrpc/${METHODS.register}`) {
		const caller = await authenticate(options, request, METHODS.register);
		const input = parseInput(
			hivemind.coordinator.register.$input.schema,
			await readJsonBody(request),
		);
		return api.register(caller, input);
	}
	if (method === "POST" && url.pathname === `/xrpc/${METHODS.setFeedMember}`) {
		const caller = await authenticate(options, request, METHODS.setFeedMember);
		const input = parseInput(
			hivemind.coordinator.defs.feedMember,
			await readJsonBody(request),
		);
		await api.setFeedMember(caller, input);
		return {};
	}

	// 3. The access check, asked by the authority's PDS, i.e. signed as the coordinator itself
	if (method === "GET" && url.pathname === `/xrpc/${METHODS.checkUserAccess}`) {
		const caller = await authenticate(
			options,
			request,
			METHODS.checkUserAccess,
		);
		if (caller !== coordinator) {
			throw new XrpcFailure(
				403,
				"Forbidden",
				"Only the space authority may ask",
			);
		}
		const space = url.searchParams.get("space");
		const user = url.searchParams.get("user");
		const access = url.searchParams.get("access");
		if (
			space === null ||
			user === null ||
			(access !== "read" && access !== "write")
		) {
			throw new XrpcFailure(
				400,
				"InvalidRequest",
				"space, user and access are required",
			);
		}
		const authorized = await api.checkUserAccess(
			space as SpaceRef,
			user as Did,
			access as AccessKind,
		);
		return { authorized };
	}

	if (url.pathname.startsWith("/xrpc/")) {
		throw new XrpcFailure(
			501,
			"MethodNotImplemented",
			`Not implemented: ${url.pathname}`,
		);
	}
	throw new XrpcFailure(404, "NotFound", "Not found");
}

async function authenticate(
	options: XrpcServerOptions,
	request: IncomingMessage,
	method: Nsid,
): Promise<Did> {
	const { coordinator, serviceFragment, resolveSigningKey, clock } = options;
	return verifyServiceAuth(
		request.headers.authorization,
		{ audience: coordinator, serviceFragment, method },
		resolveSigningKey,
		clock.now(),
	);
}

// The lexicon schemas of the generated code: safeParse returns the value or the issues
interface InputSchema<Value> {
	safeParse(
		input: unknown,
	): { success: true; value: Value } | { success: false; message?: string };
}

function parseInput<Value>(schema: InputSchema<Value>, body: unknown): Value {
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new XrpcFailure(
			400,
			"InvalidRequest",
			parsed.message ?? "Invalid input",
		);
	}
	return parsed.value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			throw new XrpcFailure(413, "PayloadTooLarge", "Request body too large");
		}
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new XrpcFailure(400, "InvalidRequest", "Body is not JSON");
	}
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

// Refusals the lexicons declare are 400, failed authentication 401, everything unexpected 500
function sendFailure(response: ServerResponse, error: unknown): void {
	if (error instanceof XrpcFailure) {
		sendJson(response, error.status, {
			error: error.error,
			message: error.message,
		});
		return;
	}
	if (error instanceof CoordinatorApiError) {
		sendJson(response, 400, { error: error.error, message: error.message });
		return;
	}
	if (error instanceof ServiceAuthError) {
		sendJson(response, 401, { error: error.error, message: error.message });
		return;
	}
	console.error(error);
	sendJson(response, 500, {
		error: "InternalServerError",
		message: "Internal server error",
	});
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// In-memory network
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The same API as a service of the in-memory network, which passes the caller's DID itself.
// Inputs are checked against the lexicons as on HTTP.
export function toLocalSimService(api: CoordinatorApi): LocalSimService {
	return {
		checkUserAccess: (space, user, access) =>
			api.checkUserAccess(space, user, access),
		procedures: {
			[METHODS.register]: (caller, input) =>
				api.register(
					caller,
					parseInput(hivemind.coordinator.register.$input.schema, input),
				),
			[METHODS.setFeedMember]: async (caller, input) => {
				await api.setFeedMember(
					caller,
					parseInput(hivemind.coordinator.defs.feedMember, input),
				);
				return {};
			},
		},
	};
}
