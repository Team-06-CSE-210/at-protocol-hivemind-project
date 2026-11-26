# Space Service

Carries out the coordinator's space operations through `SpaceService` (`core/protocol/interfaces/internal/space_service.ts`): setting up and following the request intake and the offer intake, writing and closing dispatches in feed spaces, creating task spaces, writing task states and assignments, and following task spaces.

| File | What it is |
| --- | --- |
| `atproto_spaces.ts` | `AtprotoSpaces`: the operations on atproto Spaces, using the coordinator's `AtprotoGateway` and `SpaceAuthority`. |

| Operations | Status |
| --- | --- |
| Task spaces: `createTaskSpace`, `writeTaskState`, `assign`, `watchTaskSpace` | done (S6, #29) |
| Offer intake: `setUpOfferIntake`, `watchOfferIntake` | implemented (S2 #27) |
| Request intake and combined setup: `watchRequestIntake`, `setUpIntakes` | open (S1 #23) |
| Feed spaces: `setUpFeedSpace`, `writeDispatch`, `closeDispatch` | open (S3 #25) |

Every write must be idempotent: the coordinator repeats a write until it succeeds, also after a restart, so a second call with the same input must leave the same result and must not fail because the first one already succeeded (ADR-007). Creating a space that exists rejects with `SpaceAlreadyExistsError` on both gateways; the service treats it as success. Members and the `self` records are put, so writing them again changes nothing.

The space layout itself (space types, policies, addresses) is protocol and stays in `core/protocol/`.

For S2, pass the coordinator's managed-space policy from `policy_types/offer_intake.json` to
`setUpOfferIntake(policy)` after replacing `{coordinator}` with its DID. The existing constructor
still takes the task-space policy. Combined `setUpIntakes` can call this method alongside request
intake setup when S1 is added.

`watchOfferIntake(onChange)` follows the coordinator's canonical offer inbox using its Gateway,
replaying current offers and forwarding later creates, updates and deletions. It filters unrelated
collections because space access is not collection-specific, and returns the Gateway's unsubscribe
function. `TaskRunner.start()` supplies the callback; its existing `handleOfferChange` validates
offers, checks eligibility and deadlines, stores responses and withdraws deleted offers. There is
no second collector in this service, and no Gateway implementation changes are needed.

The coordinator retries failed offer storage and withdrawals with the delays of ADR-007 while the
change can still matter (ADR-009): until its task stops collecting, and at most
`TasksConfig.maxAnswerWindowMs` after the change arrived. Retries go back through the record and
task queues, recheck deadlines and eligibility, and skip changes that were superseded. An answer
from the same agent for the same task that arrives later takes precedence over an earlier retry,
whatever its record key. Shutdown cancels retry timers. Every failed attempt is reported; the
retry queue is in memory, and after a restart the watch replays the intake.
