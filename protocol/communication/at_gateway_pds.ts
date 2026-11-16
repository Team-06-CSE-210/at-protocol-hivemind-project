import { type Agent, AtpAgent, AtUri as AtUriParser } from "@atproto/api";
import { P256Keypair } from "@atproto/crypto";
import { getDidKeyFromMultibase, type IdResolver } from "@atproto/identity";
import { jsonToLex } from "@atproto/lexicon";
import {
	COMMIT_MAC_TYPE,
	type Commit,
	createSpaceSigHeaders,
	encapsulate,
	formatWantMacHeader,
	MAC_HEADER,
	parseMacHeader,
	verifyCommitMac,
	verifyRepoStarFull,
	WANT_MAC_HEADER,
} from "@atproto/space";
import { Firehose } from "@atproto/sync";
import {
	type AtprotoGateway,
	type RecordChange,
	SpaceAccessDeniedError,
	type SpaceAuthority,
	type SpacePolicy,
} from "../interfaces/internal/atproto_gateway.js";
import type { RevisionStore } from "../interfaces/internal/stores.js";
import type {
	AtUri,
	Did,
	Nsid,
	SpaceRef,
	TypedObject,
} from "../interfaces/internal/types.js";
import { authorityOf } from "../protocol_config/space_definition.js";

// Real gateway: talks to PDSes running the Spaces alpha pinned in package.json
// (0.0.0-spaces-alpha-20261105160032). One instance per account.
//
// Reading a space takes five steps, all hidden behind watchSpace:
// 1. delegation token from the account's own PDS      (com.atproto.space.getDelegationToken)
// 2. space credential from the authority              (com.atproto.space.getSpaceCredential)
// 3. writer set from the space host                   (com.atproto.space.listRepos)
// 4. first sync of a writer: its whole repo, verified (com.atproto.space.getRepo)
// 5. afterwards: its new operations, MAC-checked      (com.atproto.space.listRepoOps)
// Every request after step 2 is signed with the P-256 key the credential is bound to.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Constants
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The frozen alpha issues credentials valid for 600 s; renew a minute before they expire
const CREDENTIAL_RENEWAL_MARGIN_MS = 60_000;

const DEFAULT_POLL_INTERVAL_MS = 2_000;

// Answers an authority may give for "no access"; it may say SpaceNotFound instead of refusing
const ACCESS_REFUSALS = new Set([
	"UserNotAuthorized",
	"NotAuthorized",
	"SpaceNotFound",
	"SpaceDeleted",
]);

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Options
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export interface PdsGatewayOptions {
	// Logged-in session of the account: app password (AtpAgent) or OAuth (Agent)
	agent: Agent;
	// Resolves DIDs to DID documents (PLC directory, did:web)
	didResolver: IdResolver;
	// WebSocket URL of a relay or PDS, for watchPublic, e.g. wss://bsky.network
	firehoseService?: string;
	// Lets a watch resume after a restart; without one every watch replays the whole space
	revisionStore?: RevisionStore;
	// How often followed spaces are checked for new writes
	pollIntervalMs?: number;
	// Errors that happen in the background, after watchSpace has already returned
	onError?: (error: unknown) => void;
}

// Response shapes of the space methods used here (com.atproto.space.listRepos, listRepoOps)
interface WriterEntry {
	did: Did;
	repoRev: string;
}

interface OpEntry {
	rev: string;
	collection: Nsid;
	rkey: string;
	cid?: string | null;
	prev?: string | null;
	value?: unknown;
}

interface WriterSync {
	revision: string;
	changes: RecordChange[];
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Atproto Gateway
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

export class PdsGateway implements AtprotoGateway {
	readonly did: Did;

	private readonly agent: Agent;
	private readonly didResolver: IdResolver;
	private readonly options: PdsGatewayOptions;
	// Space credentials are bound to this key; it never leaves the gateway
	private readonly credentialKey: Promise<P256Keypair> = P256Keypair.create();
	private readonly credentials = new Map<
		SpaceRef,
		{ token: string; expiresAtMs: number }
	>();
	private readonly pdsByDid = new Map<Did, string>();
	private readonly kemKeyByDid = new Map<Did, string>();

