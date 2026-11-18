// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's side of the server (src/net): the server address and the token
 * (?tk= taken out of the address, the Authorization header, a token the
 * server does not know forgotten), features only when the server offers
 * them, the progress merged per kind (unions against the last agreed copy,
 * the newest settings, a 409 merged and sent again), and the other players'
 * snapshots drawn 100 ms in the past – all with a fake fetch and a fake
 * WebSocket.
 *
 *   node --test "tests/net/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerClient, ServerError, backoff, normaliseServerUrl, urlParams, validToken } from '../../src/net/client.ts';
import type { KeyValue } from '../../src/net/client.ts';
import { KINDS, ProgressSync, mergeLists, newest } from '../../src/net/sync.ts';
import { DELAY, MultiplayerSession, RemoteTrack, cleanSnapshot, lerpAngle, sessionCode, socketUrl } from '../../src/net/multiplayer.ts';
import type { Snapshot, SocketLike } from '../../src/net/multiplayer.ts';
import { checkUpload, parseImage, twoToOne } from '../../src/net/images.ts';

function memory(): KeyValue & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fake server: routes "METHOD /path" → [status, json] (or a function of the body). */
function fakeFetch(routes: Record<string, (body: unknown, auth: string | null) => [number, unknown]>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? null;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, url, auth, body });
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    const h = routes[`${method} ${path}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found', message: 'no' }), { status: 404 });
    const [status, json] = h(body, auth);
    if (status === 0) throw new TypeError('Failed to fetch');
    return new Response(json === undefined ? '' : JSON.stringify(json), { status });
  }) as typeof fetch;
}

const INFO = { name: 'Test', server: '1.0.0', api: 1, capabilities: ['accounts', 'progress', 'images', 'multiplayer'], limits: { imageBytes: 1000 }, motd: 'hi', registration: true, guests: true };
const ME = { id: 'a1', name: 'Anna', admin: false, created: '2026-01-01T00:00:00Z' };
const TOKEN = 'abcdefgh12345678';

test('server addresses and tokens: what is typed is cleaned, ?tk= is taken out of the address', () => {
  assert.equal(normaliseServerUrl(' fahrsim.example.org/ '), 'https://fahrsim.example.org');
  assert.equal(normaliseServerUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normaliseServerUrl('https://x.org/sub/api/v1/?a=1#b'), 'https://x.org/sub');
  assert.equal(normaliseServerUrl(''), '');
  assert.equal(normaliseServerUrl('ftp://x.org'), null);
  assert.equal(normaliseServerUrl('https://u:p@x.org'), null);
  assert.ok(validToken('abc-_.12'));
  assert.ok(!validToken('short'));
  assert.ok(!validToken('has space 123'));
  const q = urlParams('https://g.io/game/?lang=de&server=s.org&tk=abcdefgh123&join=abc123#x');
  assert.equal(q.server, 'https://s.org');
  assert.equal(q.token, 'abcdefgh123');
  assert.equal(q.join, 'ABC123');
  assert.equal(q.cleaned, 'https://g.io/game/?lang=de&server=s.org&join=abc123#x');
  assert.equal(urlParams('https://g.io/?lang=de').cleaned, null, 'nothing to take out');
  assert.equal(urlParams('https://g.io/?tk=bad').token, null, 'an invalid token is not taken');
  assert.ok(backoff(0, 0.5) === 1000 && backoff(3, 0.5) === 8000 && backoff(30, 0.5) === 60000);
});

test('the token is kept per server and sent as a Bearer header; capabilities only while online', async () => {
  const store = memory();
  const calls: Call[] = [];
  const c = new ServerClient({ store, fetch: fakeFetch({ 'GET /info': () => [200, INFO], 'GET /me': (_b, a) => (a === `Bearer ${TOKEN}` ? [200, ME] : [401, { error: 'unauthorized' }]) }, calls) });
  assert.equal(c.has('progress'), false, 'nothing without a server');
  c.setServer('https://s.org');
  c.setToken(TOKEN);
  assert.equal(c.has('progress'), false, 'nothing before the server answered');
  assert.equal(await c.connect(), true);
  assert.equal(c.status, 'online');
  assert.ok(c.has('progress') && c.has('multiplayer') && !c.has('images360'));
  assert.equal(c.me?.name, 'Anna');
  assert.equal(calls[0].auth, null, '/info goes without the token');
  assert.equal(calls[1].auth, `Bearer ${TOKEN}`);
  assert.equal(c.info?.registration, true);
  // another client of the same browser finds the token for that server – and none for another
  const c2 = new ServerClient({ store, fetch: fakeFetch({}) });
  c2.setServer('https://s.org/');
  assert.equal(c2.token, TOKEN);
  c2.setServer('https://other.org');
  assert.equal(c2.token, '');
  c.signOut();
  assert.equal(c.token, '');
  const c3 = new ServerClient({ store, fetch: fakeFetch({}) });
  c3.setServer('https://s.org');
  assert.equal(c3.token, '', 'signed out: forgotten');
});

test('a token the server does not know is forgotten; no answer means offline and a retry', async () => {
  const store = memory();
  const c = new ServerClient({ store, fetch: fakeFetch({ 'GET /info': () => [200, INFO], 'GET /me': () => [401, { error: 'bad_token', message: 'revoked' }] }) });
  c.setServer('https://s.org');
  c.setToken(TOKEN);
  assert.equal(await c.connect(), true);
  assert.equal(c.me, null);
  assert.equal(c.token, '');
  assert.equal(c.lastError, 'bad_token');
  const off = new ServerClient({ store: memory(), fetch: fakeFetch({ 'GET /info': () => [0, null] }) });
  off.setServer('https://s.org');
  assert.equal(await off.connect(), false);
  assert.equal(off.status, 'offline');
  assert.equal(off.lastError, 'offline');
  assert.equal(off.has('accounts'), false);
  off.stop();
  // a GET is tried again on a 5xx; a POST is not
  let n = 0;
  const flaky = new ServerClient({ store: memory(), sleep: async () => {}, fetch: fakeFetch({ 'GET /x': () => (++n < 3 ? [503, { error: 'busy' }] : [200, { ok: 1 }]), 'POST /y': () => [503, { error: 'busy' }] }) });
  flaky.setServer('https://s.org');
  assert.deepEqual(await flaky.request('GET', '/x', undefined, { retries: 3 }), { ok: 1 });
  await assert.rejects(flaky.request('POST', '/y', {}, { retries: 3 }), (e: unknown) => e instanceof ServerError && e.status === 503 && e.code === 'busy');
});

test('accounts: registering signs in with the token the server made; a refused registration says why', async () => {
  const store = memory();
  const c = new ServerClient({ store, fetch: fakeFetch({ 'GET /info': () => [200, INFO], 'POST /accounts': (b) => [201, { account: { ...ME, name: (b as { name: string }).name }, token: TOKEN }] }) });
  c.setServer('https://s.org');
  await c.connect();
  const me = await c.register('  Anna\n  B ');
  assert.equal(me.name, 'Anna B');
  assert.equal(c.token, TOKEN);
  const closed = new ServerClient({ store: memory(), fetch: fakeFetch({ 'POST /accounts': () => [403, { error: 'registration_closed', message: 'closed' }] }) });
  closed.setServer('https://s.org');
  await assert.rejects(closed.register('X'), (e: unknown) => e instanceof ServerError && e.code === 'registration_closed');
});

// ------------------------------------------------------------------ progress

test('merging: lists are unions against the last agreed copy, the newest settings win', () => {
  const k = (x: string): string => x;
  assert.deepEqual(mergeLists(null, ['a', 'b'], ['b', 'c'], k), ['a', 'b', 'c'], 'no base: a union');
  // b taken out here, d added there, c taken out there
  assert.deepEqual(mergeLists(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'd'], k), ['a', 'd']);
  assert.deepEqual(newest({ t: 5, v: 1 }, { t: 9, v: 2 }), { t: 9, v: 2 });
  assert.deepEqual(newest({ t: 9, v: 1 }, { t: 9, v: 2 }), { t: 9, v: 1 }, 'equal: the local one');
  const theory = KINDS.find((x) => x.kind === 'theory')!;
  assert.deepEqual(theory.merge(null, { done: ['b', 'a'] }, { done: ['c', 'a'] }), { done: ['a', 'b', 'c'] });
  const results = KINDS.find((x) => x.kind === 'results')!;
  const e = (t: number): unknown => ({ t, id: 'speed', severity: 'minor', data: {} });
  assert.equal((results.merge(null, { cleared: 0, entries: [e(1), e(3)] }, { cleared: 0, entries: [e(2), e(3)] }) as { entries: unknown[] }).entries.length, 3);
  // the log emptied here: the server's old entries go, a newer one stays
  const m = results.merge({ cleared: 0, entries: [e(1), e(2)] }, { cleared: 0, entries: [] }, { cleared: 0, entries: [e(1), e(2), e(5)] }) as { cleared: number; entries: Array<{ t: number }> };
  assert.equal(m.cleared, 2);
  assert.deepEqual(m.entries.map((x) => x.t), [5]);
});

/** a server that keeps progress documents with revisions, like the real one */
function progressServer(docs: Record<string, { rev: number; data: unknown }>, calls: Call[] = []): typeof fetch {
  return fakeFetch(
    {
      'GET /info': () => [200, INFO],
      'GET /me': () => [200, ME],
      'GET /progress': () => [200, Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, { rev: d.rev, updated: '' }]))],
      ...Object.fromEntries(
        ['tours', 'history', 'favourites', 'theory', 'results', 'settings', 'maplayers'].flatMap((kind) => [
          [`GET /progress/${kind}`, () => (docs[kind] ? [200, docs[kind]] : [404, { error: 'not_found' }])],
          [
            `PUT /progress/${kind}`,
            (b: unknown) => {
              const { rev, data } = b as { rev: number; data: unknown };
              const cur = docs[kind]?.rev ?? 0;
              if (rev !== cur) return [409, { error: 'conflict', message: 'stale', rev: cur, updated: '', data: docs[kind]?.data }];
              docs[kind] = { rev: cur + 1, data };
              return [200, { rev: cur + 1 }];
            },
          ],
        ]),
      ),
    },
    calls,
  );
}

test('progress: pulled into the browser, pushed when changed, a deletion carried over, a 409 merged and sent again', async () => {
  const docs: Record<string, { rev: number; data: unknown }> = {
    favourites: { rev: 3, data: [{ name: 'There', x: 100, z: 100, yaw: 0 }] },
    settings: { rev: 1, data: { t: 2000, v: { lang: 'de', voice: true, quality: 'ultra' } } },
  };
  const store = memory();
  store.setItem('fahrsim.favourites', JSON.stringify([{ name: 'Here', x: 0, z: 0, yaw: 0 }]));
  store.setItem('fahrsim-baunatal.settings.v2', JSON.stringify({ lang: 'en', voice: false, quality: 'low', graphics: { shadows: 'off' } }));
  store.setItem('fahrsim.sync.stamps', JSON.stringify({ settings: 1000 }));
  const calls: Call[] = [];
  const c = new ServerClient({ store, fetch: progressServer(docs, calls) });
  c.setServer('https://s.org');
  c.setToken(TOKEN);
  await c.connect();
  let now = 10_000;
  const pulled: string[] = [];
  const sync = new ProgressSync({ client: c, store, now: () => now, pulled: (k) => pulled.push(k) });
  await sync.sync();
  // the union of the favourites, here and there
  const fav = JSON.parse(store.getItem('fahrsim.favourites')!) as Array<{ name: string }>;
  assert.deepEqual(fav.map((f) => f.name).sort(), ['Here', 'There']);
  assert.equal((docs.favourites.data as unknown[]).length, 2);
  // the server's settings are newer: taken over – but not the device's own (quality, graphics)
  const st = JSON.parse(store.getItem('fahrsim-baunatal.settings.v2')!) as Record<string, unknown>;
  assert.equal(st.lang, 'de');
  assert.equal(st.voice, true);
  assert.equal(st.quality, 'low');
  assert.deepEqual(st.graphics, { shadows: 'off' });
  assert.ok(pulled.includes('favourites') && pulled.includes('settings'));
  assert.ok(!('quality' in ((docs.settings.data as { v: object }).v)) || (docs.settings.data as { v: { quality: string } }).v.quality === 'ultra', 'device settings are never sent');
  // a favourite taken out here: noticed, and taken out on the server too
  store.setItem('fahrsim.favourites', JSON.stringify([{ name: 'There', x: 100, z: 100, yaw: 0 }]));
  assert.equal(sync.look(), true);
  assert.equal(sync.due(5000), false, 'not at once');
  now += 6000;
  assert.equal(sync.due(5000), true);
  const before = calls.length;
  await sync.sync(true);
  assert.deepEqual((docs.favourites.data as Array<{ name: string }>).map((f) => f.name), ['There']);
  assert.ok(calls.slice(before).every((x) => x.auth === `Bearer ${TOKEN}`));
  // meanwhile another device added one (rev went up) and this one adds one too: 409, merged, sent again
  docs.favourites = { rev: docs.favourites.rev + 1, data: [{ name: 'Elsewhere', x: 900, z: 900, yaw: 0 }, { name: 'There', x: 100, z: 100, yaw: 0 }] };
  store.setItem('fahrsim.favourites', JSON.stringify([{ name: 'New', x: 500, z: 500, yaw: 0 }, { name: 'There', x: 100, z: 100, yaw: 0 }]));
  // (the index was read before the other device wrote: the PUT is stale)
  sync.look();
  now += 6000;
  await sync.sync(true);
  assert.deepEqual((docs.favourites.data as Array<{ name: string }>).map((f) => f.name).sort(), ['Elsewhere', 'New', 'There']);
  assert.deepEqual((JSON.parse(store.getItem('fahrsim.favourites')!) as Array<{ name: string }>).map((f) => f.name).sort(), ['Elsewhere', 'New', 'There']);
});

test('progress: nothing at all without a server, or not signed in', async () => {
  const store = memory();
  const calls: Call[] = [];
  const c = new ServerClient({ store, fetch: progressServer({}, calls) });
  const sync = new ProgressSync({ client: c, store });
  await sync.sync();
  assert.equal(calls.length, 0);
  c.setServer('https://s.org');
  await c.connect();
  await sync.sync();
  assert.ok(calls.every((x) => !x.url.includes('/progress')), 'not signed in: no progress requests');
});

// ------------------------------------------------------------------ playing together

const snap = (time: number, x: number, yaw = 0): Snapshot => ({ time, kind: 'car', x, y: 0, z: 0, yaw, pitch: 0, roll: 0, speed: 10, steer: 0, lights: 0, signal: 0, brake: false, horn: false });

test('snapshots: drawn 100 ms behind, between two, carried on a moment, angles the short way', () => {
  const tr = new RemoteTrack();
  // their clock is 5000 ms behind ours; the snapshots come 80 ms apart, 20 ms on the way
  for (let i = 0; i <= 5; i++) tr.add(snap(i * 80, i * 8), 5000 + i * 80 + 20);
  const out = {} as Snapshot;
  // now = 5420: our clock − 5020 (the quickest seen) − DELAY = their 300 → x 30 (between 240 and 320)
  assert.equal(DELAY, 100);
  assert.ok(tr.sample(5420, out));
  assert.ok(Math.abs(out.x - 30) < 1e-9, `x ${out.x}`);
  // nothing new for long: carried on 250 ms at most, then held
  tr.sample(5000 + 400 + 20 + 100 + 150, out);
  assert.ok(Math.abs(out.x - 55) < 1e-9, `extrapolated ${out.x}`);
  tr.sample(9000, out);
  assert.ok(Math.abs(out.x - 65) < 1e-9, `held ${out.x}`);
  // an old snapshot coming late is not wanted
  tr.add(snap(100, 999), 9001);
  assert.equal(tr.latest?.x, 40);
  assert.ok(Math.abs(lerpAngle(3.1, -3.1, 0.5) - Math.PI) < 0.01, 'across ±π the short way');
  assert.equal(cleanSnapshot({ x: NaN, z: 0 }), null);
  const c = cleanSnapshot({ x: 1, z: 2, y: 'a', signal: 7, steer: 9, paint: 'red', extra: 1 })!;
  assert.deepEqual([c.y, c.signal, c.steer, c.paint, c.extra], [0, 1, 1, undefined, 1]);
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

test('a session: hello, others joining and moving, the own state at 12 Hz, chat echoed once, kicked', () => {
  let now = 0;
  const sockets: FakeSocket[] = [];
  const lines: string[] = [];
  let ended = '';
  const ses = new MultiplayerSession({ url: socketUrl('https://s.org', 'ABCDEF', TOKEN), code: 'ABCDEF', now: () => now, socket: (u) => (sockets[sockets.length] = new FakeSocket(u)), events: { line: (l) => lines.push(`${l.system ? '*' : l.name}:${l.text}`), ended: (r) => (ended = r) } });
  const s = sockets[0];
  assert.equal(s.url, `wss://s.org/api/v1/ws?session=ABCDEF&token=${TOKEN}`);
  s.open();
  ses.tick(snap(0, 0));
  assert.equal(s.sent.length, 0, 'nothing before the hello');
  s.msg({ t: 'hello', you: 'me', host: 'h', map: 'm1', players: [{ id: 'me', name: 'Me', host: false }, { id: 'h', name: 'Host', host: true, s: snap(0, 5) }] });
  assert.equal(ses.players.size, 1, 'the others only');
  assert.equal(ses.players.get('h')?.host, true);
  assert.equal(ses.players.get('h')?.track.latest?.x, 5);
  // the own state: at most 12 a second
  for (now = 0; now < 1000; now += 16) ses.tick(snap(now, now / 100));
  const states = s.sent.filter((m) => m.t === 'state').length;
  assert.ok(states >= 11 && states <= 13, `${states} a second`);
  // without a vehicle: a ping now and then
  s.sent.length = 0;
  for (now = 1000; now < 30_000; now += 500) ses.tick(null);
  assert.deepEqual(s.sent.map((m) => m.t), ['ping']);
  s.msg({ t: 'join', player: { id: 'g', name: 'Guest' } });
  s.msg({ t: 'state', id: 'g', s: snap(10, 3) });
  assert.equal(ses.players.get('g')?.track.latest?.x, 3);
  assert.equal(ses.chatSend('  hello  '), true);
  assert.deepEqual(s.sent.at(-1), { t: 'chat', text: 'hello' });
  s.msg({ t: 'chat', id: 'me', name: 'Me', text: 'hello' });
  s.msg({ t: 'leave', id: 'g', reason: 'left' });
  assert.deepEqual(lines, ['*:join', 'Me:hello', '*:leave']);
  assert.equal(ses.kick('h'), false, 'only the host sends away');
  s.msg({ t: 'bye', reason: 'kicked' });
  assert.equal(ended, 'kicked');
  assert.equal(s.closed, 1000);
  assert.equal(ses.players.size, 0);
});

