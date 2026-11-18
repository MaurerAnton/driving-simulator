# Fahrsim Baunatal – Server

*Deutsch unten zuerst, [English below](#english).*

Der Server zum freien Fahrschulsimulator [Fahrsim Baunatal](https://github.com/MaurerAnton/driving-simulator):
Konten mit Zugangsschlüsseln (Tokens), Fotos und 360°-Panoramen auf der Karte, Spielstände auf mehreren Geräten und
Mehrspieler-Sitzungen. Das Protokoll steht in [PROTOCOL.md](PROTOCOL.md); das Spiel fragt `GET /api/v1/info` und
nutzt nur, was der Server dort anbietet. Der Server hat eine eigene Versionsnummer (`package.json`, Tags
`server-vX.Y.Z`) und braucht nichts außer **Node.js 26** – keine Pakete, keine Datenbank-Software (SQLite ist in Node
eingebaut). Lizenz: AGPL-3.0-only ([NOTICE.md](NOTICE.md)).

## Schnell ausprobieren

```bash
cd server
FAHRSIM_DATA=./data node src/main.ts          # lauscht auf :8080
FAHRSIM_DATA=./data node src/cli.ts account create Anna --admin   # druckt den Token
```

Im Spiel den Server `http://localhost:8080` eintragen und mit dem Token anmelden – oder das Spiel mit
`?tk=<token>` öffnen. Ohne `FAHRSIM_PEPPER` legt der Server einmalig eine Zufallsdatei `data/pepper` an.

## Einstellungen (Umgebungsvariablen)

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `FAHRSIM_DATA` | `./data` | Verzeichnis für Datenbank (`fahrsim.db`) und Bilder (`images/`) |
| `FAHRSIM_PEPPER` | Datei `data/pepper` | Geheimnis für die Token-Hashes (≥ 16 Zeichen). **Nie ändern** – sonst gelten alle Tokens nicht mehr |
| `FAHRSIM_PORT` / `FAHRSIM_HOST` | `8080` / `0.0.0.0` | Adresse |
| `FAHRSIM_TRUST_PROXY` | `0` | Zahl der Reverse-Proxys davor, deren `X-Forwarded-For` gilt (hinter Caddy/nginx: `1`) |
| `FAHRSIM_ORIGINS` | `https://maureranton.github.io,http://localhost:*,http://127.0.0.1:*` | erlaubte Browser-Ursprünge (CORS); `*` als Platzhalter für Port oder Namensteil |
| `FAHRSIM_REGISTRATION` | `false` | Selbstregistrierung (später per Admin änderbar) |
| `FAHRSIM_MOTD` | leer | Nachricht des Tages |
| `FAHRSIM_IMAGE_BYTES` | `26214400` | größtes Bild (25 MB) |
| `FAHRSIM_THUMB_BYTES` | `524288` | größtes Vorschaubild |
| `FAHRSIM_SESSION_PLAYERS` | `16` | Spieler je Sitzung höchstens |
| `FAHRSIM_SESSION_EMPTY_MINUTES` | `30` | leere Sitzung endet nach … |
| `FAHRSIM_RATE_IP` / `FAHRSIM_RATE_TOKEN` | `600` / `1200` | Anfragen je Minute und IP / Token |
| `FAHRSIM_REGISTRATIONS_PER_HOUR` | `5` | neue Konten je Stunde und IP |
| `FAHRSIM_UPLOADS_PER_HOUR` | `120` | Bilder je Stunde und Konto |
| `FAHRSIM_WS_PER_IP` | `8` | gleichzeitige WebSockets je IP |
| `FAHRSIM_JSON_BYTES` | `1200000` | größter JSON-Rumpf |
| `FAHRSIM_SOURCE_URL` | Projekt auf GitHub | Quelltext-Adresse (AGPL § 13) – bei eigener veränderter Fassung setzen |
| `FAHRSIM_LOG` | `info` | `quiet` schaltet das Anfrage-Protokoll ab |

Registrierung, Gäste, Nachricht des Tages und Ursprünge ändert der Admin danach im Spiel, über
`PATCH /api/v1/admin/settings` oder die Kommandozeile; diese Werte stehen dann in der Datenbank.

## Kommandozeile

```bash
node src/cli.ts help
node src/cli.ts account create "Klasse 10b" --token fahrschule-2026   # eigener Token zum Verteilen
node src/cli.ts account list
node src/cli.ts account token Anna            # weiterer Token
node src/cli.ts account revoke Anna AbC123    # Token anhand seiner ersten 6 Zeichen widerrufen
node src/cli.ts settings registration on
node src/cli.ts image import pano.jpg --owner Anna --lat 51.2563 --lon 9.4181 --kind pano360 --visibility public
node src/cli.ts sessions
```

Mit Docker: `docker compose exec fahrsim node src/cli.ts …`.

## Auf einem eigenen Server (VPS) betreiben

Voraussetzungen: ein kleiner Linux-Server (1 CPU, 1 GB RAM reichen) mit Docker und dem Compose-Plugin, eine
(Sub-)Domain.

1. **DNS:** einen `A`-Eintrag (und ggf. `AAAA`) für z. B. `fahrsim.example.org` auf die Adresse des Servers setzen.
   Ports 80 und 443 müssen offen sein.
2. **Code holen:** `git clone https://github.com/MaurerAnton/driving-simulator.git && cd driving-simulator/server/deploy`
3. **Einstellen:** `cp .env.example .env`, darin `FAHRSIM_DOMAIN` und `FAHRSIM_PEPPER` (`openssl rand -base64 32`)
   setzen; den Pepper zusätzlich sicher aufbewahren.
4. **Starten:** `docker compose up -d --build`. Caddy holt das HTTPS-Zertifikat selbst.
   Prüfen: `curl https://fahrsim.example.org/api/v1/info`.
5. **Ersten Admin anlegen:** `docker compose exec fahrsim node src/cli.ts account create "Ich" --admin` – den
   gedruckten Token sicher aufheben und im Spiel unter Server eintragen.
6. **Datensicherung:** alles liegt im Volume `fahrsim-data` (`fahrsim.db` + `images/` + ggf. `pepper`). Z. B. täglich:
   ```bash
   docker compose exec fahrsim node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/fahrsim.db').exec(\"VACUUM INTO '/data/backup.db'\")"
   docker run --rm -v deploy_fahrsim-data:/data -v "$PWD":/backup debian:stable-slim \
     tar czf /backup/fahrsim-$(date +%F).tar.gz -C /data backup.db images
   ```
   (`VACUUM INTO` macht eine stimmige Kopie, während der Server läuft. Den Volume-Namen zeigt `docker volume ls`.)
   Wiederherstellen: Server anhalten, `backup.db` als `fahrsim.db` und `images/` ins Volume zurückkopieren, starten.
   Den Pepper (aus `.env`) mitsichern – ohne ihn sind alle Tokens wertlos.
7. **Aktualisieren:** `git pull && docker compose up -d --build`. Die Datenbank wird beim Start selbst ergänzt;
   Sitzungen laufen nach dem Neustart weiter, die Spieler verbinden sich neu.

Ohne Docker: Node 26 installieren, `deploy/fahrsim-server.service` (systemd) und `deploy/nginx.conf` als Vorlage nehmen.
**HTTPS gehört vor den Server** (Caddy oder nginx); der Server selbst spricht nur HTTP. Dann `FAHRSIM_TRUST_PROXY=1`
setzen und den Server nur auf `127.0.0.1` lauschen lassen. Achtung beim Proxy-Protokoll: die WebSocket-Adresse
enthält den Token in der Query – Zugriffsprotokolle ohne Query schreiben (die nginx-Vorlage tut das; in Caddy kein
`log` mit voller URI einschalten).

## Sicherheit

- Tokens werden nur als HMAC-SHA-256 mit dem Pepper gespeichert und in konstanter Zeit verglichen; der Server
  protokolliert weder Header noch Rümpfe noch Query-Strings.
- Begrenzungen je IP und je Token, für Fehlanmeldungen (30 je Minute und IP), Registrierungen und Uploads;
  Größenbegrenzung aller Rümpfe und WebSocket-Nachrichten.
- Bilder: nur JPEG/PNG/WebP (an den Bytes erkannt); EXIF, GPS, XMP, IPTC, Kommentare und angehängte Daten werden
  entfernt, ohne die Bilddaten anzufassen (bei JPEG bleibt nur die Drehung). Dateinamen sind vom Server erzeugte Ids.
- CORS nur für die eingestellten Ursprünge; ein Browser von anderswo bekommt 403, auch beim WebSocket.

## Tests

```bash
cd server && npm test                 # oder im Hauptverzeichnis: npm run test:server
npm run typecheck                     # braucht TypeScript aus dem Hauptverzeichnis
```

Die Tests starten den Server auf einem freien Port mit einem Wegwerf-Datenverzeichnis, ohne Netz.

## Grenzen

- Der Server erzeugt keine Vorschaubilder (keine Bildbibliothek); das Spiel schickt eine kleine Vorschau als Teil
  `thumb` mit.
- Bei PNG und WebP geht eine EXIF-Drehung verloren (selten; Kameras schreiben JPEG).
- Ein einzelner Prozess: Begrenzungen und laufende Sitzungen liegen im Speicher. Für mehrere Prozesse bräuchte es
  einen gemeinsamen Speicher – für eine Fahrschule oder einen Verein ist das nicht nötig.

---

<a id="english"></a>

# Fahrsim Baunatal – server (English)

The server for the free driving-school simulator Fahrsim Baunatal: accounts with access tokens, photos and 360°
panoramas on the map, progress synced across devices, and multiplayer sessions. The protocol is in
[PROTOCOL.md](PROTOCOL.md); the game reads `GET /api/v1/info` and uses only what the server offers. The server has
its own version (`package.json`, tags `server-vX.Y.Z`) and needs nothing but **Node.js 26** – no packages, no
database software (SQLite is built into Node). Licence: AGPL-3.0-only ([NOTICE.md](NOTICE.md)).

## Try it

```bash
cd server
FAHRSIM_DATA=./data node src/main.ts                               # listens on :8080
FAHRSIM_DATA=./data node src/cli.ts account create Anna --admin   # prints the token
```

Enter `http://localhost:8080` as server in the game and sign in with the token, or open the game with
`?tk=<token>`. Without `FAHRSIM_PEPPER` the server makes a random `data/pepper` file once.

## Configuration

Environment variables as in the German table above: `FAHRSIM_DATA` (data directory), `FAHRSIM_PEPPER` (secret for
token hashes, ≥ 16 characters – **never change it**, every token would stop working), `FAHRSIM_PORT`, `FAHRSIM_HOST`,
`FAHRSIM_TRUST_PROXY` (number of reverse proxies whose `X-Forwarded-For` is trusted; `1` behind Caddy/nginx),
`FAHRSIM_ORIGINS` (allowed browser origins, comma-separated, `*` as wildcard for a port or a host label),
`FAHRSIM_REGISTRATION`, `FAHRSIM_MOTD`, `FAHRSIM_IMAGE_BYTES`, `FAHRSIM_THUMB_BYTES`, `FAHRSIM_SESSION_PLAYERS`,
`FAHRSIM_SESSION_EMPTY_MINUTES`, `FAHRSIM_RATE_IP`, `FAHRSIM_RATE_TOKEN`, `FAHRSIM_REGISTRATIONS_PER_HOUR`,
`FAHRSIM_UPLOADS_PER_HOUR`, `FAHRSIM_WS_PER_IP`, `FAHRSIM_JSON_BYTES`, `FAHRSIM_SOURCE_URL` (AGPL § 13: point it to
your modified source), `FAHRSIM_LOG` (`quiet`). Registration, guests, motd and origins are then changed by the admin
(game, `PATCH /api/v1/admin/settings` or CLI) and kept in the database.

## Command line

`node src/cli.ts help` lists everything: accounts (create with `--admin` / `--token <custom>`, list, show, token,
revoke by prefix, admin on/off, disable, rename, delete), settings, image import/list/delete, sessions list/end. With
Docker: `docker compose exec fahrsim node src/cli.ts …`.

## Running it on your own VPS

1. **DNS:** an `A` (and `AAAA`) record for e.g. `fahrsim.example.org` pointing to the server; ports 80 and 443 open.
2. `git clone https://github.com/MaurerAnton/driving-simulator.git && cd driving-simulator/server/deploy`
3. `cp .env.example .env`; set `FAHRSIM_DOMAIN` and `FAHRSIM_PEPPER` (`openssl rand -base64 32`), and keep the pepper
   somewhere safe.
4. `docker compose up -d --build` – Caddy obtains the certificate. Check `curl https://fahrsim.example.org/api/v1/info`.
5. First admin: `docker compose exec fahrsim node src/cli.ts account create "Me" --admin`; keep the printed token.
6. **Backups:** everything is in the volume `fahrsim-data` (`fahrsim.db`, `images/`). Make a consistent copy of the
   database with `VACUUM INTO` while the server runs and archive it with `images/` (commands in the German section).
   Back up the pepper too.
7. **Updating:** `git pull && docker compose up -d --build`. The schema is extended on start; running sessions survive
   a restart (players reconnect).

Without Docker: install Node 26 and use `deploy/fahrsim-server.service` (systemd) and `deploy/nginx.conf`. **HTTPS
belongs in front of the server** (Caddy or nginx); the server speaks plain HTTP – set `FAHRSIM_TRUST_PROXY=1` and let
it listen on `127.0.0.1`. The WebSocket URL carries the token in its query: keep proxy access logs free of query
strings (the nginx example does).

## Security

Tokens are stored only as HMAC-SHA-256 with the pepper and compared in constant time; the server never logs headers,
bodies or query strings. Rate limits per IP and per token, for failed sign-ins (30 per minute and IP), registrations
and uploads; size limits for every body and WebSocket message. Images: JPEG/PNG/WebP only (recognised by their
bytes); EXIF, GPS, XMP, IPTC, comments and trailing data are removed without touching the pixel data (a JPEG keeps
only its orientation). File names are server-made ids. CORS only for the configured origins; a browser from
elsewhere gets 403, the WebSocket too.

## Tests

`cd server && npm test` (or `npm run test:server` in the repository root); `npm run typecheck`. The tests start the
server on a free port with a throw-away data directory; no network needed.

## Limits

No server-side thumbnails (no image library): the game sends a small one as part `thumb`. PNG/WebP lose an EXIF
orientation. One process: rate limits and live sessions are in memory – plenty for a driving school or a club.
