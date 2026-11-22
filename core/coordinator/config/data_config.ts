// Where the coordinator keeps its data.
// Used by: data/sqlite_stores.ts

export interface DataConfig {
	// SQLite file of the coordinator's database, relative to the working directory;
	// ":memory:" keeps everything in memory
	readonly databasePath: string;
}

export const DEFAULT_DATA_CONFIG: DataConfig = {
	databasePath: "data/coordinator.sqlite",
};
