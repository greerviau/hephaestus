# Hephaestus

Hephaestus is a factory management layer on [T3 Code](https://github.com/pingdotgg/t3code) and [Hermes Agent](https://github.com/NousResearch/hermes-agent). It runs as a systemd user service on the Hermes host, keeps all of its state under `~/.hephaestus/`, and serves a dashboard behind a single password.

The MVP plan is in [issue #1](https://github.com/greerviau/hephaestus/issues/1).

## Requirements

- Linux with a systemd user manager
- Node.js 22.12 or newer and npm 11 or newer

## Install

```sh
npm ci
npm run build
node dist/cli.js install --port 7700
```

`install` asks for the dashboard password, or reads it from the first line of stdin when stdin is not a terminal. The password must be at least 12 characters. Install then does these steps:

1. It records hashes of the owner's personal Hermes profile, Claude and Codex config, and T3 settings in `~/.hephaestus/baseline.json`. `src/baseline.ts` lists the files it covers.
2. It creates `~/.hephaestus/` with mode 700 and stores the password as a scrypt hash.
3. It installs and starts `hephaestus.service` in `~/.config/systemd/user/`.

The dashboard listens on all interfaces on the chosen port, so other devices on the LAN can reach it. Sessions last 7 days.

## Uninstall

```sh
node dist/cli.js uninstall
```

`uninstall` stops and removes the service, deletes `~/.hephaestus/`, and then lists every baseline file that changed since install. It exits with code 2 when a file changed.

## Development

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:container   # needs Docker; boots systemd in a privileged container
```
