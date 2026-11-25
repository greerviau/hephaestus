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
- A project's policy starts from a preset, `standard` when none is given, and can override any setting. `yolo` merges when checks pass, with no review and no escalation paths. `standard`, the default, also needs an approving review from a different provider on the head commit and stops for changes under `.github/workflows/`. `strict` makes every merge wait for the owner. All three revert a factory merge whose checks fail, allow 2 review rounds, and cap open factory-filed issues at 5.
- The Settings page lists versions with their author and diff, and edits create versions. It can approve, reject, and revert. Deploying an approved version to workers is not built yet, so until then no version reaches the deployed state.
- Every night at 03:00, Hephaestus writes all versions to `~/.hephaestus/backups/` and keeps the newest 14 backups.
- `~/.hephaestus/secrets.json` (mode 600) holds named secrets that config versions refer to by name. Backups leave it out, so secrets must be entered again after a restore.

## Config versions

All factory config lives as numbered versions in `~/.hephaestus/state.db`: factory projects and their policies, the planner, lead, and improver roles, the instructions for factory threads, and skills. No repo holds them.

- Every edit creates a draft version with a diff against the version it was built from. A draft becomes approved or rejected, an approved version becomes deployed, and the version it replaces becomes superseded.
- Reverting a deployed version creates a draft that restores what that version changed. A value that a later version changed again keeps its later value, and the page says how many such values it left.
- A project's policy starts from a preset and can override any setting. `yolo` merges when checks pass, with no review and no escalation paths. `standard`, the default, also needs an approving review from a different provider on the head commit and stops for changes under `.github/workflows/`. `strict` makes every merge wait for the owner. All three revert a factory merge whose checks fail, allow 2 review rounds, and cap open factory-filed issues at 5.
- The Settings page lists versions with their author and diff, and edits create versions. It can approve, reject, and revert. Deploying an approved version to workers is not built yet, so until then no version reaches the deployed state.
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

## Factory Hermes

The factory's planner, lead, and improver run as Hermes profiles in a Hermes root of their own, `~/.hephaestus/hermes/`, never in the owner's `~/.hermes`. With the factory under the owner's home, the owner's running gateway rewrites the owner's `config.yaml`, and the two gateways run each other's cards and cron jobs (see the Hermes prototype in issue #4).

```sh
node dist/cli.js hermes sync
```

`hermes sync` runs every `hermes` command with `HERMES_HOME` set to the factory root. It makes these changes:

- It turns off model-driven triage and Hermes's own review dispatch, so cards move only through Hephaestus.
- It creates the factory board.
- It brings each role's profile in line with the current config version: the persona and skills arrive as a profile distribution, and the Hephaestus MCP entry and the role's cron jobs are set through the CLI. The `terminal`, `code_execution`, and `cronjob` toolsets are off, because a cron job can run a script.
- It installs and starts `hephaestus-hermes-gateway.service`, the factory's own gateway, which serves only the factory profiles and the factory board.

Install records the `hermes` CLI's path; `--hermes <path>` overrides it. Hephaestus does not set a model: configure one for the factory root with `HERMES_HOME=~/.hephaestus/hermes hermes model`. The MCP entry points at the port after the dashboard's, where the Hephaestus MCP server (issue #10) will listen.

Card stages map onto the board as the prototype proposed: Admitted is `ready` for the lead, the stages that run in T3 threads are `blocked` with the stage in a comment, Done is `done`, and Abandoned is archived. Cards complete without Hermes PR completion contracts, which need branch protection; Hephaestus checks CI itself.

## Uninstall

```sh
node dist/cli.js uninstall
```

`uninstall` stops and removes the service and the factory Hermes gateway, lists every baseline file that changed since install, and deletes `~/.hephaestus/`. It exits with code 0 when nothing changed, 2 when a file changed, and 3 when the baseline was unreadable, so changes are unknown. If the service will not stop, uninstall keeps `~/.hephaestus/` and exits with an error.

## Development

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:container   # needs Docker; boots systemd in a privileged container
```
