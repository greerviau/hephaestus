# The factory

The factory works only on factory projects, the repos listed under `projects` in the deployed config version, and only on issues it may work on.

## Intake

Every two minutes Hephaestus lists each factory project's open issues with `gh`. It records an issue it did not file as external, and an external issue waits for the owner to admit or reject it on the dashboard. An issue a factory role files with `file_issue` is admitted at once, unless the project already has `openIssueCap` factory-filed issues admitted whose card has not started a thread; then it waits for the owner too. Every admitted issue gets a card, and a card on the Hermes board for the lead.

A closed issue leaves the owner's queue and comes back if it is reopened, and closing an admitted issue before any thread starts abandons its card. `gh` lists at most 200 open issues, so an issue missing from a full list is read on its own: 10 such reads per poll split among the projects, with at least one for each, oldest first. The intake reads time out after 30 seconds, so a stalled project delays the next poll by a few minutes at most. Writes to GitHub take no timeout, because one that outlived it might still have happened.

### Attachments

`file_issue` takes an optional `attachments` list of absolute local file paths, such as an image the requester attached in a chat, which the planner reads from its cache on the Hermes host. Calls without it behave as before.

Hephaestus checks every file first: it must exist, be a readable regular file, and be at most 10 MB, and a call takes at most 10 files. Any type is accepted, and URLs are not. A bad file fails the call with an error that names it, and no issue is filed. Otherwise each file is committed through the GitHub API to the branch `hephaestus/attachments` of the target repo, which Hephaestus creates from the default branch when it is missing and uses for nothing else. A file lands at `attachments/<first 16 hex characters of its sha256>/<name>`, so filing the same file again reuses the existing commit. Characters in a name outside letters, digits, dot, underscore, and hyphen become underscores. The files are committed before the issue is created, so a failure after that can leave files on the branch with no issue; they are harmless.

The issue body gains an `Attachments` section with a commit-pinned link, the size, and the sha256 of each file, and images (png, jpg, gif, webp, svg) are embedded so they render on the issue. Because the files live on the branch, they outlive the planner's cache.

The implement thread's first message lists each attachment's path and commit when the issue links any, with the steps to fetch the exact bytes: `git fetch origin hephaestus/attachments`, then `git show <commit>:<path> > <destination>`. The engineer commits the file into its own branch where the task says; it never pushes to the attachments branch.

## The pipeline

- The lead starts a card with `start_work` and a brief. If the lead has not started an admitted card after `factory.autoStartMinutes` (10 by default; 0 waits for the lead), Hephaestus starts it from the issue.
- Hephaestus picks the ready worker with the fewest running factory threads, and the card stays on that worker. It clones the repo there as a T3 project once, then launches the implement thread on Factory Claude in a new worktree on the branch `factory/<install>-card-<id>`, where `<install>` is the first 8 characters of this install's id, so a reinstall's card 1 never reuses the last install's branch. The brief and the issue text go in the first message.
- The implement thread ends with a result block naming its PR and head commit. Only a PR from the card's branch, in the same repo, against the default branch counts. Hephaestus then launches a review thread on Factory Codex for that exact commit. When the reviewer asks for changes and the policy's `maxReviewRounds` remain, the findings go back to the implement thread.
- The card is escalated to the lead when the thread fails, asks a question, gives no valid result block, or runs out of review rounds. The lead restarts it with `start_work`, or escalates it to the owner with `escalate`.
- Before each thread start, and before each message that resumes a thread, Hephaestus checks the pause switch, that the worker is ready, and the limits in `factory.limits`: running factory threads per worker and overall, and thread starts per UTC day. A card that cannot start says why.

## The merge gate

Hephaestus merges a PR itself, squashing it, only when the project's policy allows it:

- Every check on the head commit passed, at least one ran unless the policy sets `allowNoChecks`, and every check named in the policy's `requiredChecks` ran and passed. Hephaestus reads every check run and status through `gh`'s paginated API, so the gate works without branch protection. It waits three minutes after a new head so slow checks can register, and a head still waiting for checks after an hour goes to the owner.
- Unless the policy is `yolo`, the other provider's review approved exactly that head commit.
- No changed file, including the old name of a renamed one, matches an escalation path, unless the owner approved that head on the dashboard.
- The policy allows auto-merge and does not have the owner approve every merge.

Otherwise the card is escalated with the reason: to the lead for failing checks or a missing review, and to the owner for escalation paths and owner approval. Hephaestus merges through GitHub's merge API, which answers with the merge commit, and puts `Merged by Hephaestus for card <id>.` in the squash commit. A PR someone else merged first is never taken for its own, and a merge whose reply was lost is recognized by that line. When GitHub cannot be read back to tell, the card goes to the owner. A PR that conflicts with its base branch, by GitHub's refusal or its mergeable state, goes back to the implement thread to bring in the base branch, as one more review round, or to the lead once `maxReviewRounds` is spent; the new head goes through the gate again. A conflicting revert PR goes to the owner. When GitHub refuses the merge with a 405 or 409 that is not a conflict, such as a branch that must be up to date, a required human review, or a merge queue, Hephaestus tries once more, and when the same head is refused again the card goes to the owner with GitHub's message, so the owner can change the rule or merge by hand; a revert PR is handled the same way. Network errors and server errors keep retrying in Merging. Agents are told never to merge. A factory PR merged by anything else ends its card, flagged, and Hephaestus never validates or reverts that merge.

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
