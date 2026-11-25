# Development

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:container   # needs Docker; boots systemd in a privileged container
```

## Integration tests

`HEPHAESTUS_T3_INTEGRATION=1 HEPHAESTUS_T3_WORKER=<environment id> npx vitest run test/t3/integration.test.ts` runs one short thread on a real worker through this host's T3, then archives it and revokes its session.

`HEPHAESTUS_HERMES_INTEGRATION=1 HEPHAESTUS_HERMES_BIN=<hermes> HEPHAESTUS_HERMES_ROOT=<empty folder> npx vitest run test/hermes/integration.test.ts` syncs the factory profiles and drives the board against a real `hermes` CLI. Run it only where a stray write cannot reach anyone's real Hermes home, such as a container.
