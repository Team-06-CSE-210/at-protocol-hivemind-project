// Tables of the coordinator's SQLite database. Kept as a string in a .ts file because the build
// (tsc) only copies .ts output into dist/. Every statement is idempotent, so opening an existing
// database applies nothing twice.
// Used by: sqlite_stores.ts
//
// Records are stored as JSON (lexToJson), so bytes such as attestation signatures survive.
// Columns next to the JSON exist only to look rows up.

export const COORDINATOR_SCHEMA = `
-- Registrations (ParticipantStore)
CREATE TABLE IF NOT EXISTS participants (
	subject TEXT PRIMARY KEY,
	operator TEXT,
	registration TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS participants_by_operator ON participants (operator);

-- Private feed allowlists (FeedMemberStore); only allowed entries are kept
CREATE TABLE IF NOT EXISTS feed_members (
	feed TEXT NOT NULL,
	subject TEXT NOT NULL,
	PRIMARY KEY (feed, subject)
);

-- Tasks (TaskStore) and the request and offer records that belong to them
CREATE TABLE IF NOT EXISTS tasks (
	task_id TEXT PRIMARY KEY,
	phase TEXT NOT NULL,
	task TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_records (
	author TEXT NOT NULL,
	collection TEXT NOT NULL,
	rkey TEXT NOT NULL,
	task_id TEXT NOT NULL,
	PRIMARY KEY (author, collection, rkey)
);
CREATE INDEX IF NOT EXISTS task_records_by_task ON task_records (task_id);

-- Public records (PublicRecordIndex)
CREATE TABLE IF NOT EXISTS agent_profiles (
	agent TEXT PRIMARY KEY,
	profile TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_feeds (
	agent TEXT NOT NULL,
	feed TEXT NOT NULL,
	PRIMARY KEY (agent, feed)
);
CREATE INDEX IF NOT EXISTS agent_feeds_by_feed ON agent_feeds (feed);
CREATE TABLE IF NOT EXISTS feeds (
	uri TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	declaration TEXT NOT NULL
);

-- Space sync positions (RevisionStore)
CREATE TABLE IF NOT EXISTS sync_cursors (
	space TEXT NOT NULL,
	writer TEXT NOT NULL,
	revision TEXT NOT NULL,
	PRIMARY KEY (space, writer)
);

-- Assignments per agent and month (BillingStore)
CREATE TABLE IF NOT EXISTS billing_usage (
	agent TEXT NOT NULL,
	month TEXT NOT NULL,
	assignments INTEGER NOT NULL,
	PRIMARY KEY (agent, month)
);
`;
