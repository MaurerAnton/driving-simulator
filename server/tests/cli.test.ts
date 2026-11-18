// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The admin CLI on a temporary data directory, and a token it made signing
 * in to a server running on the same directory (the pepper file is shared).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { api, hasSecret, jpeg } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let dir = '';
let app: App;
let base = '';

const cli = (...args: string[]): string =>
  execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, FAHRSIM_DATA: dir, FAHRSIM_PEPPER: '' }, encoding: 'utf8' });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fahrsim-cli-test-'));
  app = createApp(loadConfig({ FAHRSIM_DATA: dir, FAHRSIM_LOG: 'quiet' }, { port: 0, host: '127.0.0.1' }));
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('accounts and tokens', async () => {
  const out = cli('account', 'create', 'Lehrerin', '--admin');
  const token = /token: (\S+)/.exec(out)![1];
  const id = /account (\S+)/.exec(out)![1];
  let r = await api(base, 'GET', '/api/v1/me', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.admin, true);
  assert.match(cli('account', 'list'), /Lehrerin {2}\[admin\]/);
  const custom = cli('account', 'token', 'Lehrerin', '--token', 'baunatal-2026');
  assert.match(custom, /baunatal-2026/);
  assert.equal((await api(base, 'GET', '/api/v1/me', { token: 'baunatal-2026' })).status, 200);
  assert.match(cli('account', 'revoke', id, 'baunat'), /revoked: 1/);
  assert.equal((await api(base, 'GET', '/api/v1/me', { token: 'baunatal-2026' })).status, 401);
  cli('account', 'rename', id, 'Frau', 'Müller');
  assert.equal((await api(base, 'GET', '/api/v1/me', { token })).body.name, 'Frau Müller');
  cli('account', 'admin', id, 'off');
  assert.equal((await api(base, 'GET', '/api/v1/me', { token })).body.admin, false);
  const show = JSON.parse(cli('account', 'show', id));
  assert.equal(show.tokens.length, 1);
  assert.ok(!JSON.stringify(show).includes(token));
  cli('account', 'disable', id, 'on');
  assert.equal((await api(base, 'GET', '/api/v1/me', { token })).status, 403);
  cli('account', 'delete', id);
  assert.equal((await api(base, 'GET', '/api/v1/me', { token })).status, 401);
  assert.throws(() => execFileSync(process.execPath, [CLI, 'account', 'delete', 'nobody'], { env: { ...process.env, FAHRSIM_DATA: dir }, stdio: 'pipe' }));
});

test('settings', async () => {
  cli('settings', 'registration', 'on');
  cli('settings', 'motd', 'Willkommen', 'in', 'Baunatal');
  cli('settings', 'origins', 'https://maureranton.github.io,https://fahrsim.example.org');
  const s = JSON.parse(cli('settings'));
  assert.equal(s.registration, true);
  assert.equal(s.motd, 'Willkommen in Baunatal');
  const r = await api(base, 'GET', '/api/v1/info', { headers: { Origin: 'https://fahrsim.example.org' } });
  assert.equal(r.body.registration, true);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://fahrsim.example.org');
});

test('image import, list, delete', async () => {
  const owner = /account (\S+)/.exec(cli('account', 'create', 'Fotograf'))![1];
  const file = join(dir, 'in.jpg');
  writeFileSync(file, jpeg(800, 400));
  const out = cli('image', 'import', file, '--owner', 'Fotograf', '--lat', '51.25', '--lon', '9.42', '--kind', 'pano360', '--title', 'Marktplatz');
  const id = /image (\S+)/.exec(out)![1];
  const r = await api(base, 'GET', `/api/v1/images/${id}`);
  assert.equal(r.body.image.kind, 'pano360');
  assert.equal(r.body.image.owner, owner);
  const f = await api(base, 'GET', `/api/v1/images/${id}/file`);
  assert.ok(!hasSecret(f.body));
  assert.match(cli('image', 'list'), new RegExp(id));
  cli('image', 'delete', id);
  assert.equal((await api(base, 'GET', `/api/v1/images/${id}`)).status, 404);
  assert.ok(readFileSync(file).length > 0);
});

test('sessions: list and end', async () => {
  const t = /token: (\S+)/.exec(cli('account', 'create', 'Spieler'))![1];
  const r = await api(base, 'POST', '/api/v1/sessions', { token: t, json: { title: 'Abend', world: { map: 'm', x: 0, z: 0 } } });
  const code = r.body.session.code;
  assert.match(cli('sessions'), new RegExp(`${code} {2}Abend`));
  cli('sessions', 'end', code);
  (app.hub as any).tick(); // the server notices within 5 s; here at once
  assert.equal((await api(base, 'GET', `/api/v1/sessions/${code}`)).status, 404);
});
