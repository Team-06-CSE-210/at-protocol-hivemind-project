import { l } from "@atproto/lex";
import * as hivemind from "../../protocol/generated/com/hivemind-network.js";
import type { AtprotoGateway } from "../../protocol/interfaces/internal/atproto_gateway.js";
import type {
	AccessKind,
	CoordinatorApi,
	RegisterInput,
} from "../../protocol/interfaces/internal/coordinator_api.js";
import type {
	CoordinatorStores,
	IndexedFeed,
} from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentProfile,
	AtUri,
	Did,
	FeedMember,
	Registration,
	SpaceRef,
} from "../../protocol/interfaces/internal/types.js";
import {
	feedKeyOf,
	INTAKE_SPACE_KEY,
	parseSpaceRef,
	SPACE_TYPES,
} from "../../protocol/protocol_config/space_definition.js";
import {
	AGENT_PROFILE_COLLECTION,
	FEED_DECLARATION_COLLECTION,
} from "../data/public_records.js";
import {
	decideManagedSpaceAccess,
	type ManagedSpaceAccessQuestion,
} from "../library/access_rules.js";
import type { Clock } from "../library/clock.js";
import {
	checkFeedMemberChange,
	decideRegistration,
} from "../library/registration_rules.js";
import { collectFeedEligibility } from "./access_checks.js";

// The coordinator's answers to the three methods it serves (CoordinatorApi). The caller is already
// verified (xrpc_server.ts or the in-memory network); the decisions are in library/.

export interface ApiHandlerDependencies {
	coordinator: Did;
	stores: CoordinatorStores;
	// Reads public records the index has not seen yet; the firehose only delivers new changes
	gateway: Pick<AtprotoGateway, "getRecord">;
	clock: Clock;
}

// The agent profile's record key (agent/profile.json)
const PROFILE_RKEY = "self";

export class CoordinatorApiHandlers implements CoordinatorApi {
	// Feed space key -> feed declaration URI; filled on demand, since the key is a hash of the URI
	private readonly feedByKey = new Map<string, AtUri>();

	constructor(private readonly dependencies: ApiHandlerDependencies) {}

	// * * * * * * * * * * * * * * * * * *
	// register
	// * * * * * * * * * * * * * * * * * *

	async register(caller: Did, input: RegisterInput): Promise<Registration> {
		const { stores, clock } = this.dependencies;
		const isAgent = input.role === "agent";
		const subject = isAgent ? input.subject : caller;

		// 1. The facts: current registrations and, for an agent, its profile read fresh
		const existing =
			subject === undefined
				? undefined
				: await stores.participants.get(subject);
		const callerRegistration = isAgent
			? await stores.participants.get(caller)
			: undefined;
		const agentProfile =
			isAgent && subject !== undefined
				? await this.readAgentProfile(subject)
				: undefined;

		// 2. The decision; it throws the refusals the lexicon declares
		const registration = decideRegistration({
			caller,
			input,
			existing,
			callerRegistration,
			agentProfile,
			now: l.toDatetimeString(clock.now()),
		});

		// 3. Only a new registration is stored; repeating the call changes nothing
		if (existing === undefined) {
			await stores.participants.put(registration);
		}
		return registration;
	}

	// * * * * * * * * * * * * * * * * * *
	// setFeedMember
	// * * * * * * * * * * * * * * * * * *

	async setFeedMember(caller: Did, input: FeedMember): Promise<void> {
		const { stores } = this.dependencies;
		checkFeedMemberChange({
			caller,
			feed: await this.readFeed(input.feed),
			subjectRegistration: await stores.participants.get(input.subject),
		});
		await stores.feedMembers.set(input);
	}

	// * * * * * * * * * * * * * * * * * *
	// checkUserAccess
	// * * * * * * * * * * * * * * * * * *

	async checkUserAccess(
		space: SpaceRef,
		user: Did,
		access: AccessKind,
	): Promise<boolean> {
		return decideManagedSpaceAccess(
			await this.accessQuestion(space, user, access),
		);
	}

