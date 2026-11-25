---
name: verify-hephaestus
description: Launch and drive Hephaestus (a Node CLI that installs a systemd user service and a password-gated HTTP dashboard) in a disposable systemd container. Use to prove a change to install, uninstall, the service, login, or dashboard routes works the way the owner uses it.
---

# verify-hephaestus

Hephaestus's surfaces are the `hephaestus` CLI (`install`, `uninstall`, `serve`) and the dashboard it serves over HTTP.
`install` and `uninstall` drive a real systemd user manager, so every journey runs inside a privileged container with systemd as PID 1, as the unprivileged user `owner`.
Never run `install` or `uninstall` on a machine whose systemd user manager someone uses.

All commands run from the repo root and need Docker.

## Launch

```sh
name=$(test/container/up.sh)
```

`up.sh` builds an image from the checkout (`npm ci`, `npm run build`) under the tag `hephaestus-test:<name>`, boots systemd in a container from it, and starts the user manager for `owner`.
It prints the container name when the user manager's bus is up, which is the ready signal.
Each run builds its own image tag and container, so instances run side by side.
The container is the instance; record its name instead of a PID.

## Doctor

```sh
test/container/as-owner.sh "$name" systemctl --user is-system-running
test "$(docker exec "$name" cat /opt/hephaestus/SOURCE_SHA256)" = "$(test/container/source-hash.sh)" && echo "build matches checkout"
```

The first prints `running` or `degraded`.
The second compares a hash of `package.json`, `package-lock.json`, the tsconfig files, and `src/` taken inside the image with the same hash of the checkout, and prints `build matches checkout` when they agree.

## Drive

Run CLI commands as `owner`:

```sh
printf '%s\n' 'correct horse battery' | test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js install --port 7700
test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js uninstall
```

Quote any command that uses `~` or `$HOME` with `sh -c '...'`, so the container's shell expands it, not the host's.

Drive the dashboard with `curl` inside the container. Routes and handles: `GET /login` (form field `name="password"`), `POST /login`, `POST /logout`, `GET /`, `GET /api/session`, and the cookie `hephaestus_session`.

```sh
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7700/api/session
```

`scripts/journey.sh` runs the whole install, login, and uninstall journey and saves a transcript.
The feature map in `features/README.md` lists each feature's entry points.

## Evidence

Save transcripts under `${HEPHAESTUS_VERIFY_EVIDENCE:-$HOME/.cache/hephaestus-verify}/<UTC timestamp>/`, outside the checkout and outside the container.
Capture each command, its output, HTTP status codes and `Set-Cookie` headers, `systemctl --user` state, and the files under `~/.hephaestus/` and `~/.config/systemd/user/`.

## Cleanup

```sh
test/container/down.sh "$name"
```

This removes the container, everything in it, and its image tag. Evidence on the host stays.

## Helpers

- `test/container/up.sh [name]`: build the image and boot a container; prints its name.
- `test/container/as-owner.sh <name> <command...>`: run a command as `owner` with the user manager reachable.
- `test/container/down.sh <name>`: remove the container and its image tag.
- `test/container/source-hash.sh [root]`: print the source hash the doctor compares.
- `.agents/skills/verify-hephaestus/scripts/journey.sh`: launch, run the full journey, save evidence, clean up. Prints the evidence directory.
