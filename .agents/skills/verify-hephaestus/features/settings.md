# Settings and config versions

## Sub-features

- Lists config versions with state, author, creation time, and message.
- Shows one version's diff against its parent and its whole config.
- Saves an edit of the config JSON as a draft built from the current version; an invalid edit answers 400 and keeps the text.
- Approves and rejects drafts, and reverts a deployed or superseded version into a new draft.
- `GET /api/config/versions` and `GET /api/config/versions/<id>` serve the same data as JSON.

## How to reach it

Sign in, then follow Settings in the navigation bar (`/settings`).

## Driving it

Install with a skill so version 1 has something to show, then sign in as in dashboard-auth.md:

```sh
test/container/as-owner.sh "$name" sh -c 'mkdir -p ~/factory-skills/triage && echo "# Triage" > ~/factory-skills/triage/SKILL.md'
printf '%s\n' 'correct horse battery' | test/container/as-owner.sh "$name" sh -c 'node /opt/hephaestus/dist/cli.js install --port 7700 --skill ~/factory-skills/triage'
test/container/as-owner.sh "$name" curl -s -H "cookie: $cookie" http://127.0.0.1:7700/settings
test/container/as-owner.sh "$name" curl -s -H "cookie: $cookie" http://127.0.0.1:7700/api/config/versions/1
test/container/as-owner.sh "$name" sh -c "curl -s -H 'cookie: $cookie' http://127.0.0.1:7700/api/config/versions/1 | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const v=JSON.parse(s).version.document;v.roles.lead.persona=\"Lead carefully.\";process.stdout.write(JSON.stringify(v))})' > /tmp/edit.json"
test/container/as-owner.sh "$name" sh -c "curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'cookie: $cookie' --data-urlencode document@/tmp/edit.json --data-urlencode 'message=Tune the lead' --data-urlencode parentId=1 http://127.0.0.1:7700/settings/versions"
test/container/as-owner.sh "$name" sh -c "curl -s -o /dev/null -w '%{http_code}\n' -H 'cookie: $cookie' -X POST http://127.0.0.1:7700/settings/versions/2/approve"
```

The edit answers `303` with a redirect to `/settings/versions/2`, and the approve answers `303`.

## Gotchas

- `$cookie` comes from the login step in dashboard-auth.md.
- No version reaches `deployed` until worker deploys exist, so the Revert button does not appear yet. The unit tests in `test/web/settings.test.ts` cover revert.
