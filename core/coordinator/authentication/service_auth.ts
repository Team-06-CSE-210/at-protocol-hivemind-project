import { verifySignature } from "@atproto/crypto";
import { l } from "@atproto/lex";
import type { Did, Nsid } from "../../protocol/interfaces/internal/types.js";

// Verifies the atproto service-auth JWT on every call to the coordinator and returns the caller.
// Same checks as verifyJwt in @atproto/xrpc-server (src/auth.ts), with these differences:
// -> the clock is passed in
// -> both audiences the coordinator is called with are accepted
// -> a cached key that cannot check the signature at all (another key type after a rotation)
//    leads to a fresh key, like a key that does not match
// -> the Bearer scheme is matched in any case, as HTTP auth schemes are (RFC 9110, 11.1)
//
// Who calls with which audience:
// -> participants, through their PDS (atproto-proxy header): aud = the coordinator's DID
// -> the space authority's PDS for checkUserAccess:          aud = <coordinator DID>#<serviceFragment>

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Types
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// The did:key a DID currently signs with; forceRefresh skips caches after a key rotation
export type ResolveSigningKey = (
	did: Did,
	forceRefresh: boolean,
) => Promise<string>;

export interface ServiceAuthExpectation {
	// The coordinator's DID
	audience: Did;
	// Fragment of the coordinator service, e.g. hivemind_coordinator
	serviceFragment: string;
	// NSID of the method being called; the token's lxm must name it
	method: Nsid;
}

// `error` is the reason, named as @atproto/xrpc-server names it (BadJwt, JwtExpired, ...)
export class ServiceAuthError extends Error {
	constructor(
		readonly error: string,
		message: string,
	) {
		super(message);
	}
}

interface JwtHeader {
	alg: string;
	typ?: string;
}

interface JwtPayload {
	iss: string;
	aud: string;
	exp: number;
	lxm?: string;
}

// Token types that are never service tokens: OAuth access tokens (RFC 9068), the refresh tokens
// of the @atproto packages, and DPoP proofs (RFC 9449)
const REFUSED_TOKEN_TYPES = new Set(["at+jwt", "refresh+jwt", "dpop+jwt"]);

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Verification
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Takes the Authorization header as sent; returns the caller's DID or throws ServiceAuthError
export async function verifyServiceAuth(
	authorization: string | undefined,
	expectation: ServiceAuthExpectation,
	resolveSigningKey: ResolveSigningKey,
	now: Date,
): Promise<Did> {
	const { audience, serviceFragment, method } = expectation;

	// 1. A bearer token with three parts
	const token = bearerToken(authorization);
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new ServiceAuthError("BadJwt", "Poorly formatted JWT");
	}
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = parseHeader(encodedHeader);
	const payload = parsePayload(encodedPayload);

	// 2. The claims: type, expiry, audience, method, issuer
	if (header.typ !== undefined && REFUSED_TOKEN_TYPES.has(header.typ)) {
		throw new ServiceAuthError("BadJwtType", `Invalid JWT type ${header.typ}`);
	}
	if (now.getTime() / 1_000 > payload.exp) {
		throw new ServiceAuthError("JwtExpired", "JWT expired");
	}
	const acceptedAudiences = [audience, `${audience}#${serviceFragment}`];
	if (!acceptedAudiences.includes(payload.aud)) {
		throw new ServiceAuthError(
			"BadJwtAudience",
			"JWT audience is not this coordinator",
		);
	}
	if (payload.lxm !== method) {
		throw new ServiceAuthError(
			"BadJwtLexiconMethod",
			`JWT lxm must be ${method}`,
		);
	}
	const caller = issuerDid(payload.iss);

	// 3. The signature, with the issuer's current key; once more with a fresh key after a rotation
	const signedBytes = new TextEncoder().encode(
		`${encodedHeader}.${encodedPayload}`,
	);
	const signature = Buffer.from(encodedSignature, "base64url");
	// A key that cannot check this signature (e.g. another key type) is no match either
	const verifyWith = async (didKey: string) => {
		try {
			return await verifySignature(didKey, signedBytes, signature, {
				jwtAlg: header.alg,
				allowMalleableSig: true,
			});
		} catch {
			return false;
		}
	};
	const cachedKey = await resolveSigningKey(caller, false);
	if (await verifyWith(cachedKey)) {
		return caller;
	}
	const freshKey = await resolveSigningKey(caller, true);
	if (freshKey !== cachedKey && (await verifyWith(freshKey))) {
		return caller;
	}
	throw new ServiceAuthError(
		"BadJwtSignature",
		"JWT signature does not match its issuer",
	);
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Parsing
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// "Bearer <token>", the scheme in any case
const BEARER_PATTERN = /^bearer\s+(\S+)\s*$/i;

function bearerToken(authorization: string | undefined): string {
	const token = authorization?.match(BEARER_PATTERN)?.[1];
	if (token === undefined) {
		throw new ServiceAuthError("AuthMissing", "Authentication required");
	}
	return token;
}

function decodeJson(encoded: string): unknown {
	try {
		return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new ServiceAuthError("BadJwt", "Poorly formatted JWT");
	}
}

function parseHeader(encoded: string): JwtHeader {
	const header = decodeJson(encoded) as Partial<JwtHeader> | null;
	if (typeof header?.alg !== "string") {
		throw new ServiceAuthError("BadJwt", "Poorly formatted JWT");
	}
	return header as JwtHeader;
}

function parsePayload(encoded: string): JwtPayload {
	const payload = decodeJson(encoded) as Partial<JwtPayload> | null;
	const wellFormed =
		typeof payload?.iss === "string" &&
		typeof payload.aud === "string" &&
		typeof payload.exp === "number" &&
		(payload.lxm === undefined || typeof payload.lxm === "string");
	if (!wellFormed) {
		throw new ServiceAuthError("BadJwt", "Poorly formatted JWT");
	}
	return payload as JwtPayload;
}

// iss is a DID, or a DID with a service fragment; the DID part names the caller and its key
function issuerDid(issuer: string): Did {
	const [did, fragment, ...rest] = issuer.split("#");
	const fragmentValid =
		fragment === undefined || (fragment.length > 0 && rest.length === 0);
	if (!fragmentValid || !l.isDidString(did)) {
		throw new ServiceAuthError("BadJwtIss", "JWT iss is not a valid DID");
	}
	return did;
}
