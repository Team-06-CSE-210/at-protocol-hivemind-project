# Hivemind Preliminary Prototype Summary

Nov 9, 2026 · @Philipp

Hivemind is a ROS-inspired open standard plus a coordination service that lets people hand tasks to autonomous systems (robotaxis, warehouse robots, EV chargers) over the AT Protocol. The prototype runs the whole system on one machine: a simulated atproto network including the Spaces permissioned-data alpha, the Hivemind coordinator, open SDKs for agents, requesters and organizations, and a San Diego robotaxi demo on a map.

It shows that registration, routing into feeds, private offers, ranking, signed assignment and progress reporting can all run on atproto records and spaces, without a request ever reaching a relay or a competing operator.

New to the project? Read the system overview and the component list first, then follow Process 4, one ride from request to drop-off. Every term is defined in Hivemind Glossary. This is a prototype, not production software: Spaces is itself an alpha (build of 2026-10-29), and `network.hivemind` is a placeholder namespace until a domain is registered.

## System at a glance

&#91;embedded content: system composition · who runs what, who calls whom\]

Requests, offers, dispatches and assignments move only as space records through the Hivemind PDS; only profiles, feed declarations, subscriptions and certifications reach the relay. Riders and agents also call the coordinator API to register and to look up the intake space. The database is dashed because it is in memory in the prototype.

## Components and responsibilities

The system has three kinds of client software, two kinds of PDS, one coordinator service and the shared atproto network. Only the coordinator contains Hivemind's business logic; both PDS kinds are standard atproto software.

| Component | Run by | Responsibilities | Code |
| --- | --- | --- | --- |
| Rider app | End users (app by Hivemind or third parties) | Registers the rider; writes requests into the intake space through the rider's own PDS; follows the task space; writes selections and cancellations | `HivemindRequester` in `packages/sdk` |
| Org console | Operators and feed owners | Registers the organization; enrolls agents; publishes and updates feed declarations; edits private-feed allowlists; shows billing | `HivemindOrganization`; demo tabs Feeds and Operators & billing stand in for a UI |
| Agent runtime | Operator, on or for each vehicle | Publishes the agent profile and feed subscriptions; joins feed spaces; decides on each dispatch and writes an offer; finds out whether it won; verifies the signed assignment; reports status until done | `HivemindAgent` plus the operator's `AgentBehavior` |
| Hivemind PDS | Hivemind | Standard, invite-only PDS. Hosts rider accounts, the coordinator's account and agents of operators that do not self-host. As the coordinator's PDS it is the space host of every Hivemind space: issues space credentials after access checks, orders writes with spaceRev, forwards notifyWrite to registered services | Simulated in `packages/atproto-sim`; real: the spaces-alpha PDS image |
| Coordinator | Hivemind only | Indexes public records, keeps registry and billing, owns all spaces (their DID authority), answers access checks as managing app, routes requests, ranks offers, signs assignments | `packages/coordinator` |
| Coordinator database | Hivemind | Operational state that is not protocol data: participants, billing, allowlists, feed-to-space map, task state machines, indexed public records | In memory today; JSON-file mock next, then Postgres |
| Matching service | Hivemind (planned) | Ranking and, later, fleet optimisation behind a `MatchingEngine` interface, possibly in Java or Kotlin | Ranking runs in TypeScript today |
| Operator PDS | Operator (optional) | Same PDS software. Hosts the operator's and its agents' accounts and keys; is the repo host of their offers and status updates; calls notifyWrite on the space host after each write | Any atproto PDS with Spaces support |
| Relay | Bluesky or anyone | Crawls PDSes and merges public commits into the firehose; never sees space data | Simulated `SimRelay`; real: `com.atproto.sync.subscribeRepos` |
| PLC directory and did:web | Bluesky (PLC); Hivemind (its domain) | Resolve DIDs to DID documents: signing keys, PDS address, Hivemind service entries | `IdentityResolver` |

### Inside the coordinator

| Module | Responsibility |
| --- | --- |
| `PublicRecordIndexer` | Reads the firehose; validates and indexes agent profiles, feed declarations, feed subscriptions |
| `ParticipantRegistry` | Registration, agent enrollment, suspension and reactivation; publishes and deletes certification records |
| `BillingLedger` | Flat monthly fee per agent; per-assignment fee above the included quota; invoice preview |
| `FeedDirectory` | Creates one managed space per accepted feed declaration; holds allowlists; decides who may read a feed and who may post into it |
| `RequestRouter` | Picks the matched feeds for a request: task type, coverage, requester access |
| `rankCandidates`, `resolveScoringWeights` | Ranking by weighted, normalised features; decides default or custom weights |
| `TaskManager` | The per-task state machine: task space, dispatch, answer window, offers, ranking, selection, assignment, status, cancellation |
| `TaskTypeRegistry` | One `TaskTypeModule` per task type (rides today): routing points, validation, scoring features, default weights |
| `buildCoordinatorApi` | XRPC endpoint: `checkUserAccess`, `coordinator.describe`, `registry.*`, `feed.*`, plus the notifyWrite receiver |

### Identities

| Participant | DID | Extra DID document entries |
| --- | --- | --- |
| Coordinator | `did:web:hivemind.network` (placeholder) | Service `#hivemind_coordinator` (its API endpoint); key `#hivemind_attestation` (signs assignments) |
| Agent | did:plc on the Hivemind PDS or the operator's PDS | Service `#hivemind_agent` (its endpoint for forwarded notifyWrite calls) |
| Rider, operator, feed owner | did:plc | None; only the standard `#atproto` key and `#atproto_pds` service |

