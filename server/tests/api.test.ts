// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The HTTP API end to end: a server on a random port with a temporary data
 * directory; info, CORS, accounts and tokens, admin vs. user, progress with
 * conflicts, images with metadata stripping and visibility, limits.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, form, hasSecret, jpeg, png, startServer, webp, type TestServer } from './helpers.ts';

let srv: TestServer;
let base: string;
let admin: string;

before(async () => {
  srv = await startServer({}, { imageBytes: 200_000, thumbBytes: 20_000 });
  base = srv.base;
  admin = srv.admin;
});
after(async () => { await srv.stop(); });

describe('info and CORS', () => {
  test('info lists capabilities and limits', async () => {
    const r = await api(base, 'GET', '/api/v1/info');
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Fahrsim Baunatal server');
    assert.equal(r.body.server, '1.0.0');
    assert.equal(r.body.api, 1);
    assert.deepEqual(r.body.capabilities, ['accounts', 'images', 'images360', 'progress', 'multiplayer']);
    assert.equal(r.body.limits.imageBytes, 200_000);
    assert.equal(r.body.limits.sessionPlayers, 16);
    assert.equal(r.body.registration, false);
    assert.match(r.body.source, /^https:\/\//);
  });

  test('allowed origins get CORS headers, others are refused', async () => {
    let r = await api(base, 'GET', '/api/v1/info', { headers: { Origin: 'https://maureranton.github.io' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://maureranton.github.io');
    r = await api(base, 'GET', '/api/v1/info', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    r = await api(base, 'OPTIONS', '/api/v1/me', { headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH' } });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    r = await api(base, 'GET', '/api/v1/info', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'origin_not_allowed');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  test('unknown paths give 404 JSON errors; the root names the source', async () => {
    const r = await api(base, 'GET', '/api/v1/nothing');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    const root = await fetch(base + '/');
    assert.match(await root.text(), /AGPL-3\.0-only/);
  });
});

describe('accounts and tokens', () => {
  let userToken = '';
  let userId = '';

  test('self-registration closed by default, open after the admin allows it', async () => {
    let r = await api(base, 'POST', '/api/v1/accounts', { json: { name: 'Bea' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'registration_closed');
    r = await api(base, 'PATCH', '/api/v1/admin/settings', { token: admin, json: { registration: true, motd: 'Hallo' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.registration, true);
    r = await api(base, 'POST', '/api/v1/accounts', { json: { name: '  Bea  ' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.account.name, 'Bea');
    assert.equal(r.body.account.admin, false);
    assert.match(r.body.token, /^[A-Za-z0-9_-]{32}$/);
    userToken = r.body.token;
    userId = r.body.account.id;
    assert.equal((await api(base, 'GET', '/api/v1/info')).body.motd, 'Hallo');
    r = await api(base, 'POST', '/api/v1/accounts', { json: { name: '' } });
    assert.equal(r.status, 400);
    r = await api(base, 'POST', '/api/v1/accounts', { json: { name: 'x'.repeat(41) } });
    assert.equal(r.status, 400);
  });

  test('a token signs in; a wrong one does not', async () => {
    let r = await api(base, 'GET', '/api/v1/me', { token: userToken });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['admin', 'created', 'id', 'name']);
    assert.equal(r.body.id, userId);
    r = await api(base, 'GET', '/api/v1/me', { token: userToken + 'x' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'bad_token');
    r = await api(base, 'GET', '/api/v1/me');
    assert.equal(r.status, 401);
    r = await api(base, 'GET', '/api/v1/me', { headers: { Authorization: 'Basic abc' } });
    assert.equal(r.status, 401);
  });

  test('rename, new token, revoke by prefix', async () => {
    let r = await api(base, 'PATCH', '/api/v1/me', { token: userToken, json: { name: 'Beate' } });
    assert.equal(r.body.name, 'Beate');
    r = await api(base, 'POST', '/api/v1/me/tokens', { token: userToken });
    assert.equal(r.status, 201);
    const second = r.body.token;
    assert.equal(r.body.prefix, second.slice(0, 6));
    r = await api(base, 'GET', '/api/v1/me/tokens', { token: second });
    assert.equal(r.body.tokens.length, 2);
    assert.ok(r.body.tokens.every((t: any) => t.prefix.length === 6 && !('hash' in t)));
    r = await api(base, 'DELETE', `/api/v1/me/tokens/${userToken.slice(0, 6)}`, { token: second });
    assert.equal(r.status, 200);
    assert.equal((await api(base, 'GET', '/api/v1/me', { token: userToken })).status, 401);
    userToken = second;
    r = await api(base, 'DELETE', '/api/v1/me/tokens/zzzzzz', { token: userToken });
    assert.equal(r.status, 404);
  });

  test('tokens are stored hashed only', async () => {
    const rows = srv.app.db.prepare('SELECT hash, prefix FROM tokens').all() as any[];
    for (const row of rows) {
      assert.match(row.hash, /^[0-9a-f]{64}$/);
      assert.ok(!row.hash.includes(userToken));
    }
    const dbFile = readFileSync(join(srv.dataDir, 'fahrsim.db'));
    assert.ok(!dbFile.includes(Buffer.from(userToken)));
  });

  test('a user cannot use admin endpoints', async () => {
    for (const [m, p] of [['GET', '/api/v1/admin/accounts'], ['GET', '/api/v1/admin/settings'], ['GET', '/api/v1/admin/sessions'],
      ['DELETE', `/api/v1/admin/accounts/${userId}`]]) {
      const r = await api(base, m, p, { token: userToken });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.error, 'not_admin');
    }
    assert.equal((await api(base, 'GET', '/api/v1/admin/accounts')).status, 401);
  });

  test('admin: accounts with custom tokens, admin flag, disable, delete', async () => {
    let r = await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Klasse 10b', token: 'fahrschule-2026' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.token, 'fahrschule-2026');
    const id = r.body.account.id;
    assert.equal((await api(base, 'GET', '/api/v1/me', { token: 'fahrschule-2026' })).body.name, 'Klasse 10b');
    r = await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Again', token: 'fahrschule-2026' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'token_taken');
    assert.ok(!(await api(base, 'GET', '/api/v1/admin/accounts', { token: admin })).body.accounts.some((a: any) => a.name === 'Again'));
    r = await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Short', token: 'abc' } });
    assert.equal(r.status, 400);
    r = await api(base, 'POST', `/api/v1/admin/accounts/${id}/tokens`, { token: admin, json: { token: 'zweites.token' } });
    assert.equal(r.status, 201);
    r = await api(base, 'POST', `/api/v1/admin/accounts/${id}/tokens`, { token: admin });
    assert.equal(r.status, 201);
    assert.equal(r.body.token.length, 32);
    r = await api(base, 'GET', `/api/v1/admin/accounts/${id}`, { token: admin });
    assert.equal(r.body.tokens.length, 3);
    r = await api(base, 'DELETE', `/api/v1/admin/accounts/${id}/tokens/zweite`, { token: admin });
    assert.equal(r.body.revoked, 1);
    r = await api(base, 'PATCH', `/api/v1/admin/accounts/${id}`, { token: admin, json: { admin: true } });
    assert.equal(r.body.account.admin, true);
    assert.equal((await api(base, 'GET', '/api/v1/admin/settings', { token: 'fahrschule-2026' })).status, 200);
    r = await api(base, 'PATCH', `/api/v1/admin/accounts/${id}`, { token: admin, json: { admin: false, disabled: true } });
    assert.equal(r.body.account.disabled, true);
    r = await api(base, 'GET', '/api/v1/me', { token: 'fahrschule-2026' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'account_disabled');
    r = await api(base, 'DELETE', `/api/v1/admin/accounts/${id}`, { token: admin });
    assert.equal(r.status, 200);
    assert.equal((await api(base, 'GET', '/api/v1/me', { token: 'fahrschule-2026' })).status, 401);
    assert.equal((await api(base, 'GET', `/api/v1/admin/accounts/${id}`, { token: admin })).status, 404);
  });

  test('the last admin cannot be removed', async () => {
    const me = (await api(base, 'GET', '/api/v1/me', { token: admin })).body;
    let r = await api(base, 'PATCH', `/api/v1/admin/accounts/${me.id}`, { token: admin, json: { admin: false } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last_admin');
    r = await api(base, 'DELETE', '/api/v1/me', { token: admin });
    assert.equal(r.status, 409);
  });

  test('admin settings are validated', async () => {
    let r = await api(base, 'PATCH', '/api/v1/admin/settings', { token: admin, json: { origins: ['javascript:alert(1)'] } });
    assert.equal(r.status, 400);
    r = await api(base, 'PATCH', '/api/v1/admin/settings', { token: admin, json: { registration: 'yes' } });
    assert.equal(r.status, 400);
    r = await api(base, 'PATCH', '/api/v1/admin/settings', { token: admin, json: { origins: ['https://maureranton.github.io', 'http://localhost:*', 'https://*.example.org'] } });
    assert.equal(r.status, 200);
    r = await api(base, 'GET', '/api/v1/info', { headers: { Origin: 'https://game.example.org' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://game.example.org');
  });

  test('a user may delete their own account', async () => {
    const r0 = await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Gone' } });
    const t = r0.body.token;
    assert.equal((await api(base, 'DELETE', '/api/v1/me', { token: t })).status, 200);
    assert.equal((await api(base, 'GET', '/api/v1/me', { token: t })).status, 401);
  });
});

describe('progress', () => {
  let t = '';
  before(async () => {
    t = (await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Progress' } })).body.token;
  });

  test('put, get, list, conflict, delete', async () => {
    let r = await api(base, 'GET', '/api/v1/progress', { token: t });
    assert.deepEqual(r.body, {});
    assert.equal((await api(base, 'GET', '/api/v1/progress/lessons', { token: t })).status, 404);
    r = await api(base, 'PUT', '/api/v1/progress/lessons', { token: t, json: { rev: 0, data: { done: ['a'] } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.rev, 1);
    r = await api(base, 'PUT', '/api/v1/progress/lessons', { token: t, json: { rev: 1, data: { done: ['a', 'b'] } } });
    assert.equal(r.body.rev, 2);
    // a second device with the old revision gets the server's copy back
    r = await api(base, 'PUT', '/api/v1/progress/lessons', { token: t, json: { rev: 1, data: { done: ['c'] } } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'conflict');
    assert.equal(r.body.rev, 2);
    assert.deepEqual(r.body.data, { done: ['a', 'b'] });
    r = await api(base, 'PUT', '/api/v1/progress/lessons', { token: t, json: { rev: 0, data: {} } });
    assert.equal(r.status, 409);
    r = await api(base, 'GET', '/api/v1/progress/lessons', { token: t });
    assert.equal(r.body.rev, 2);
    assert.deepEqual(r.body.data, { done: ['a', 'b'] });
    r = await api(base, 'GET', '/api/v1/progress', { token: t });
    assert.equal(r.body.lessons.rev, 2);
    assert.match(r.body.lessons.updated, /^\d{4}-\d\d-\d\dT/);
    r = await api(base, 'DELETE', '/api/v1/progress/lessons', { token: t });
    assert.equal(r.status, 200);
    assert.equal((await api(base, 'GET', '/api/v1/progress/lessons', { token: t })).status, 404);
  });

  test('kinds and sizes are checked; progress is private', async () => {
    let r = await api(base, 'PUT', '/api/v1/progress/Bad.Kind', { token: t, json: { rev: 0, data: 1 } });
    assert.equal(r.status, 400);
    r = await api(base, 'PUT', '/api/v1/progress/big', { token: t, json: { rev: 0, data: 'x'.repeat(1024 * 1024 + 10) } });
    assert.equal(r.status, 413);
    r = await api(base, 'PUT', '/api/v1/progress/x', { token: t, json: { rev: -1, data: 1 } });
    assert.equal(r.status, 400);
    r = await api(base, 'PUT', '/api/v1/progress/x', { token: t, body: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal((await api(base, 'GET', '/api/v1/progress')).status, 401);
    await api(base, 'PUT', '/api/v1/progress/settings', { token: t, json: { rev: 0, data: { lang: 'de' } } });
    const other = (await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Other' } })).body.token;
    assert.equal((await api(base, 'GET', '/api/v1/progress/settings', { token: other })).status, 404);
  });

  test('append-only items', async () => {
    let r = await api(base, 'POST', '/api/v1/progress/results/items', { token: t, json: { item: { score: 1 } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.rev, 1);
    r = await api(base, 'POST', '/api/v1/progress/results/items', { token: t, json: { item: { score: 2 } } });
    assert.equal(r.body.rev, 2);
    assert.equal(r.body.items, 2);
    r = await api(base, 'GET', '/api/v1/progress/results', { token: t });
    assert.deepEqual(r.body.data, [{ score: 1 }, { score: 2 }]);
    r = await api(base, 'POST', '/api/v1/progress/settings/items', { token: t, json: { item: 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_a_list');
    // full: the oldest items go
    const big = 'y'.repeat(200 * 1024);
    for (let i = 0; i < 6; i++) r = await api(base, 'POST', '/api/v1/progress/log/items', { token: t, json: { item: { i, big } } });
    assert.ok(r.body.dropped > 0);
    const log = (await api(base, 'GET', '/api/v1/progress/log', { token: t })).body.data;
    assert.equal(log[log.length - 1].i, 5);
    assert.ok(log[0].i > 0);
  });
});

describe('images', () => {
  let alice = '';
  let bob = '';
  let photo: any;
  before(async () => {
    alice = (await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Alice' } })).body.token;
    bob = (await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Bob' } })).body.token;
  });

  test('upload a JPEG: metadata stripped, position only in meta', async () => {
    const r = await api(base, 'POST', '/api/v1/images', {
      token: alice,
      body: form({ lat: 51.2601, lon: 9.4102, heading: 90, kind: 'photo', title: 'Rathaus', visibility: 'public', taken: '2026-05-01T10:00:00+02:00' }, jpeg(640, 480), png(160, 120)),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photo = r.body.image;
    assert.equal(photo.type, 'image/jpeg');
    assert.equal(photo.width, 640);
    assert.equal(photo.lat, 51.2601);
    assert.equal(photo.taken, '2026-05-01T08:00:00.000Z');
    assert.equal(photo.ownerName, 'Alice');
    assert.equal(photo.file, `/api/v1/images/${photo.id}/file`);
    assert.equal(photo.thumb, `/api/v1/images/${photo.id}/thumb`);
    const f = await api(base, 'GET', photo.file);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/jpeg');
    assert.ok(!hasSecret(f.body));
    assert.equal(f.body.length, photo.bytes);
    const th = await api(base, 'GET', photo.thumb);
    assert.equal(th.headers.get('content-type'), 'image/png');
    assert.ok(!hasSecret(th.body));
    for (const name of readdirSync(join(srv.dataDir, 'images'))) {
      assert.ok(!hasSecret(readFileSync(join(srv.dataDir, 'images', name))), name);
    }
    const again = await fetch(base + photo.file, { headers: { 'If-None-Match': f.headers.get('etag')! } });
    assert.equal(again.status, 304);
  });

  test('PNG and WebP, a private pano, 2:1 check', async () => {
    let r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form({ lat: 51.26, lon: 9.41, kind: 'photo', visibility: 'public' }, png(50, 40)) });
    assert.equal(r.status, 201);
    assert.equal(r.body.image.thumb, null);
    assert.equal((await api(base, 'GET', `/api/v1/images/${r.body.image.id}/thumb`)).status, 404);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form({ lat: 51.27, lon: 9.42, kind: 'pano360', visibility: 'private' }, webp(4000, 2000)) });
    assert.equal(r.status, 201);
    assert.equal(r.body.image.kind, 'pano360');
    assert.equal(r.body.image.visibility, 'private');
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form({ lat: 51.27, lon: 9.42, kind: 'pano360', visibility: 'public' }, jpeg(4000, 1500)) });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'not_equirectangular');
  });

  test('bad uploads are refused', async () => {
    const ok = { lat: 51, lon: 9, kind: 'photo', visibility: 'public' };
    let r = await api(base, 'POST', '/api/v1/images', { body: form(ok, jpeg(10, 10)) });
    assert.equal(r.status, 401);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form(ok, Buffer.from('GIF89a' + 'x'.repeat(50))) });
    assert.equal(r.status, 415);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form({ ...ok, lat: 91 }, jpeg(10, 10)) });
    assert.equal(r.status, 400);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form({ ...ok, kind: 'video' }, jpeg(10, 10)) });
    assert.equal(r.status, 400);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, json: ok });
    assert.equal(r.status, 400);
    // above the size limit (200 000 bytes in this test server)
    const huge = Buffer.concat([jpeg(10, 10).subarray(0, -2 - 'TRAILING-MOTION-PHOTO GPS-SECRET-51.2600N-9.4100E'.length), Buffer.alloc(300_000)]);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form(ok, huge) });
    assert.equal(r.status, 413);
    r = await api(base, 'POST', '/api/v1/images', { token: bob, body: form(ok, jpeg(10, 10), jpeg(2000, 2000)) });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'thumb_too_big');
  });

  test('bbox query: public ones there and the caller\'s own', async () => {
    const bbox = '9.40,51.25,9.43,51.28';
    let r = await api(base, 'GET', `/api/v1/images?bbox=${bbox}`);
    assert.equal(r.body.images.length, 2); // Alice's and Bob's public photos
    r = await api(base, 'GET', `/api/v1/images?bbox=${bbox}`, { token: bob });
    assert.equal(r.body.images.length, 3); // + Bob's private pano
    r = await api(base, 'GET', `/api/v1/images?bbox=${bbox}&kind=pano360`, { token: bob });
    assert.equal(r.body.images.length, 1);
    r = await api(base, 'GET', `/api/v1/images?bbox=${bbox}&kind=pano360`, { token: alice });
    assert.equal(r.body.images.length, 0);
    r = await api(base, 'GET', '/api/v1/images?bbox=0,0,1,1');
    assert.equal(r.body.images.length, 0);
    r = await api(base, 'GET', '/api/v1/images?mine=1', { token: alice });
    assert.equal(r.body.images.length, 1);
    r = await api(base, 'GET', '/api/v1/images?bbox=1,2,3');
    assert.equal(r.status, 400);
    assert.equal((await api(base, 'GET', '/api/v1/images?all=1', { token: alice })).status, 403);
    assert.ok((await api(base, 'GET', '/api/v1/images?all=1', { token: admin })).body.images.length >= 3);
  });

  test('visibility, PATCH and DELETE rights', async () => {
    const pano = (await api(base, 'GET', '/api/v1/images?kind=pano360', { token: bob })).body.images[0];
    assert.equal((await api(base, 'GET', `/api/v1/images/${pano.id}`)).status, 404);
    assert.equal((await api(base, 'GET', `/api/v1/images/${pano.id}/file`, { token: alice })).status, 404);
    assert.equal((await api(base, 'GET', `/api/v1/images/${pano.id}/file`, { token: bob })).status, 200);
    assert.equal((await api(base, 'GET', `/api/v1/images/${pano.id}`, { token: admin })).status, 200);
    let r = await api(base, 'PATCH', `/api/v1/images/${photo.id}`, { token: bob, json: { title: 'mine now' } });
    assert.equal(r.status, 403);
    r = await api(base, 'PATCH', `/api/v1/images/${photo.id}`, { token: alice, json: { title: 'Rathaus Baunatal', visibility: 'private' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.image.title, 'Rathaus Baunatal');
    assert.equal(r.body.image.visibility, 'private');
    r = await api(base, 'PATCH', `/api/v1/images/${photo.id}`, { token: alice, json: { kind: 'pano360' } });
    assert.equal(r.status, 400);
    assert.equal((await api(base, 'GET', `/api/v1/images/${photo.id}`)).status, 404);
    assert.equal((await api(base, 'DELETE', `/api/v1/images/${photo.id}`, { token: bob })).status, 404);
    assert.equal((await api(base, 'DELETE', `/api/v1/images/${pano.id}`, { token: admin })).status, 200);
    assert.equal((await api(base, 'DELETE', `/api/v1/images/${photo.id}`, { token: alice })).status, 200);
    assert.equal((await api(base, 'GET', `/api/v1/images/${photo.id}/file`, { token: alice })).status, 404);
    const left = readdirSync(join(srv.dataDir, 'images'));
    assert.ok(!left.some((n) => n.startsWith(photo.id) || n.startsWith(pano.id)));
  });

  test('ids cannot reach outside the image directory', async () => {
    for (const p of ['/api/v1/images/..%2F..%2Ffahrsim.db/file', '/api/v1/images/../../pepper', '/api/v1/images/%2e%2e/file']) {
      const r = await api(base, 'GET', p, { token: admin });
      assert.equal(r.status, 404, p);
      assert.ok(!(r.body instanceof Buffer));
    }
  });
});

describe('limits', () => {
  test('JSON bodies above the limit are refused', async () => {
    const t = (await api(base, 'POST', '/api/v1/admin/accounts', { token: admin, json: { name: 'Big' } })).body.token;
    const r = await api(base, 'PATCH', '/api/v1/me', { token: t, body: JSON.stringify({ name: 'x'.repeat(10_000) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 413);
  });
});

describe('rate limits', () => {
  test('per IP', async () => {
    const s = await startServer({ FAHRSIM_RATE_IP: '5' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await api(s.base, 'GET', '/api/v1/info')).status);
      assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
      assert.equal(codes[7], 429);
    } finally {
      await s.stop();
    }
  });

  test('failed sign-ins per IP', async () => {
    const s = await startServer();
    try {
      let last = 0;
      for (let i = 0; i < 35; i++) last = (await api(s.base, 'GET', '/api/v1/me', { token: `wrong-token-${i}` })).status;
      assert.equal(last, 429);
      // even the right token waits now
      assert.equal((await api(s.base, 'GET', '/api/v1/me', { token: s.admin })).status, 429);
    } finally {
      await s.stop();
    }
  });

  test('registrations per IP', async () => {
    const s = await startServer({ FAHRSIM_REGISTRATION: 'true', FAHRSIM_REGISTRATIONS_PER_HOUR: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await api(s.base, 'POST', '/api/v1/accounts', { json: { name: `n${i}` } })).status);
      assert.deepEqual(codes, [201, 201, 429]);
    } finally {
      await s.stop();
    }
  });

  test('trusted proxy header decides the address', async () => {
    const s = await startServer({ FAHRSIM_RATE_IP: '2', FAHRSIM_TRUST_PROXY: '1' });
    try {
      const get = (ip: string) => api(s.base, 'GET', '/api/v1/info', { headers: { 'X-Forwarded-For': `6.6.6.6, ${ip}` } }).then((r) => r.status);
      assert.deepEqual([await get('1.1.1.1'), await get('1.1.1.1'), await get('1.1.1.1')], [200, 200, 429]);
      assert.equal(await get('2.2.2.2'), 200);
    } finally {
      await s.stop();
    }
  });
});
