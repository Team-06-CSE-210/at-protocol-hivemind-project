import type { RecordChange } from "../../protocol/interfaces/internal/atproto_gateway.js";
import type {
	BillingStore,
	CoordinatorStores,
	FeedMemberStore,
	IndexedFeed,
	ParticipantStore,
	PublicRecordIndex,
	RevisionStore,
	TaskRecord,
	TaskStore,
} from "../../protocol/interfaces/internal/stores.js";
import type {
	AgentProfile,
	AtUri,
	Did,
	FeedMember,
	Nsid,
	Registration,
	SpaceRef,
	TaskId,
} from "../../protocol/interfaces/internal/types.js";
import { isEndPhase } from "../library/task_rules.js";
import { classifyPublicChange } from "./public_records.js";

// The coordinator's stores in memory, for tests and the in-memory demo. Same behavior as
// sqlite_stores.ts (tests/coordinator/data/ runs one contract against both). Every value is
// copied in and out, so callers never share an object with the store.

export function createMemoryStores(coordinator: Did): CoordinatorStores {
	return {
		participants: new MemoryParticipantStore(),
		feedMembers: new MemoryFeedMemberStore(),
		tasks: new MemoryTaskStore(),
		publicIndex: new MemoryPublicRecordIndex(coordinator),
		revisions: new MemoryRevisionStore(),
		billing: new MemoryBillingStore(),
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Participants and allowlists
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class MemoryParticipantStore implements ParticipantStore {
	private readonly registrations = new Map<Did, Registration>();

	async get(subject: Did): Promise<Registration | undefined> {
		const registration = this.registrations.get(subject);
		return registration === undefined
			? undefined
			: structuredClone(registration);
	}

	async put(registration: Registration): Promise<void> {
		this.registrations.set(registration.subject, structuredClone(registration));
	}

	async listByOperator(operator: Did): Promise<Registration[]> {
		return [...this.registrations.values()]
			.filter((registration) => registration.operator === operator)
			.map((registration) => structuredClone(registration));
	}
}

class MemoryFeedMemberStore implements FeedMemberStore {
	// Allowed subjects per feed; removing an entry deletes it
	private readonly allowedByFeed = new Map<AtUri, Set<Did>>();

	async set({ feed, subject, allowed }: FeedMember): Promise<void> {
		const allowedSubjects = this.allowedByFeed.get(feed) ?? new Set<Did>();
		if (allowed) {
			allowedSubjects.add(subject);
		} else {
			allowedSubjects.delete(subject);
		}
		this.allowedByFeed.set(feed, allowedSubjects);
	}

	async isAllowed(feed: AtUri, subject: Did): Promise<boolean> {
		return this.allowedByFeed.get(feed)?.has(subject) ?? false;
	}

	async list(feed: AtUri): Promise<FeedMember[]> {
		const allowedSubjects = [...(this.allowedByFeed.get(feed) ?? [])].sort();
		return allowedSubjects.map((subject) => ({ feed, subject, allowed: true }));
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Tasks
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class MemoryTaskStore implements TaskStore {
	private readonly tasks = new Map<TaskId, TaskRecord>();
	// "author collection rkey" of a request or offer -> its task
	private readonly taskByRecord = new Map<string, TaskId>();

	async get(taskId: TaskId): Promise<TaskRecord | undefined> {
		const task = this.tasks.get(taskId);
		return task === undefined ? undefined : structuredClone(task);
	}

	async findByRecord(
		author: Did,
		collection: Nsid,
		rkey: string,
	): Promise<TaskRecord | undefined> {
		const taskId = this.taskByRecord.get(recordKey(author, collection, rkey));
		return taskId === undefined ? undefined : this.get(taskId);
	}

	async put(task: TaskRecord): Promise<void> {
		this.tasks.set(task.taskId, structuredClone(task));
		// Replace the task's record links with the ones it has now
		for (const [key, taskId] of this.taskByRecord) {
			if (taskId === task.taskId) {
				this.taskByRecord.delete(key);
			}
		}
		for (const key of recordKeysOf(task)) {
			this.taskByRecord.set(key, task.taskId);
		}
	}

	async listOpen(): Promise<TaskRecord[]> {
		return [...this.tasks.values()]
			.filter((task) => !isEndPhase(task.state.phase))
			.map((task) => structuredClone(task));
	}
}

function recordKey(author: Did, collection: Nsid, rkey: string): string {
	return `${author} ${collection} ${rkey}`;
}

function recordKeysOf(task: TaskRecord): string[] {
	return [
		recordKey(task.requester, task.request.$type, task.requestRkey),
		...task.offers.map(({ agent, rkey, offer }) =>
			recordKey(agent, offer.$type, rkey),
		),
	];
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Public records
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class MemoryPublicRecordIndex implements PublicRecordIndex {
	private readonly profiles = new Map<Did, AgentProfile>();
	// Only feeds whose declaration names this coordinator
	private readonly feeds = new Map<AtUri, IndexedFeed>();

	constructor(private readonly coordinator: Did) {}

	async apply(change: RecordChange): Promise<void> {
		const update = classifyPublicChange(change, this.coordinator);
		if (update.kind === "profile") {
			const { agent, profile } = update;
			if (profile === undefined) {
				this.profiles.delete(agent);
			} else {
				this.profiles.set(agent, structuredClone(profile));
			}
		}
		if (update.kind === "feed") {
			const { uri, owner, declaration } = update;
			if (declaration === undefined) {
				this.feeds.delete(uri);
			} else {
				this.feeds.set(uri, structuredClone({ uri, owner, declaration }));
			}
		}
	}

	async getAgentProfile(agent: Did): Promise<AgentProfile | undefined> {
		const profile = this.profiles.get(agent);
		return profile === undefined ? undefined : structuredClone(profile);
	}

	async getFeed(feed: AtUri): Promise<IndexedFeed | undefined> {
		const indexedFeed = this.feeds.get(feed);
		return indexedFeed === undefined ? undefined : structuredClone(indexedFeed);
	}

	async listFeeds(): Promise<IndexedFeed[]> {
		return [...this.feeds.values()]
			.sort((first, second) => first.uri.localeCompare(second.uri))
			.map((indexedFeed) => structuredClone(indexedFeed));
	}

	async listAgentsServing(feed: AtUri): Promise<Did[]> {
		return [...this.profiles.entries()]
			.filter(([, profile]) => (profile.feeds ?? []).includes(feed))
			.map(([agent]) => agent)
			.sort();
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Sync positions and billing
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class MemoryRevisionStore implements RevisionStore {
	private readonly revisions = new Map<string, string>();

	async get(space: SpaceRef, writer: Did): Promise<string | undefined> {
		return this.revisions.get(`${space} ${writer}`);
	}

	async set(space: SpaceRef, writer: Did, revision: string): Promise<void> {
		this.revisions.set(`${space} ${writer}`, revision);
	}
}

class MemoryBillingStore implements BillingStore {
	private readonly assignments = new Map<string, number>();

	async addAssignment(agent: Did, month: string): Promise<number> {
		const count = (this.assignments.get(`${agent} ${month}`) ?? 0) + 1;
		this.assignments.set(`${agent} ${month}`, count);
		return count;
	}

	async countAssignments(agent: Did, month: string): Promise<number> {
		return this.assignments.get(`${agent} ${month}`) ?? 0;
	}
}