## Where data lives

Hivemind splits its data into two layers. Who a participant is and which feeds exist is public; everything about a concrete task lives in spaces, which never reach a relay. Every record stays in its author's own repository on the author's own PDS; a space only decides who may read it and who may write into it.

| Record (`network.hivemind.…`) | Layer | Written by, into | Readable by |
| --- | --- | --- | --- |
| `agent.profile` | Public | Agent, own public repo | Everyone (firehose) |
| `feed.declaration` | Public | Feed owner, own public repo | Everyone |
| `feed.subscription` | Public | Agent, own public repo | Everyone |
| `registry.certification` | Public | Coordinator, own public repo | Everyone; deleting it suspends the subject |
| `task.request` | Intake space | Requester, own repo in the space | Coordinator only |
| `task.offer` (accept or decline) | Intake space | Agent, own repo in the space | Coordinator only |
| `task.dispatch` | Feed space | Coordinator | Agents authorized for that feed |
| `task.state` (phase, ranked options) | Task space | Coordinator | Requester; the winning agent after assignment |
| `task.selection`, `task.cancellation` | Task space | Requester | Coordinator; the assigned agent |
| `task.assignment` (signed) | Task space | Coordinator | Requester and the assigned agent |
| `task.statusUpdate` | Task space | Assigned agent | Requester and coordinator |

Message types are lexicons in `packages/protocol/lexicons/network/hivemind/`, the counterpart of ROS `.msg` files. Because atproto records cannot hold floats, positions are integers in degrees × 10⁷ (`latE7`, `lonE7`), money is in minor units with a currency code and scores run from 0 to 1000. Task payloads are open unions, so a new task type adds its own lexicon without touching the core records.

The coordinator also keeps its own database. The rule of thumb: what other participants must see or verify goes into atproto records (public or in spaces); what only Hivemind needs to run (registry, billing, task state machines, indexes) goes into the database.

## Spaces in one request

One ride touches three kinds of space: the single intake space, one feed space per matched feed, and the task's own space. The coordinator's DID is the authority of all of them, so all of them are hosted on the Hivemind PDS.

| Space | How many | Policy | Who writes | Who reads | Created |
| --- | --- | --- | --- | --- | --- |
| Intake `…/space/network.hivemind.space.intake/main` | 1 per coordinator | Managed; managing app = coordinator | Active requesters (requests), active agents (offers) | Coordinator only | At coordinator start |
| Feed `…/space/network.hivemind.space.feed/{rkey}.{owner}` | 1 per feed; a ride hits 1 to 4 in the demo | Managed; managing app = coordinator | Coordinator (dispatches) | Agents that are certified, paid for, subscribed, support the task type and, for private feeds, are allowlisted | When the coordinator first indexes the declaration of a registered owner |
| Task `…/space/network.hivemind.space.task/{taskId}` | 1 per request | Member space: explicit member list | Coordinator, requester, assigned agent | Same three | When the request arrives (planned: only at assignment) |

### How a space works, mechanically

1. **Writing.** A participant writes a space record to its own PDS (`com.atproto.space.createRecord`). That PDS, the repo host, stores it in the writer's permissioned repo for the space and calls `notifyWrite` on the space host.
2. **Write check and ordering.** The space host checks that the writer may write (for managed spaces it asks the coordinator through `checkUserAccess`), stamps the write with the next `spaceRev` and forwards the notice to every service registered with `registerNotify`.
3. **Getting read access.** A reader asks its own PDS for a single-use delegation token, sends it to the space host's `getSpaceCredential`, and receives a credential valid for about 10 minutes, bound to a fresh key. For managed spaces the host first asks the coordinator.
4. **Reading.** With the credential plus a request proof signed by the bound key, the reader calls `listRepoOps` on the writer's repo host to fetch what changed since the last revision it saw.
5. **Staying informed.** Readers register an endpoint with `registerNotify` (valid 24 hours) and sync on every forwarded notification instead of polling. The rider app still polls in the prototype.

Spaces are access control, not encryption: the PDS operators that store a record can read it.

## Process 1: registering a new end user

A rider needs an atproto account and a registration with the coordinator; nothing public says that the account uses Hivemind. Actors: rider app, Hivemind PDS, PLC directory, coordinator.

