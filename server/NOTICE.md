# Rechtliche Hinweise / Notices – Fahrsim Baunatal server

Fahrsim Baunatal server – Copyright (C) 2026 die Mitwirkenden des Projekts / the project's contributors.

Dieses Programm ist freie Software unter der **GNU Affero General Public License, Version 3** (ausschließlich dieser
Version, SPDX `AGPL-3.0-only`); den Text enthält [../LICENSE](../LICENSE). Wer den Server – auch verändert – über ein
Netzwerk anbietet, muss den Benutzerinnen und Benutzern den Quelltext zugänglich machen (§ 13 AGPL). Der Server nennt
die Adresse seines Quelltexts unter `GET /` und `GET /api/v1/info` (`source`; mit `FAHRSIM_SOURCE_URL` auf die eigene
veränderte Fassung zu setzen).

This program is free software under the **GNU Affero General Public License, version 3** (only this version,
SPDX `AGPL-3.0-only`). Whoever offers the server – modified or not – over a network must offer its users the source
(AGPL § 13); the server names its source URL at `GET /` and in `GET /api/v1/info` (`source`, set
`FAHRSIM_SOURCE_URL` for a modified version).

## Abhängigkeiten / Dependencies

Keine. Der Server nutzt nur Node.js (≥ 26) und dessen eingebaute Module (`node:http`, `node:sqlite`, `node:crypto`);
WebSocket (RFC 6455) ist im Server selbst umgesetzt (`src/websocket.ts`). Node.js steht unter der MIT-Lizenz, das
darin enthaltene SQLite ist gemeinfrei.

None. The server uses only Node.js (≥ 26) and its built-in modules; WebSocket (RFC 6455) is implemented in
`src/websocket.ts`. Node.js is MIT-licensed; the SQLite inside it is in the public domain.

The container image is based on `node:26-slim` (Debian); the example deployment uses Caddy (Apache-2.0) or nginx
(BSD-2-Clause) as reverse proxy – separate programs, not part of this one.
