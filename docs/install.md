# Install and uninstall

```sh
npm ci
npm run build
node dist/cli.js install --port 7700 --skill ~/skills/review
```

`install` asks for the dashboard password, or reads it from the first line of stdin when stdin is not a terminal. The password must be 12 to 256 characters. Install then does these steps:

1. It records hashes of the owner's personal Hermes profiles, Claude and Codex config, and T3 settings in `~/.hephaestus/baseline.json`. `src/baseline.ts` lists the files it covers. It honours `HERMES_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `T3CODE_HOME`, and records the folders it used so uninstall checks the same ones. It follows symlinks, so a linked skill's contents count too. It leaves out the files Hermes rewrites in a skills folder: the usage counts and skill locks in `.usage.json` and its lock file, `.curator_state`, `.curator_ledger.jsonl`, `.curator_backups`, `.hub`, `.bundled_manifest`, and `.locks`. It ignores them in a baseline taken before they were left out too, so a changed Hermes skill lock is not reported. The rule applies directly under every covered folder named `skills`, including Claude and Codex ones.
2. It creates `~/.hephaestus/` with mode 700 and stores the password as a scrypt hash.
3. It creates config version 1 from the starter skills Hephaestus ships and each `--skill` folder (a folder with a `SKILL.md`), and approves it. The roles' and coding threads' own instructions are not copied: they ship with Hephaestus (see [Configuration](configuration.md)), so the owner's instructions start empty.
4. It installs and starts `hephaestus.service` in `~/.config/systemd/user/` (or under `XDG_CONFIG_HOME`), and records the unit's path. It refuses to replace a unit file that is already there.
5. It waits until its own dashboard answers on the port. If any step fails, it removes the service and `~/.hephaestus/` again.

The dashboard listens on all interfaces on the chosen port, so other devices on the LAN can reach it. It uses plain HTTP, so the password and session cookie cross the LAN unencrypted. Sessions last 7 days. A client that sends 10 wrong passwords in 15 minutes is locked out for the rest of that window. The dashboard refuses any POST whose `Origin` is not the dashboard itself, so a page served from another port on the same host cannot act with the owner's session.

## Update

```sh
node dist/cli.js update
```

`update` acts on the checkout the service runs from, which it reads from the service's unit, wherever the command itself is run from. It fetches `main` from `origin`, fast-forwards the checkout to it, runs `npm ci` and `npm run build`, and restarts the service. When npm is older than 11, it runs npm 11 through it. When a change touched what `hermes sync` installs (`templates/hermes/`, `src/hermes/`, or `src/config/shipped.ts`) and a factory Hermes root is set up, it runs the new build's `hermes sync` before the restart. The service brings new shipped role instructions and starter skills itself when it starts (see [Configuration](configuration.md)).

It refuses, and changes nothing, when the checkout has uncommitted changes to tracked files, is not on `main`, cannot fetch from `origin`, or has commits `origin/main` does not. When `npm ci` or the build fails, it does not restart the service: it resets the checkout to the commit it was on and rebuilds that, so the service keeps its build and a restart or reboot still starts it, and the next `update` tries again. When the new build does not start, it rolls back the same way and restarts the service on the old build. The update never runs inside the service, because a bad build would then stop the update that rolls it back. A lock file, `~/.hephaestus/update.lock`, lets one update run at a time, from the dashboard or a shell; the lock of an update whose process is gone is taken over.

The sidebar shows the commit the service runs. Every five minutes the service fetches `main` from `origin`. When `origin/main` has commits the running one lacks, every page except the Update page (`/update`) opens with an Update available notice that says how many, with an Update now button and a link to the Update page, and the sidebar says how many too. While an update holds the lock, from the dashboard or a shell, the notice says so instead and links to the Update page. A fetch that fails shows nothing. Update now runs the same `update` as a transient systemd user unit, `hephaestus-update.service`, so it outlives the restart of the service that started it; a second update is refused while one runs. The page shows the run's output, which goes to `~/.hephaestus/update.log`, reloads every few seconds while it runs, and gives the command to run on the host if the dashboard does not come back, or if the last update stopped before it finished.

### Upgrading from a build that called the agent the Planner

The chat agent was called the Planner before it was the Communicator. The first start after the upgrade renames it in place and keeps its data: the state database moves the `planner` role to `communicator` in every config version, in the recorded skills, cron jobs, and agent calls, and in chat changes that are waiting; the next `hephaestus hermes sync`, or the service's own start, moves the factory Hermes root's `profiles/planner/` to `profiles/communicator/` with its skills, memories, and sessions, and moves the `hermes-mcp-token-planner` secret to `hermes-mcp-token-communicator`. A running factory gateway is stopped for the profile move and started again after, and its Discord sessions and routes are then rekeyed to the new name with `hermes profile migrate-identity planner communicator`, so existing Discord threads keep their conversation. A start or rekey that fails is logged and tried again on the next start of the service; until then `~/.hephaestus/hermes-profile-move.json` records what is left. The service moves the profile only when its config names the hermes CLI; otherwise it logs that `hephaestus hermes sync --hermes <path>` moves it. Each step checks first, so running it again changes nothing, and a `communicator` profile that already exists is never overwritten.

For one release the old name still works where an owner may type it: a `roles.planner` key in an imported config, `/config/agents/planner`, `/activity?role=planner`, and the change target `persona:planner`. Each logs a deprecation warning and uses the Communicator. There are no environment variables to rename.

## Uninstall

```sh
node dist/cli.js uninstall
```

`uninstall` removes the factory setup from each worker (see [Workers](workers.md)), stops and removes the service and the factory Hermes gateway, lists every baseline file that changed since install, and deletes `~/.hephaestus/`. It exits with code 0 when nothing changed, 2 when a file changed, and 3 when the baseline was unreadable, so changes are unknown. If the service will not stop, uninstall keeps `~/.hephaestus/` and exits with an error.