1. **Invite.** The rider app obtains an invite code for the Hivemind PDS, which is invite-only. (In the demo the scenario mints one; in production the app's sign-up backend would.)
2. **Account.** The app calls `com.atproto.server.createAccount` on the Hivemind PDS with handle and invite code (plus email and password in production).
3. **Keys and DID.** The PDS generates the account's signing key and keeps it. It registers a new did:plc in the PLC directory; the DID document names the handle, the `#atproto` key and the Hivemind PDS as `#atproto_pds`.
4. **Repository.** The PDS creates the rider's empty public repository with a first signed commit. The relay sees that the account exists, as for any atproto account.
5. **Session.** The PDS returns access and refresh tokens to the app.
6. **Service auth token.** The app asks its PDS for a service auth token (`com.atproto.server.getServiceAuth`) with `aud` = the coordinator's service and `lxm` = `network.hivemind.registry.register`.
7. **Registration call.** The app calls `network.hivemind.registry.register` on the coordinator with `{role: requester, displayName}` and the token.
8. **Verification.** The coordinator resolves the rider's DID, takes the `#atproto` key from the DID document and checks the token's signature, audience, method and expiry.
9. **Registry entry.** The registry stores `{did, role: requester, status: active}` in the coordinator's database. Requesters pay nothing and get no public record.
10. **Answer.** The coordinator returns `{status: active}`. From now on, `checkUserAccess` lets this DID write into the intake space.
11. **Discovery.** Before its first request, the app calls `network.hivemind.coordinator.describe` and learns the intake space, the attestation key ID and the supported task types.

A rider who already has an atproto account elsewhere skips steps 1 to 5 and registers the existing DID; its requests are then written through its own PDS.

## Process 2: registering an organization and its first agent

An operator registers once, then enrolls each agent; an enrolled agent publishes itself and joins its feeds. Actors: org console, operator's PDS (or the Hivemind PDS), coordinator, relay, agent runtime, space host.

### Operator account

1. **Hosting choice.** The operator either takes accounts on the Hivemind PDS (invite code) or deploys its own Spaces-capable PDS under its own domain.
2. **Account.** `createAccount` for the operator on the chosen PDS creates its did:plc, exactly as in Process 1.
3. **Registration.** The org console gets a service auth token and calls `network.hivemind.registry.register` with `{role: operator, displayName}`.
4. **Billing account.** The coordinator verifies the token, stores the operator as active and opens its billing account. Payment details go to a payment provider, off-protocol (not built yet).

### Agent account and enrollment

5. **Agent account.** The operator creates an account for the vehicle (e.g. `robotaxi-1.fleet.example`) on its PDS. The DID document also gets a `#hivemind_agent` service entry pointing at the agent runtime's endpoint, which is where notifications will arrive.
6. **Enrollment call.** The org console calls `network.hivemind.registry.enrollAgent` with `{agent: <agent DID>}`, authenticated as the operator.
7. **Checks and billing.** The coordinator checks that the operator is registered and active, stores the agent with its operator, and starts the agent's flat monthly fee.
8. **Certification.** The coordinator writes a `registry.certification` record `{subject, role: agent, operator, plan}` into its own public repo. The commit goes through the relay, so anyone can see that this agent is in good standing.
9. **Private feeds (optional).** The owner of each private feed the agent should serve adds it with `network.hivemind.feed.putMember {feed, did, role: agent}`.

### Agent comes online (`HivemindAgent.start`)

10. **Profile.** The agent writes `agent.profile` (record key `self`) to its public repo: display name, kind, operator DID, supported task types, capabilities (seats, pricing, maximum pickup distance) and operating area.
11. **Subscriptions.** For every feed it wants to serve it writes a `feed.subscription` record naming the feed.
12. **Indexing.** The relay streams both commits; the coordinator's indexer validates them against the lexicons and indexes them.
13. **Discovery.** The agent calls `coordinator.describe` (intake space) and, per feed, `network.hivemind.feed.getFeed` (the feed's space reference).
14. **Credential request.** Per feed space, the agent gets a delegation token from its own PDS and calls `getSpaceCredential` on the space host with the key ID of a fresh key.
15. **Access check.** The space host asks the coordinator `checkUserAccess(space, agent, read)`. The coordinator says yes only if the feed is active, the agent and its operator are active, the agent subscribes to the feed, its profile supports one of the feed's task types, and the feed is public or the agent is allowlisted.
16. **Retry.** If the indexer has not yet seen the subscription, access is denied and the SDK retries with backoff (up to 10 attempts, 100 ms to 2 s); after that the feed is marked denied.
17. **Notifications.** With the credential granted, the agent calls `registerNotify` for the feed space with its `#hivemind_agent` service, so new dispatches are pushed to it.
18. **Catch-up.** The agent syncs the dispatches already in the space (`listRepos`, `listRepoOps`) and is now joined. It now costs USD 9.00 a month, with 1,000 assignments included.

Gap to close: the coordinator does not yet check that the enrolled agent agrees, e.g. that its profile names the enrolling operator.

## Process 3: setting up a feed

An interest group declares a feed in public; the coordinator backs it with a private space and decides who may use it. Actors: feed owner (org console), relay, coordinator, Hivemind PDS, agents.

1. **Owner account.** The interest group (city council, campus, warehouse, fleet) gets an account and registers with `{role: feedOwner}`. Feed owners pay nothing.
2. **Declaration.** It writes a `feed.declaration` record (record key = feed slug, e.g. `downtown`) to its public repo: display name, description, coordinator DID, coverage (`geoCircle` or `geoPolygon`), task types, access (`public` or `private`), answer window (50 ms to 10 min) and scoring settings (`default`, or `custom` weights).
3. **Indexing.** The relay streams the commit; the coordinator's indexer validates it. A declaration naming another coordinator is ignored. One whose owner has not registered yet waits and is adopted on registration.
4. **Feed space.** The coordinator creates the feed's managed space (`createSpace`, managing app = the coordinator's service), key `{rkey}.{owner DID suffix}`, and marks the feed active.
5. **Private allowlists.** For a private feed the owner calls `network.hivemind.feed.putMember {feed, did, role}` for every agent that may read it (`role: agent`) and every requester that may post into it (`role: requester`). The lists live only in the coordinator's database.
6. **Agents join.** Agents subscribe and join exactly as in Process 2, steps 11 to 18.
7. **Changing settings.** The owner rewrites the declaration under the same key, e.g. a longer answer window. The coordinator picks up the change from the firehose; it applies to requests that arrive afterwards.
8. **Removing access.** `feed.removeMember` takes a DID off an allowlist; new credentials and notifications are refused at once, credentials already issued expire within about 10 minutes. Deleting the declaration deactivates the feed: no more routing, no more reads.

What the owner cannot change is the matcher: the space belongs to the coordinator's DID, so routing, ranking and assignment stay with Hivemind. In the demo, the Feeds tab edits the answer window and lets the rider post into the private campus feed.

## Process 4: a ride from request to drop-off

This is the core of the protocol: 40 steps from the rider's tap to the rider leaving the car, every one of them a space record, a notification or a computation. Actors: rider app, Hivemind PDS (rider's PDS and space host), coordinator, agents with their PDSes. The drawn sequence follows in the next section.

