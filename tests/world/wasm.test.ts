// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The WebAssembly (src/wasm/kernels.cpp) against its JavaScript twins: the
 * same numbers from the same input, to the last bit – the coded sections
 * of a tile, the faces of buildings, the quickest way through a network –
 * and the module built from the source as it is now (tools/build-wasm.ts).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { builtModule, sourceHash } from '../../tools/build-wasm.ts';
import { FACE, unpackFaces } from '../../src/world/facade.ts';
import { quickest, quickestToEdge, routeFor, RG } from '../../src/world/routegraph.ts';
import type { RouteGraph } from '../../src/world/routegraph.ts';
import { CODING, encodeSection, packSections, unpackSections, unpackTile } from '../../src/world/tilefmt.ts';
import type { SectionInfo } from '../../src/world/tilefmt.ts';
import { ROUTE_MIN_WAYS, setWasmMode, wasmActive } from '../../src/wasm/kernels.ts';
import { haveMap, mapDir } from '../realmap.ts';

/** a little random generator of our own, the same every run */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/** what `f` gives in JavaScript and in WebAssembly */
function both<T>(f: () => T): { js: T; wasm: T } {
  setWasmMode('off');
  const js = f();
  setWasmMode('auto');
  assert.ok(wasmActive(), 'the WebAssembly is in use');
  const wasm = f();
  return { js, wasm };
}

test('the module was built from the source as it is now (else: node tools/build-wasm.ts)', () => {
  const built = builtModule();
  assert.ok(built, 'src/wasm/kernels.wasm.ts');
  assert.equal(built.hash, sourceHash());
  const section = WebAssembly.Module.customSections(new WebAssembly.Module(built.bytes as BufferSource), 'fahrsim-source-sha256')[0];
  assert.equal(new TextDecoder().decode(section), built.hash);
});

test('coded sections: the WebAssembly decodes them to the same numbers', () => {
  const r = rng(7);
  const wavy = (n: number, lo: number, hi: number): number[] => {
    const out: number[] = [];
    let v = 0;
    for (let i = 0; i < n; i++) {
      v += Math.round((r() - 0.5) * 300);
      if (r() < 0.02) v = lo + Math.floor(r() * (hi - lo));
      out.push(Math.max(lo, Math.min(hi, v)));
    }
    return out;
  };
  const arrays = [
    Int16Array.from(wavy(3 * 500, -32768, 32767)),
    Uint16Array.from(wavy(3 * 333, 0, 65535)),
    Uint32Array.from(wavy(3 * 250, 0, 4294967295)),
    Int32Array.from(wavy(4 * 200, -2147483648, 2147483647)),
    Uint8Array.from(wavy(600, 0, 255)),
    Int8Array.from(wavy(600, -128, 127)),
    Int16Array.from([-32768, 32767, -32768, 0, 32767, -1, 1, 0, 0]),
    Uint32Array.from([0, 4294967295, 1, 4294967295, 0, 2147483648]),
    Int32Array.from([-2147483648, 2147483647, 0, 2147483647, -2147483648, -1]),
  ];
  for (const a of arrays) {
    for (const stride of [1, 2, 3, a.length % 4 === 0 ? 4 : 3]) {
      if (a.length % stride) continue;
      for (const coding of [CODING.PLANES, CODING.DELTA, CODING.GRID]) {
        const packed = packSections({ v: 1 }, { a: encodeSection(a, coding, stride) });
        const get = (): number[] => Array.from(unpackSections<{ sections: Record<string, SectionInfo> }>(packed.buffer as ArrayBuffer).get('a') ?? []);
        const { js, wasm } = both(get);
        assert.deepEqual(wasm, js, `${a.constructor.name}, stride ${stride}, coding ${coding}`);
        assert.deepEqual(js, Array.from(a));
      }
    }
  }
});

test('faces of buildings: the WebAssembly gives every corner the same four numbers', () => {
  const r = rng(11);
  const pos: number[] = [];
  const run: number[] = [];
  const uvx: number[] = [];
  let corners = 0;
  for (let f = 0; f < 600; f++) {
    const n = 1 + Math.floor(r() * 7);
    const rule = Math.floor(r() * 5);
    // walls, roofs, slivers, faces standing on one point – what a tile holds and what it should not
    const cx = Math.round((r() - 0.5) * 40000);
    const cz = Math.round((r() - 0.5) * 40000);
    const flat = r() < 0.15;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rad = r() < 0.05 ? 0 : 50 + r() * 800;
      pos.push(Math.round(cx + Math.cos(a) * rad), flat ? 300 : Math.round(r() * 3000), Math.round(cz + Math.sin(a) * rad));
    }
    if (rule === FACE.EXPLICIT) for (let i = 0; i < n * 4; i++) uvx.push(Math.round((r() - 0.5) * 60000));
    run.push((n << 3) | rule);
    corners += n;
  }
  assert.equal(pos.length, corners * 3);
  const p = Int16Array.from(pos);
  const ru = Uint16Array.from(run);
  for (const u of [Int16Array.from(uvx), Int16Array.from(uvx.slice(0, uvx.length >> 1)), null]) {
    const { js, wasm } = both(() => Array.from(unpackFaces(p, ru, u)));
    assert.deepEqual(wasm, js);
  }
});

