import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { jsonToLex, lexToJson } from "@atproto/lexicon";
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
import type { DataConfig } from "../config/data_config.js";
import { END_PHASES } from "../library/task_rules.js";
import { classifyPublicChange } from "./public_records.js";
import { COORDINATOR_SCHEMA } from "./schema.js";

// The coordinator's stores in a SQLite file (node:sqlite, built into Node.js 22.13 and later).
// node:sqlite is synchronous; the methods stay async because the store interfaces are.

export interface SqliteCoordinatorStores extends CoordinatorStores {
	close(): void;
}

const IN_MEMORY_DATABASE = ":memory:";

export function openSqliteStores(
	config: DataConfig,
	coordinator: Did,
): SqliteCoordinatorStores {
	// 1. Open the file, creating its folder on first start, and apply the schema
	const { databasePath } = config;
	if (databasePath !== IN_MEMORY_DATABASE) {
		mkdirSync(dirname(databasePath), { recursive: true });
	}
	const database = new DatabaseSync(databasePath);
	database.exec(COORDINATOR_SCHEMA);

	// 2. One store per interface, all on the same connection
	return {
		participants: new SqliteParticipantStore(database),
		feedMembers: new SqliteFeedMemberStore(database),
		tasks: new SqliteTaskStore(database),
		publicIndex: new SqlitePublicRecordIndex(database, coordinator),
		revisions: new SqliteRevisionStore(database),
		billing: new SqliteBillingStore(database),
		close: () => database.close(),
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// JSON columns
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

type LexValue = Parameters<typeof lexToJson>[0];
type Row = Record<string, SQLInputValue>;

// lexToJson turns bytes and CIDs into their JSON form ({"$bytes": ...}), jsonToLex back
function toJsonText(value: unknown): string {
	return JSON.stringify(lexToJson(value as LexValue));
}

function fromJsonText<Value>(text: SQLInputValue): Value {
	return jsonToLex(JSON.parse(String(text))) as Value;
}

// Runs `steps` as one transaction, so a task and its record links never disagree
function inTransaction(database: DatabaseSync, steps: () => void): void {
	database.exec("BEGIN");
	try {
		steps();
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Participants and allowlists
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class SqliteParticipantStore implements ParticipantStore {
	constructor(private readonly database: DatabaseSync) {}

	async get(subject: Did): Promise<Registration | undefined> {
		const row = this.database
			.prepare("SELECT registration FROM participants WHERE subject = ?")
			.get(subject) as Row | undefined;
		return row === undefined ? undefined : fromJsonText(row.registration);
	}

	async put(registration: Registration): Promise<void> {
		this.database
			.prepare(
				`INSERT INTO participants (subject, operator, registration) VALUES (?, ?, ?)
				ON CONFLICT (subject) DO UPDATE SET operator = excluded.operator, registration = excluded.registration`,
			)
			.run(
				registration.subject,
				registration.operator ?? null,
				toJsonText(registration),
			);
	}

	async listByOperator(operator: Did): Promise<Registration[]> {
		const rows = this.database
			.prepare(
				"SELECT registration FROM participants WHERE operator = ? ORDER BY subject",
			)
			.all(operator) as Row[];
		return rows.map((row) => fromJsonText<Registration>(row.registration));
	}
}

class SqliteFeedMemberStore implements FeedMemberStore {
	constructor(private readonly database: DatabaseSync) {}

	// Only allowed entries are kept; removing one deletes its row
	async set({ feed, subject, allowed }: FeedMember): Promise<void> {
		const statement = allowed
			? "INSERT OR IGNORE INTO feed_members (feed, subject) VALUES (?, ?)"
			: "DELETE FROM feed_members WHERE feed = ? AND subject = ?";
		this.database.prepare(statement).run(feed, subject);
	}

	async isAllowed(feed: AtUri, subject: Did): Promise<boolean> {
		const row = this.database
			.prepare("SELECT 1 FROM feed_members WHERE feed = ? AND subject = ?")
			.get(feed, subject);
		return row !== undefined;
	}

	async list(feed: AtUri): Promise<FeedMember[]> {
		const rows = this.database
			.prepare(
				"SELECT subject FROM feed_members WHERE feed = ? ORDER BY subject",
			)
			.all(feed) as Row[];
		return rows.map((row) => ({
			feed,
			subject: String(row.subject) as Did,
			allowed: true,
		}));
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Tasks
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class SqliteTaskStore implements TaskStore {
	constructor(private readonly database: DatabaseSync) {}

	async get(taskId: TaskId): Promise<TaskRecord | undefined> {
		const row = this.database
			.prepare("SELECT task FROM tasks WHERE task_id = ?")
			.get(taskId) as Row | undefined;
		return row === undefined ? undefined : fromJsonText(row.task);
	}

	async findByRecord(
		author: Did,
		collection: Nsid,
		rkey: string,
	): Promise<TaskRecord | undefined> {
		const row = this.database
			.prepare(
				`SELECT tasks.task FROM task_records JOIN tasks USING (task_id)
				WHERE author = ? AND collection = ? AND rkey = ?`,
			)
			.get(author, collection, rkey) as Row | undefined;
		return row === undefined ? undefined : fromJsonText(row.task);
	}

	async put(task: TaskRecord): Promise<void> {
		const { taskId, requester, requestRkey, request, offers, state } = task;
		inTransaction(this.database, () => {
			// 1. The task itself; its phase is kept apart to find open tasks
			this.database
				.prepare(
					`INSERT INTO tasks (task_id, phase, task) VALUES (?, ?, ?)
					ON CONFLICT (task_id) DO UPDATE SET phase = excluded.phase, task = excluded.task`,
				)
				.run(taskId, state.phase, toJsonText(task));

			// 2. Its request and offer records, replaced with the ones it has now
			this.database
				.prepare("DELETE FROM task_records WHERE task_id = ?")
				.run(taskId);
			const link = this.database.prepare(
				"INSERT OR REPLACE INTO task_records (author, collection, rkey, task_id) VALUES (?, ?, ?, ?)",
			);
			link.run(requester, request.$type, requestRkey, taskId);
			for (const { agent, rkey, offer } of offers) {
				link.run(agent, offer.$type, rkey, taskId);
			}
		});
	}

	// Not in an end phase, or with writes still owed. A record without the published field (stored
	// before it existed) has NULL there and counts as published.
	async listOpen(): Promise<TaskRecord[]> {
		const endPhases = [...END_PHASES];
		const rows = this.database
			.prepare(
				`SELECT task FROM tasks
				WHERE phase NOT IN (${endPhases.map(() => "?").join(", ")})
					OR json_extract(task, '$.published') = 0
				ORDER BY task_id`,
			)
			.all(...endPhases) as Row[];
		return rows.map((row) => fromJsonText<TaskRecord>(row.task));
	}
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Public records
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class SqlitePublicRecordIndex implements PublicRecordIndex {
	constructor(
		private readonly database: DatabaseSync,
		private readonly coordinator: Did,
	) {}

	async apply(change: RecordChange): Promise<void> {
		const update = classifyPublicChange(change, this.coordinator);
		if (update.kind === "profile") {
			const { agent, profile } = update;
			inTransaction(this.database, () => this.replaceProfile(agent, profile));
		}
		if (update.kind === "feed") {
			const { uri, owner, declaration } = update;
			if (declaration === undefined) {
				this.database.prepare("DELETE FROM feeds WHERE uri = ?").run(uri);
			} else {
				this.database
					.prepare(
						`INSERT INTO feeds (uri, owner, declaration) VALUES (?, ?, ?)
						ON CONFLICT (uri) DO UPDATE SET owner = excluded.owner, declaration = excluded.declaration`,
					)
					.run(uri, owner, toJsonText(declaration));
			}
		}
	}

	// The profile and the feeds it lists change together
	private replaceProfile(agent: Did, profile: AgentProfile | undefined): void {
		this.database
			.prepare("DELETE FROM agent_profiles WHERE agent = ?")
			.run(agent);
		this.database.prepare("DELETE FROM agent_feeds WHERE agent = ?").run(agent);
		if (profile === undefined) {
			return;
		}
		this.database
			.prepare("INSERT INTO agent_profiles (agent, profile) VALUES (?, ?)")
			.run(agent, toJsonText(profile));
		const listFeed = this.database.prepare(
			"INSERT OR IGNORE INTO agent_feeds (agent, feed) VALUES (?, ?)",
		);
		for (const feed of profile.feeds ?? []) {
			listFeed.run(agent, feed);
		}
	}

	async getAgentProfile(agent: Did): Promise<AgentProfile | undefined> {
		const row = this.database
			.prepare("SELECT profile FROM agent_profiles WHERE agent = ?")
			.get(agent) as Row | undefined;
		return row === undefined ? undefined : fromJsonText(row.profile);
	}

	async getFeed(feed: AtUri): Promise<IndexedFeed | undefined> {
		const row = this.database
			.prepare("SELECT uri, owner, declaration FROM feeds WHERE uri = ?")
			.get(feed) as Row | undefined;
		return row === undefined ? undefined : toIndexedFeed(row);
	}

	async listFeeds(): Promise<IndexedFeed[]> {
		const rows = this.database
			.prepare("SELECT uri, owner, declaration FROM feeds ORDER BY uri")
			.all() as Row[];
		return rows.map(toIndexedFeed);
	}

	async listAgentsServing(feed: AtUri): Promise<Did[]> {
		const rows = this.database
			.prepare("SELECT agent FROM agent_feeds WHERE feed = ? ORDER BY agent")
			.all(feed) as Row[];
		return rows.map((row) => String(row.agent) as Did);
	}
}

function toIndexedFeed(row: Row): IndexedFeed {
	return {
		uri: String(row.uri) as AtUri,
		owner: String(row.owner) as Did,
		declaration: fromJsonText(row.declaration),
	};
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Sync positions and billing
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

class SqliteRevisionStore implements RevisionStore {
	constructor(private readonly database: DatabaseSync) {}

	async get(space: SpaceRef, writer: Did): Promise<string | undefined> {
		const row = this.database
			.prepare(
				"SELECT revision FROM sync_cursors WHERE space = ? AND writer = ?",
			)
			.get(space, writer) as Row | undefined;
		return row === undefined ? undefined : String(row.revision);
	}

	async set(space: SpaceRef, writer: Did, revision: string): Promise<void> {
		this.database
			.prepare(
				`INSERT INTO sync_cursors (space, writer, revision) VALUES (?, ?, ?)
				ON CONFLICT (space, writer) DO UPDATE SET revision = excluded.revision`,
			)
			.run(space, writer, revision);
	}
}

class SqliteBillingStore implements BillingStore {
	constructor(private readonly database: DatabaseSync) {}

	async recordAssignment(
		taskId: TaskId,
		agent: Did,
		month: string,
	): Promise<void> {
		this.database
			.prepare(
				`INSERT INTO billing_assignments (task_id, agent, month) VALUES (?, ?, ?)
				ON CONFLICT (task_id) DO NOTHING`,
			)
			.run(taskId, agent, month);
	}

	async countAssignments(agent: Did, month: string): Promise<number> {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS assignments FROM billing_assignments WHERE agent = ? AND month = ?",
			)
			.get(agent, month) as Row;
		return Number(row.assignments);
	}
}