### A. The rider asks

1. **Input.** The rider sets pickup and destination, picks *Pick the best for me* (`auto`) or *Let me choose* (`choose`), and may cap the wait (`maxWaitMs`).
2. **Request record.** The app writes `task.request` through its PDS: `com.atproto.space.createRecord` into the intake space, record key a fresh TID, value `{taskType: network.hivemind.mobility.ride, payload: {pickup, dropoff, passengerCount}, selectionMode, maxWaitMs}`.
3. **Task identity.** The app derives the task ID `{rkey}-{DID suffix}` and the task space address from it, and starts watching that space. Until the coordinator adds the rider, reads are refused and retried; the prototype app polls every 400 ms.
4. **Write notice.** The rider's PDS, as repo host, calls `notifyWrite` for the intake space on the space host (here the same PDS).
5. **Write check.** The space host asks the coordinator `checkUserAccess(intake, rider, write)`; an active requester passes. The host stamps the next `spaceRev` and forwards the notice to the coordinator's registered endpoint.
6. **Fetch.** The coordinator reads the new record with `listRepoOps` on the rider's repo in the intake space. Nobody else can read it.

### B. The coordinator routes

7. **Task record.** The task manager computes the task ID and ignores duplicates and inactive requesters.
8. **Task space.** It creates the task's member space (key = task ID), adds the rider with read and write rights, and registers for its notifications.
9. **Validation.** Lexicon check; task type supported; ride rules (pickup and destination not the same place). A failure ends the task in phase `failed`.
10. **Routing.** Matched feeds = every active feed that accepts rides, whose coverage contains the pickup, and that lets this rider post (public, or rider allowlisted). Sorted smallest area first. No match ends the task in phase `noCoverage`.
11. **Window, weights, eligible agents.** Answer window = the longest window of the matched feeds, capped by `maxWaitMs`; `respondBy` = now + window. Weights: custom only if all matched feeds share the same custom weights, otherwise 50 % pickup time, 40 % price, 10 % trip time. Eligible agents = every agent allowed to read at least one matched feed.
12. **State.** It writes `task.state` `{phase: collecting, matchedFeeds, respondBy}` into the task space, where the rider sees it.
13. **Dispatch.** Into each matched feed space it writes `task.dispatch` (record key = task ID): `{taskId, taskType, payload, feed, taskSpace, respondBy, state: open}`. The payload today includes the exact pickup and destination.
14. **Timer.** It sets a timer for `respondBy`. With no eligible agent at all, it closes at once (step 22).

### C. Agents answer

15. **Fan-out.** For every dispatch the space host forwards `notifyWrite` to each agent registered on that feed space, re-checking read access per delivery, so an agent cut off since joining gets nothing.
16. **Fetch.** Each agent reads the dispatch with `listRepoOps` on the coordinator's repo in the feed space, using its credential.
17. **Dedup.** The same task can arrive through up to four feeds; the agent answers once per task ID and skips dispatches past `respondBy`.
18. **Decision on board.** The operator's `AgentBehavior` decides: available (not busy, charging or in maintenance), pickup inside the operating area and within maximum pickup distance, enough seats. If yes it computes pickup ETA, trip distance and duration, and price (base fare + per km + per minute).
19. **Offer.** The agent writes `task.offer` into the intake space through its own PDS: `{taskId, feed, decision: accept, payload: {etaToPickupSeconds, tripDistanceMeters, tripDurationSeconds, price, vehicle}, agentState}`, or `decision: decline` with a reason.
20. **Delivery.** The agent's PDS (operator PDS or Hivemind PDS) calls `notifyWrite`; the space host checks that the agent is active and forwards to the coordinator, which fetches the offer. Neither the rider nor other operators can read it.

### D. The coordinator ranks

21. **Offer check.** Each offer must be lexicon-valid, name a feed the task went to, come from an agent allowed to read that feed, and carry valid terms (enough seats). Offers after closing are ignored.
22. **Closing.** Collection ends when every eligible agent has answered (early close) or at `respondBy`.
23. **No offers.** With no acceptable offer, every dispatch is closed with `closedReason: noOffers` and the task ends in phase `noOffers`.
24. **Ranking.** Per scoring feature (pickup ETA, price, trip time) the values are min-max normalised across the offers, inverted because lower is better, weighted and added up to a score from 0 to 1000. The top five become offer options `{optionId, agent, names, score, headline, terms}`.

### E. Selection

