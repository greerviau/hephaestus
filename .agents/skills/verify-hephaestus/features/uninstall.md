# Uninstall and baseline report

## Sub-features

- Stops and disables the service and deletes its unit file.
- Deletes `~/.hephaestus/`.
- Lists each baseline file that changed since install and exits with code 2; exits 0 when nothing changed, and 3 when the baseline is unreadable.
- Leaves a unit file it did not write, and keeps `~/.hephaestus/` when the service will not stop.

## How to reach it

`hephaestus uninstall`

## Driving it

```sh
test/container/as-owner.sh "$name" sh -c 'echo "# edited" > ~/.claude/CLAUDE.md'
test/container/as-owner.sh "$name" node /opt/hephaestus/dist/cli.js uninstall; echo "exit $?"
test/container/as-owner.sh "$name" sh -c 'ls ~/.hephaestus ~/.config/systemd/user/hephaestus.service'
```

The last command must fail with "No such file or directory" for both paths.

## Gotchas

- The baseline covers the paths in `BASELINE_TARGETS` in `src/baseline.ts` plus named Hermes profiles. Create the stand-in owner file from install.md before `install`, or the edit step fails with "Directory nonexistent".
