# Hivemind Glossary

Nov 8, 2026 · @Philipp

Every term the Hivemind project uses or depends on, sorted A to Z. Each entry carries one mark right after its name:

- **(atproto term)**: a fixed AT Protocol term, used exactly as the official specs at [atproto.com/specs](https://atproto.com/specs) define it. **(atproto term, Spaces alpha)** marks terms from the permissioned-data alpha (build of 2026-10-29), which may still change before release.
- **(hivemind notation)**: a naming convention internal to this project: our lexicons under `com.hivemind-network`, our roles, components and code names. Nobody outside Hivemind will recognise these.
- **(general term)**: a standard computing or industry term that neither atproto nor Hivemind owns.

Where Hivemind reuses a word that atproto already uses differently (agent, feed, subscription), the entry gives both meanings. Names in `monospace` are the code, file or lexicon names you will find in the repository.

## A

**Account** (atproto term): A DID plus the repository a PDS hosts for it, with login credentials. Created with `com.atproto.server.createAccount`. In Hivemind every requester, agent, operator, feed owner and the coordinator itself is an account.

**Account migration** (atproto term): Moving an account's repository, blobs and settings to another PDS and pointing the DID document at the new PDS. The DID and handle stay the same. This is how an operator can move its agents off the Hivemind PDS onto its own.

**AccountSession** (hivemind notation): Client class in `packages/atproto-client/src/account-session.ts`. Logs an account into its PDS and makes every authenticated call for it: records, service auth tokens, space writes and space credentials.

**Agent** (hivemind notation): An autonomous system with its own DID that receives dispatches and answers with offers, such as a robotaxi, warehouse robot or EV charger. Not the same as an atproto client "agent": in Bluesky's TypeScript libraries, `Agent` / `AtpAgent` is just an API client object.

**Agent kind** (hivemind notation): The `agentKind` field of an agent profile: `vehicle`, `mobileRobot`, `manipulator`, `chargingStation` or `other`.

**Agent profile** (hivemind notation): Public record `com.hivemind-network.agent.profile` (record key `self`) in the agent's own repo. States display name, agent kind, operator, supported task types, capabilities and operating area.

**Agent runtime** (hivemind notation): The software that runs an agent on the network: it holds the agent's keys, reads its feed spaces, writes offers and status updates, and executes assignments. Built on the `HivemindAgent` SDK class and run by the operator.

**Agent snapshot** (hivemind notation): The `agentSnapshot` object an agent attaches to each offer: position, battery percent and operational status (`available`, `busy`, `charging`, `maintenance`).

**AgentBehavior** (hivemind notation): SDK interface in `packages/sdk/src/hivemind-agent.ts` that an operator implements: decide whether and how to offer on a dispatch, then carry out an assigned task. The taxi demo implements it in `taxi-agent-behavior.ts`.

**allowedApps** (atproto term, Spaces alpha): Member-space policy field listing the apps (service identifiers) allowed to access the space on a member's behalf.

**Allowlist** (hivemind notation): The two DID lists a private feed's owner keeps: agents allowed to read its dispatches, and requesters allowed to post into it. Managed through `com.hivemind-network.feed.putMember` and `removeMember`; only the coordinator sees the lists.

**Answer window** (hivemind notation): How long the coordinator collects offers after dispatching, set per feed as `answerWindowMs` in the feed declaration. For one task, the longest window among the matched feeds applies, capped by the request's `maxWaitMs`.

**App View** (atproto term): A service that reads the firehose, indexes the records it cares about and serves app-specific queries, like Bluesky's App View for posts. The coordinator's indexer plays this role for `com.hivemind-network.*` public records.

**Assignment** (hivemind notation): Record `com.hivemind-network.task.assignment` (record key `self`) that the coordinator writes into the task space. Names the winning agent, the requester, the request and the agreed terms, and carries the coordinator's attestation. Agents act only on assignments whose signature checks out.

**AT Protocol / atproto** (atproto term): The Authenticated Transfer Protocol: an open, federated protocol for apps built on portable identities (DIDs, handles), signed data repositories, PDSes, relays, App Views, lexicons and XRPC. Hivemind runs on it; Bluesky is its best-known app.

**AT-URI** (atproto term): The address of a record: `at://{DID or handle}/{collection NSID}/{record key}`, e.g. `at://did:plc:abc…/com.hivemind-network.feed.declaration/downtown`. We call it a record address in plain language.

**atproto-proxy** (atproto term): HTTP header (`atproto-proxy: {DID}#{service fragment}`) that asks a PDS to forward an XRPC call, with a service auth token, to the named service. Lets an app reach the coordinator through the user's own PDS.

**Attestation** (hivemind notation): The coordinator's detached signature over an assignment (`attestation` object: `signer`, `keyId`, `signature`). Anyone can verify it against the attestation key in the coordinator's DID document.

**Attestation key** (hivemind notation): The key published as verification method `#hivemind_attestation` in the coordinator's DID document. Kept separate from the account's atproto signing key, it signs assignments only.

**Auto mode** (hivemind notation): Selection mode `auto`, shown as *Pick the best for me*: the coordinator assigns the top-ranked offer itself. The alternative is `choose`.

**awaitingSelection** (hivemind notation): Task phase after ranking in `choose` mode: options are in the task state and the coordinator waits for the requester's selection until `selectBy`.

## B

**Billing ledger** (hivemind notation): Coordinator component in `packages/coordinator/src/registry/billing-ledger.ts`. Tracks each operator's enrolled agents and assignment counts and produces an invoice preview; collecting the money happens off-protocol through a payment provider.

**Billing plan** (hivemind notation): The prices the billing ledger applies (`DEFAULT_BILLING_PLAN`): USD 9.00 per agent per month (900 minor units), 1,000 included assignments per agent per month, then USD 0.002 per extra assignment (2,000 micros). Requesters and feed owners pay nothing.

**Blob** (atproto term): Binary data such as an image or video, uploaded to a PDS and referenced from a record by its CID. Blobs sit next to the repository, not inside it. Hivemind does not use blobs yet.

**Bluesky** (general term): The social app built on atproto, and the company (Bluesky Social PBC) that leads the protocol's development. It runs the main relay, the PLC directory and the Bluesky App View, and publishes the Spaces alpha.

**Bound key** (atproto term, Spaces alpha): The key a space credential is tied to, named in the credential (`cnf.kid`, requested as `credentialKid`). Every request that uses the credential must carry a request proof signed with this key, so a stolen credential alone is useless.

## C

**Cancellation** (hivemind notation): Record `com.hivemind-network.task.cancellation` that the requester writes into the task space, with an optional reason. The coordinator then closes the task's dispatches and moves the task to `cancelled`.

**Capabilities** (hivemind notation): The task-type-specific part of an agent profile. For rides: seat count, pricing model (`baseFare`, `perKilometer`, `perMinute`) and maximum pickup distance.

**Certification** (hivemind notation): Public record `com.hivemind-network.registry.certification` in the coordinator's own repo, stating that a DID is a registered participant in good standing (`subject`, `role`, `operator`, `plan`, `issuedAt`). Anyone can check it on the firehose; deleting it suspends the participant.

**checkUserAccess** (atproto term, Spaces alpha): Method `com.atproto.managedspace.checkUserAccess`. The space authority calls the managing app with it to ask whether a DID may read or write a managed space. The coordinator answers from its registry, the feed subscriptions and the allowlists.

**Choose mode** (hivemind notation): Selection mode `choose`, shown as *Let me choose*: the coordinator puts the ranked offer options into the task state and the requester picks one with a selection record.

**CID** (atproto term): Content Identifier: a hash-based address of a block of data such as a record, commit or blob. Any change to the content changes the CID, which is what makes repositories verifiable.

**Closed reason** (hivemind notation): The `closedReason` a dispatch gets when its state turns `closed`: `assigned`, `cancelled`, `noOffers` or `expired`.

**collecting** (hivemind notation): First task phase: dispatches are out and offers come in until the answer window ends or every eligible agent has answered.

**Collection** (atproto term): All records of one type in a repository, named by the NSID of their lexicon, e.g. `com.hivemind-network.feed.declaration`. The middle part of an AT-URI.

**com.hivemind-network** (hivemind notation): The NSID authority for every Hivemind lexicon, collection, space type and method: the domain `hivemind-network.com` reversed.

**Commit** (atproto term): A signed snapshot of a repository: its DID, revision (`rev`), the root CID of its MST and a signature by the account's signing key. Relays broadcast every public commit on the firehose.

**Coordinator** (hivemind notation): The Hivemind service (`did:web:hivemind-network.com`) in `packages/coordinator`. It indexes public records, keeps the registry and billing, owns the intake, feed and task spaces, routes requests, ranks offers and signs assignments. Only Hivemind runs it; companies cannot host their own.

**Coordinator API** (hivemind notation): The XRPC methods the coordinator serves (`coordinator-api.ts`): `com.hivemind-network.coordinator.describe`, `registry.register`, `registry.enrollAgent`, `registry.getStatus`, `feed.getFeed`, `feed.putMember` and `feed.removeMember`, plus the Spaces callbacks `checkUserAccess` and `notifyWrite`.

**Coordinator description** (hivemind notation): What `com.hivemind-network.coordinator.describe` returns: the coordinator's DID, its intake space, the ID of its attestation key and the task types it supports. The first call any participant makes.

**Coverage** (hivemind notation): A feed's geographic area in its declaration, as a `geoCircle` or `geoPolygon`. A request is routed to the feed only if its routing points lie inside the coverage.

**createSpace** (atproto term, Spaces alpha): Method `com.atproto.space.createSpace`, by which a space authority creates a space with a given space type, space key and policy. The coordinator calls it for the intake space, each feed space and each task space.

**Credible exit** (atproto term): atproto's design principle that a user can leave any provider (PDS, app, feed) and keep their identity, data and connections. Hivemind keeps it for accounts and data, while the coordinator's registry and spaces stay a service of their own.

## D

**DAG-CBOR** (atproto term): The binary encoding atproto uses for records and commits: a deterministic subset of CBOR that can hold links (CIDs). The atproto data model behind it has no floating-point numbers, which is why Hivemind stores coordinates as degE7 integers.

**Data layers** (hivemind notation): Hivemind's split of its data into two layers. The public layer holds records on the firehose (agent profiles, feed declarations, feed subscriptions, certifications); the permissioned layer holds everything about tasks in spaces (requests, dispatches, offers, states, assignments, status updates).

**Decision** (hivemind notation): The `decision` field of an offer: `accept` (with terms in the payload) or `decline` (with an optional `declineReason`).

**degE7** (hivemind notation): Coordinates as integers in degrees × 10,000,000 (`latE7`, `lonE7` in `geoPoint`), about 1 cm resolution. Needed because atproto records cannot contain floats.

**Delegation token** (atproto term, Spaces alpha): A single-use token from `com.atproto.space.getDelegationToken` that the user's own PDS mints and signs with the user's key. The reader presents it to the space authority to prove who it reads for and gets a space credential in exchange.

**DID** (atproto term): Decentralized Identifier, the permanent ID of an account, e.g. `did:plc:7c3x…`. A W3C standard; atproto accepts two methods, did:plc and did:web. Everything in Hivemind (records, spaces, allowlists, certifications) refers to participants by DID, never by handle.

**DID document** (atproto term): The JSON document a DID resolves to. For atproto it holds the handle (`alsoKnownAs`), the signing key (`#atproto`) and the PDS address (service `#atproto_pds`). Hivemind adds its own entries: `#hivemind_coordinator`, `#hivemind_agent` and `#hivemind_attestation`.

**did:key** (atproto term): A public key written as a DID string, e.g. `did:key:zDnae…`. atproto uses this format to publish signing keys in DID documents and to name keys elsewhere, such as the bound key of a space credential. It is not used as an account ID.

**did:plc** (atproto term): The DID method made for atproto: identities registered in the PLC directory, with key rotation and migration between PDSes. Requesters and agents on the Hivemind PDS get did:plc identities.

**did:web** (atproto term): A DID tied to a domain, resolved from `https://{domain}/.well-known/did.json`. The coordinator uses `did:web:hivemind-network.com`; losing the domain means losing the identity.

**Dispatch** (hivemind notation): Record `com.hivemind-network.task.dispatch` that the coordinator writes into a feed space, one per matched feed: task ID, task type, payload, feed, task space, `respondBy`, state (`open` / `closed`) and closed reason. It names no requester, though today's task ID still embeds the requester's DID suffix (see Task ID).

## E–F

**Early close** (hivemind notation): Ending offer collection before the answer window runs out because every eligible agent has already answered. Keeps short tasks fast even when a feed allows a long window.

**Eligible agents** (hivemind notation): The agents that can read at least one matched feed space when a request is dispatched: certified, subscribed, not suspended and, for a private feed, allowlisted. Early close waits for exactly this set.

**End user** (hivemind notation): A person who asks for tasks, using Hivemind for free with an account on the Hivemind PDS. Called requester in the protocol and rider in the taxi demo.

**Enrollment** (hivemind notation): An operator adding one of its agents through `com.hivemind-network.registry.enrollAgent`. Starts the agent's monthly fee and publishes the agent's certification.

**expired** (hivemind notation): Task phase and closed reason when the requester did not pick an option before `selectBy` (selection window: 60 s by default, 45 s in the taxi demo).

**failed** (hivemind notation): Task phase, and status-update value, for a task the assigned agent could not complete, or whose accepted offers the coordinator could not rank.

**Fan-out** (general term): Sending one message to many recipients. The coordinator fans a request out by writing one dispatch into each matched feed's space; the demo map draws this as lines from the pickup to every agent that can read one of those feeds.

**Feed** (hivemind notation): A task channel: a coverage area plus task types, access rules, an answer window and scoring settings, declared by a feed owner. Requests that match are dispatched into the feed's space. Not a Bluesky feed, which is a timeline of posts; only the declaration pattern is borrowed from Bluesky feed generators.

**Feed access** (hivemind notation): The `access` setting of a feed declaration. `public`: every certified agent that subscribes can read it, and every requester's matching request goes there. `private`: only allowlisted agents can read and only allowlisted requesters can post.

**Feed declaration** (hivemind notation): Public record `com.hivemind-network.feed.declaration` in the feed owner's repo, modelled on Bluesky's `app.bsky.feed.generator`. Holds display name, description, coordinator, coverage, task types, access, `answerWindowMs` and scoring settings.

**Feed generator** (atproto term): A Bluesky service that builds a custom timeline, announced by an `app.bsky.feed.generator` record in its owner's repo. Part of Bluesky's app lexicons rather than the core protocol; the model for Hivemind's feed declarations.

**Feed owner** (hivemind notation): The account that publishes a feed declaration: an interest group, fleet company, campus or warehouse. Free of charge; controls the feed's access, allowlists, answer window and scoring.

**Feed space** (hivemind notation): The managed space that carries one feed's dispatches: `at://{coordinator DID}/space/com.hivemind-network.space.feed/{declaration rkey}.{owner DID suffix}`. The coordinator is its authority and decides who reads it.

**Feed subscription** (hivemind notation): Public record `com.hivemind-network.feed.subscription` in an agent's repo that names a feed it serves, like a follow. The coordinator grants feed-space access only to subscribed agents that are also certified (and allowlisted, for private feeds).

**Firehose** (atproto term): The event stream a relay serves (`com.atproto.sync.subscribeRepos`) with every public commit of every repository it crawls. The coordinator's indexer reads it; space data never appears on it.

## G–I

**geoPoint, geoCircle, geoPolygon** (hivemind notation): Shared geometry types in `com.hivemind-network.defs`. A point is `latE7` / `lonE7` in degE7; a circle is a centre plus `radiusMeters`; a polygon is an ordered, implicitly closed list of points.

**goat** (general term): Bluesky's official command-line tool for atproto, written in Go. Creates accounts, edits PLC identities, inspects repositories and records and checks lexicons; useful once we move off the simulation.

**Handle** (atproto term): The human-readable name of an account, a domain such as `alice.bsky.social`, proven through a DNS TXT record (`_atproto`) or `/.well-known/atproto-did`. Can change at any time while the DID stays, so Hivemind never stores handles as identifiers.

**Headline** (hivemind notation): One-line summary of an offer shown to the requester inside an offer option (e.g. pickup time and price), produced by the task type module.

**Hivemind** (hivemind notation): This project: a ROS-inspired open standard (the `com.hivemind-network` lexicons) plus a coordination service that lets autonomous systems take tasks from people over atproto.

**Hivemind PDS** (hivemind notation): The PDS Hivemind operates (`pds.hivemind-network.com` in the demo, invite-only). Hosts end-user accounts for free, agents of operators that do not self-host, and the coordinator's own account, which makes it the space host of every Hivemind space.

**HivemindAgent** (hivemind notation): SDK class in `packages/sdk/src/hivemind-agent.ts` that turns an AgentBehavior into a working agent: publishes profile and subscriptions, reads feed spaces, writes offers, verifies assignments and reports status.

**HivemindOrganization** (hivemind notation): SDK class for operators and feed owners: registers with the coordinator, enrolls agents, publishes feed declarations and manages private-feed allowlists.

**HivemindRequester** (hivemind notation): SDK class for end-user apps: writes requests into the request intake space, follows the task space (`RequesterTask`), selects options and cancels.

**HPKE** (general term): Hybrid Public Key Encryption (RFC 9180). Planned for encrypting request payloads end to end, because spaces control who may read data but do not encrypt it from the hosting PDS.

**IdentityResolver** (hivemind notation): Interface in `packages/atproto-core/src/identity.ts` for atproto identity resolution: DID to DID document, and handle to DID. The simulation implements it as `SimIdentityDirectory`; production would call the PLC directory and `did:web` hosts.

**Indexer** (hivemind notation): The coordinator's `PublicRecordIndexer`. Reads the firehose and keeps every `com.hivemind-network.*` public record (agent profiles, feed declarations, feed subscriptions, certifications) as the coordinator's current picture of the network.

**Intake spaces** (hivemind notation): The coordinator's two inboxes, both managed spaces that only the coordinator reads (ADR-005). See **Request intake space** and **Offer intake space**.

**Interest group** (hivemind notation): Any group (company, campus, community, warehouse) that sets up a feed so that tasks in its area reach the agents it chooses.

**Invite code** (atproto term): A code a PDS can require before `createAccount`. The Hivemind PDS requires one, so only participants Hivemind admits can open accounts there.

## J–L

**JWT** (general term): JSON Web Token: a signed, compact claims token. atproto uses JWTs for PDS login sessions and service auth; the Spaces alpha uses them for delegation tokens and space credentials. The prototype signs all of them with ES256 (P-256).

**K-256** (general term): The secp256k1 elliptic curve. One of the two curves atproto allows for signing keys, next to P-256; the prototype uses P-256 only.

**Lexicon** (atproto term): atproto's JSON schema language. Each lexicon has an NSID and defines a record, query, procedure or subscription. Hivemind's 22 lexicons live in `packages/protocol/lexicons/network/hivemind/`.

**Lexicon validation** (hivemind notation): The check in `packages/protocol/src/lexicon-validator.ts` that runs every Hivemind record through `@atproto/lexicon` before it is written or accepted. The coordinator drops requests and offers that fail it.

**listRepoOps** (atproto term, Spaces alpha): Method `com.atproto.space.listRepoOps`: lists one writer's creates, updates and deletes in a space since a given revision. How a SpaceSyncer catches up after a notification.

**listRepos** (atproto term, Spaces alpha): Method `com.atproto.space.listRepos`: lists a space's writer set with each repo's current revision, served by the space host.

**literal:self** (atproto term): Record-key type that allows exactly one record per repo in a collection, under the key `self`. Used by agent profiles, task states and assignments; see Record key.

## M–N

**Managed space** (atproto term, Spaces alpha): A space whose policy (`com.atproto.managedspace.policy`) hands every access decision to a managing app, which the space authority asks through `checkUserAccess`. Hivemind's intake space and feed spaces are managed spaces, so the coordinator's registry decides who gets in.

**Managing app** (atproto term, Spaces alpha): The service named in a managed-space policy that decides access, given as a service identifier. For Hivemind: `did:web:hivemind-network.com#hivemind_coordinator`.

**MatchingEngine** (hivemind notation): Planned interface that would move ranking and optimisation into a separate matching service (possibly Java or Kotlin, with a solver such as Timefold or OR-Tools). Today ranking runs in TypeScript in `packages/coordinator/src/matching/`.

**maxWaitMs** (hivemind notation): Field of a request: the longest the requester is willing to wait for offers (50 ms to 10 min). Caps the answer window of the matched feeds.

**Member space** (atproto term, Spaces alpha): A space whose policy (`com.atproto.memberspace.policy`) is an explicit member list with read and write flags, kept by the authority through `putMember`, `removeMember` and `listMembers`. Options: `publicRead`, `publicWrite`, `allowedApps`, `publishPolicy`, `publishMembers`. Hivemind's task spaces are member spaces.

**Money** (hivemind notation): The `money` object in `com.hivemind-network.defs`: an integer `amountMinor` in the currency's smallest unit (cents for USD) plus an ISO currency code. Billing uses micros (millionths of a unit) for fees below one cent.

**MST** (atproto term): Merkle Search Tree, the data structure of a repository. It maps every `collection/rkey` path to a record CID, and its root CID goes into each commit.

**Network delay per hop** (hivemind notation): Demo setting that adds simulated latency to every XRPC call, to feel how a globe-spanning network behaves. Set in the demo header, next to simulated time speed.

**noCoverage** (hivemind notation): Task phase when no feed's coverage and task types match the request, so nothing is dispatched.

**noOffers** (hivemind notation): Task phase and closed reason when the answer window ends without a single acceptable offer.

**Notification receiver** (hivemind notation): `SpaceNotificationReceiver` in `packages/atproto-client`: the endpoint that takes incoming `notifyWrite` calls and passes each one to the SpaceSyncer of that space.

**notifyCredentialRevoked** (atproto term, Spaces alpha): Method `com.atproto.space.notifyCredentialRevoked`, by which the space authority tells repo hosts to reject a space credential before it expires, e.g. after a member is removed.

**notifyWrite** (atproto term, Spaces alpha): Method `com.atproto.space.notifyWrite`. A writer's repo host calls the space authority after a write; the authority gives the write a spaceRev and forwards the notice to every service registered with registerNotify. This is how the coordinator learns of new requests and offers without polling.

**NSID** (atproto term): Namespaced Identifier: a reversed domain plus a name, e.g. `com.hivemind-network.task.offer`. Names lexicons, collections, XRPC methods and space types.

## O

**Offer** (hivemind notation): Record `com.hivemind-network.task.offer` that an agent writes into the offer intake space in answer to a dispatch: task ID, feed, decision, decline reason, payload and agent snapshot. For rides the payload holds pickup ETA, trip distance and duration, price and vehicle. Neither the requester nor competing operators can read it.

**Offer intake space** (hivemind notation): Managed space `at://{coordinator DID}/space/com.hivemind-network.space.offerIntake/main`. Active agents write their offers and declines into it; only the coordinator reads it.

**Offer option** (hivemind notation): One ranked choice the requester sees in the task state (`offerOption`): option ID, agent, agent and operator display names, score, headline and terms. A filtered view of an offer; the raw offers stay with the coordinator.

**Offer ranking** (hivemind notation): `rankCandidates` in `packages/coordinator/src/matching/offer-ranker.ts`, which scores offers by simple additive weighting; see Ranking.

**Offers space** (hivemind notation): Superseded by the offer intake space (ADR-005): one offer inbox for all feeds instead of one per feed.

**Open union** (atproto term): A lexicon `union` that accepts types beyond the ones it lists (unions are open unless marked `closed`). Hivemind's task payloads are open unions, so a new task type adds its own lexicon without changing the core task records.

**Operating area** (hivemind notation): The `operatingArea` of an agent profile, a `geoCircle` or `geoPolygon` where the agent works. The taxi agents decline dispatches whose pickup lies outside it.

**Operational status** (hivemind notation): Agent state reported in each offer's agent snapshot: `available`, `busy`, `charging` or `maintenance`.

**Operator** (hivemind notation): A company that owns and runs agents, e.g. a robotaxi fleet. Registers with the coordinator, enrolls agents and pays per agent; may host its accounts on the Hivemind PDS or on its own PDS.

**Operator PDS** (hivemind notation): A PDS an operator runs itself for its own account and its agents' accounts. It is then the repo host for its agents' space writes and sends the matching `notifyWrite` calls to the coordinator's PDS.

**Org console** (hivemind notation): Planned web app for operators and feed owners to register, enroll agents, manage feeds and allowlists, and see billing. The demo's Feeds and Operators & billing tabs stand in for it today.

## P

**P-256** (general term): The NIST elliptic curve secp256r1 (signature algorithm ES256). One of the two curves atproto allows for signing keys, next to K-256; the prototype uses it for every key.

**Payload** (hivemind notation): The task-type-specific body of a request, dispatch, offer or assignment, typed by an open union. For rides: `com.hivemind-network.mobility.ride#request` (pickup, dropoff, passenger count) and `#offer`.

**PDS** (atproto term): Personal Data Server: hosts accounts and their repositories, handles login, and signs and serves records. In the Spaces alpha a PDS also stores its users' permissioned repos (repo host) and runs spaces for its accounts (space host).

**Permissioned data** (atproto term, Spaces alpha): Records kept in spaces instead of the public repository. They never go to a relay or the firehose and can only be read with a valid space credential.

**Permissioned repository** (atproto term, Spaces alpha): One writer's repository inside one space, stored on the writer's own PDS. In the simulation: `packages/atproto-sim/src/pds/permissioned-repository.ts`.

**Personal space** (atproto term, Spaces alpha): A space with policy `com.atproto.personalspace.policy`: only its owner reads and writes, e.g. private bookmarks. Hivemind does not use it.

**Phase** (hivemind notation): The `phase` of a task in its task state: `collecting`, `awaitingSelection`, `assigned`, `completed`, `cancelled`, `failed`, `noCoverage`, `noOffers` or `expired`.

**PLC directory** (atproto term): The registry at `plc.directory`, run by Bluesky, that stores the signed operation log of every did:plc and resolves it to a DID document.

**Policy** (atproto term, Spaces alpha): A space's access rules, one of three types: personal, member or managed. Set at `createSpace` and changeable with `updateSpace` within the rules of its type; `publishPolicy` makes it publicly readable. It is a record the protocol defines, not a config file.

**Private feed** (hivemind notation): A feed with `access: private`; see Feed access.

**Procedure** (atproto term): Lexicon type for an XRPC method that changes state, sent as HTTP POST, e.g. `com.hivemind-network.registry.register`.

**Protocol inspector** (hivemind notation): Demo panel that lists every XRPC call, firehose commit, space write and coordinator decision from the trace. *Show plumbing* adds credentials, polling and access checks.

**Public feed** (hivemind notation): A feed with `access: public`; see Feed access.

**Public record** (hivemind notation): A record in an account's public repository, sent to relays and visible on the firehose. Hivemind keeps only participant and feed information there: agent profiles, feed declarations, feed subscriptions, certifications.

**putMember** (atproto term, Spaces alpha): Method `com.atproto.memberspace.putMember`, by which a member space's authority adds a DID with read and/or write rights. Not to be confused with Hivemind's `com.hivemind-network.feed.putMember` (hivemind notation), by which a feed owner allowlists a DID on a private feed.

## Q–R

**Query** (atproto term): Lexicon type for a read-only XRPC method, sent as HTTP GET, e.g. `com.hivemind-network.coordinator.describe`.

**Ranking** (hivemind notation): How the coordinator orders accepted offers: simple additive weighting. Each scoring feature is min-max normalised across the offers (inverted where lower is better), weighted, and summed into a score from 0 to 1000; rides default to 50 % pickup time, 40 % price, 10 % trip time.

**Record** (atproto term): A single typed JSON object (stored as DAG-CBOR) in a collection, carrying its lexicon NSID in `$type` and addressed by an AT-URI. Public records live in the repository; Spaces adds records inside spaces.

**Record address** (hivemind notation): Our plain-language name for an AT-URI, the full address of one record. Its space counterpart is the space address (space reference).

**Record key / rkey** (atproto term): The last part of an AT-URI, unique within its collection. A lexicon sets the key type: `tid` (time-sorted, used for requests, offers, subscriptions), `literal:self` (one per repo), `any` (free text, used for feed declarations and dispatches) or `nsid`.

**registerNotify** (atproto term, Spaces alpha): Method `com.atproto.space.registerNotify`, by which a service asks the space authority to forward notifyWrite notices for a space to it. Registrations expire after 24 hours and must be renewed; `unregisterNotify` ends them.

**Registry** (hivemind notation): The coordinator's `ParticipantRegistry`: every registered DID with its role (`requester`, `operator`, `feedOwner`, `agent`) and status (`active`, `suspended`). Behind `registry.register`, `registry.enrollAgent` and `registry.getStatus`, and the source of all certifications.

**Relay** (atproto term): A service that crawls PDSes, checks their commits and merges them into one firehose. It only ever sees public repositories, never spaces.

**Repo host** (atproto term, Spaces alpha): The PDS that stores a writer's permissioned repo for a space, i.e. the writer's own PDS. Readers fetch the writer's records there with a space credential; after each write it calls notifyWrite on the space authority.

**Repository / repo** (atproto term): An account's signed set of records, organised as an MST and versioned by commits. Portable: it can be exported and moved to another PDS.

**Request** (hivemind notation): Record `com.hivemind-network.task.request` that the requester writes into the request intake space: task type, payload, selection mode and `maxWaitMs`. The start of every task; only the coordinator can read it.

**Request intake space** (hivemind notation): Managed space `at://{coordinator DID}/space/com.hivemind-network.space.requestIntake/main`. Active requesters write their requests into it; only the coordinator reads it.

**Request proof** (atproto term, Spaces alpha): A signature by the bound key on each request that uses a space credential, proving the caller holds that key. The alpha uses HTTP message signatures (RFC 9421); the simulation uses a signed JWS header instead.

**Requester** (hivemind notation): The protocol role of an end user: registers for free and writes requests, selections and cancellations. The rider in the taxi demo.

**respondBy** (hivemind notation): Deadline on a dispatch (and in the task state) by which agents must answer; the end of the answer window.

**Rev** (atproto term): A repository's revision, a TID that increases with every commit. Spaces readers use revs to ask for everything since the last one they saw.

**Rider** (hivemind notation): The requester in the taxi scenario, shown as the magenta ring on the demo map.

**ROS** (general term): Robot Operating System, the robotics middleware that inspired Hivemind's message design: topics map to feeds and dispatches, services to XRPC methods, actions to assignments with status updates. Hivemind does not connect to ROS itself.

**Routing** (hivemind notation): The coordinator's `RequestRouter` choosing the matched feeds for a request: every active feed that accepts the task type, covers all routing points and lets this requester post. Feeds are ordered smallest area first.

**Routing points** (hivemind notation): The locations a task type says must lie inside a feed's coverage; for rides, only the pickup.

## S

**SAW** (general term): Simple additive weighting, a standard multi-criteria decision method: normalise each criterion, multiply by its weight, add up. The basis of Hivemind's ranking.

**Scenario** (hivemind notation): A pluggable demo world implementing `DemoScenario` (`apps/demo-server/src/scenarios/scenario.ts`): it creates the accounts, agents and feeds and supplies its own map layers and panels. The taxi scenario ships today; a warehouse scenario is planned.

**Scoring feature** (hivemind notation): One measurable property of an offer that ranking uses, with a direction (lower or higher is better). Rides use `etaToPickup`, `price` and `tripDuration`, all lower-is-better.

**Scoring settings** (hivemind notation): The `scoring` part of a feed declaration: `mode` `default` or `custom`, with custom `weights` (feature and percent). Custom weights apply only if every matched feed has the same custom settings; otherwise the task type's defaults apply, so no owner ranks another owner's agents.

**selectBy** (hivemind notation): Deadline in the task state by which the requester must pick an option in choose mode; after it the task is `expired`.

**Selection** (hivemind notation): Record `com.hivemind-network.task.selection` that the requester writes into the task space, naming the chosen option ID.

**Selection mode** (hivemind notation): The request's `selectionMode`: `auto` (coordinator assigns the best offer) or `choose` (requester picks from ranked options).

**Selection window** (hivemind notation): How long a requester has to choose, set per coordinator: 60 s by default, 45 s in the taxi demo.

**Service auth** (atproto term): A short-lived JWT, signed with the caller's signing key, that proves to another service which account is calling. Claims: `iss` (caller DID), `aud` (service DID), `lxm` (the one method it is valid for), `exp`. Obtained from the caller's PDS via `com.atproto.server.getServiceAuth`; every call to the coordinator API uses it.

**Service entry / service identifier** (atproto term): An entry in a DID document's `service` list (fragment ID, type, endpoint URL). The service identifier `{DID}#{fragment}` names one service, e.g. `did:web:hivemind-network.com#hivemind_coordinator`.

**Session** (atproto term): A login to a PDS (`com.atproto.server.createSession`), giving an access token and a refresh token for further calls on the account's behalf.

**Signing key** (atproto term): The account key published as `#atproto` in its DID document. Signs repository commits and service auth tokens; in the Spaces alpha it also signs delegation tokens and, for an authority, space credentials.

**Simulation** (hivemind notation): `SimulatedAtprotoNetwork` in `packages/atproto-sim`: an in-process stand-in for the real network, with a DID directory, PDSes (public repos, Spaces repo host and authority), relay and XRPC transport. Lets the whole system run offline on one machine.

**Snapshot** (hivemind notation): `DemoSnapshot`, the full demo state (coordinator, feeds, agents, tasks, trace) the demo server streams to the browser over WebSocket.

**Space** (atproto term, Spaces alpha): A permissioned container of records, defined by an authority, a space type, a space key and a policy. Each writer keeps its records in its own permissioned repo for the space. Spaces control who can read; they do not encrypt.

**Space address** (hivemind notation): Our plain-language name for a space reference.

**Space authority** (atproto term, Spaces alpha): The DID that owns a space. Its PDS enforces the policy, mints space credentials, orders writes with spaceRev and forwards notifications. For every Hivemind space the authority is the coordinator.

**Space credential** (atproto term, Spaces alpha): A short-lived read token (about 10 minutes) from `com.atproto.space.getSpaceCredential`, issued by the space authority in exchange for a delegation token and bound to a key. Sent with the auth scheme `Atproto-Space-Credential` plus a request proof.

**Space host** (atproto term, Spaces alpha): The PDS of the space authority, which runs the space itself. For Hivemind's spaces that is the Hivemind PDS, because it hosts the coordinator's account.

**Space key / skey** (atproto term, Spaces alpha): The last part of a space reference, chosen by the authority. Hivemind uses `main` for both intake spaces, `{declaration rkey}.{owner DID suffix}` for feed spaces and the task ID for task spaces.

**Space reference** (atproto term, Spaces alpha): The address of a space: `at://{authority DID}/space/{space type}/{space key}`, e.g. `at://did:web:hivemind-network.com/space/com.hivemind-network.space.requestIntake/main`.

**Space type** (atproto term, Spaces alpha): An NSID that says what kind of space it is. Hivemind defines `com.hivemind-network.space.requestIntake`, `com.hivemind-network.space.offerIntake`, `com.hivemind-network.space.feed` and `com.hivemind-network.space.task`.

**SpaceReader** (hivemind notation): Client class in `packages/atproto-client` that reads one space for one account: gets a delegation token, exchanges it for a space credential, signs request proofs and registers for notifications.

**spaceRev** (atproto term, Spaces alpha): The authority's running revision for a whole space, stamped on each forwarded notifyWrite so receivers can process writes in order and spot gaps.

**Spaces alpha** (atproto term): Bluesky's alpha release of permissioned data for atproto (build 0.0.0-spaces-alpha-20261029, Docker image `ghcr.io/bluesky-social/atproto:pds-spaces-alpha`). Stated by the atproto team as not ready for production; its terms are marked "Spaces alpha" in this glossary.

**SpaceSyncer** (hivemind notation): Client class that keeps a local copy of a space current: on each notification it calls listRepoOps for the changed writer and reports every record change to its owner.

**Status update** (hivemind notation): Record `com.hivemind-network.task.statusUpdate` that the assigned agent writes into the task space: `status` (`accepted`, `enRoute`, `arrived`, `inProgress`, `completed`, `failed`), position, ETA and note. ROS action feedback; `completed` is the result.

**subscribeRepos** (atproto term): Method `com.atproto.sync.subscribeRepos`, the WebSocket stream behind the firehose.

**Subscription** (atproto term): Lexicon type for an event-stream method delivered over WebSocket, such as subscribeRepos. Unrelated to Hivemind's feed subscription records.

**Suspension** (hivemind notation): A participant's `suspended` status, e.g. after a failed payment. The coordinator deletes the certifications of the operator's agents (visible on the firehose) and refuses them in checkUserAccess, so they stop receiving dispatches. Credentials already issued run out within about 10 minutes; early revocation via notifyCredentialRevoked is not wired up yet.

## T

**Task** (hivemind notation): One unit of work a requester asks for, from request through dispatch, offers, ranking and assignment to completion. Identified by its task ID and tracked by the coordinator's `TaskManager`.

**Task ID** (hivemind notation): The identifier of a task, today `{request rkey}-{requester DID suffix}`. Derived rather than assigned, so the requester knows its task space the moment it writes the request. Planned change: an opaque hash with a nonce, because the current form reveals the requester to every agent that sees a dispatch.

**Task space** (hivemind notation): The member space of one task, `at://{coordinator DID}/space/com.hivemind-network.space.task/{task ID}`. The coordinator owns it and adds the requester right away; the winning agent joins at assignment. Holds the task state, selection, assignment, status updates and cancellation. Created when the request arrives today; planned to be created only at assignment and deleted after a retention period.

**Task state** (hivemind notation): Record `com.hivemind-network.task.state` (record key `self`) that the coordinator keeps current in the task space: phase, matched feeds, `respondBy`, ranked options, `selectBy` and assigned agent. The requester's view of progress.

**Task type** (hivemind notation): The NSID naming a kind of task and its payload lexicon, e.g. `com.hivemind-network.mobility.ride`. New task types (warehouse picks, charging slots) get their own lexicon under their own authority.

**Task type module** (hivemind notation): The coordinator-side code for one task type, implementing `TaskTypeModule` (`packages/coordinator/src/task-types/`): routing points, request and offer validation, scoring features, default weights and headline. Registered in the `TaskTypeRegistry`; `ride-task-type.ts` is the first.

**Taxi scenario** (hivemind notation): The first demo scenario: robotaxis of several operators in San Diego, public feeds Downtown San Diego, San Diego County, Southern California and West Coast, a private campus shuttle feed, and straight-line driving.

**Terms** (hivemind notation): The accepted offer's task-type payload (for rides: ETA, distance, duration, price, vehicle) as copied into an offer option and into the assignment. What the agent commits to.

**TID** (atproto term): Timestamp Identifier: a 13-character, sortable base32 string built from a microsecond timestamp and a clock ID. Used as record keys (requests, offers, subscriptions) and as repository revisions.

**Trace** (hivemind notation): `ProtocolTrace` in `packages/atproto-core/src/trace.ts`, the event log every component writes to: XRPC calls, commits, space writes, coordinator decisions. Shown in the protocol inspector and printed by `npm run headless`.

**Trusted coordinator** (hivemind notation): A coordinator DID an agent is configured to accept assignments from (`trustedCoordinatorDids` in `HivemindAgentOptions`). The agent checks the attestation against that DID's attestation key before it moves.

## V–X

**Validation** (hivemind notation): See Lexicon validation. Task type modules add semantic checks on top, e.g. that a ride's pickup and dropoff differ.

**Vehicle** (hivemind notation): The `vehicle` object in a ride offer: model, seat count and plate, so the rider knows which car to look for.

**Verification method** (atproto term): A public-key entry in a DID document, named by a fragment. atproto requires `#atproto` (the signing key); Hivemind adds `#hivemind_attestation` to the coordinator's document.

**Warehouse scenario** (hivemind notation): Planned second demo scenario: high-frequency tasks for warehouse robots in a private feed, the case the per-assignment fee is designed for.

**Writer set** (atproto term, Spaces alpha): All repos that have written into a space, each with its current revision, as listed by listRepos. Readers walk the writer set to collect a space's records.

**XRPC** (atproto term): atproto's HTTP RPC convention: methods at `/xrpc/{NSID}`, queries as GET and procedures as POST, with lexicon-defined inputs and outputs. Every call in Hivemind, simulated or real, follows it.

**XrpcTransport** (hivemind notation): Interface in `packages/atproto-core/src/xrpc.ts` that every component sends XRPC calls through. `SimXrpcNetwork` implements it in memory (with the per-hop delay); an HTTP transport replaces it when we move to real atproto infrastructure.
