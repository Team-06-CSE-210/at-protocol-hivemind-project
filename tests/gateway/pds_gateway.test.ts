import { AtpAgent } from "@atproto/api";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { IdResolver } from "@atproto/identity";
import {
	PdsGateway,
	PdsSpaceAuthority,
} from "../../protocol/communication/at_gateway_pds.js";
import { runGatewayContract } from "./gateway_contract.js";

// The same contract against a real PDS and PLC directory, started in this process by
// @atproto/dev-env (both on the frozen Spaces alpha). Takes about half a minute.

// Polling fast keeps the test short; the default is 2 s
const POLL_INTERVAL_MS = 100;

runGatewayContract("PDS (frozen Spaces alpha)", async () => {
	const network = await TestNetworkNoAppView.create({});
	const didResolver = new IdResolver({ plcUrl: network.plc.url });
	const backgroundErrors: unknown[] = [];

	// Each account logs in with a password, as the demo's accounts do
	async function login(name: string): Promise<AtpAgent> {
		const agent = new AtpAgent({ service: network.pds.url });
		await agent.createAccount({
			handle: `${name}.test`,
			email: `${name}@test.invalid`,
			password: "password",
		});
		return agent;
	}
	function gatewayFor(agent: AtpAgent): PdsGateway {
		return new PdsGateway({
			agent,
			didResolver,
			// The PDS serves its own firehose (com.atproto.sync.subscribeRepos)
			firehoseService: network.pds.url.replace(/^http/, "ws"),
			pollIntervalMs: POLL_INTERVAL_MS,
			onError: (error) => {
				backgroundErrors.push(error);
				console.error("Background error:", error);
			},
		});
	}

	const coordinatorAgent = await login("coordinator");
	return {
		coordinator: {
			gateway: gatewayFor(coordinatorAgent),
			authority: new PdsSpaceAuthority(coordinatorAgent),
		},
		rider: gatewayFor(await login("rider")),
		taxi: gatewayFor(await login("taxi")),
		// A few poll rounds
		settle: () =>
			new Promise((resolve) => setTimeout(resolve, 4 * POLL_INTERVAL_MS)),
		close: async () => {
			await network.close();
			if (backgroundErrors.length > 0) {
				throw new AggregateError(backgroundErrors, "Errors while polling");
			}
		},
	};
});
