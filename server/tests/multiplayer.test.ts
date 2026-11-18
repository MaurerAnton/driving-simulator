// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Multiplayer sessions over real WebSockets (Node's built-in client): make
 * a session, two players join, states/chat/events are relayed, guests,
 * kick, host leaving (with and without `keep`), limits, ending by the admin
 * and expiry of an empty session.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, startServer, WsClient, wsUrl, type TestServer } from './helpers.ts';

let srv: TestServer;
let base: string;
let host = '';
let guestT = '';

const snapshot = (x: number) => ({ time: 1000, kind: 'car', x, y: 180, z: -20, yaw: 0.5, pitch: 0, roll: 0, speed: 8, steer: 0, lights: 1, signal: 0, brake: false, horn: false, future: { a: 1 } });

async function makeSession(token: string, extra: Record<string, unknown> = {}) {
  const r = await api(base, 'POST', '/api/v1/sessions', { token, json: { title: 'Fahrstunde', world: { map: '2026-11-17', x: 100, z: -50 }, public: true, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.session;
}

async function join(code: string, q: Record<string, string>): Promise<{ c: WsClient; hello: any }> {
  const c = new WsClient(wsUrl(base, { session: code, ...q }));
  const hello = await c.next((m) => m.t === 'hello' || m.t === 'bye');
  return { c, hello };
}

before(async () => {
  srv = await startServer();
  base = srv.base;
  host = (await api(base, 'POST', '/api/v1/admin/accounts', { token: srv.admin, json: { name: 'Hanna' } })).body.token;
  guestT = (await api(base, 'POST', '/api/v1/admin/accounts', { token: srv.admin, json: { name: 'Gerd' } })).body.token;
});
after(async () => { await srv.stop(); });

describe('sessions over HTTP', () => {
  test('create, list public ones, look up by code', async () => {
    const s = await makeSession(host, { maxPlayers: 4 });
    assert.match(s.code, /^[A-Z]{6}$/);
    assert.equal(s.maxPlayers, 4);
    assert.equal(s.players, 0);
    let r = await api(base, 'GET', '/api/v1/sessions');
    assert.ok(r.body.sessions.some((x: any) => x.code === s.code));
    r = await api(base, 'GET', `/api/v1/sessions/${s.code.toLowerCase()}`);
    assert.equal(r.body.session.id, s.id);
    assert.deepEqual(r.body.session.world, { map: '2026-11-17', x: 100, z: -50 });
    const p = await makeSession(host, { public: false });
    r = await api(base, 'GET', '/api/v1/sessions');
    assert.ok(!r.body.sessions.some((x: any) => x.code === p.code));
    assert.equal((await api(base, 'GET', `/api/v1/sessions/${p.code}`)).status, 200);
    assert.equal((await api(base, 'GET', '/api/v1/sessions/ZZZZZZ')).status, 404);
  });

  test('bad requests', async () => {
    assert.equal((await api(base, 'POST', '/api/v1/sessions', { json: { world: { map: 'm', x: 0, z: 0 } } })).status, 401);
    assert.equal((await api(base, 'POST', '/api/v1/sessions', { token: host, json: { world: { map: 'm', x: 'a', z: 0 } } })).status, 400);
    assert.equal((await api(base, 'POST', '/api/v1/sessions', { token: host, json: { world: { map: 'm', x: 0, z: 0 }, maxPlayers: 99 } })).status, 400);
    assert.equal((await api(base, 'POST', '/api/v1/sessions', { token: host, json: {} })).status, 400);
  });
});

describe('the relay', () => {
  test('two players: hello, join, state, chat, event, leave; host leaves → bye', async () => {
    const s = await makeSession(host);
    const a = await join(s.code, { token: host });
    assert.equal(a.hello.t, 'hello');
    assert.equal(a.hello.map, '2026-11-17');
    assert.equal(a.hello.host, a.hello.you);
    assert.equal(a.hello.players.length, 1);
    a.c.send({ t: 'state', s: snapshot(1) });
    await new Promise((r) => setTimeout(r, 100));
    const b = await join(s.code, { token: guestT });
    assert.equal(b.hello.players.length, 2);
    assert.equal(b.hello.host, a.hello.you);
    const aInB = b.hello.players.find((p: any) => p.id === a.hello.you);
    assert.equal(aInB.name, 'Hanna');
    assert.equal(aInB.host, true);
    assert.equal(aInB.s.x, 1); // the last snapshot comes with hello
    const j = await a.c.next((m) => m.t === 'join');
    assert.equal(j.player.name, 'Gerd');
    assert.equal(j.player.id, b.hello.you);
    assert.equal((await api(base, 'GET', `/api/v1/sessions/${s.code}`)).body.session.players, 2);

    b.c.send({ t: 'state', s: snapshot(42) });
    const st = await a.c.next((m) => m.t === 'state');
    assert.equal(st.id, b.hello.you);
    assert.equal(st.s.x, 42);
    assert.deepEqual(st.s.future, { a: 1 }); // unknown fields pass through

    a.c.send({ t: 'chat', text: '  Hallo\u0007 Gerd!  ' });
    for (const c of [a.c, b.c]) {
      const m = await c.next((x) => x.t === 'chat');
      assert.equal(m.text, 'Hallo  Gerd!');
      assert.equal(m.id, a.hello.you);
      assert.equal(m.name, 'Hanna');
    }
    b.c.send({ t: 'event', kind: 'horn', data: { long: true } });
    const ev = await a.c.next((m) => m.t === 'event');
    assert.deepEqual(ev, { t: 'event', id: b.hello.you, kind: 'horn', data: { long: true } });
    b.c.send({ t: 'ping' });
    assert.equal((await b.c.next((m) => m.t === 'pong')).t, 'pong');
    b.c.send({ t: 'future-type', x: 1 }); // ignored
    b.c.send({ t: 'kick', id: a.hello.you });
    assert.equal((await b.c.next((m) => m.t === 'error')).code, 'not_host');

    a.c.close();
    const bye = await b.c.next((m) => m.t === 'bye');
    assert.equal(bye.reason, 'host_left');
    await b.c.waitClosed();
    assert.equal((await api(base, 'GET', `/api/v1/sessions/${s.code}`)).status, 404);
  });

  test('keep: another player becomes host', async () => {
    const s = await makeSession(host, { keep: true });
    const a = await join(s.code, { token: host });
    const b = await join(s.code, { token: guestT });
    a.c.close();
    const l = await b.c.next((m) => m.t === 'leave');
    assert.equal(l.id, a.hello.you);
    const h = await b.c.next((m) => m.t === 'host');
    assert.equal(h.id, b.hello.you);
    b.c.close();
    await b.c.waitClosed();
  });

  test('guests only where allowed; host kicks; kicked cannot return', async () => {
    const closed = await makeSession(host);
    const g0 = await join(closed.code, { name: 'Gast' });
    assert.equal(g0.hello.t, 'bye');
    assert.equal(g0.hello.reason, 'guests_not_allowed');
    const s = await makeSession(host, { guests: true });
    const a = await join(s.code, { token: host });
    const g = await join(s.code, { name: 'Gast' });
    assert.equal(g.hello.t, 'hello');
    assert.equal(g.hello.players.find((p: any) => p.id === g.hello.you).guest, true);
    const anon = await join(s.code, {});
    assert.equal(anon.hello.reason, 'unauthorized');
    const badTok = await join(s.code, { token: 'not-a-real-token' });
    assert.equal(badTok.hello.reason, 'bad_token');
    a.c.send({ t: 'kick', id: g.hello.you });
    assert.equal((await g.c.next((m) => m.t === 'bye')).reason, 'kicked');
    assert.equal((await a.c.next((m) => m.t === 'leave')).reason, 'kicked');
    const again = await join(s.code, { name: 'Gast2' });
    assert.equal(again.hello.reason, 'kicked'); // a guest is kept out by address
    // the admin switches guests off for the whole server
    await api(base, 'PATCH', '/api/v1/admin/settings', { token: srv.admin, json: { guests: false } });
    const s2 = await makeSession(host, { guests: true });
    assert.equal((await join(s2.code, { name: 'Gast' })).hello.reason, 'guests_not_allowed');
    await api(base, 'PATCH', '/api/v1/admin/settings', { token: srv.admin, json: { guests: true } });
    a.c.close();
  });

  test('limits: full session, bad messages, oversized message, state rate', async () => {
    const s = await makeSession(host, { maxPlayers: 2 });
    const a = await join(s.code, { token: host });
    const b = await join(s.code, { token: guestT });
    const third = (await api(base, 'POST', '/api/v1/admin/accounts', { token: srv.admin, json: { name: 'Dritte' } })).body.token;
    assert.equal((await join(s.code, { token: third })).hello.reason, 'full');
    a.c.ws.send('not json');
    assert.equal((await a.c.next((m) => m.t === 'error')).code, 'bad_message');
    a.c.send({ t: 'state', s: { x: 'a', y: 0, z: 0 } });
    assert.equal((await a.c.next((m) => m.t === 'error')).code, 'bad_state');
    a.c.send({ t: 'chat', text: 'x'.repeat(301) });
    assert.equal((await a.c.next((m) => m.t === 'error')).code, 'bad_chat');
    a.c.send({ t: 'event', kind: 'Bad Kind' });
    assert.equal((await a.c.next((m) => m.t === 'error')).code, 'bad_event');
    // 40 states at once: only the first 20 (one second's worth) are relayed
    for (let i = 0; i < 40; i++) a.c.send({ t: 'state', s: snapshot(i) });
    await new Promise((r) => setTimeout(r, 400));
    const got = b.c.messages.filter((m) => m.t === 'state').length;
    assert.ok(got >= 18 && got <= 22, `relayed ${got}`);
    // a message above 16 KB closes the connection
    b.c.send({ t: 'chat', text: 'x'.repeat(20000) });
    assert.equal((await b.c.waitClosed()).code, 1009);
    a.c.close();
  });

  test('the same account again replaces the older connection (host stays host)', async () => {
    const s = await makeSession(host);
    const a1 = await join(s.code, { token: host });
    const b = await join(s.code, { token: guestT });
    const a2 = await join(s.code, { token: host });
    assert.equal((await a1.c.next((m) => m.t === 'bye')).reason, 'replaced');
    assert.equal(a2.hello.host, a2.hello.you);
    assert.equal((await b.c.next((m) => m.t === 'host')).id, a2.hello.you);
    a2.c.close();
    assert.equal((await b.c.next((m) => m.t === 'bye')).reason, 'host_left');
  });

  test('the admin ends a session; others cannot', async () => {
    const s = await makeSession(host);
    const a = await join(s.code, { token: host });
    let r = await api(base, 'GET', '/api/v1/admin/sessions', { token: srv.admin });
    const live = r.body.sessions.find((x: any) => x.code === s.code);
    assert.equal(live.playerList[0].name, 'Hanna');
    assert.equal((await api(base, 'DELETE', `/api/v1/admin/sessions/${s.code}`, { token: host })).status, 403);
    r = await api(base, 'DELETE', `/api/v1/admin/sessions/${s.code}`, { token: srv.admin });
    assert.equal(r.status, 200);
    assert.equal((await a.c.next((m) => m.t === 'bye')).reason, 'ended');
  });

  test('an unknown session code and a wrong path', async () => {
    assert.equal((await join('QQQQQQ', { token: host })).hello.reason, 'not_found');
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/other');
    const ev = await new Promise<string>((resolve) => { ws.onerror = () => resolve('error'); ws.onopen = () => resolve('open'); });
    assert.equal(ev, 'error');
  });

  test('a browser from a foreign origin cannot open the WebSocket', async () => {
    const { request } = await import('node:http');
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve) => {
      const req = request({ port, host: '127.0.0.1', path: '/api/v1/ws?session=AAAAAA', headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: 'https://evil.example',
      } });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', () => resolve(101));
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('expiry', () => {
  test('an empty session ends after the configured time', async () => {
    const s2 = await startServer({ FAHRSIM_SESSION_EMPTY_MINUTES: '1' });
    try {
      const t = (await api(s2.base, 'POST', '/api/v1/admin/accounts', { token: s2.admin, json: { name: 'X' } })).body.token;
      const r = await api(s2.base, 'POST', '/api/v1/sessions', { token: t, json: { world: { map: 'm', x: 0, z: 0 } } });
      const live = s2.app.hub.get(r.body.session.code)!;
      live.emptySince = Date.now() - 61_000; // as if a minute had passed
      (s2.app.hub as any).tick();
      assert.equal((await api(s2.base, 'GET', `/api/v1/sessions/${r.body.session.code}`)).status, 404);
    } finally {
      await s2.stop();
    }
  });
});
