import { network as lexicons } from "../protocol/generated/index.js";
import { lexiconOfferValidation } from "../protocol/offer_validation.ts";
import { runOfferRoutingWalkthrough } from "./offer_routing_walkthrough.ts";

await runOfferRoutingWalkthrough({
	validation: lexiconOfferValidation,
	validationLabel: "generated AT Protocol Lexicon validators",
	validatePayload: (payload, request) => {
		const ride = lexicons.hivemind.mobility.ride.request.$validate(request);
		const terms = lexicons.hivemind.mobility.ride.offer.$validate(payload);
		if (terms.vehicle.seats < ride.passengers) {
			throw new Error("Offer has insufficient seats");
		}
	},
});
