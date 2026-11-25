# Install

## Sub-features

- Records baseline hashes of the owner's config before writing anything.
- Creates `~/.hephaestus/` (mode 700) with `config.json`, `state.db`, and `baseline.json`.
- Stores the dashboard password as a scrypt hash.
- Writes `~/.config/systemd/user/hephaestus.service`, then enables and starts it.
- Refuses a second install and passwords shorter than 12 characters.

## How to reach it

`hephaestus install [--port <port>]`. The password comes from a hidden prompt on a terminal, or from the first line of stdin.

## Driving it

```sh
printf '%s\n' 'correct horse battery' | test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js install --port 7700
test/container/as-owner.sh "$name" systemctl --user is-active hephaestus.service
test/container/as-owner.sh "$name" ls -la /home/owner/.hephaestus
```

For the terminal prompt, run `docker exec -it --user owner ...` with the same environment as `as-owner.sh` and type the password.

## Gotchas

- The dashboard needs about a second after `install` returns before it answers.
- Without a user manager (`loginctl enable-linger owner`), `systemctl --user` fails. `up.sh` sets this up.