25. **Auto mode.** The best-ranked agent is assigned right away (step 28).
26. **Choose mode.** The task state turns `awaitingSelection` with the options and `selectBy` (60 s by default, 45 s in the demo). The rider app shows the options.
27. **Selection record.** The rider taps one; the app writes `task.selection {taskId, optionId}` into the task space, which reaches the coordinator through the usual write notice. Without a selection by `selectBy`, dispatches close as `expired` and the task ends in phase `expired`.

### F. Assignment

28. **Standing check.** The coordinator confirms the chosen agent is still active and paid for, falling back down the ranking otherwise.
29. **Membership.** It adds the winner to the task space with read and write rights (`putMember`).
30. **Signed assignment.** It builds `{taskId, taskType, agent, requester, taskSpace, request, terms, assignedAt}`, signs it with the `#hivemind_attestation` key, and writes it as `task.assignment` (record key `self`) into the task space.
31. **State.** `task.state` turns `assigned` with the assigned agent.
32. **Dispatches closed.** Every dispatch is rewritten with `state: closed, closedReason: assigned`. Membership and assignment come first on purpose, because closing is the signal agents react to.
33. **Metering.** The billing ledger counts the assignment for the agent's operator.

### G. Agents learn the outcome

34. **Win or lose.** Every agent with an open offer sees its dispatch close. If the reason is `assigned`, it asks for a credential for the task space: refused means lost, granted means won. Losers learn nothing else about the task.
35. **Winner syncs.** The winner registers for the task space's notifications and reads the assignment.
36. **Safety check.** It verifies the signature against the `#hivemind_attestation` key in the coordinator's DID document, that the signer is a coordinator it trusts, and that the assignment names itself. Otherwise it does not move.

### H. The ride

37. **Accepted.** The agent writes `task.statusUpdate {status: accepted, position, etaSeconds}` into the task space and drives to the pickup.
38. **En route and arrival.** Periodic `enRoute` updates with position and ETA, then `arrived` at the pickup.
39. **On board.** After boarding, periodic `inProgress` updates until the destination.
40. **Completed.** When the rider gets out, the agent writes `completed`; the coordinator sets the task state to `completed`. A `failed` update ends the task as `failed` instead.

Each status update follows the same path: the agent's PDS, a write notice, the space host, then the coordinator (notified) and the rider (polling). At any point before the end the rider can write `task.cancellation`; see Process 5.

## Process 4 at a glance

&#91;embedded content: Process 4 as a sequence · 25 messages in 8 phases\]

The agent never calls the coordinator during a ride, and the rider never sees an offer it was not shown: everything is a space record on a PDS plus a notification. The highlighted message is the one that lets the winner move, the assignment signed with the coordinator's attestation key.

## Process 5: suspension, cancellation and other endings

Outside the normal ride, three things change the outcome: an operator's failed payment, a rider's cancellation and the timeouts. All of them are decided by the coordinator and announced through the same records.

### An operator's payment fails

1. **Trigger.** The payment provider reports a failed payment. (Demo: *Simulate failed payment* in the Operators & billing tab; production: an authenticated admin API or a provider webhook.)
2. **Status.** The registry sets the operator to `suspended`. Its agents count as inactive from this moment, because an agent is only as active as the operator paying for it.
3. **Public signal.** The coordinator deletes the certification record of each of the operator's agents. The deletions travel over the firehose, so anyone relying on Hivemind's vetting sees them.
4. **Feeds cut off.** `checkUserAccess` now answers no for these agents: no new credentials, no forwarded dispatch notifications, and their offers are neither forwarded nor accepted.
5. **Running work.** An agent already assigned to a task stays a member of that task space and can finish the ride. A rider's selection of a suspended agent falls back to the next-ranked agent.
6. **Credentials.** Credentials already issued run out within about 10 minutes; revoking them early with `notifyCredentialRevoked` is not wired up yet.
7. **Reactivation.** Once paid, the operator is set active again, certifications are republished, and the agents rejoin their feeds (Process 2, steps 14 to 18).

### The rider cancels

1. The rider app writes `task.cancellation {taskId, reason}` into the task space.
2. The coordinator, notified as usual, ignores it if the task has already ended. Otherwise it stops its timers.
3. If no agent was assigned yet, every dispatch is closed with `closedReason: cancelled`, and agents holding an open offer release it.
4. The task state turns `cancelled`.
5. If an agent was already assigned, it sees the cancellation in the task space and stops the ride.

### Every way a task can end

| Phase | When | Dispatches closed as |
| --- | --- | --- |
| `completed` | The assigned agent reports `completed` | `assigned` (at assignment) |
| `failed` | The request fails validation, or the assigned agent reports `failed` | Not dispatched, or `assigned` |
| `noCoverage` | No feed matches task type, pickup and requester access | Not dispatched |
| `noOffers` | No acceptable offer by the end of the window, or no active agent left at assignment | `noOffers` |
| `expired` | Choose mode and no selection before `selectBy` | `expired` |
| `cancelled` | The requester cancels | `cancelled`, if not yet assigned |

## Decision rules

Five rules decide what happens to a request; all of them run in the coordinator and none can be moved to a feed owner or operator.

