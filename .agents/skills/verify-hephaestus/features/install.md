# Install

## Sub-features

- Records baseline hashes of the owner's config before writing anything.
- Creates `~/.hephaestus/` (mode 700) with `config.json`, `state.db`, and `baseline.json`.
- Stores the dashboard password as a scrypt hash.
- Writes `~/.config/systemd/user/hephaestus.service`, then enables and starts it.
- Refuses a second install, passwords shorter than 12 or longer than 256 characters, and an existing unit file it did not write.
- Waits until its own dashboard answers on the port, and rolls back the service and `~/.hephaestus/` if it never does.

## How to reach it

`hephaestus install [--port <port>]`. The password comes from a hidden prompt on a terminal, or from the first line of stdin.

## Driving it

Create stand-in owner config first, so the baseline has something to record:

```sh
test/container/as-owner.sh "$name" sh -c 'mkdir -p ~/.claude && echo "# personal" > ~/.claude/CLAUDE.md'
printf '%s\n' 'correct horse battery' | test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js install --port 7700
test/container/as-owner.sh "$name" systemctl --user is-active hephaestus.service
test/container/as-owner.sh "$name" sh -c 'ls -la ~/.hephaestus && cat ~/.config/systemd/user/hephaestus.service'
```

For the hidden terminal prompt, allocate a TTY and type the password when asked:

```sh
uid=$(docker exec "$name" id -u owner)
docker exec -it --user owner --workdir /home/owner \
  --env "XDG_RUNTIME_DIR=/run/user/$uid" --env "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
  "$name" node /opt/hephaestus/dist/cli.js install --port 7700
```

## Gotchas

- The dashboard needs about a second after `install` returns before it answers.
- Without a user manager (`loginctl enable-linger owner`), `systemctl --user` fails. `up.sh` sets this up.