	constructor(options: PdsGatewayOptions) {
		this.options = options;
		this.agent = options.agent;
		this.didResolver = options.didResolver;
		this.did = options.agent.assertDid;
	}

	// * * * * * * * * * * * * * * * * * *
	// PDS Interaction
	// * * * * * * * * * * * * * * * * * *

	async putRecord(
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<AtUri> {
		const { data } = await this.agent.com.atproto.repo.putRecord({
			repo: this.did,
			collection,
			rkey,
			record,
		});
		return data.uri as AtUri;
	}

	async deleteRecord(collection: Nsid, rkey: string): Promise<void> {
		await this.agent.com.atproto.repo.deleteRecord({
			repo: this.did,
			collection,
			rkey,
		});
	}

	async getRecord(uri: AtUri): Promise<TypedObject | undefined> {
		// Public records are read from the author's own PDS, without logging in
		const { host, collection, rkey } = new AtUriParser(uri);
		const reader = new AtpAgent({ service: await this.pdsOf(host as Did) });
		try {
			const { data } = await reader.com.atproto.repo.getRecord({
				repo: host,
				collection,
				rkey,
			});
			return data.value as TypedObject;
		} catch (error) {
			if (xrpcErrorName(error) === "RecordNotFound") {
				return undefined;
			}
			throw error;
		}
	}

	// * * * * * * * * * * * * * * * * * *
	// Space Interaction: writing
	// * * * * * * * * * * * * * * * * * *

	// Writes go to the account's own repo inside the space; its PDS then notifies the space host.
	// The PDS accepts the write even without write access: the space host just leaves this
	// writer out, so the record never reaches readers.
	async putSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
		record: TypedObject,
	): Promise<void> {
		await this.agent.com.atproto.space.putRecord({
			space,
			repo: this.did,
			collection,
			rkey,
			record,
		});
	}

	async deleteSpaceRecord(
		space: SpaceRef,
		collection: Nsid,
		rkey: string,
	): Promise<void> {
		await this.agent.com.atproto.space.deleteRecord({
			space,
			repo: this.did,
			collection,
			rkey,
		});
	}

	// * * * * * * * * * * * * * * * * * *
	// Space Interaction: following
	// * * * * * * * * * * * * * * * * * *