/** A town of streets in a grid, with all that a network has: one-way streets, closed ones, minor ones, motorways, turns of every kind. */
function gridNetwork(w: number, h: number, seed: number): RouteGraph {
  const r = rng(seed);
  const nodes = w * h;
  const nx = (i: number): number => (i % w) * 100 + (r() - 0.5) * 30;
  const nz = (i: number): number => Math.floor(i / w) * 100 + (r() - 0.5) * 30;
  const px = Float32Array.from({ length: nodes }, (_, i) => nx(i));
  const pz = Float32Array.from({ length: nodes }, (_, i) => nz(i));
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < nodes; i++) {
    if (i % w < w - 1) edges.push([i, i + 1]);
    if (i + w < nodes) edges.push([i, i + w]);
  }
  const n = edges.length * 2;
  const g: RouteGraph = {
    n,
    len: new Float32Array(n),
    secs: new Float32Array(n),
    kind: new Uint8Array(n),
    cls: new Uint8Array(n),
    x0: new Float32Array(n),
    z0: new Float32Array(n),
    x1: new Float32Array(n),
    z1: new Float32Array(n),
    first: new Uint32Array(n + 1),
    to: new Uint32Array(0),
    turn: new Uint8Array(0),
    across: new Float32Array(0),
    firstIn: new Uint32Array(n + 1),
    from: new Uint32Array(0),
    inTurn: new Uint32Array(0),
  };
  const out: number[][] = Array.from({ length: nodes }, () => []);
  edges.forEach(([a, b], e) => {
    const oneWay = r() < 0.08 ? 1 + Math.floor(r() * 2) : 0;
    for (let d = 0; d < 2; d++) {
      const wy = e * 2 + d;
      const s = d === 0 ? a : b;
      const t = d === 0 ? b : a;
      g.x0[wy] = px[s];
      g.z0[wy] = pz[s];
      g.x1[wy] = px[t];
      g.z1[wy] = pz[t];
      g.cls[wy] = Math.floor(r() * 14);
      if (oneWay === d + 1) continue;
      g.len[wy] = Math.max(0.5, Math.hypot(px[t] - px[s], pz[t] - pz[s]) * (1 + r() * 0.3));
      g.secs[wy] = g.len[wy] / (5 + r() * 31);
      g.kind[wy] = (r() < 0.04 ? RG.NO_ENTRY : 0) | (r() < 0.06 ? RG.ACCESS_ONLY : 0) | (r() < 0.03 ? RG.TO_MAP_END : 0);
      out[s].push(wy);
    }
  });
  const to: number[] = [];
  const turn: number[] = [];
  const across: number[] = [];
  for (let wy = 0; wy < n; wy++) {
    g.first[wy] = to.length;
    if (g.len[wy] === 0) continue;
    const end = edges[wy >> 1][(wy & 1) === 0 ? 1 : 0];
    for (const t of out[end]) {
      to.push(t);
      turn.push(t >> 1 === wy >> 1 ? 3 : Math.floor(r() * 3));
      across.push(r() * 25);
    }
  }
  g.first[n] = to.length;
  g.to = Uint32Array.from(to);
  g.turn = Uint8Array.from(turn);
  g.across = Float32Array.from(across);
  return g;
}

test('the quickest way: the same ways and the same seconds in WebAssembly', () => {
  const g = gridNetwork(60, 60, 3);
  assert.ok(g.n >= ROUTE_MIN_WAYS, 'big enough for the WebAssembly');
  const r = rng(5);
  const pick = (): number => {
    for (;;) {
      const w = Math.floor(r() * g.n);
      if (g.len[w] > 0) return w;
    }
  };
  let found = 0;
  try {
    for (let i = 0; i < 60; i++) {
      const a = pick();
      const b = pick();
      // what the game asks for: plain, round the motorway, with roads closed and dearer
      routeFor.noMotorway = i % 3 === 1;
      routeFor.wayCost = i % 4 === 2 ? (w) => (w % 17 === 0 ? Infinity : w % 5 === 0 ? 30 : 0) : null;
      const { js, wasm } = both(() => quickest(g, a, b));
      assert.deepEqual(wasm, js, `from ${a} to ${b}`);
      if (js) found++;
      const e = both(() => quickestToEdge(g, a, b >> 1));
      assert.deepEqual(e.wasm, e.js);
    }
  } finally {
    routeFor.noMotorway = false;
    routeFor.wayCost = null;
  }
  assert.ok(found > 30, `ways found: ${found}`);
});

test('the real map: tiles and ways the same in WebAssembly', { skip: !haveMap && 'no map in public/map' }, async () => {
  // tiles of Baunatal: every section and the faces of the buildings
  const dir = join(mapDir, 'tiles');
  const files = readdirSync(dir).filter((f) => /^(39[89]|40[01])_(39[89]|40[01])\.fsb$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const raw = readFileSync(join(dir, f));
    const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const names = [...Object.keys(unpackTile(buf).header.sections), 'bldg_a16'];
    const { js, wasm } = both(() => {
      const u = unpackTile(buf);
      return names.map((name) => Array.from(u.get(name) ?? []));
    });
    assert.deepEqual(wasm, js, f);
  }
  // ways across the whole map
  const { unpackNet, routeGraphOfNet } = await import('../../src/world/netfile.ts');
  const { mainWays } = await import('../../src/world/routegraph.ts');
  const nb = gunzipSync(readFileSync(join(mapDir, 'net.bin.gz')));
  const g = routeGraphOfNet(unpackNet(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength) as ArrayBuffer));
  const main = mainWays(g);
  const ids: number[] = [];
  for (let w = 0; w < g.n; w++) if (main[w]) ids.push(w);
  const r = rng(9);
  for (let i = 0; i < 4; i++) {
    const a = ids[Math.floor(r() * ids.length)];
    const b = ids[Math.floor(r() * ids.length)];
    const { js, wasm } = both(() => quickest(g, a, b));
    assert.deepEqual(wasm, js, `from ${a} to ${b}`);
  }
});
