import { fixtureValidation } from "../tests/support/offer_fixtures.ts";
import { runOfferRoutingWalkthrough } from "./offer_routing_walkthrough.ts";

await runOfferRoutingWalkthrough({
	validation: fixtureValidation,
	validationLabel: "small test validators (not generated AT Protocol validators)",
	validatePayload: (payload) => {
		if (payload.$type !== "network.hivemind.mobility.ride#offer") {
			throw new Error("Unexpected sample payload type");
		}
	},
});
