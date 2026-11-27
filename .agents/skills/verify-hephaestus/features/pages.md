# Dashboard pages, sidebar, and dialogs

## Sub-features

- Every page shares the sidebar: the Project picker, the page links, Pause or Resume, and Sign out.
- Pages hold no script. Dialogs are popovers, and "..." menus are `details` elements.
- Forms with typed text that are reached from a reloading page are pages of their own, such as `/work/new`.
- Every response carries the same `content-security-policy` header.

## How to reach it

Sign in, then follow the sidebar. The pages are `/`, `/work` (tabs `?tab=needs`, `?tab=finished`, `?tab=all`, and the board at `?view=board`), `/work/new`, `/activity`, `/analytics`, `/projects`, `/workers`, `/chat`, `/proposals`, and `/config` with its tabs (see settings.md).

## Driving it

Record each page's status, check the header, and check that no page holds a script:

```sh
base=http://127.0.0.1:7700
for path in / /work '/work?view=board' '/work?tab=needs' /work/new /activity /analytics /projects /workers /chat /proposals /config /config/models /config/models/planning /config/agents /config/versions /config/json; do
  test/container/as-owner.sh "$name" sh -c "curl -s -D /tmp/h -o /tmp/b -w '%{http_code} ' -H 'cookie: $cookie' '$base$path'; grep -ci '<script' /tmp/b; grep -i '^content-security-policy' /tmp/h"
done
```

Expect `200` for every page except `/workers`, which answers `502` without T3, a script count of `0`, and `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'`.

Pause and resume from the sidebar, and set the Project picker:

```sh
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "cookie: $cookie" --data-urlencode back=/work $base/factory/pause
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "cookie: $cookie" --data-urlencode back=/work $base/factory/resume
test/container/as-owner.sh "$name" curl -s -D - -o /dev/null -H "cookie: $cookie" --data-urlencode project=octo/app --data-urlencode back=/work $base/project-filter
```

Pause and resume answer `303` back to `/work` with `notice=paused` and `notice=resumed`. The picker answers `303` and sets the `hephaestus_project` cookie when the repo is a project in the current config version, and clears it otherwise.

To look at the pages, reach the dashboard from the host at the container's address, which needs no published port:

```sh
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
```

A headless browser that signs in at `http://$ip:7700/login` holds the session cookie itself. Open a dialog by clicking its `popovertarget` button, and force the dark theme by emulating `prefers-color-scheme: dark`.

## Gotchas

- The container has no T3, no GitHub login, and no Hermes, so Workers answers 502, Add project is refused, and Chat and the planning model page say the install has no factory Hermes. The page tests in `test/web/` cover those pages with data.
- The Project picker is absent while the config has no project. Add one by saving the config JSON with a project in it; see settings.md.
- `$cookie` comes from the login step in dashboard-auth.md.
