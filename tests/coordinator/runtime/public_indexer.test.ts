import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryStores } from "../../../core/coordinator/data/memory_stores.js";
import { PublicIndexer } from "../../../core/coordinator/runtime/public_indexer.js";
import type { RecordChange } from "../../../core/protocol/interfaces/internal/atproto_gateway.js";
import type {
	AtUri,
	SpaceRef,
} from "../../../core/protocol/interfaces/internal/types.js";
import {
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	FakeSpaceService,
	FEED_OWNER,
	feedDeclaration,
} from "../fixtures.js";

// Starting the public-record index: the firehose is followed before the feed spaces are set up,
// so a change made in between is not lost.

const LATER_FEED =
	`at://${FEED_OWNER}/com.hivemind-network.feed.declaration/later` as AtUri;

// A firehose the test writes into, counting open subscriptions
function fakeFirehose() {
	const firehose = {
		open: 0,
		push: undefined as ((change: RecordChange) => void) | undefined,
		watchPublic: async (
			_collections: unknown,
			onChange: (change: RecordChange) => void,
		) => {
			firehose.open += 1;
			firehose.push = onChange;
			return () => {
				firehose.open -= 1;
			};
		},
	};
	return firehose;
}

describe("public indexer: start", () => {
	test("a feed declared while feed spaces are set up is not missed", async () => {
		const stores = createMemoryStores(COORDINATOR);
		await stores.publicIndex.apply(
			created(FEED_OWNER, "downtown", feedDeclaration()),
		);
		const firehose = fakeFirehose();
		const spaces = new FakeSpaceService();
		// While the existing feed's space is set up, another feed is declared
		const setUpFeedSpace = spaces.setUpFeedSpace.bind(spaces);
		spaces.setUpFeedSpace = async (feed: AtUri): Promise<SpaceRef> => {
			if (feed === DOWNTOWN_FEED) {
				firehose.push?.(created(FEED_OWNER, "later", feedDeclaration()));
			}
			return setUpFeedSpace(feed);
		};
		const indexer = new PublicIndexer({
			gateway: firehose,
			publicIndex: stores.publicIndex,
			spaces,
		});

		await indexer.start();
		await indexer.settled();
		assert.ok(await stores.publicIndex.getFeed(LATER_FEED));
		assert.ok(spaces.feedSpaces.has(DOWNTOWN_FEED));
		assert.ok(spaces.feedSpaces.has(LATER_FEED));
		await indexer.stop();
		assert.equal(firehose.open, 0);
	});

	test("a feed space that cannot be set up fails the start and closes the subscription", async () => {
		const stores = createMemoryStores(COORDINATOR);
		await stores.publicIndex.apply(
			created(FEED_OWNER, "downtown", feedDeclaration()),
		);
		const firehose = fakeFirehose();
		const spaces = new FakeSpaceService();
		spaces.setUpFeedSpace = async () => {
			throw new Error("space host unreachable");
		};
		const indexer = new PublicIndexer({
			gateway: firehose,
			publicIndex: stores.publicIndex,
			spaces,
		});

		await assert.rejects(indexer.start(), /space host unreachable/);
		assert.equal(firehose.open, 0);
	});
});
