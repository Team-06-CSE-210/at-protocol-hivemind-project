import { sha256 } from "@atproto/crypto";
import type {
	AtUri,
	Did,
	Nsid,
	SpaceRef,
	TaskId,
} from "../interfaces/internal/types.js";

// Space addresses and the rules for their keys. Every component that computes a space address
// (coordinator, gateways, agents, requesters) uses these functions, so the rules exist once.

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Space types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// NSIDs of the space-type lexicons in type_definition/msg_types/general/network/space/
export const SPACE_TYPES = {
	requestIntake: "com.hivemind-network.space.requestIntake",
	offerIntake: "com.hivemind-network.space.offerIntake",
	feed: "com.hivemind-network.space.feed",
	task: "com.hivemind-network.space.task",
} as const satisfies Record<string, Nsid>;

// The coordinator has exactly one request intake and one offer intake; both use this key
// (see policy_types/request_intake.json and offer_intake.json)
export const INTAKE_SPACE_KEY = "main";

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Building and reading addresses
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// A space address is at://{authority DID}/space/{space type NSID}/{space key}
const SPACE_REF_PATTERN =
	/^at:\/\/(did:[a-z]+:[^/]+)\/space\/([^/]+)\/([^/]+)$/;

export function formatSpaceRef(
	authority: Did,
	spaceType: Nsid,
	spaceKey: string,
): SpaceRef {
	return `at://${authority}/space/${spaceType}/${spaceKey}`;
}

export function parseSpaceRef(space: SpaceRef): {
	authority: Did;
	spaceType: Nsid;
	spaceKey: string;
} {
	const match = SPACE_REF_PATTERN.exec(space);
	if (!match) {
		throw new Error(`Not a space address: ${space}`);
	}
	const [, authority, spaceType, spaceKey] = match;
	return {
		authority: authority as Did,
		spaceType: spaceType as Nsid,
		spaceKey,
	};
}

// The authority decides who may read and write; its PDS is the space host
export function authorityOf(space: SpaceRef): Did {
	return parseSpaceRef(space).authority;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Hivemind spaces
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Requesters write their requests here
export function requestIntakeSpaceRef(coordinator: Did): SpaceRef {
	return formatSpaceRef(
		coordinator,
		SPACE_TYPES.requestIntake,
		INTAKE_SPACE_KEY,
	);
}

// Agents write their offers and declines here
export function offerIntakeSpaceRef(coordinator: Did): SpaceRef {
	return formatSpaceRef(coordinator, SPACE_TYPES.offerIntake, INTAKE_SPACE_KEY);
}

// The task ID is the space key, so the requester knows its task space as soon as it writes the request
export function taskSpaceRef(coordinator: Did, taskId: TaskId): SpaceRef {
	return formatSpaceRef(coordinator, SPACE_TYPES.task, taskId);
}

// Agents compute a feed's space from the declaration URI in their profile; no lookup needed
export async function feedSpaceRef(
	coordinator: Did,
	feedDeclaration: AtUri,
): Promise<SpaceRef> {
	return formatSpaceRef(
		coordinator,
		SPACE_TYPES.feed,
		await feedKeyOf(feedDeclaration),
	);
}

// feedKey rule from policy_types/feed.json: lowercase base32 (RFC 4648, no padding) of the
// first 16 bytes of SHA-256 over the UTF-8 AT-URI of the feed declaration
export async function feedKeyOf(feedDeclaration: AtUri): Promise<string> {
	const digest = await sha256(feedDeclaration);
	return base32Lowercase(digest.slice(0, 16));
}

// Task ID rule from com.hivemind-network.defs#taskId: at least 128 random bits, lowercase base32.
// Chosen by the requester; it must not be derived from the requester's identity.
export function createTaskId(): TaskId {
	const randomBytes = crypto.getRandomValues(new Uint8Array(16));
	return base32Lowercase(randomBytes) as TaskId;
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Encoding
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// RFC 4648 base32 alphabet, lower case
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lowercase(bytes: Uint8Array): string {
	let output = "";
	let buffer = 0;
	let bufferedBits = 0;
	// Take 8 bits in, give 5 bits out; 16 bytes become 26 characters
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bufferedBits += 8;
		while (bufferedBits >= 5) {
			bufferedBits -= 5;
			output += BASE32_ALPHABET[(buffer >> bufferedBits) & 31];
		}
		buffer &= (1 << bufferedBits) - 1;
	}
	// Pad the last group with zero bits, without "=" padding characters
	if (bufferedBits > 0) {
		output += BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 31];
	}
	return output;
}
