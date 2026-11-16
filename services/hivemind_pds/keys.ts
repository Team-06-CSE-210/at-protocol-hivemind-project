/*
 * P-256 keys in the did:key form that DID documents and space credentials use.
 *
 * The coordinator's attestation key is one: it signs assignments only (glossary: "Attestation
 * key"), so it is kept apart from the account's atproto signing key that the PDS holds, and is
 * published in verification method #hivemind_attestation. Participants also bind each space
 * credential to such a key (credentialKid).
 */
import {
	createPrivateKey,
	generateKeyPairSync,
	type JsonWebKey,
	sign,
} from "node:crypto";

export type P256Key = {
	/* Public key as did:key, the value that goes into a DID document. */
	didKey: string;
	/* Private key as JWK. Stays with the key's owner. */
	privateJwk: JsonWebKey;
};

const BASE58_ALPHABET =
	"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/* Multicodec code 0x1200 (p256-pub) as an unsigned varint. */
const P256_PUBLIC_KEY_PREFIX = Uint8Array.of(0x80, 0x24);

export function generateP256Key(): P256Key {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	return {
		didKey: p256DidKey(publicKey.export({ format: "jwk" })),
		privateJwk: privateKey.export({ format: "jwk" }),
	};
}

/* did:key of a P-256 public key: "z" + base58btc(multicodec prefix + compressed point). */
export function p256DidKey(jwk: JsonWebKey): string {
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
		throw new Error("Expected a P-256 public key in JWK form");
	}
	const x = Buffer.from(jwk.x, "base64url");
	const y = Buffer.from(jwk.y, "base64url");
	const parity = y[y.length - 1] & 1 ? 0x03 : 0x02;
	const bytes = Buffer.concat([
		P256_PUBLIC_KEY_PREFIX,
		Uint8Array.of(parity),
		x,
	]);
	return `did:key:z${base58btc(bytes)}`;
}

/* A compact JWT signed with ES256, e.g. the service auth token a did:web account shows a PDS. */
export function signEs256Jwt(
	key: P256Key,
	payload: Record<string, unknown>,
): string {
	const encode = (part: object) =>
		Buffer.from(JSON.stringify(part)).toString("base64url");
	const signingInput = `${encode({ typ: "JWT", alg: "ES256" })}.${encode(payload)}`;
	const signature = sign("sha256", Buffer.from(signingInput), {
		key: createPrivateKey({ key: key.privateJwk, format: "jwk" }),
		dsaEncoding: "ieee-p1363",
	});
	return `${signingInput}.${signature.toString("base64url")}`;
}

function base58btc(bytes: Uint8Array): string {
	let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
	let out = "";
	while (value > 0n) {
		out = BASE58_ALPHABET[Number(value % 58n)] + out;
		value /= 58n;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		out = `1${out}`;
	}
	return out;
}
