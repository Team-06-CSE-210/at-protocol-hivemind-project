/*
 * Readable names for the message types every internal interface uses.
 *
 * Nothing is defined here: each type comes from the lexicons in type_definition/msg_types and
 * interfaces/external, generated into protocol/generated/ by `lex build`. Change the lexicon,
 * rebuild, and these follow.
 */
import type { l } from '@atproto/lex'
import type { internal, network } from '../../generated/index.js'

// Identifiers and addresses
export type Did = l.DidString
export type AtUri = l.AtUriString
export type Nsid = l.NsidString
export type Datetime = l.DatetimeString
export type TaskId = network.hivemind.defs.TaskId
/** Space address: at://{authority DID}/space/{space type NSID}/{space key}. */
export type SpaceRef = `at://${string}/space/${string}/${string}`
/** Any record or payload, identified by its $type. Payload slots in the general records have this type. */
export type TypedObject = l.Unknown$TypedObject

// Shared types (network.hivemind.defs)
export type GeoPoint = network.hivemind.defs.GeoPoint
export type GeoCircle = network.hivemind.defs.GeoCircle
export type GeoPolygon = network.hivemind.defs.GeoPolygon
export type Money = network.hivemind.defs.Money
export type Attestation = network.hivemind.defs.Attestation

// General records
export type RequesterRequest = network.hivemind.requester.request.Main
export type RequesterSelection = network.hivemind.requester.selection.Main
export type AgentProfile = network.hivemind.agent.profile.Main
export type AgentOffer = network.hivemind.agent.offer.Main
export type AgentSnapshot = network.hivemind.agent.offer.AgentSnapshot
export type AgentProgress = network.hivemind.agent.progress.Main
export type Dispatch = network.hivemind.coordinator.dispatch.Main
export type TaskState = network.hivemind.coordinator.taskState.Main
export type OfferOption = network.hivemind.coordinator.taskState.OfferOption
export type Assignment = network.hivemind.coordinator.assignment.Main
export type FeedDeclaration = network.hivemind.feed.declaration.Main

// Coordinator types
export type Registration = network.hivemind.coordinator.defs.Registration
export type FeedMember = network.hivemind.coordinator.defs.FeedMember
export type ScoringCriterion = internal.hivemind.coordinator.defs.ScoringCriterion
export type FeatureValue = internal.hivemind.coordinator.defs.FeatureValue
export type RankCandidate = internal.hivemind.coordinator.defs.RankCandidate
export type RankedOption = internal.hivemind.coordinator.defs.RankedOption

/** A record as the caller fills it in: the library adds $type and createdAt. */
export type Draft<RecordType> = Omit<RecordType, '$type' | 'createdAt'>
