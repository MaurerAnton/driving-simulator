# Fahrsim Baunatal server – protocol v1

The server is released on its own cycle (its version in `server/package.json`, tags `server-vX.Y.Z`), independent of
the game's version. Games of any version talk to any server through this protocol: **features are discovered, not
assumed** – the game reads `GET /api/v1/info` and uses only the capabilities listed there. A server keeps every
capability of v1 working; incompatible changes go to `/api/v2` (served beside v1 for a long time).

All JSON. Times ISO-8601 UTC. Errors: HTTP status + `{"error": "<code>", "message": "<English text>"}`.
CORS: the server allows the game's origins (configurable list, default `https://maureranton.github.io` and
`http://localhost:*`).

## Info
`GET /api/v1/info` → `{"name": "Fahrsim Baunatal server", "server": "1.0.0", "api": 1,
"capabilities": ["accounts", "images", "images360", "progress", "multiplayer"], "limits": {"imageBytes": 26214400,
"sessionPlayers": 16}, "motd": "…"}`

## Accounts and tokens
- Every account has one or more **access tokens** (any length ≥ 8 characters, letters/digits/`-_.`; the admin may set a
  custom one). A token alone signs in: the game opened with `?tk=<token>` stores it and removes it from the address bar.
- Requests carry `Authorization: Bearer <token>`.
- `POST /api/v1/accounts` `{"name": "…"}` → `{"account": {…}, "token": "…"}` (if self-registration is enabled by the
  admin; otherwise 403 `registration_closed`).
- `GET /api/v1/me` → `{"id", "name", "admin": bool, "created"}`; `PATCH /api/v1/me` `{"name"}`.
- `POST /api/v1/me/tokens` → a new token; `DELETE /api/v1/me/tokens/<prefix>` revokes one (tokens are stored hashed;
  a token is identified by its first 6 characters).
- Admin (`admin: true`): `GET /api/v1/admin/accounts`, `POST /api/v1/admin/accounts` `{"name", "token"?: custom, "admin"?}`,
  `PATCH/DELETE /api/v1/admin/accounts/<id>`, `POST /api/v1/admin/accounts/<id>/tokens` `{"token"?: custom}`,
  `GET /api/v1/admin/settings` / `PATCH` `{"registration": bool, "motd", "origins": […]}`. Everything the admin can do
  here can also be done with the CLI (`node server/src/cli.ts …`) and from the game's admin panel.

## Images (also 360° panoramas)
- `POST /api/v1/images` (multipart: `file` + `meta` JSON `{"lat", "lon", "heading"?, "pitch"?, "kind": "photo"|"pano360",
  "taken"?, "title"?, "visibility": "private"|"public"}`) → `{"image": {…}}`. JPEG/PNG/WebP only; EXIF/GPS metadata
  stripped from the stored file (position kept only in `meta`); a pano360 must be 2:1.
- `GET /api/v1/images?bbox=minLon,minLat,maxLon,maxLat&kind=…` → public images there + the caller's own.
- `GET /api/v1/images/<id>` (meta), `GET /api/v1/images/<id>/file` and `/thumb` (bytes), `PATCH` (meta), `DELETE`
  (own or admin).

## Progress (everything the player did)
Opaque, versioned documents per account, by kind: `lessons`, `routes`, `tours`, `results`, `settings`, `favourites`,
`history`, `theory`, `cranes`, `forklift`, … (the game decides kinds; the server stores any `[a-z0-9_-]{1,32}`).
- `GET /api/v1/progress` → `{"<kind>": {"rev": n, "updated": "…"}}`
- `GET /api/v1/progress/<kind>` → `{"rev": n, "data": <any JSON ≤ 1 MB>}`
- `PUT /api/v1/progress/<kind>` `{"rev": n, "data": …}` → `{"rev": n+1}`; 409 `conflict` with the server's copy when
  `rev` is stale (the game merges and retries). Append-only kinds (results) may use `POST /api/v1/progress/<kind>/items`.

## Multiplayer
- `POST /api/v1/sessions` `{"title"?, "world": {"map": "<map stamp>", "x", "z"}, "public": bool, "maxPlayers"?, "guests"?: bool,
  "keep"?: bool}` →
  `{"session": {"id", "code": "6 letters"}}`; `GET /api/v1/sessions` (public ones); `GET /api/v1/sessions/<code>`.
