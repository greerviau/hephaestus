# The factory

The factory works only on factory projects, the repos listed under `projects` in the deployed config version, and only on issues it may work on.

## Intake

Every two minutes Hephaestus lists each factory project's open issues with `gh`. It records an issue it did not file as external, and an external issue waits for the owner to admit or reject it on the dashboard. An issue a factory role files with `file_issue` is admitted at once, unless the project already has `openIssueCap` factory-filed issues admitted whose card has not started a thread; then it waits for the owner too. Every admitted issue gets a card, and a card on the Hermes board for the lead.

## The pipeline

- The lead starts a card with `start_work` and a brief. If the lead has not started an admitted card after `factory.autoStartMinutes` (10 by default; 0 waits for the lead), Hephaestus starts it from the issue.
- Hephaestus picks the ready worker with the fewest running factory threads, and the card stays on that worker. It clones the repo there as a T3 project once, then launches the implement thread on Factory Claude in a new worktree on the branch `factory/card-<id>`. The brief and the issue text go in the first message.
- The implement thread ends with a result block naming its PR and head commit. Only a PR from the card's branch, in the same repo, against the default branch counts. Hephaestus then launches a review thread on Factory Codex for that exact commit. When the reviewer asks for changes and the policy's `maxReviewRounds` remain, the findings go back to the implement thread.
- The card is escalated to the lead when the thread fails, asks a question, gives no valid result block, or runs out of review rounds. The lead restarts it with `start_work`, or escalates it to the owner with `escalate`.
- Before each thread start, and before each message that resumes a thread, Hephaestus checks the pause switch, that the worker is ready, and the limits in `factory.limits`: running factory threads per worker and overall, and thread starts per UTC day. A card that cannot start says why.

## The merge gate

Hephaestus merges a PR itself, squashing it, only when the project's policy allows it:

- Every check on the head commit passed, at least one ran unless the policy sets `allowNoChecks`, and every check named in the policy's `requiredChecks` ran. Hephaestus reads every check run and status through `gh`'s paginated API, so the gate works without branch protection. It waits three minutes after a new head so slow checks can register, and a head still waiting for checks after an hour goes to the owner.
- Unless the policy is `yolo`, the other provider's review approved exactly that head commit.
- No changed file, including the old name of a renamed one, matches an escalation path, unless the owner approved that head on the dashboard.
- The policy allows auto-merge and does not have the owner approve every merge.

Otherwise the card is escalated with the reason: to the lead for failing checks or a missing review, and to the owner for escalation paths and owner approval. Hephaestus merges through GitHub's merge API, which answers with the merge commit, and puts `Merged by Hephaestus for card <id>.` in the squash commit. A PR someone else merged first is never taken for its own, and a merge whose reply was lost is recognized by that line. Agents are told never to merge. A factory PR merged by anything else ends its card, flagged, and Hephaestus never validates or reverts that merge.

## Validation and revert

After a merge, Hephaestus watches the merge commit's checks on the default branch. Every check that ran on the PR's head must run and finish there too. When one has not after an hour, the owner is notified and validation goes on, so a late failure still reverts. When they pass, the card is done. When they fail and the policy has `autoRevert`, Hephaestus opens GitHub's revert PR and merges it under the same gate, with its own review. It then reopens the issue, notifies the owner, and starts the card again from a new implement thread that is told about the revert.

## MCP server

The factory profiles reach Hephaestus through an MCP server on `127.0.0.1`, on the port after the dashboard's. Each profile has its own bearer token, kept in `~/.hephaestus/secrets.json` and in the profile's `.env`, and each role gets only its tools:

| Role     | Tools                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| planner  | `file_issue`, `get_status`, `list_cards`, `read_thread`                                    |
| lead     | `start_work`, `escalate`, `file_issue`, `get_status`, `list_cards`, `read_thread`          |
| improver | `propose_version`, `get_config`, `get_status`, `list_cards`, `list_threads`, `read_thread` |

Every call is recorded with the calling role, including calls to a tool the role does not have. `propose_version` creates a draft config version authored by the improver, with the factory threads it cites as evidence; it changes nothing until the owner approves it.
