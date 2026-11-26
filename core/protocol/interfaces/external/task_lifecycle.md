# Task lifecycle

The task lifecycle is Hivemind's action interface (the ROS `.action` analogue): the request is the goal, the assignment is the accepted goal, `agent.progress` records are the feedback, and `completed` or `failed` is the result. There is no method for it. The lifecycle runs entirely on records written into spaces, and this file is its definition.

Record names below drop the `com.hivemind-network.` prefix.

## Phases

The coordinator keeps the phase in `coordinator.taskState` (record key `self`) in the task space.

| Phase | Entered when | Coordinator does | Leaves to |
| --- | --- | --- | --- |
| `collecting` | The coordinator reads a valid `requester.request` in the request intake space and at least one feed matches. | Creates the task space with the requester as member, writes `taskState`, writes one `coordinator.dispatch` per matched feed. | `awaitingSelection` (choose mode) or `assigned` (auto mode) once `respondBy` passes or every eligible agent has answered; `noOffers` if no offer was accepted or no agent that accepted is free. |
| `awaitingSelection` | Ranking is done in choose mode. | Writes the ranked `options` and `selectBy` into `taskState`, leaving out agents that hold another task. | `assigned` on a valid `requester.selection`; `noOffers` if no option's agent is free by then; `expired` once `selectBy` passes. |
| `assigned` | The best offer (auto) or the selected one (choose) wins, from an agent that holds no other active task (see [One task per agent](#one-task-per-agent)). | Writes `coordinator.assignment`, adds the winning agent to the task space, clears `options`, sets `assignedAgent`, deletes all dispatches of the task. | `completed` or `failed` when the assigned agent writes `agent.progress` with that status. |

End phases: `completed`, `failed`, `cancelled`, `noCoverage`, `noOffers`, `expired`. Once a task reaches one, nobody writes to its space any more, except the coordinator repeating the end phase until the space shows it (see [Failed writes](#failed-writes)).

| End phase | Cause |
| --- | --- |
| `noCoverage` | No feed accepts the task type and covers its routing points (for rides, the pickup), so nothing is dispatched. The task space is still created so the requester can read this phase. |
| `noOffers` | The answer window closed without an accepted offer, or every agent that accepted holds another task when the coordinator assigns. |
| `expired` | Choose mode, and the requester did not select before `selectBy`. |
| `cancelled` | The requester deleted its `requester.request` before an end phase. |
| `completed`, `failed` | Reported by the assigned agent. |

## Deadlines

- `respondBy` = dispatch time + the longest `answerWindowMs` among the matched feeds, capped by the request's `maxWaitMs`.
- Collection ends early once every eligible agent has written an offer (accept or decline).
- `selectBy` = ranking time + the coordinator's selection window (a coordinator setting, not part of the protocol).

## Who learns what

- **Requester**: reads `taskState`, `assignment` and `agent.progress` in its task space. It knows the task space address from the moment it writes the request, because it chose the task ID.
- **Agents**: see only dispatches, with coarsened locations and no requester. An agent learns that it won when the coordinator grants it access to the task space; losing agents are simply refused, so nothing leaks to them. A deleted dispatch means the call for offers is over.
- **Winning agent**: verifies the assignment's attestation against a coordinator it trusts before acting. The assignment carries the exact request.

## Rules readers enforce

A PDS grants access per space, not per collection. Readers therefore drop records written by the wrong role; the allowed writers per collection are in `type_definition/policy_types/`. In particular:

- The coordinator ignores a `selection` from anyone but the task's requester, and `progress` from anyone but the assigned agent.
- Agents and requesters ignore `taskState`, `assignment` and `dispatch` records not written by the coordinator.
- The coordinator ignores offers at or after `respondBy` and offers with `decision: accept` but no payload.
- A `requester.request` record is read once. Changing it later, even to a new task ID, does nothing; to change a request, the requester deletes it (which cancels the task) and writes a new one.
- An `agent.offer` record belongs to the task it was first written for, as long as it is the agent's current offer for that task. Changing it to name another task does nothing. A new offer for the same task replaces the agent's earlier one; the earlier record is then no longer tied to the task, and changing it counts as a new offer.

## One task per agent

An agent holds at most one active task: from its assignment until the task reaches an end phase. The coordinator checks this as the last step before it assigns, and reserves the agent in the same step, so two tasks that close at the same moment cannot both take one agent (ADR-008).

- Auto mode: the best offer from an agent that is still free wins. Offers from agents busy with another task are skipped.
- Choose mode: the options leave out agents that hold another task when ranking ends. If the selected agent has taken another task since, the next free option in ranked order is assigned instead.
- With no free agent left, the task ends in `noOffers`.
- An agent may offer on several tasks at once. Once it is assigned one, its other offers are skipped; it should also withdraw them, so the tasks they were for can close early.

## Failed writes

The coordinator stores every phase change before it writes it into the spaces. If a write fails (a space host cannot be reached), it tries again, after one second at first and then with a doubling delay of at most one minute, and again after a restart, until the spaces show the stored phase. Every write it makes can be repeated without changing the result.

- Participants may see a phase late, but never one the coordinator has not decided.
- Deadlines (`respondBy`, `selectBy`) run on the stored phase, not on what a space shows. A choose-mode requester whose options appear late has correspondingly less time to select.
- Each assignment is billed once, however often its writes are repeated.