- WebSocket `GET /api/v1/ws?session=<code>&token=<token>` (guests allowed if the host allows it: `&name=`).
  Messages are JSON `{"t": "<type>", …}`:
  - server → client: `hello` {you, players[], host, map}, `join` {player}, `leave` {id}, `state` {id, s: snapshot},
    `chat` {id, text}, `event` {id, kind, data}, `host` {id}, `bye` {reason}
  - client → server: `state` {s: snapshot} (≤ 15 Hz), `chat` {text ≤ 300}, `event` {kind, data}, `kick` {id} (host)
  - snapshot `s`: `{"time": ms, "kind": vehicle kind, "paint"?, "x", "y", "z", "yaw", "pitch", "roll", "speed",
    "steer", "lights": bits, "signal": -1|0|1, "brake": bool, "horn": bool, "walker"?: {…}}` – the server relays, it
    does not simulate. Unknown fields are passed through (newer games may send more).
- Sessions end when the host leaves (unless `"keep": true` and another player becomes host) or after 30 min empty.

## Details (server 1.0.0)

Everything below is what server 1.0.0 does beyond the summary above; all of it is compatible with it (extra fields,
extra endpoints). A game must ignore fields it does not know.

**Info.** Also `"registration": bool` (self-registration open), `"guests": bool` (guests allowed at all), `"source"`
(URL of the server's source code, AGPL § 13). `limits` also has `thumbBytes`, `thumbSide` (1024), `progressBytes`
(1048576), `chatLength` (300), `stateHz` (15), `wsMessageBytes` (16384).

**Errors.** Codes used: `bad_request`, `bad_json`, `bad_meta`, `bad_upload`, `bad_kind`, `bad_token_format`,
`unauthorized` (401, no token), `bad_token` (401, unknown/revoked token – the game should forget it),
`account_disabled` (403), `not_admin` (403), `forbidden`, `origin_not_allowed`, `registration_closed`, `not_found`,
`conflict`, `token_taken`, `last_admin`, `too_many_tokens`, `too_many_kinds`, `too_many_sessions`, `not_a_list`,
`too_large` (413), `busy` (503, too many uploads at once – retry), `bad_image` (415), `not_equirectangular` / `thumb_too_big` (422), `rate_limited` (429, header
`Retry-After`), `internal` (500).

**Accounts.** Names: 1–40 characters (trimmed, control characters removed). An account object is
`{"id", "name", "admin", "created"}` (admin endpoints add `"disabled"`, the list adds `"tokens"`: count).
Extra: `GET /api/v1/me/tokens` → `{"tokens": [{"prefix", "created", "lastUsed"}]}`; `POST /api/v1/me/tokens` →
`{"token", "prefix"}`; `DELETE /api/v1/me` deletes the own account with its images and progress (not for the last
admin). Admin extras: `GET /api/v1/admin/accounts/<id>` → `{"account", "tokens"}`, `PATCH` takes `{"name"?, "admin"?,
"disabled"?}`, `GET` / `DELETE /api/v1/admin/accounts/<id>/tokens[/<prefix>]`, settings also `"guests": bool`,
`GET /api/v1/admin/sessions` (with `playerList`), `DELETE /api/v1/admin/sessions/<code>` (players get `bye` "ended").
The last admin cannot be demoted, disabled or deleted (409 `last_admin`). Tokens: 8–128 of `A-Za-z0-9-_.`; generated
ones have 32 characters.

**Images.** Upload parts: `file` (required), `meta` (JSON, required; `visibility` defaults to `private`, `title` ≤ 200
characters, `heading` −360…360, `pitch` −90…90, `taken` any ISO-8601 time, stored in UTC), `thumb` (optional: a
client-made thumbnail, JPEG/PNG/WebP, at most 1024 × 1024 px and `thumbBytes`; the server makes none). A pano360 may
differ from 2:1 by 0.5 %. Image object: `{"id", "owner", "ownerName", "kind", "lat", "lon", "heading", "pitch",
"taken", "title", "visibility", "type", "width", "height", "bytes", "created", "updated", "file": "/api/v1/images/<id>/file",
"thumb": "/api/v1/images/<id>/thumb" | null}` (paths relative to the server). JPEG keeps its EXIF orientation
(a minimal EXIF block with only that tag); `width`/`height` are as displayed. `GET /api/v1/images`: `bbox` optional,
`kind`, `mine=1` (only the caller's own), `limit` (1–1000, default 200, newest first), admins `all=1` (`&owner=<id>`).
Private images (meta and bytes) need the owner's (or an admin's) `Authorization` header – an `<img src>` cannot
send it, so the game fetches them and uses an object URL; public ones need no token. Files have an `ETag`
(`If-None-Match` → 304). `PATCH` takes the meta fields except `kind`. Answers to `POST` are 201.

**Progress.** `GET /api/v1/progress/<kind>` also returns `"updated"`. `PUT`: `rev` 0 (or missing) creates; the 409
`conflict` body is `{"error", "message", "rev", "updated", "data"}` (the server's copy). `DELETE /api/v1/progress/<kind>`.
`POST /api/v1/progress/<kind>/items` `{"item": <any JSON ≤ 256 KB>}` appends to a list document (created if missing;
409 `not_a_list` if the stored document is no list) → `{"rev", "items", "dropped"}`: when the list would pass 1 MB the
oldest items are dropped. At most 100 kinds per account.

**Sessions.** Making one needs an account. `maxPlayers` 2…`limits.sessionPlayers` (default the limit); `guests` (default
false) lets guests in (if the admin's `guests` setting allows), `keep` (default false) keeps the session when the host
leaves. Session object: `{"id", "code", "title", "world", "public", "guests", "keep", "maxPlayers", "players": count,
"host": host's name | null, "created"}`. Codes are case-insensitive in URLs. An account runs at most 5 sessions; making
a sixth ends its oldest empty one (else 409 `too_many_sessions`). The account that made the session becomes host when
it connects.

**WebSocket.** `GET /api/v1/ws?session=<code>&token=<token>` or `…&name=<guest name>` (1–40 characters). The
connection always opens; refusals come as `bye` followed by close: reasons `not_found`, `bad_token`, `unauthorized`
(neither token nor name), `guests_not_allowed`, `kicked`, `full`; later `host_left`, `replaced` (same account connected
again, or the owner made a new session in place of this empty one), `ended` (admin), `expired`, `timeout`, `flood`,
`server_stopping`. Close codes: 1000 normal, 1008 flood, 1009 message above 16 KB, 4401/4403/4404/4409 refusals.
- `hello` is `{"t": "hello", "you": id, "host": id | null, "map", "session": <session object>, "players": [{"id",
  "name", "guest", "host": bool, "s"?: last snapshot}]}` – `players` includes yourself.
- `join` `{"player": {"id", "name", "guest", "host"}}`, `leave` `{"id", "reason": "left" | "kicked" | "replaced"}`,
  `chat` `{"id", "name", "text"}` goes to everybody **including the sender** (cleaned: control characters removed,
  trimmed), `state` and `event` go to the others only.
- server → client also `error` `{"code", "message"}` (codes `bad_message`, `bad_state`, `bad_chat`, `bad_event`,
  `too_large`, `rate_limited`, `not_host`, `bad_kick`) and `pong` `{"time"}`; client → server also `ping` `{}`
  (answered with `pong`). Unknown client types are ignored.
- `state` needs numeric `s.x`, `s.y`, `s.z`; a snapshot ≤ 4 KB; above 20 per second the rest is dropped quietly.
  `chat` ≤ 300 characters, 5 per 10 s (`error` `rate_limited` beyond). `event` `kind` matches `[a-z0-9_-]{1,32}`,
  `data` ≤ 8 KB, 10 per second. More than 50 messages per second in total → `bye` "flood".
- The server sends WebSocket ping frames to a client silent for 10 s (browsers answer by themselves); a client
  silent for 60 s is dropped. The same account connecting again replaces its older connection (and keeps the host role).
- A browser's `Origin` must be an allowed origin (else the upgrade is refused with 403).
