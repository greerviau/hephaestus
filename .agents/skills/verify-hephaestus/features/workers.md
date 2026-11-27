# Workers and T3

## Sub-features

- The Workers page lists the machines linked to T3, each with its link state, access, and link expiry.
- Home warns about links that expire within 7 days.
- The service signs in to T3's outside MCP server with a pairing code it mints with the `t3` CLI.
- The service follows factory threads and stores their activity.

## How to reach it

Sign in, then follow Workers in the sidebar (`/workers`).

## Driving it

The test container has no T3, so the page answers 502 there with "T3 could not be reached". That proves the route is wired and behind the session check:

```sh
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code}\n' -H "cookie: $cookie" http://127.0.0.1:7700/workers
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7700/api/environments
```

Expect `502`, then `401`.

On a host with T3 and a linked worker, the integration test drives the real path:

```sh
HEPHAESTUS_T3_INTEGRATION=1 HEPHAESTUS_T3_WORKER=<environment id> npx vitest run test/t3/integration.test.ts
```

## Gotchas

- The integration test needs a T3 server on this host and a reachable linked worker with a `claudeAgent` provider instance. It launches one short thread there and archives it; T3 keeps the thread's empty scratch folder on the worker.
- `$cookie` comes from the login step in dashboard-auth.md.
