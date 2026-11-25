# Dashboard login and sessions

## Sub-features

- Every page except `/login` redirects to `/login` (303) without a session.
- Every `/api/` route answers 401 `{"error":"unauthorized"}` without a session.
- `POST /login` with the right password sets an HttpOnly, SameSite=Strict `hephaestus_session` cookie; a wrong one answers 401.
- `POST /logout` ends the session.
- Sessions survive a service restart.

## How to reach it

Open `http://<host>:<port>/` in a browser on the LAN.

## Driving it

```sh
base=http://127.0.0.1:7700
test/container/as-owner.sh "$name" curl -s -o /dev/null -w '%{http_code}\n' $base/
cookie=$(test/container/as-owner.sh "$name" curl -s -D - -o /dev/null --data-urlencode 'password=correct horse battery' $base/login \
  | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\);.*/\1/p')
test/container/as-owner.sh "$name" curl -s -H "cookie: $cookie" $base/api/session
```

## Gotchas

- Install the service first; see install.md.