test('a session: a dropped connection is tried again, a refusal is not; codes and links', async () => {
  const sockets: FakeSocket[] = [];
  let ended = '';
  const ses = new MultiplayerSession({ url: 'wss://s.org/api/v1/ws?session=X', code: 'X', socket: (u) => (sockets[sockets.length] = new FakeSocket(u)), events: { ended: (r) => (ended = r) } });
  sockets[0].open();
  sockets[0].onclose?.({ code: 1006 });
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(sockets.length, 2, 'connected again after a pause');
  sockets[1].onclose?.({ code: 4404, reason: 'not_found' });
  assert.equal(ended, 'refused');
  ses.leave();
  assert.equal(sessionCode(' abc123 '), 'ABC123');
  assert.equal(sessionCode('https://g.io/?server=s.org&join=QWERTY'), 'QWERTY');
  assert.equal(sessionCode('no!'), null);
});

// ------------------------------------------------------------------ images

test('images: the server’s objects read, the checks before an upload', () => {
  const img = parseImage({ image: { id: 7, lat: 51.25, lon: 9.4, kind: 'pano360', visibility: 'public', owner: 'a1', ownerName: 'Anna', heading: null, thumb: null, width: 4000, height: 2000 } })!;
  assert.equal(img.id, '7');
  assert.equal(img.kind, 'pano360');
  assert.ok(Number.isNaN(img.heading));
  assert.equal(img.hasThumb, false);
  assert.equal(parseImage({ id: 1, lat: 'x', lon: 9 }), null);
  assert.ok(twoToOne(4000, 2000) && twoToOne(4001, 2000) && !twoToOne(4000, 2100));
  const meta = { lat: 51, lon: 9, kind: 'photo' as const, visibility: 'private' as const };
  assert.equal(checkUpload({ type: 'image/jpeg', size: 10 }, meta, 1000, { width: 10, height: 10 }), null);
  assert.equal(checkUpload({ type: 'image/gif', size: 10 }, meta, 1000, { width: 10, height: 10 }), 'net.imgBadType');
  assert.equal(checkUpload({ type: 'image/png', size: 2000 }, meta, 1000, { width: 10, height: 10 }), 'net.imgTooBig');
  assert.equal(checkUpload({ type: 'image/png', size: 10 }, { ...meta, lat: NaN }, 1000, { width: 10, height: 10 }), 'net.imgNoPlace');
  assert.equal(checkUpload({ type: 'image/png', size: 10 }, { ...meta, kind: 'pano360' }, 1000, { width: 300, height: 200 }), 'net.imgNot21');
});
