// How the running coordinator talks to the network.
// Used by: main.ts

export interface RuntimeConfig {
	// How often followed spaces are checked for new records
	readonly spacePollIntervalMs: number;
	// WebSocket URL of the relay (or PDS) whose firehose feeds the public-record index
	readonly firehoseUrl: string;
	// Port of the coordinator's XRPC server
	readonly xrpcPort: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	spacePollIntervalMs: 2_000,
	firehoseUrl: "wss://bsky.network",
	xrpcPort: 2_590,
};
