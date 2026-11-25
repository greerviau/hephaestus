# Hephaestus

Hephaestus is a factory management layer on [T3 Code](https://github.com/pingdotgg/t3code) and [Hermes Agent](https://github.com/NousResearch/hermes-agent). It runs as a systemd user service on the Hermes host, keeps all of its state under `~/.hephaestus/`, and serves a dashboard behind a single password.

The MVP plan is in [issue #1](https://github.com/greerviau/hephaestus/issues/1).

## Requirements

- Linux with a systemd user manager
- Node.js 22.13 or newer and npm 11 or newer

## Install

```sh
npm ci
npm run build
node dist/cli.js install --port 7700 --skill ~/skills/review
```

`install` asks for the dashboard password, or reads it from the first line of stdin when stdin is not a terminal. The password must be 12 to 256 characters. Install then does these steps:

1. It records hashes of the owner's personal Hermes profiles, Claude and Codex config, and T3 settings in `~/.hephaestus/baseline.json`. `src/baseline.ts` lists the files it covers. It honours `HERMES_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `T3CODE_HOME`, and records the folders it used so uninstall checks the same ones. It follows symlinks, so a linked skill's contents count too.
2. It creates `~/.hephaestus/` with mode 700 and stores the password as a scrypt hash.
3. It creates config version 1 from the role and instruction templates in `templates/`, plus each `--skill` folder (a folder with a `SKILL.md`), and approves it.
4. It installs and starts `hephaestus.service` in `~/.config/systemd/user/` (or under `XDG_CONFIG_HOME`), and records the unit's path. It refuses to replace a unit file that is already there.
5. It waits until its own dashboard answers on the port. If any step fails, it removes the service and `~/.hephaestus/` again.

The dashboard listens on all interfaces on the chosen port, so other devices on the LAN can reach it. It uses plain HTTP, so the password and session cookie cross the LAN unencrypted. Sessions last 7 days. A client that sends 10 wrong passwords in 15 minutes is locked out for the rest of that window. The dashboard refuses any POST whose `Origin` is not the dashboard itself, so a page served from another port on the same host cannot act with the owner's session.

## Config versions

All factory config lives as numbered versions in `~/.hephaestus/state.db`: factory projects and their policies, the planner, lead, and improver roles, the instructions for factory threads, and skills. No repo holds them.

- Every edit creates a draft version with a diff against the version it was built from: the deployed version, or before the first deploy the newest approved one. A draft becomes approved or rejected, an approved version becomes deployed, and the version it replaces becomes superseded. Only a version built from the deployed version can be deployed, so deploying never drops changes made in between.
- Reverting a deployed version creates a draft that restores what that version changed. A change stays as it is when a later version changed the same value, or when undoing it alone would make the config invalid, and the page says how many such changes it left. The first version cannot be reverted.
- A project's policy starts from a preset, `standard` when none is given, and can override any setting. `yolo` merges when checks pass, with no review and no escalation paths. `standard`, the default, also needs an approving review from a different provider on the head commit and stops for changes under `.github/workflows/`. `strict` makes every merge wait for the owner. All three revert a factory merge whose checks fail, allow 2 review rounds, cap open factory-filed issues at 5, and need checks to run on a PR; `allowNoChecks` lets a repo without CI merge without them.
- The Settings page lists versions with their author and diff, and edits create versions. It can approve, reject, revert, and deploy. Deploying publishes the version to the config repo, applies it to the factory Hermes root, and starts a deploy thread on every worker (see Workers).
- The `factory` section sets which skills factory threads load (`threadSkills`), the model for each factory instance, the owner's own instance and model that run setup threads on a worker, and the thread limits.
- Every night at 03:00, Hephaestus writes all versions to `~/.hephaestus/backups/` and keeps the newest 14 backups.
- `~/.hephaestus/secrets.json` (mode 600) holds named secrets that config versions refer to by name. Backups leave it out, so secrets must be entered again after a restore.

## T3

Hephaestus drives this host's T3 server, and through it the linked worker environments, with T3's outside MCP server over loopback. It reads T3's port from `~/.t3/userdata/server-runtime.json` (or under `T3CODE_HOME`).

- Install records the absolute path of the `t3` CLI, because the systemd user manager's `PATH` is usually shorter than a login shell's. On first use, the service runs `t3 auth pairing create` for a 5-minute pairing code and signs itself in with it. No browser is needed. It keeps the 30-day token in `~/.hephaestus/secrets.json`, and signs in again 3 days before the token expires or when T3 rejects it, revoking its earlier session.
- It records every factory thread with its card, worker, provider instance, model, and config version, and copies each thread's activity into `state.db` while the thread runs. T3 updates items in place, so Hephaestus re-reads from the oldest item that is not final, and fetches the rest of any text T3 cut short. Restarts lose and duplicate nothing. Each thread is polled on its own and backs off up to 5 minutes after errors. A thread T3 no longer has is marked unavailable, and its history stays.
- T3 cannot send attachments to a linked environment, so content for a worker goes inline in the thread's first message.
- The Environments page lists the linked environments with reachability, access, and link expiry, and Overview warns 7 days before a link expires.
- Uninstall revokes the T3 sessions Hephaestus signed in.

`HEPHAESTUS_T3_INTEGRATION=1 HEPHAESTUS_T3_WORKER=<environment id> npx vitest run test/t3/integration.test.ts` runs one short thread on a real worker through this host's T3, then archives it and revokes its session.

## Workers

A worker is a linked T3 environment that the owner marked on the Environments page. Hephaestus sets each worker up through short T3 threads on the owner's own provider instance (`factory.setup` in the config), so the owner only signs the factory instances in.

1. Name a private config repo on the Environments page, such as `owner/hephaestus-config`. On the first deploy Hephaestus creates it, private, with `gh` when GitHub says it does not exist, and it refuses a repo that is not private. It pushes one tag per deployed version, named with this install's id, from a clone in `~/.hephaestus/config-repo`. Each worker needs `gh` signed in to an account that can read the repo; the deploy script uses it as git's credential helper.
2. Click Use as a worker. Approving a version in Settings deploys it to every worker, and Deploy on a worker retries. The deploy thread sends `templates/worker/deploy.sh` inline. The script fetches the version's tag, checks that its commit holds that version, installs it under `~/.hephaestus/` on the worker, and adds the Factory Claude (`hephaestus-claude`) and Factory Codex (`hephaestus-codex`) provider instances to T3's `settings.json`, changing no other setting. Writes to that file hold a lock and start over if T3 changed the file meanwhile. The script also keeps the owner's `~/.claude/CLAUDE.md` and `~/.agents/skills` out of factory threads. Hephaestus checks that the worker reports the commit it published.
3. Click Sign in Claude, open the thread "Hephaestus: sign in Factory Claude" on that worker in T3, and paste the token that `claude setup-token` prints into its secret card. The same token works on every worker.
4. Click Sign in Codex. The page shows a link and a code; approve the code in a browser within 15 minutes.
5. After each deploy and sign-in, Hephaestus runs a one-line test turn on each factory instance. The worker is ready once it runs the deployed version and commit, its last deploy succeeded, both test turns since that deploy passed, and T3 reports no problem with either instance.

A worker that is running factory threads gets a new version only after they finish, so a thread never sees instructions or skills change under it; it takes no new threads meanwhile. A failed deploy is retried after 30 minutes, and every worker is deployed again every 6 hours so owner skills added since stay out of Factory Codex. A launch whose reply from T3 was lost is replayed with the same request id (T3 scopes that id to Hephaestus's T3 session, so a replay after a sign-in change can start a second thread; see issue #21), and a task that stalls is given up after a timeout. T3 writes its `settings.json` with its own writer, which Hephaestus cannot lock: the deploy script checks the file just before replacing it, so only a T3 write in the moment between that check and the rename could be lost.

Uninstall stops the service, waits until T3 lists no Hephaestus setup thread as running on each worker, and then runs a cleanup thread there that signs the factory Codex out, removes both instances, and deletes `~/.hephaestus/`. If the logout or the instance removal fails, `~/.hephaestus/` stays on the worker so the cleanup can run again. If any worker cannot be cleaned up, uninstall changes nothing on this host, starts the service again, and names the workers; `uninstall --skip-workers` removes Hephaestus anyway. Revoke the Claude setup token in your Claude account afterwards.

## Factory Hermes

Deploying a version also applies it to the factory Hermes root. The factory's planner, lead, and improver run as Hermes profiles in a Hermes root of their own, `~/.hephaestus/hermes/`, never in the owner's `~/.hermes`. With the factory under the owner's home, the owner's running gateway rewrites the owner's `config.yaml`, and the two gateways run each other's cards and cron jobs (see the Hermes prototype in issue #4).

```sh
node dist/cli.js hermes sync
```

`hermes sync` runs every `hermes` command with `HERMES_HOME` set to the factory root. It makes these changes:

- It turns off model-driven triage and Hermes's own review dispatch, so cards move only through Hephaestus.
- It creates the factory board.
- It brings each role's profile in line with the current config version: the persona and skills arrive as a profile distribution, and the Hephaestus MCP entry and the role's cron jobs are set through the CLI. The `terminal`, `code_execution`, and `cronjob` toolsets are off, because a cron job can run a script.
- It installs and starts `hephaestus-hermes-gateway.service`, the factory's own gateway, which serves only the factory profiles and the factory board.

Install records the `hermes` CLI's path; `--hermes <path>` overrides it. Hermes must run as the same user as Hephaestus, because Hephaestus reads and prunes files Hermes writes in the factory root. Hermes commands also get `HERMES_KANBAN_HOME` set to the factory root, so an inherited value cannot point the factory board at the owner's boards. Hephaestus does not set a model: configure one for the factory root with `HERMES_HOME=~/.hephaestus/hermes hermes model`. The MCP entry points at the Hephaestus MCP server on the port after the dashboard's (see The factory).

Card stages map onto the board as the prototype proposed: Admitted is `ready` for the lead, the stages that run in T3 threads are `blocked` with the stage in a comment, Done is `done`, and Abandoned is archived. A card escalated to the lead goes back to `ready` with a comment that gives the reason. Cards complete without Hermes PR completion contracts, which need branch protection; Hephaestus checks CI itself.

## The factory

The factory works only on factory projects, the repos listed under `projects` in the deployed config version, and only on issues it may work on.

### Intake

Every two minutes Hephaestus lists each factory project's open issues with `gh`. It records an issue it did not file as external, and an external issue waits for the owner to admit or reject it on the dashboard. An issue a factory role files with `file_issue` is admitted at once, unless the project already has `openIssueCap` factory-filed issues admitted whose card has not started a thread; then it waits for the owner too. Every admitted issue gets a card, and a card on the Hermes board for the lead.

### The pipeline

- The lead starts a card with `start_work` and a brief. If the lead has not started an admitted card after `factory.autoStartMinutes` (10 by default; 0 waits for the lead), Hephaestus starts it from the issue.
- Hephaestus picks the ready worker with the fewest running factory threads, and the card stays on that worker. It clones the repo there as a T3 project once, then launches the implement thread on Factory Claude in a new worktree on the branch `factory/card-<id>`. The brief and the issue text go in the first message.
- The implement thread ends with a result block naming its PR and head commit. Only a PR from the card's branch, in the same repo, against the default branch counts. Hephaestus then launches a review thread on Factory Codex for that exact commit. When the reviewer asks for changes and the policy's `maxReviewRounds` remain, the findings go back to the implement thread.
- The card is escalated to the lead when the thread fails, asks a question, gives no valid result block, or runs out of review rounds. The lead restarts it with `start_work`, or escalates it to the owner with `escalate`.
- Before each thread start, and before each message that resumes a thread, Hephaestus checks the pause switch, that the worker is ready, and the limits in `factory.limits`: running factory threads per worker and overall, and thread starts per UTC day. A card that cannot start says why.

### The merge gate

Hephaestus merges a PR itself, squashing it, only when the project's policy allows it:

- Every check on the head commit passed, and at least one ran unless the policy sets `allowNoChecks`. Hephaestus reads every check run and status through `gh`'s paginated API, so the gate works without branch protection. A head with no checks after an hour goes to the owner.
- Unless the policy is `yolo`, the other provider's review approved exactly that head commit.
- No changed file, including the old name of a renamed one, matches an escalation path, unless the owner approved that head on the dashboard.
- The policy allows auto-merge and does not have the owner approve every merge.

Otherwise the card is escalated with the reason: to the lead for failing checks or a missing review, and to the owner for escalation paths and owner approval. Hephaestus merges through GitHub's merge API, which answers with the merge commit, so a PR someone else merged first is never taken for its own. Agents are told never to merge. A factory PR merged by anything else ends its card, flagged, and Hephaestus never validates or reverts that merge.

### Validation and revert

After a merge, Hephaestus watches the merge commit's checks on the default branch. Every check that ran on the PR's head must run and finish there too; when one has not after an hour, the card goes to the owner. When they pass, the card is done. When they fail and the policy has `autoRevert`, Hephaestus opens GitHub's revert PR and merges it under the same gate, with its own review. It then reopens the issue, notifies the owner, and starts the card again from a new implement thread that is told about the revert.

### MCP server

The factory profiles reach Hephaestus through an MCP server on `127.0.0.1`, on the port after the dashboard's. Each profile has its own bearer token, kept in `~/.hephaestus/secrets.json` and in the profile's `.env`, and each role gets only its tools:

| Role     | Tools                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| planner  | `file_issue`, `get_status`, `list_cards`, `read_thread`                                    |
| lead     | `start_work`, `escalate`, `file_issue`, `get_status`, `list_cards`, `read_thread`          |
| improver | `propose_version`, `get_config`, `get_status`, `list_cards`, `list_threads`, `read_thread` |

Every call is recorded with the calling role, including calls to a tool the role does not have. `propose_version` creates a draft config version authored by the improver, with the factory threads it cites as evidence; it changes nothing until the owner approves it.

## Uninstall

```sh
node dist/cli.js uninstall
```

`uninstall` removes the factory setup from each worker (see Workers), stops and removes the service and the factory Hermes gateway, lists every baseline file that changed since install, and deletes `~/.hephaestus/`. It exits with code 0 when nothing changed, 2 when a file changed, and 3 when the baseline was unreadable, so changes are unknown. If the service will not stop, uninstall keeps `~/.hephaestus/` and exits with an error.

## Development

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:container   # needs Docker; boots systemd in a privileged container
```
