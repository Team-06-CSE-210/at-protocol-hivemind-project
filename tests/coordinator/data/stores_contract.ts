import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
	CoordinatorStores,
	TaskRecord,
} from "../../../core/protocol/interfaces/internal/stores.js";
import {
	agentProfile,
	COORDINATOR,
	created,
	DOWNTOWN_FEED,
	deleted,
	FEED_OWNER,
	feedDeclaration,
	OPERATOR,
	PRIVATE_FEED,
	RIDER,
	registration,
	rideOffer,
	rideRequest,
	TAXI_ONE,
	TAXI_TWO,
	taskIdFor,
} from "../fixtures.js";

// One contract for every CoordinatorStores implementation (memory and SQLite), so both behave
// the same. Each test gets fresh stores.

export function runStoresContract(
	name: string,
	openStores: () => CoordinatorStores & { close?(): void },
): void {
	async function withStores(
		steps: (stores: CoordinatorStores) => Promise<void>,
	) {
		const stores = openStores();
		try {
			await steps(stores);
		} finally {
			stores.close?.();
		}
	}

	describe(`${name}: participants and allowlists`, () => {
		test("registrations are stored, replaced and listed by operator", () =>
			withStores(async ({ participants }) => {
				await participants.put(
					registration(OPERATOR, "operator", "pendingPayment"),
				);
				await participants.put(registration(TAXI_ONE, "agent"));
				await participants.put(registration(TAXI_TWO, "agent"));
				await participants.put(registration(OPERATOR, "operator", "active"));

				assert.equal((await participants.get(OPERATOR))?.status, "active");
				assert.equal(await participants.get(RIDER), undefined);
				const agents = await participants.listByOperator(OPERATOR);
				assert.deepEqual(agents.map(({ subject }) => subject).sort(), [
					TAXI_ONE,
					TAXI_TWO,
				]);
			}));

		test("allowlist entries are added and removed per feed", () =>
			withStores(async ({ feedMembers }) => {
				await feedMembers.set({
					feed: PRIVATE_FEED,
					subject: RIDER,
					allowed: true,
				});
				await feedMembers.set({
					feed: PRIVATE_FEED,
					subject: TAXI_ONE,
					allowed: true,
				});
				await feedMembers.set({
					feed: PRIVATE_FEED,
					subject: TAXI_ONE,
					allowed: false,
				});

				assert.equal(await feedMembers.isAllowed(PRIVATE_FEED, RIDER), true);
				assert.equal(
					await feedMembers.isAllowed(PRIVATE_FEED, TAXI_ONE),
					false,
				);
				assert.equal(await feedMembers.isAllowed(DOWNTOWN_FEED, RIDER), false);
				assert.deepEqual(await feedMembers.list(PRIVATE_FEED), [
					{ feed: PRIVATE_FEED, subject: RIDER, allowed: true },
				]);
			}));
	});

	describe(`${name}: tasks`, () => {
		const taskId = taskIdFor("stored");
		const task = (): TaskRecord => ({
			taskId,
			requester: RIDER,
			requestRkey: "r1",
			request: rideRequest(taskId),
			matchedFeeds: [DOWNTOWN_FEED],
			offers: [{ agent: TAXI_ONE, rkey: "o1", offer: rideOffer(taskId, 120) }],
			state: {
				$type: "com.hivemind-network.coordinator.taskState",
				phase: "collecting",
				updatedAt: "2026-11-19T12:00:00.000Z",
			},
		});

		test("a task is found by ID and by its request and offer records", () =>
			withStores(async ({ tasks }) => {
				await tasks.put(task());
				assert.deepEqual(await tasks.get(taskId), task());
				const byRequest = await tasks.findByRecord(
					RIDER,
					"com.hivemind-network.requester.request",
					"r1",
				);
				const byOffer = await tasks.findByRecord(
					TAXI_ONE,
					"com.hivemind-network.agent.offer",
					"o1",
				);
				assert.equal(byRequest?.taskId, taskId);
				assert.equal(byOffer?.taskId, taskId);
				assert.equal(
					await tasks.findByRecord(
						TAXI_TWO,
						"com.hivemind-network.agent.offer",
						"o1",
					),
					undefined,
				);
			}));

		test("listOpen leaves out tasks in an end phase, and bytes survive storage", () =>
			withStores(async ({ tasks }) => {
				await tasks.put(task());
				assert.equal((await tasks.listOpen()).length, 1);

				const finished = task();
				finished.state = { ...finished.state, phase: "completed" };
				finished.assignment = {
					$type: "com.hivemind-network.coordinator.assignment",
					taskId,
					agent: TAXI_ONE,
					requester: RIDER,
					request: finished.request.payload,
					terms: finished.offers[0].offer.payload,
					issuedAt: "2026-11-19T12:00:05.000Z",
					attestation: {
						keyId: `${COORDINATOR}#hivemind_attestation`,
						signature: new Uint8Array([9, 8, 7]),
					},
				} as TaskRecord["assignment"];
				await tasks.put(finished);

				assert.deepEqual(await tasks.listOpen(), []);
				const stored = await tasks.get(taskId);
				assert.deepEqual(
					stored?.assignment?.attestation.signature,
					new Uint8Array([9, 8, 7]),
				);
			}));
	});

	describe(`${name}: public records`, () => {
		test("profiles and feeds follow creates and deletes; feeds of other coordinators are left out", () =>
			withStores(async ({ publicIndex }) => {
				await publicIndex.apply(
					created(FEED_OWNER, "downtown", feedDeclaration()),
				);
				await publicIndex.apply(
					created(FEED_OWNER, "elsewhere", {
						...feedDeclaration(),
						coordinator: "did:plc:othercoordinator",
					}),
				);
				await publicIndex.apply(created(TAXI_ONE, "self", agentProfile()));
				await publicIndex.apply(created(TAXI_TWO, "self", agentProfile([])));

				assert.deepEqual(
					(await publicIndex.listFeeds()).map(({ uri }) => uri),
					[DOWNTOWN_FEED],
				);
				assert.equal(
					(await publicIndex.getFeed(DOWNTOWN_FEED))?.owner,
					FEED_OWNER,
				);
				assert.deepEqual(await publicIndex.listAgentsServing(DOWNTOWN_FEED), [
					TAXI_ONE,
				]);

				await publicIndex.apply(
					deleted(TAXI_ONE, "com.hivemind-network.agent.profile", "self"),
				);
				await publicIndex.apply(
					deleted(
						FEED_OWNER,
						"com.hivemind-network.feed.declaration",
						"downtown",
					),
				);
				assert.equal(await publicIndex.getAgentProfile(TAXI_ONE), undefined);
				assert.deepEqual(
					await publicIndex.listAgentsServing(DOWNTOWN_FEED),
					[],
				);
				assert.deepEqual(await publicIndex.listFeeds(), []);
			}));
	});

	describe(`${name}: sync positions and billing`, () => {
		test("revisions are kept per space and writer", () =>
			withStores(async ({ revisions }) => {
				const space =
					`at://${COORDINATOR}/space/com.hivemind-network.space.requestIntake/main` as const;
				await revisions.set(space, RIDER, "rev1");
				await revisions.set(space, RIDER, "rev2");
				assert.equal(await revisions.get(space, RIDER), "rev2");
				assert.equal(await revisions.get(space, TAXI_ONE), undefined);
			}));

		test("assignments are counted per agent and month", () =>
			withStores(async ({ billing }) => {
				assert.equal(await billing.addAssignment(TAXI_ONE, "2026-11"), 1);
				assert.equal(await billing.addAssignment(TAXI_ONE, "2026-11"), 2);
				await billing.addAssignment(TAXI_ONE, "2026-12");
				assert.equal(await billing.countAssignments(TAXI_ONE, "2026-11"), 2);
				assert.equal(await billing.countAssignments(TAXI_TWO, "2026-11"), 0);
			}));
	});
}
