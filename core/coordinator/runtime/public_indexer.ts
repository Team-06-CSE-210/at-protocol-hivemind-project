import { l } from "@atproto/lex";
import * as hivemind from "../../protocol/generated/com/hivemind-network.js";
import type {
	AtprotoGateway,
	RecordChange,
} from "../../protocol/interfaces/internal/atproto_gateway.js";
import type { SpaceService } from "../../protocol/interfaces/internal/space_service.js";
import type { PublicRecordIndex } from "../../protocol/interfaces/internal/stores.js";
import {
	AGENT_PROFILE_COLLECTION,
	FEED_DECLARATION_COLLECTION,
	feedUri,
} from "../data/public_records.js";

// Keeps the public-record index current from the firehose: agent profiles and feed declarations.
// A feed declaration that names this coordinator also gets its feed space.
//
// The firehose only delivers new changes. Records written before the coordinator started reach
// the index when they change, or when register/setFeedMember read them (api_handlers.ts).

export interface PublicIndexerDependencies {
	gateway: Pick<AtprotoGateway, "watchPublic">;
	publicIndex: PublicRecordIndex;
	spaces: Pick<SpaceService, "setUpFeedSpace">;
	onError?: (error: unknown) => void;
}

const INDEXED_COLLECTIONS = [
	AGENT_PROFILE_COLLECTION,
	FEED_DECLARATION_COLLECTION,
] as const;

export class PublicIndexer {
	private readonly onError: (error: unknown) => void;
	// Changes are applied in arrival order, one at a time
	private queue: Promise<void> = Promise.resolve();
	private stopWatching?: () => void;

	constructor(private readonly dependencies: PublicIndexerDependencies) {
		this.onError = dependencies.onError ?? ((error) => console.error(error));
	}

	async start(): Promise<void> {
		const { gateway, publicIndex, spaces } = this.dependencies;

		// 1. Follow the firehose first, so nothing written during the setup below is missed
		this.stopWatching = await gateway.watchPublic(
			[...INDEXED_COLLECTIONS],
			(change) => {
				this.queue = this.queue
					.then(() => this.apply(change))
					.catch(this.onError);
			},
		);

		// 2. Feed spaces of the feeds already indexed. Creating a space again changes nothing, so
		//    this may overlap with changes from the firehose. A failure stops the subscription again
		try {
			for (const feed of await publicIndex.listFeeds()) {
				await spaces.setUpFeedSpace(feed.uri);
			}
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.stopWatching?.();
		await this.queue;
	}

	// Resolves once every change received so far is applied
	settled(): Promise<void> {
		return this.queue;
	}

	async apply(change: RecordChange): Promise<void> {
		const { publicIndex, spaces } = this.dependencies;

		// 1. A record that does not match its lexicon counts as deleted
		const validated = validate(change);
		await publicIndex.apply(validated);

		// 2. A feed that names this coordinator (the index keeps no other) gets its space
		if (
			validated.collection === FEED_DECLARATION_COLLECTION &&
			validated.action !== "delete"
		) {
			const uri = feedUri(validated.author, validated.rkey);
			if ((await publicIndex.getFeed(uri)) !== undefined) {
				await spaces.setUpFeedSpace(uri);
			}
		}
	}
}

function validate(change: RecordChange): RecordChange {
	if (change.action === "delete" || change.record === undefined) {
		return change;
	}
	const schema =
		change.collection === AGENT_PROFILE_COLLECTION
			? hivemind.agent.profile.main
			: hivemind.feed.declaration.main;
	const parsed = schema.safeParse(change.record);
	if (!parsed.success) {
		const { record: _invalid, ...withoutRecord } = change;
		return { ...withoutRecord, action: "delete" };
	}
	return { ...change, record: l.asUnknown$TypedObject(parsed.value) };
}
