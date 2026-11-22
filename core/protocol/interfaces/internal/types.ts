/*
 * Readable names for the message types every internal interface uses.
 *
 * Nothing is defined here: each type comes from the lexicons in type_definition/msg_types and
 * interfaces/external, generated into core/protocol/generated/ by `lex build`. Change the lexicon,
 * rebuild, and these follow.
 */
import type { l } from "@atproto/lex";
import type * as hivemind from "../../generated/com/hivemind-network.js";
import type { internal } from "../../generated/index.js";

// Identifiers and addresses
export type Did = l.DidString;
export type AtUri = l.AtUriString;
export type Nsid = l.NsidString;
export type Datetime = l.DatetimeString;
export type TaskId = hivemind.defs.TaskId;
/** Space address: at://{authority DID}/space/{space type NSID}/{space key}. */
export type SpaceRef = `at://${string}/space/${string}/${string}`;
/** Any record or payload, identified by its $type. Payload slots in the general records have this type. */
export type TypedObject = l.Unknown$TypedObject;

// Shared types (com.hivemind-network.defs)
export type GeoPoint = hivemind.defs.GeoPoint;
export type GeoCircle = hivemind.defs.GeoCircle;
export type GeoPolygon = hivemind.defs.GeoPolygon;
export type Money = hivemind.defs.Money;
export type Attestation = hivemind.defs.Attestation;

// General records
export type RequesterRequest = hivemind.requester.request.Main;
export type RequesterSelection = hivemind.requester.selection.Main;
export type AgentProfile = hivemind.agent.profile.Main;
export type AgentOffer = hivemind.agent.offer.Main;
export type AgentSnapshot = hivemind.agent.offer.AgentSnapshot;
export type AgentProgress = hivemind.agent.progress.Main;
export type Dispatch = hivemind.coordinator.dispatch.Main;
export type TaskState = hivemind.coordinator.taskState.Main;
export type OfferOption = hivemind.coordinator.taskState.OfferOption;
export type Assignment = hivemind.coordinator.assignment.Main;
export type FeedDeclaration = hivemind.feed.declaration.Main;

// Coordinator types
export type Registration = hivemind.coordinator.defs.Registration;
export type FeedMember = hivemind.coordinator.defs.FeedMember;
export type ScoringCriterion =
	internal.hivemind.coordinator.defs.ScoringCriterion;
export type FeatureValue = internal.hivemind.coordinator.defs.FeatureValue;
export type RankCandidate = internal.hivemind.coordinator.defs.RankCandidate;
export type RankedOption = internal.hivemind.coordinator.defs.RankedOption;

/** A record as the caller fills it in: the SDK adds $type and createdAt. */
export type Draft<RecordType> = Omit<RecordType, "$type" | "createdAt">;
