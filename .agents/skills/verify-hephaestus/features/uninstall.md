# Uninstall and baseline report

## Sub-features

- Stops and disables the service and deletes its unit file.
- Deletes `~/.hephaestus/`.
- Lists each baseline file that changed since install and exits with code 2; exits 0 when nothing changed.

## How to reach it

`hephaestus uninstall`

## Driving it

```sh
test/container/as-owner.sh "$name" sh -c 'echo "# edited" > ~/.claude/CLAUDE.md'
test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js uninstall; echo "exit $?"
test/container/as-owner.sh "$name" ls ~/.hephaestus ~/.config/systemd/user/hephaestus.service
```

## Gotchas

- The baseline covers only files that exist in `BASELINE_TARGETS` in `src/baseline.ts`. Create stand-in owner files before `install` so the report has something to compare.
