<p align="center"><img src="docs/images/banner.jpg" alt="Hephaestus" width="800"></p>

Hephaestus turns your repos into a software factory. Requests become GitHub issues, AI agents implement them in [T3 Code](https://github.com/pingdotgg/t3code) threads on your machines, a second agent from another provider reviews each PR, and Hephaestus merges it only when your policy allows. A failing merge is reverted, everything is recorded, and every night the factory proposes improvements to its own instructions for you to approve.

It runs as a service on one Linux host and serves a dashboard on your LAN.

## How it works

Three [Hermes Agent](https://github.com/NousResearch/hermes-agent) profiles manage the work: the planner is the factory's general communicator: it answers questions, discusses ideas, reports stats, and turns requests for work into issues; the lead starts and unblocks work, and the improver proposes config changes. Each piece of work then runs as T3 threads on your worker machines, on two provider instances that Hephaestus sets up there: Factory Claude implements, and Factory Codex reviews.

Hephaestus sits between them. It starts and watches every thread, enforces the thread limits and the merge gate, merges and reverts, keeps the record, and serves the dashboard. Nothing it adds changes your own Hermes profile, Claude and Codex config, or T3 settings, and uninstall removes it all.

## Requirements

On the host that runs Hephaestus:

- Linux with a systemd user session
- Node.js 22.13 or newer, and npm 11 or newer
- T3 Code, with your worker machines linked to it
- Hermes Agent
- The GitHub CLI (`gh`), signed in

On each worker: T3 Code, Claude Code, the Codex CLI, `git`, `python3`, and `gh` signed in to an account that can read your factory repos.

## Set up

1. Install and start the service. It asks for a dashboard password of 12 or more characters.

   ```sh
   git clone https://github.com/greerviau/hephaestus.git
   cd hephaestus
   npx -y npm@11 ci
   npm run build
   node dist/cli.js install
   ```

2. Open `http://<host>:7700` and sign in.
3. On **Workers**, name a private repo for config versions, such as `you/hephaestus-config`. Hephaestus creates it if it does not exist. Then click **Use as a worker** on each machine that should run factory threads.
4. On **Projects**, add each factory repo. Pick it from the list of repos your `gh` account can see, choose a policy preset (`yolo`, `standard`, the default, or `strict`), and change any setting from the preset if you need to. Adding a project creates a config version and approves and deploys it to every worker and to the factory's Hermes profiles.
5. On **Workers**, sign each worker's factory instances in. For Claude, run `claude setup-token` on any machine and paste the token into the secret card that the worker's sign-in thread opens in T3. For Codex, approve the code the page shows. A worker is ready when both checks pass.
6. On **Model**, give the factory's Hermes a model. Pick any provider Hermes supports, sign in with an API key or the code the page shows, and choose a model. The factory's Hermes home is separate from your own `~/.hermes`.

7. Optionally, on **Messaging**, connect a Discord or Telegram bot made for the factory. You can then talk with the factory in the chat, ask for work and follow each request in its own thread, and get alerts when something needs you.

## Use it

Talk with the factory in the chat you connected: ask what it is doing, bounce an idea off it, or ask for work. Or ask for work on Work items, or open an issue on a factory repo and admit it on **Work items**. The dashboard shows what needs you first on **Overview**: merges waiting for your approval, issues waiting for admission, improvement proposals, and workers that need a sign-in. **Pause** on Overview stops new factory threads.

The policy decides what merges on its own. `standard` merges when checks pass and the other provider approved the exact head commit, and stops for you when a PR touches `.github/workflows/`. `strict` stops for you on every merge, and `yolo` needs no review.

## Uninstall

```sh
node dist/cli.js uninstall
```

Uninstall removes the factory setup from every worker, then the service and `~/.hephaestus/`, and reports any change to your own config since install. Revoke the Claude setup token in your Claude account afterwards.

## Documentation

- [Install and uninstall](docs/install.md): what install records and changes, and dashboard security
- [Configuration](docs/configuration.md): config versions, policies, factory settings, backups, and secrets
- [Dashboard](docs/dashboard.md): the pages and the actions on each
- [Workers](docs/workers.md): how workers are deployed, signed in, and cleaned up
- [The factory](docs/factory.md): intake, the pipeline, the merge gate, revert, and the MCP server
- [Factory Hermes](docs/hermes.md): the factory's own Hermes home and gateway
- [T3 integration](docs/t3.md): how Hephaestus drives T3 and records threads
- [Development](docs/development.md): checks, tests, and integration tests

The MVP plan is in [issue #1](https://github.com/greerviau/hephaestus/issues/1).