| Rule | How it works | Set by |
| --- | --- | --- |
| Routing | A request goes to every active feed that accepts its task type, contains all its routing points (rides: the pickup) and lets the requester post. A ride in downtown San Diego hits Downtown, County, Southern California and West Coast | Coordinator, from public feed declarations |
| Answer window | The longest `answerWindowMs` of the matched feeds (each 50 ms to 10 min), capped by the request's `maxWaitMs`. Ends early once every eligible agent has answered | Feed owners, capped by the requester |
| Weights | Custom weights apply only when every matched feed has identical custom settings, e.g. a single private warehouse feed; mixed feeds use the task type's defaults, so no owner ranks another owner's agents | Task type defaults (rides 50 / 40 / 10); feed owners for custom |
| Selection | `auto`: best score is assigned at once. `choose`: up to five ranked options, selection window 60 s by default (45 s in the demo) | Requester per request; window per coordinator |
| Billing | Requesters and feed owners free. Operators: USD 9.00 per agent per month with 1,000 assignments included, then USD 0.002 per assignment. Payment off-protocol; entitlement on-protocol through certifications and live access checks | Hivemind |

### Ranking formula

For every scoring feature f, each offer i gets a goodness between 0 (worst value among the offers) and 1 (best value); all offers get 1 when their values are equal. For lower-is-better features such as price:

```latex
g_{i,f} = \frac{\max_f - x_{i,f}}{\max_f - \min_f}, \qquad \mathrm{score}_i = \mathrm{round}\left(1000 \cdot \frac{\sum_f w_f \, g_{i,f}}{\sum_f w_f}\right)
```

This is simple additive weighting (Hwang and Yoon, 1981). Ties keep arrival order. A different optimiser, e.g. fleet-wide assignment, can replace it behind the planned `MatchingEngine` interface without changing the protocol.

## Confidentiality

The architecture can run fully on atproto while keeping task data away from the public, relays and competitors, but not away from the services that store it, and the prototype still has three leaks to agents.

**Why requests never reach a relay.** Relays crawl only public repositories through `subscribeRepos`. Space records sit in separate permissioned repositories that are not part of the account's public repo or its commits, so no relay, App View or firehose consumer ever receives them. Reading them takes a space credential, which the space host issues only after the coordinator says yes.

**Who can read what today.**

| Party | Can read |
| --- | --- |
| Public, relays, App Views | Profiles, feed declarations, subscriptions, certifications; that an account exists. No requests, offers or assignments |
| Competing operators | Nothing of another operator's offers; dispatches only for feeds they are admitted to |
| Agents of a matched feed | The dispatch: exact pickup and destination, task ID |
| Winning agent | The task space: request, terms, rider DID, status |
| Hivemind (coordinator and PDS) | Everything: it is the authority and stores rider data |
| An operator running its own PDS | Its own agents' offers and status updates |

**Spaces are access control, not encryption.** Whoever runs a PDS that stores a record can read it. Hivemind therefore acts as data processor for riders (GDPR), and end-to-end payload encryption (HPKE) is an option for regulated deployments.

### Known leaks and planned fixes

| Issue in the prototype | Planned fix |
| --- | --- |
| The task ID `{rkey}-{DID suffix}` reveals the requester's DID to every agent that sees a dispatch | Opaque task ID: a hash of the request URI and a secret nonce (how the requester then finds its task space is still open) |
| Every eligible agent sees the exact pickup and destination | Coarse location (cell or district) and trip length in the dispatch; exact addresses only in the assignment |
| Dispatches are never deleted | Delete them once the task closes |
| A task space is created for every request, even without a match | Create it lazily at assignment, delete it after a retention period |
| Requests and offers share one intake space | A separate offers space per feed, so replies do not mix with requests |
| One authority for everything | Shard spaces across several coordinator DIDs and PDS instances as load grows |

## Path to a deployed system

Moving off the simulation means swapping four interface implementations, not rewriting services: the coordinator, SDKs and clients never import the simulation.

| Interface (`@hivemind/atproto-core`) | Simulation today | Deployed |
| --- | --- | --- |
| `XrpcTransport`, `XrpcServerHost` | In-memory `SimXrpcNetwork` with a configurable delay per hop | HTTP: `fetch` for calls, a small HTTP server or `@atproto/xrpc-server` for the coordinator and agent endpoints |
| `IdentityResolver` | `SimIdentityDirectory` (did:plc and did:web) | PLC directory (local or public) and `did.json` over HTTPS; handles via DNS or `.well-known` |
| `FirehoseSource` | `SimRelay` | Relay `subscribeRepos`, Jetstream or Tap, filtered to `network.hivemind.*` |
| Spaces client under `SpaceReader` | Simulated alpha semantics, JWS request proofs | The alpha SDK's space client: RFC 9421 request signatures and MAC checks |

### Deployment layout

| Part | Technology | Notes |
| --- | --- | --- |
| Hivemind PDS | The spaces-alpha PDS Docker image (`ghcr.io/bluesky-social/atproto:pds-spaces-alpha`) on its own domain | Creating it means deploying the image, DNS, a PLC identity per account. It is a database with a protocol around it: per-account signed repositories with a standard API, portable to other PDSes |
| Coordinator | TypeScript service, close to the atproto SDKs | did:web identity on Hivemind's domain with the attestation key and service entry in `did.json` |
| Coordinator database | JSON-file mock first, then Postgres | Holds what only Hivemind needs: registry, billing, allowlists, task state, indexes. Records others must see or verify stay in atproto |
| Matching service | Optional separate service, e.g. Java or Kotlin with Timefold or OR-Tools, behind `MatchingEngine` | Worth it once optimisation goes beyond ranking one task's offers (fleet-wide assignment, batching); the protocol code stays in TypeScript |
| Operator PDS | Same PDS image, run by the operator | Optional; agents can stay on the Hivemind PDS |
| Lexicons | Published under a registered domain | Rename `network.hivemind`, publish schemas with `goat` or the `lex` tool |

