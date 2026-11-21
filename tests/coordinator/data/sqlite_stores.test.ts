import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteStores } from "../../../core/coordinator/data/sqlite_stores.js";
import { COORDINATOR, RIDER, registration } from "../fixtures.js";
import { runStoresContract } from "./stores_contract.js";

runStoresContract("SQLite stores", () =>
	openSqliteStores({ databasePath: ":memory:" }, COORDINATOR),
);

test("SQLite stores: data survives closing and reopening the file", async () => {
	const folder = await mkdtemp(path.join(tmpdir(), "hivemind-"));
	const config = {
		databasePath: path.join(folder, "nested", "coordinator.sqlite"),
	};
	try {
		const first = openSqliteStores(config, COORDINATOR);
		await first.participants.put(registration(RIDER, "requester"));
		first.close();

		const second = openSqliteStores(config, COORDINATOR);
		assert.equal((await second.participants.get(RIDER))?.role, "requester");
		second.close();
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});
