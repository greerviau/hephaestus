# Agent instructions

Hephaestus installs a systemd user service on the owner's machine and changes T3 and Hermes setup on the owner's workers. A mistake here can reach the owner's real config, so these rules apply to every change, including changes made by Hephaestus's own factory.

## Hard rules

- Never run `hephaestus` or `node dist/cli.js` with any command outside a disposable container. `install`, `uninstall`, `serve`, and `hermes sync` all act on the live `~/.hephaestus`. Use `npm run test:container`, or the `verify-hephaestus` skill in `.agents/skills/`, to exercise them.
- Never run `hermes` without `HERMES_HOME` set to a scratch folder. Without it, Hermes writes default files into the owner's `~/.hermes`.
- Do not change `~/.hephaestus`, `~/.hermes`, `~/.claude`, `~/.codex`, `~/.agents`, or T3 settings on any machine.
- Put nothing specific to the owner's setup in the repo, commits, PRs, or issue comments: no IP addresses, hostnames, machine names, paths under a home folder, tokens, or link details. Say "the Hermes host" and "a worker" instead.
- Do not add agent co-author trailers to commits or "Generated with" lines to PR bodies. `.claude/settings.json` turns Claude Code's own off.
- The Hermes plugin in `templates/hermes/plugin/` uses only the Python standard library and Hermes's own modules. Add no Python dependencies.
- Write ASCII only: hyphens instead of em or en dashes, and straight quotes.

## Checks

Run these before you open a PR. CI runs the same checks, plus the container test.

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

The repo needs Node 22.13 or later and npm 11 or later, as `package.json` requires. If npm is older than 11, `npm ci` fails with a lockfile error: run `npx -y npm@11.6.2 ci` instead. Never run `npm install` to fix that error, and never change the lockfile or the `engines` field for it.

`npm run test:container` needs Docker. It boots systemd in a privileged container. [Development](docs/development.md) describes the integration tests, which run against a real T3 or Hermes and are skipped by default.

## Code and docs

- Title PRs as `type(scope): summary`, such as `fix(factory): keep in-flight cards on their branch`.
- Build behavior changes test-first. A new test must fail on the base branch for the reason the change fixes.
- Keep `docs/` and `README.md` true to the code. Describe current behavior in present tense, in plain sentences.
- Code comments explain why, not what. Do not use markdown in code comments or commit messages.
- Secrets never go on a command line, in page HTML, or in logs. Pass them on stdin or in a file with mode 600.
- Text Hephaestus writes on the Messaging page, on the Model page, and in chat messages never names the factory's Hermes roles (planner, lead, improver). The page tests check the pages; a change to chat text needs its own test.