### Steps to run on the Spaces alpha

1. Implement the HTTP transport and server host.
2. Implement identity resolution against PLC and did:web.
3. Run the spaces-alpha PDS locally; add the `#hivemind_*` service entries and the attestation key through PLC operations or `did.json`.
4. Put the alpha SDK's space client under `SpaceReader` and `SpaceSyncer`.
5. Implement `FirehoseSource` on a relay subscription.
6. Register a domain, rename the lexicon authority and publish the lexicons.
7. Re-run the end-to-end tests against the real stack; they use only SDK and coordinator APIs.

The alpha is free to run locally but warns of breaking changes and data loss, so nothing sensitive goes on it.

## Rebuild plan

The system is being rebuilt from scratch in a clean repository, in nine increments ordered by importance, with every interface fixed in increment 1 so team members can work in parallel against fakes. Message types are split into general ones and application-specific ones (e.g. `applications/autonomous_taxi`), kept as general as possible: the same behaviour gets the same message type.

| # | Increment | Builds | Done when |
| --- | --- | --- | --- |
| 1 | Skeleton and contracts | Monorepo, TypeScript setup, test harness, every interface below as types only | Typecheck passes and the team has reviewed the interfaces |
| 2 | Message types | General and application-specific lexicons, generated types, validator, a sample per record | Every sample validates; invalid ones are rejected |
| 3 | Coordination core | Routing, answer window, ranking, task state machine, ride task type, default matching engine; pure logic on fakes | A ride runs from request to assignment in unit tests, without network code |
| 4 | Stores and registry | Registry, billing, feed and task stores with JSON-file implementations | State survives a restart |
| 5 | Identity and auth | Keys, DIDs, DID documents, service auth tokens, identity resolution | Forged, expired or misaddressed tokens are refused |
| 6 | Public layer | Public repos, simulated relay and firehose, indexer, profiles, declarations, subscriptions, certifications | The coordinator picks up a new feed and agent from the firehose |
| 7 | Spaces and SDKs | Space client (simulated authority and repo host), credentials, notifications; agent, requester and organization SDKs | An end-to-end ride passes over simulated spaces |
| 8 | Demo | Demo server and map UI | A ride can be requested and watched on the map |
| 9 | Real infrastructure | HTTP transport, PLC and did:web, the spaces-alpha PDS | End-to-end tests pass against a local alpha stack |

### Interfaces fixed from the start

| Interface | Responsibility | Implementations |
| --- | --- | --- |
| `XrpcTransport`, `XrpcServerHost` | Make and serve XRPC calls | Simulated network; HTTP |
| `IdentityResolver` | DID to DID document, handle to DID | Simulated directory; PLC and did:web |
| `FirehoseSource` | Stream of public repo commits | Simulated relay; relay, Jetstream or Tap |
| `SpaceClient` (proposed) | Create spaces, write and read space records, credentials, notifications | Simulation; alpha SDK |
| `TaskTypeModule` | Routing points, validation, scoring features, default weights, headline per task type | Ride; later warehouse pallet move |
| `MatchingEngine` (proposed) | Rank one task's offers, later optimise across tasks | TypeScript ranking; Java or Kotlin service |
| `RegistryStore`, `FeedStore`, `TaskStore` (proposed) | Persist participants and billing, feeds and allowlists, tasks | In memory; JSON file; Postgres |
| `AgentBehavior` | Decide on dispatches, carry out assignments, handle cancellation | Taxi; later warehouse robot |

## Clarifying questions and answers

Seven decisions were taken before the first line of code; the review of the prototype then raised the questions in the second table.

### Decided at the start

| Question | Decision |
| --- | --- |
| Private channel for requests and offers | atproto Spaces, since the alpha needs no paid services; an own channel concept only as fallback |
| Infrastructure | Local simulation first, then the move to real atproto infrastructure |
| Relation to ROS | Inspiration only, no ROS interfacing. Stack: TypeScript, React, Leaflet; avoid bloat |
| Namespace | `network.hivemind` until a domain is registered |
| Feeds | Private feeds restrict both who sees and who posts. Default scoring with owner-customisable weights. Answer time adjustable per feed, for networks spanning the globe |
| Business model | Users free; flat monthly fee per agent plus a very small per-request fee for high-frequency use; the matching algorithm is hosted only by Hivemind, never by companies |
| Demo and scope | Taxi in San Diego first, structured for more scenarios; straight-line driving is fine. Customer-to-agent only; agent-to-agent later |

### Asked while reviewing the prototype