	async watchSpace(
		space: SpaceRef,
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		// Progress of this watch per writer
		const syncedRevisions = new Map<Did, string>();
		let stopped = false;
		let roundRunning = false;

		// One round: ask the space host who writes, then fetch what changed per writer
		const syncRound = async () => {
			for (const writer of await this.listWriters(space)) {
				if (stopped) {
					return;
				}
				const lastRevision =
					syncedRevisions.get(writer.did) ??
					(await this.options.revisionStore?.get(space, writer.did));
				if (lastRevision === writer.repoRev) {
					syncedRevisions.set(writer.did, writer.repoRev);
					continue;
				}

				// First sync of this writer: whole repo; afterwards: only new operations
				const sync =
					lastRevision === undefined
						? await this.readWholeRepo(space, writer.did)
						: await this.readOpsSince(space, writer.did, lastRevision);
				for (const change of sync.changes) {
					if (!stopped) {
						onChange(change);
					}
				}
				syncedRevisions.set(writer.did, sync.revision);
				await this.options.revisionStore?.set(space, writer.did, sync.revision);
			}
		};

		// The first round runs before returning, so a refusal rejects watchSpace itself
		// (that is how an agent learns it lost a task)
		await syncRound();

		// Afterwards poll; a refusal later on (member removed, operator suspended) ends the watch
		const stop = () => {
			stopped = true;
			clearInterval(timer);
		};
		const timer = setInterval(() => {
			if (roundRunning || stopped) {
				return;
			}
			roundRunning = true;
			syncRound()
				.catch((error) => {
					// A round still running when the watch was stopped may fail; nobody cares
					if (stopped) {
						return;
					}
					if (error instanceof SpaceAccessDeniedError) {
						stop();
					}
					this.reportError(error);
				})
				.finally(() => {
					roundRunning = false;
				});
		}, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		return stop;
	}

	// The writer set, from the space host (the authority's PDS); paginated
	private async listWriters(space: SpaceRef): Promise<WriterEntry[]> {
		const writers: WriterEntry[] = [];
		let cursor: string | undefined;
		do {
			const response = await this.spaceRequest(
				space,
				authorityOf(space),
				"com.atproto.space.listRepos",
				{ space, ...(cursor ? { cursor } : {}) },
			);
			const body = (await response.json()) as {
				repos: WriterEntry[];
				cursor?: string;
			};
			writers.push(...body.repos);
			cursor = body.cursor;
		} while (cursor);
		return writers;
	}

	// A writer's whole repo as a STAR archive, checked against the commit's MAC and set hash.
	// Used for the first sync, because the ops log may have been shortened by the host.
	private async readWholeRepo(
		space: SpaceRef,
		writer: Did,
	): Promise<WriterSync> {
		const { keyShare, sharedSecret } = await encapsulate(
			await this.kemKeyOf(writer),
		);
		const response = await this.spaceRequest(
			space,
			writer,
			"com.atproto.space.getRepo",
			{ space, repo: writer },
			keyShare,
		);
		const mac = parseMacHeader(
			response.headers.get(MAC_HEADER) ?? undefined,
			COMMIT_MAC_TYPE,
		);
		const { commit, records } = await verifyRepoStarFull(
			[new Uint8Array(await response.arrayBuffer())],
			{ space, repo: writer, sharedSecret, mac },
		);
		return {
			revision: commit.rev,
			changes: records.map((record) => ({
				action: "create",
				author: writer,
				collection: record.collection,
				rkey: record.rkey,
				record: record.record as TypedObject,
				space,
			})),
		};
	}

	// A writer's operations since a revision. The final page carries the commit, checked by MAC.
	// Not yet checked: that the operations add up to the commit's set hash (LtHash).
	private async readOpsSince(
		space: SpaceRef,
		writer: Did,
		since: string,
	): Promise<WriterSync> {
		const kemKey = await this.kemKeyOf(writer);
		const ops: OpEntry[] = [];
		let cursor: string | undefined;
		let commit: unknown;
		let mac: Uint8Array | undefined;
		let sharedSecret: Uint8Array | undefined;

		// Page through until the page with the commit (a full page comes without one)
		do {
			const encapsulation = await encapsulate(kemKey);
			const response = await this.spaceRequest(
				space,
				writer,
				"com.atproto.space.listRepoOps",
				{ space, repo: writer, since, ...(cursor ? { cursor } : {}) },
				encapsulation.keyShare,
			);
			const body = (await response.json()) as {
				ops: OpEntry[];
				commit?: unknown;
				cursor?: string;
			};
			ops.push(...body.ops);
			cursor = body.cursor;
			if (body.commit) {
				commit = body.commit;
				sharedSecret = encapsulation.sharedSecret;
				mac = parseMacHeader(
					response.headers.get(MAC_HEADER) ?? undefined,
					COMMIT_MAC_TYPE,
				);
			}
		} while (cursor && commit === undefined);

		// The MAC proves the commit comes from the writer's PDS (keyed to its #atproto_kem)
		if (commit === undefined || !mac || !sharedSecret) {
			throw new Error(`No commit for ${writer} in ${space}`);
		}
		const verifiedCommit = jsonToLex(commit) as Commit;
		if (!verifyCommitMac(sharedSecret, verifiedCommit, mac)) {
			throw new Error(`MAC check failed for ${writer} in ${space}`);
		}

		// cid null: delete. No value: replaced by a later operation, skip. prev null: create.
		const changes: RecordChange[] = [];
		for (const op of ops) {
			const base = {
				author: writer,
				collection: op.collection,
				rkey: op.rkey,
				space,
			};
			if (op.cid == null) {
				changes.push({ ...base, action: "delete" });
			} else if (op.value !== undefined) {
				changes.push({
					...base,
					action: op.prev ? "update" : "create",
					record: jsonToLex(op.value) as TypedObject,
				});
			}
		}
		return { revision: verifiedCommit.rev, changes };
	}

	// * * * * * * * * * * * * * * * * * *
	// Public records and procedures
	// * * * * * * * * * * * * * * * * * *

	// Live only: a firehose subscription without a cursor delivers new events, no backfill
	async watchPublic(
		collections: Nsid[],
		onChange: (change: RecordChange) => void,
	): Promise<() => void> {
		if (!this.options.firehoseService) {
			throw new Error("watchPublic needs the firehoseService option");
		}
		const firehose = new Firehose({
			service: this.options.firehoseService,
			idResolver: this.didResolver,
			filterCollections: collections,
			handleEvent: (event) => {
				if (event.event === "create" || event.event === "update") {
					onChange({
						action: event.event,
						author: event.did as Did,
						collection: event.collection as Nsid,
						rkey: event.rkey,
						record: event.record as TypedObject,
					});
				} else if (event.event === "delete") {
					onChange({
						action: "delete",
						author: event.did as Did,
						collection: event.collection as Nsid,
						rkey: event.rkey,
					});
				}
			},
			onError: (error) => this.reportError(error),
		});
		// start() resolves only when the subscription ends, so it is not awaited
		void firehose.start();
		return () => {
			void firehose.destroy();
		};
	}

	// `service` is a service identifier, e.g. did:web:hivemind-network.com#hivemind_coordinator.
	// The account's own PDS forwards the call and adds the service-auth token (atproto-proxy).
	async callProcedure(
		service: Did,
		method: Nsid,
		input: unknown,
	): Promise<unknown> {
		if (!service.includes("#")) {
			throw new Error(
				`callProcedure needs a service identifier with #fragment, got ${service}`,
			);
		}
		const response = await this.agent.sessionManager.fetchHandler(
			`/xrpc/${method}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"atproto-proxy": service,
				},
				body: JSON.stringify(input),
			},
		);
		const body = await response.json().catch(() => undefined);
		if (!response.ok) {
			throw new Error(
				`${method} failed: ${body?.error ?? response.status} ${body?.message ?? ""}`,
			);
		}
		return body;
	}

	// * * * * * * * * * * * * * * * * * *
	// Credentials and signed requests
	// * * * * * * * * * * * * * * * * * *

	private async credentialFor(space: SpaceRef): Promise<string> {
		const cached = this.credentials.get(space);
		if (
			cached &&
			cached.expiresAtMs - Date.now() > CREDENTIAL_RENEWAL_MARGIN_MS
		) {
			return cached.token;
		}

		// 1. The account's own PDS vouches that this app acts for the account
		let delegationToken: string;
		try {
			const { data } = await this.agent.com.atproto.space.getDelegationToken({
				space,
			});
			delegationToken = data.token;
		} catch (error) {
			throw asAccessDenied(xrpcErrorName(error)) ?? error;
		}

		// 2. The authority decides, and binds the credential to our P-256 key
		const authorityPds = await this.pdsOf(authorityOf(space));
		const response = await fetch(
			`${authorityPds}/xrpc/com.atproto.space.getSpaceCredential`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					space,
					credentialKid: (await this.credentialKey).did(),
					delegationToken,
				}),
			},
		);
		const body = (await response.json()) as {
			credential?: string;
			error?: string;
			message?: string;
		};
		if (!response.ok || !body.credential) {
			throw (
				asAccessDenied(body.error) ??
				new Error(`getSpaceCredential failed: ${body.error} ${body.message}`)
			);
		}
		this.credentials.set(space, {
			token: body.credential,
			expiresAtMs: jwtExpiryMs(body.credential),
		});
		return body.credential;
	}

	// GET on the PDS of `audience`: the authority for the space host, the writer for its repo.
	// The audience is part of the signature, so a request cannot be replayed at another host.
	private async spaceRequest(
		space: SpaceRef,
		audience: Did,
		method: string,
		params: Record<string, string>,
		wantMacKeyShare?: string,
	): Promise<Response> {
		const credential = await this.credentialFor(space);
		const headers: Record<string, string> = await createSpaceSigHeaders(
			await this.credentialKey,
			{ authorization: `Atproto-Space-Credential ${credential}`, audience },
		);
		if (wantMacKeyShare) {
			headers[WANT_MAC_HEADER] = formatWantMacHeader(
				COMMIT_MAC_TYPE,
				wantMacKeyShare,
			);
		}
		const host = await this.pdsOf(audience);
		const response = await fetch(
			`${host}/xrpc/${method}?${new URLSearchParams(params)}`,
			{ headers },
		);
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
			};
			throw (
				asAccessDenied(body.error) ??
				new Error(
					`${method} failed: ${body.error ?? response.status} ${body.message ?? ""}`,
				)
			);
		}
		return response;
	}

	// * * * * * * * * * * * * * * * * * *
	// DID documents
	// * * * * * * * * * * * * * * * * * *

	private async pdsOf(did: Did): Promise<string> {
		let pds = this.pdsByDid.get(did);
		if (!pds) {
			pds = (await this.didResolver.did.resolveAtprotoData(did)).pds;
			this.pdsByDid.set(did, pds);
		}
		return pds;
	}

	// The PLC directory serves the key in the older Multibase format; convert it to did:key
	private async kemKeyOf(did: Did): Promise<string> {
		let kemKey = this.kemKeyByDid.get(did);
		if (!kemKey) {
			const document = await this.didResolver.did.resolve(did);
			const method = document?.verificationMethod?.find((entry) =>
				entry.id.endsWith("#atproto_kem"),
			);
			kemKey =
				method?.publicKeyMultibase === undefined
					? undefined
					: getDidKeyFromMultibase({
							type: method.type,
							publicKeyMultibase: method.publicKeyMultibase,
						});
			if (!kemKey) {
				throw new Error(`${did} publishes no #atproto_kem key`);
			}
			this.kemKeyByDid.set(did, kemKey);
		}
		return kemKey;
	}