	// Which space is asked about, with the facts its rule needs
	private async accessQuestion(
		space: SpaceRef,
		user: Did,
		access: AccessKind,
	): Promise<ManagedSpaceAccessQuestion> {
		const { coordinator, stores } = this.dependencies;
		const { authority, spaceType, spaceKey } = parseSpaceRef(space);
		if (authority !== coordinator) {
			return { space: "unknown", access };
		}
		const isIntakeKey = spaceKey === INTAKE_SPACE_KEY;
		if (spaceType === SPACE_TYPES.requestIntake && isIntakeKey) {
			return {
				space: "requestIntake",
				access,
				userRegistration: await stores.participants.get(user),
			};
		}
		if (spaceType === SPACE_TYPES.offerIntake && isIntakeKey) {
			const userRegistration = await stores.participants.get(user);
			const operatorRegistration =
				userRegistration?.operator === undefined
					? undefined
					: await stores.participants.get(userRegistration.operator);
			return {
				space: "offerIntake",
				access,
				userRegistration,
				operatorRegistration,
			};
		}
		if (spaceType === SPACE_TYPES.feed) {
			const feed = await this.feedForSpaceKey(spaceKey);
			if (feed !== undefined) {
				return {
					space: "feed",
					access,
					eligibility: await collectFeedEligibility(stores, user, feed),
				};
			}
		}
		return { space: "unknown", access };
	}

	// * * * * * * * * * * * * * * * * * *
	// Public records
	// * * * * * * * * * * * * * * * * * *

	private async feedForSpaceKey(
		spaceKey: string,
	): Promise<IndexedFeed | undefined> {
		const { publicIndex } = this.dependencies.stores;
		const known = this.feedByKey.get(spaceKey);
		if (known !== undefined) {
			return publicIndex.getFeed(known);
		}
		// A feed the map does not know yet: hash every indexed feed once
		for (const feed of await publicIndex.listFeeds()) {
			this.feedByKey.set(await feedKeyOf(feed.uri), feed.uri);
		}
		const found = this.feedByKey.get(spaceKey);
		return found === undefined ? undefined : publicIndex.getFeed(found);
	}

	// The agent's profile straight from its repo, so a registration never waits for the firehose;
	// the index is updated on the way
	private async readAgentProfile(
		agent: Did,
	): Promise<AgentProfile | undefined> {
		const { gateway, stores } = this.dependencies;
		const record = await gateway.getRecord(
			`at://${agent}/${AGENT_PROFILE_COLLECTION}/${PROFILE_RKEY}`,
		);
		const parsed = hivemind.agent.profile.main.safeParse(record);
		if (!parsed.success) {
			return stores.publicIndex.getAgentProfile(agent);
		}
		await stores.publicIndex.apply({
			action: "update",
			author: agent,
			collection: AGENT_PROFILE_COLLECTION,
			rkey: PROFILE_RKEY,
			record: l.asUnknown$TypedObject(parsed.value),
		});
		return parsed.value;
	}

	// A feed from the index, or from its owner's repo if the index has not seen it
	private async readFeed(feed: AtUri): Promise<IndexedFeed | undefined> {
		const { gateway, stores } = this.dependencies;
		const indexed = await stores.publicIndex.getFeed(feed);
		if (indexed !== undefined) {
			return indexed;
		}
		const [owner, collection, rkey] = feed.replace("at://", "").split("/");
		if (collection !== FEED_DECLARATION_COLLECTION || rkey === undefined) {
			return undefined;
		}
		const parsed = hivemind.feed.declaration.main.safeParse(
			await gateway.getRecord(feed),
		);
		if (!parsed.success) {
			return undefined;
		}
		await stores.publicIndex.apply({
			action: "update",
			author: owner as Did,
			collection: FEED_DECLARATION_COLLECTION,
			rkey,
			record: l.asUnknown$TypedObject(parsed.value),
		});
		// The index keeps only feeds that name this coordinator
		return stores.publicIndex.getFeed(feed);
	}
}
