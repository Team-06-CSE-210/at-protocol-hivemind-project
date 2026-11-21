import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import {
	ServiceAuthError,
	verifyServiceAuth,
} from "../../../core/coordinator/authentication/service_auth.js";
import type { Did } from "../../../core/protocol/interfaces/internal/types.js";
import { COORDINATOR, RIDER, START } from "../fixtures.js";
import { epochSeconds, serviceJwt, type TokenClaims } from "./service_jwt.js";

// Service auth as the coordinator checks it on every call.

const METHOD = "com.hivemind-network.coordinator.register";
const EXPECTATION = {
	audience: COORDINATOR,
	serviceFragment: "hivemind_coordinator",
	method: METHOD,
} as const;

let riderKey: Secp256k1Keypair;

before(async () => {
	riderKey = await Secp256k1Keypair.create();
});

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
	return {
		iss: RIDER,
		aud: COORDINATOR,
		lxm: METHOD,
		exp: epochSeconds(START) + 60,
		...overrides,
	};
}

async function verify(
	token: string,
	resolveKey = async (_did: Did) => riderKey.did(),
) {
	return verifyServiceAuth(`Bearer ${token}`, EXPECTATION, resolveKey, START);
}

async function rejectsWith(promise: Promise<unknown>, reason: string) {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ServiceAuthError);
		assert.equal(error.error, reason);
		return true;
	});
}

describe("service auth", () => {
	test("a valid token names its issuer as the caller", async () => {
		assert.equal(await verify(await serviceJwt(riderKey, claims())), RIDER);
	});

	test("both audiences are accepted: the bare DID and the coordinator service", async () => {
		const token = await serviceJwt(
			riderKey,
			claims({ aud: `${COORDINATOR}#hivemind_coordinator` }),
		);
		assert.equal(await verify(token), RIDER);
	});

	test("an issuer with a service fragment is the DID before it", async () => {
		const token = await serviceJwt(
			riderKey,
			claims({ iss: `${RIDER}#atproto_pds` }),
		);
		assert.equal(await verify(token), RIDER);
	});

	test("missing, expired, misaddressed and mistyped tokens are refused", async () => {
		await rejectsWith(
			verifyServiceAuth(undefined, EXPECTATION, async () => "", START),
			"AuthMissing",
		);
		await rejectsWith(verify("not.a.token.at.all"), "BadJwt");
		await rejectsWith(
			verify(
				await serviceJwt(riderKey, claims({ exp: epochSeconds(START) - 1 })),
			),
			"JwtExpired",
		);
		await rejectsWith(
			verify(await serviceJwt(riderKey, claims({ aud: "did:plc:other" }))),
			"BadJwtAudience",
		);
		await rejectsWith(
			verify(await serviceJwt(riderKey, claims({ lxm: "com.example.other" }))),
			"BadJwtLexiconMethod",
		);
		await rejectsWith(
			verify(await serviceJwt(riderKey, claims({ typ: "at+jwt" }))),
			"BadJwtType",
		);
		await rejectsWith(
			verify(await serviceJwt(riderKey, claims({ iss: "rider" }))),
			"BadJwtIss",
		);
	});

	test("a token signed by another key is refused, even after refreshing the key", async () => {
		// Same key type as the rider's, so the signature itself is what fails
		const otherKey = await Secp256k1Keypair.create();
		await rejectsWith(
			verify(await serviceJwt(otherKey, claims())),
			"BadJwtSignature",
		);
	});

	test("a rotated key is fetched again once", async () => {
		const staleKey = await Secp256k1Keypair.create();
		const lookups: boolean[] = [];
		const resolveKey = async (_did: Did, forceRefresh: boolean) => {
			lookups.push(forceRefresh);
			return forceRefresh ? riderKey.did() : staleKey.did();
		};
		const token = await serviceJwt(riderKey, claims());
		assert.equal(
			await verifyServiceAuth(
				`Bearer ${token}`,
				EXPECTATION,
				resolveKey,
				START,
			),
			RIDER,
		);
		assert.deepEqual(lookups, [false, true]);
	});

	test("a key rotated to another key type is fetched again too", async () => {
		// The cached key cannot check a P-256 signature at all; that also leads to a fresh key
		const newKey = await P256Keypair.create();
		const lookups: boolean[] = [];
		const resolveKey = async (_did: Did, forceRefresh: boolean) => {
			lookups.push(forceRefresh);
			return forceRefresh ? newKey.did() : riderKey.did();
		};
		const token = await serviceJwt(newKey, claims());
		assert.equal(
			await verifyServiceAuth(
				`Bearer ${token}`,
				EXPECTATION,
				resolveKey,
				START,
			),
			RIDER,
		);
		assert.deepEqual(lookups, [false, true]);
	});
});
