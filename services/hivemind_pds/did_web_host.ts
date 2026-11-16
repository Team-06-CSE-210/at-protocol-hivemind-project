/*
 * Serves a did:web DID document at /.well-known/did.json on localhost.
 *
 * atproto resolves did:web:{domain} by fetching https://{domain}/.well-known/did.json; for
 * localhost it uses plain HTTP, and the port is part of the DID (did:web:localhost%3A2590). In the
 * deployed system the coordinator serves its own did.json on its domain. Until the coordinator
 * service exists, this host does it, at the address #hivemind_coordinator points to.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DidDocument, DidDocumentHost } from "./did_document.ts";

export type DidWebHost = DidDocumentHost & { close(): Promise<void> };

/* Port 0 picks a free port. */
export async function startDidWebHost(port = 0): Promise<DidWebHost> {
	let document: DidDocument | undefined;
	const server = createServer((request, response) => {
		if (request.url === "/.well-known/did.json" && document) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(document));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => resolve());
	});
	const actualPort = (server.address() as AddressInfo).port;
	return {
		did: `did:web:localhost%3A${actualPort}`,
		url: `http://localhost:${actualPort}`,
		setDocument: (next) => {
			document = next;
		},
		close: () =>
			new Promise((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
