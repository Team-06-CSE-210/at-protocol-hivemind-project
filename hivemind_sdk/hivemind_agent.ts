import { l } from "@atproto/lex";
import * as hivemind from "../core/protocol/generated/com/hivemind-network.js";
import type { AgentClientOptions } from "../core/protocol/interfaces/internal/client_lib.js";

export class HivemindAgent {
	constructor(private readonly options: AgentClientOptions) {}

	async start(): Promise<void> {
		const { gateway, profile } = this.options;
		const collection = hivemind.agent.profile.$nsid;
		const record = hivemind.agent.profile.main.parse({
			...profile,
			$type: collection,
			createdAt: l.toDatetimeString(new Date()),
		});

		await gateway.putRecord(
			collection,
			"self",
			l.asUnknown$TypedObject(record),
		);
	}
}