| Question | Short answer (details in this document) |
| --- | --- |
| How do I run it? | From the repository root: `npm install`, then `npm run demo`, then open http://localhost:8787. Needs Node 22 (via nvm; load nvm in the shell first) |
| Why does the map say an API key is required? | CARTO's free basemaps now need a key; the demo switched to OpenStreetMap tiles, overridable with `VITE_TILE_URL` |
| Can the architecture run fully on atproto and keep sensitive data confidential? | Yes towards the public, relays and competitors, through spaces. Not towards the PDS operators that store it, including Hivemind. Three leaks to agents remain (Confidentiality) |
| Where are the message types specified? | JSON lexicons in `packages/protocol/lexicons/network/hivemind/`, TypeScript types in `packages/protocol/src/types.ts`, checked with `@atproto/lexicon` |
| How do requests stay off relays, and what do spaces have to do with it? | Space records live in permissioned repos that relays never crawl; reading needs a credential the coordinator approves (Confidentiality; Spaces in one request) |
| Should the optimisation run on a backend, maybe in Java? Where do user and agent data live? | Yes, a separate matching service behind `MatchingEngine` is planned; Java or Kotlin is reasonable for heavy optimisation. Participant data goes into a database, a JSON-file mock first (Path to a deployed system) |
| How is the central intake notified of a new request? | The request sits in the rider's own repo; the rider's PDS calls `notifyWrite` on the space host, which forwards it to the coordinator registered with `registerNotify` (Process 4, steps 4 to 6) |
| What is the Hivemind PDS and how does it talk to the coordinator? | A standard PDS without business logic. The coordinator is an account on it and a separate service; it calls the spaces API, and the PDS calls back with `checkUserAccess` and `notifyWrite` |
| Should agents reply in the same intake space? | It works, since only the coordinator reads intake; a separate offers space per feed is planned |
| Does every match get its own task space, and does that scale? | Today every request gets one. Spaces are records, not servers; planned: create at assignment, delete after retention, shard authorities |
| How does an operator's PDS notify the Hivemind PDS? | After each space write, its PDS (repo host) calls `notifyWrite` with service auth on the space host |
| How is a space set up, how are agents added and removed, how is access authenticated? | The authority calls `createSpace`; member spaces use `putMember` / `removeMember`; managed spaces ask the coordinator on every check; readers use delegation token, credential and request proof |
| How do we create a PDS and store data in it; is it a database? | Deploy the PDS image under a domain and create accounts; data goes in through the repo and space APIs. A PDS is a database with a protocol around it: per-account, signed, portable, standard API. Hivemind's operational data belongs in the coordinator's database |
| What does an operator PDS hold and how does it live? | The operator deploys and keeps it online; it holds operator and agent accounts and keys, their public records and the permissioned repos of their offers and status updates. Accounts can migrate |
| Is the coordinator the authority, and where does the authority reside? | Yes: the coordinator's DID is the authority of every space; the spaces reside on its PDS (the Hivemind PDS), and the coordinator service is the managing app |
| What does a policy look like; is it a config file? | A protocol-defined record of one of three types, set at `createSpace` and changed with `updateSpace` within its type. Hivemind's own rules live in coordinator code and data and are applied through `checkUserAccess` |
| Which spaces does one request use, and what are the exact steps? | Spaces in one request; Processes 1, 2 and 4 |

## Open questions

Twelve points are still undecided; the first five block the privacy fixes and the move to real infrastructure.

- [ ] **Opaque task IDs:** with a non-derivable ID, how does the requester learn its task space?
- [ ] **Coarse dispatch locations:** what granularity (grid cell, district, radius) still lets agents price and decide?
- [ ] **Alpha behaviour:** does the space authority ask the managing app on every forwarded notification or only when issuing credentials? Can the coordinator's did:web register for notifications on its own spaces?
- [ ] **App permissions:** which OAuth `space:` scopes do the rider app and agent runtime need?
- [ ] **Suspension speed:** wire up `notifyCredentialRevoked`, or shorten credential lifetimes, so cut-off is immediate?
- [ ] **Requester updates:** a push channel for rider apps instead of polling the task space.
- [ ] **Enrollment consent:** how an agent confirms the operator that enrolls it, e.g. by matching the operator named in its profile.
- [ ] **Offers space per feed:** its policy, and how the coordinator correlates offers across feeds.
- [ ] **Retention and GDPR:** how long task spaces live, Hivemind's processor role, and whether payloads get HPKE encryption.
- [ ] **Billing:** payment provider, and what happens to the monthly fee during a suspension.
- [ ] **Domain:** which domain replaces `network.hivemind` for the published lexicons.
- [ ] **Next scope:** the warehouse scenario and agent-to-agent communication.

## Where things are

The prototype lives in the `at-protocol-hivemind-demo` repository; `npm run demo` serves it at http://localhost:8787, `npm test` runs the 20 unit and end-to-end tests, `npm run headless` prints one ride's protocol trace.

| Path | Contents |
| --- | --- |
| `packages/atproto-core` | atproto primitives: keys, DIDs, JWTs, service auth, space credentials, TIDs, AT-URIs, the XRPC, identity and firehose interfaces, trace |
| `packages/atproto-sim` | The simulated network: DID directory, PDS (public repos, Spaces repo host and authority), relay, XRPC transport |
| `packages/atproto-client` | Account sessions, `SpaceReader`, `SpaceSyncer`, notification receiver |
| `packages/protocol` | The open standard: `network.hivemind` lexicons, types, validation, geo helpers, task identity, assignment signing |
| `packages/coordinator` | The Hivemind service: indexer, registry and billing, feeds, routing, ranking, task manager, API |
| `packages/sdk` | `HivemindAgent`, `HivemindRequester`, `HivemindOrganization` |
| `apps/demo-server` | Boots network and scenario; streams snapshots and trace over WebSocket; taxi scenario |
| `apps/demo-web` | React and Leaflet map UI, feeds and billing panels, protocol inspector |
| `docs/` | `architecture.md`, `protocol.md`, `real-atproto-transition.md`, `extending.md` (adding a task type or scenario) |

All terms used here are defined in Hivemind Glossary.
