# Factory Hermes

Deploying a version also applies it to the factory Hermes root. The factory's planner, lead, and improver run as Hermes profiles in a Hermes root of their own, `~/.hephaestus/hermes/`, never in the owner's `~/.hermes`. With the factory under the owner's home, the owner's running gateway rewrites the owner's `config.yaml`, and the two gateways run each other's cards and cron jobs (see the Hermes prototype in issue #4).

```sh
node dist/cli.js hermes sync
```

`hermes sync` runs every `hermes` command with `HERMES_HOME` set to the factory root. It makes these changes:

- It turns off model-driven triage and Hermes's own review dispatch, so cards move only through Hephaestus.
- It creates the factory board.
- It brings each role's profile in line with the current config version: the persona and skills arrive as a profile distribution, and the Hephaestus MCP entry and the role's cron jobs are set through the CLI. The `terminal`, `code_execution`, and `cronjob` toolsets are off, because a cron job can run a script.
- It installs and starts `hephaestus-hermes-gateway.service`, the factory's own gateway, which serves only the factory profiles and the factory board.

Install records the `hermes` CLI's path; `--hermes <path>` overrides it. Hermes must run as the same user as Hephaestus, because Hephaestus reads and prunes files Hermes writes in the factory root. Hermes commands also get `HERMES_KANBAN_HOME` set to the factory root, so an inherited value cannot point the factory board at the owner's boards. Configure a model for the factory root with `HERMES_HOME=~/.hephaestus/hermes hermes model`. Each role's profile has its own `config.yaml`, and a role without a model cannot run, so when Hephaestus deploys a version it gives a profile that names no model the root's `model:` block. It leaves a model you set on a profile alone. It copies nothing that needs a secret: with a named custom provider, or an endpoint whose model block holds an `api_key`, set the model on each profile with `HERMES_HOME=~/.hephaestus/hermes hermes -p <role> model`. A profile reads its own `.env`, not the root's, so a provider key kept only in the root's `.env` must be set on each profile the same way. The setup checklist on Overview counts the step done once every profile names a model. The MCP entry points at the Hephaestus MCP server on the port after the dashboard's (see [The factory](factory.md#mcp-server)).

Card stages map onto the board as the prototype proposed: Admitted is `ready` for the lead, the stages that run in T3 threads are `blocked` with the stage in a comment, Done is `done`, and Abandoned is archived. A card escalated to the lead goes back to `ready` with a comment that gives the reason. Cards complete without Hermes PR completion contracts, which need branch protection; Hephaestus checks CI itself.

## Messaging

The Messaging page connects Hephaestus to Discord or Telegram. Make a bot for the factory alone: a bot whose token another Hermes gateway also uses would have its messages taken by both. Hephaestus writes the bot's token, the allowed user IDs, and the chat to the `.env` of the factory profile that talks to the owner, which only the owner can read, and restarts the factory gateway, which then runs the bot. The token is never shown again, never stored in a config version, and never passed on a command line.

On Discord, the channel you give is a request channel: the bot answers there without an @mention and opens a thread for each request. On Telegram, requests and replies use your direct chat with the bot, or a group you name.

With alerts on, Hephaestus posts each new notification, the items that appear under Needs you, to the chat with a link to the dashboard. Alerts start from the moment you turn them on, so earlier notifications are not sent.

### Requests and their threads

When you ask for work in the request channel, the factory files the issue and replies in the request's thread with the issue's link and a line such as `Tracking you/your-repo#12`. Hephaestus looks for that line, in messages from the bot only, in the channel's active threads every 30 seconds. From then on it posts the work's milestones in that thread: work started, PR opened, the review's result, merged, checks passed on the default branch, reverted, stopped, and anything that needs you, with a link to the card.

When the change can be seen, the engineer saves screenshots, a recording, or output files and pushes them to `refs/hephaestus/evidence/card-<id>`, a ref that holds only those files and is not a branch. When the PR opens and when the work is done, Hephaestus downloads up to six files of up to 8 MB each from GitHub and attaches them in the thread, once per version of the evidence.

Threads and progress work on Discord. On Telegram, requests and replies use your chat with the bot, and alerts reach you there, but Hephaestus does not follow a request's progress.
