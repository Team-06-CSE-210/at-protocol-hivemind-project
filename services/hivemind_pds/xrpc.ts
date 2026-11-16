/*
 * Minimal XRPC over fetch, used by the dev network and the tests. Real Hivemind code talks to
 * atproto through AtprotoGateway (protocol/interfaces/internal/atproto_gateway.ts) instead.
 */
export type Json = Record<string, unknown>;
export type XrpcReply = { status: number; body: Json };
export type XrpcOptions = {
	/* Defaults to POST when there is a body, GET otherwise. */
	method?: "GET" | "POST";
	params?: Record<string, string>;
	body?: Json;
	/* Sent as `Authorization: Bearer …`: a session token or a service auth token. */
	token?: string;
	headers?: Record<string, string>;
};

export async function xrpc(
	baseUrl: string,
	nsid: string,
	options: XrpcOptions = {},
): Promise<XrpcReply> {
	const url = new URL(`/xrpc/${nsid}`, baseUrl);
	for (const [key, value] of Object.entries(options.params ?? {})) {
		url.searchParams.set(key, value);
	}
	const headers: Record<string, string> = { ...options.headers };
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	if (options.body) headers["content-type"] = "application/json";
	const response = await fetch(url, {
		method: options.method ?? (options.body ? "POST" : "GET"),
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text ? (JSON.parse(text) as Json) : {},
	};
}

/* The reply body, or an error that names the call and shows the PDS's answer. */
export function expectOk(reply: XrpcReply, call: string): Json {
	if (reply.status !== 200) {
		throw new Error(
			`${call} failed (${reply.status}): ${JSON.stringify(reply.body)}`,
		);
	}
	return reply.body;
}
