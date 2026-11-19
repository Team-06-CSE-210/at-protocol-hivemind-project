import type { Keypair } from "@atproto/crypto";

// Builds atproto service-auth tokens the way createServiceJwt in @atproto/xrpc-server does, so
// tests can sign as any DID and bend any claim.

export interface TokenClaims {
	iss: string;
	aud: string;
	lxm?: string;
	exp: number;
	typ?: string;
}

function base64Url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function serviceJwt(
	keypair: Keypair,
	claims: TokenClaims,
): Promise<string> {
	const { typ = "JWT", ...payload } = claims;
	const signedPart = `${base64Url({ typ, alg: keypair.jwtAlg })}.${base64Url({ ...payload, iat: payload.exp - 60, jti: "test" })}`;
	const signature = await keypair.sign(Buffer.from(signedPart, "utf8"));
	return `${signedPart}.${Buffer.from(signature).toString("base64url")}`;
}

// Seconds since the epoch, as JWT claims count them
export function epochSeconds(moment: Date): number {
	return Math.floor(moment.getTime() / 1_000);
}
