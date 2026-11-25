import type { OrganizationClientOptions } from "../core/protocol/interfaces/internal/client_lib.js";
import type {
	Did,
	Registration,
} from "../core/protocol/interfaces/internal/types.js";

const REGISTER_PROCEDURE = "com.hivemind-network.coordinator.register";

export class HivemindOrganization {
	constructor(private readonly options: OrganizationClientOptions) {}

	async registerAsOperator(): Promise<Registration> {
		const { gateway, coordinator } = this.options;
		const registration = await gateway.callProcedure(
			coordinator,
			REGISTER_PROCEDURE,
			{ role: "operator" },
		);
		return registration as Registration;
	}

	// The agent's public profile must already name this operator.
	async enrollAgent(agent: Did): Promise<Registration> {
		const { gateway, coordinator } = this.options;
		const registration = await gateway.callProcedure(
			coordinator,
			REGISTER_PROCEDURE,
			{ role: "agent", subject: agent },
		);
		return registration as Registration;
	}
}