	private reportError(error: unknown): void {
		(this.options.onError ?? console.error)(error);
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space Authority
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Only the coordinator's account uses this: it is the authority of every Hivemind space
export class PdsSpaceAuthority implements SpaceAuthority {
	constructor(private readonly agent: Agent) {}

	async createSpace(
		spaceType: Nsid,
		spaceKey: string,
		policy: SpacePolicy,
	): Promise<SpaceRef> {
		const { data } = await this.agent.com.atproto.space.createSpace({
			spaceType,
			skey: spaceKey,
			policy,
		});
		return data.uri as SpaceRef;
	}

	async putMember(
		space: SpaceRef,
		member: Did,
		access: { read: boolean; write: boolean },
	): Promise<void> {
		await this.agent.com.atproto.memberspace.putMember({
			space,
			did: member,
			read: access.read,
			write: access.write,
		});
	}

	async removeMember(space: SpaceRef, member: Did): Promise<void> {
		await this.agent.com.atproto.memberspace.removeMember({
			space,
			did: member,
		});
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Helpers
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

function xrpcErrorName(error: unknown): string | undefined {
	return (error as { error?: string } | undefined)?.error;
}

function asAccessDenied(
	errorName: string | undefined,
): SpaceAccessDeniedError | undefined {
	return errorName && ACCESS_REFUSALS.has(errorName)
		? new SpaceAccessDeniedError(errorName)
		: undefined;
}

// Reads `exp` from a JWT without verifying it; the issuer verifies its own tokens
function jwtExpiryMs(jwt: string): number {
	const [, payload] = jwt.split(".");
	const { exp } = JSON.parse(
		Buffer.from(payload, "base64url").toString("utf8"),
	) as { exp: number };
	return exp * 1000;
}
