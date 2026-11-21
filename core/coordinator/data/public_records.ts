import type { RecordChange } from "../../protocol/interfaces/internal/atproto_gateway.js";
import type {
	AgentProfile,
	AtUri,
	Did,
	FeedDeclaration,
} from "../../protocol/interfaces/internal/types.js";

// What both store implementations need to file a public record change: which kind of record it
// is and under which key. Keeps memory_stores.ts and sqlite_stores.ts deciding the same way.

export const AGENT_PROFILE_COLLECTION = "com.hivemind-network.agent.profile";
export const FEED_DECLARATION_COLLECTION =
	"com.hivemind-network.feed.declaration";

// An agent profile lives at record key self (agent/profile.json)
const PROFILE_RKEY = "self";

export type PublicRecordUpdate =
	| { kind: "profile"; agent: Did; profile: AgentProfile | undefined }
	| {
			kind: "feed";
			uri: AtUri;
			owner: Did;
			// Undefined: deleted, or the declaration no longer names this coordinator
			declaration: FeedDeclaration | undefined;
	  }
	| { kind: "ignored" };

export function feedUri(owner: Did, rkey: string): AtUri {
	return `at://${owner}/${FEED_DECLARATION_COLLECTION}/${rkey}`;
}

// The record arrives already validated (runtime/public_indexer.ts)
export function classifyPublicChange(
	change: RecordChange,
	coordinator: Did,
): PublicRecordUpdate {
	const { action, author, collection, rkey, record } = change;
	const deleted = action === "delete" || record === undefined;
	if (collection === AGENT_PROFILE_COLLECTION && rkey === PROFILE_RKEY) {
		return {
			kind: "profile",
			agent: author,
			profile: deleted ? undefined : (record as unknown as AgentProfile),
		};
	}
	if (collection === FEED_DECLARATION_COLLECTION) {
		const declaration = deleted
			? undefined
			: (record as unknown as FeedDeclaration);
		return {
			kind: "feed",
			uri: feedUri(author, rkey),
			owner: author,
			declaration:
				declaration?.coordinator === coordinator ? declaration : undefined,
		};
	}
	return { kind: "ignored" };
}
