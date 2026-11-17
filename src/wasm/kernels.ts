// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's WebAssembly (kernels.cpp, built into kernels.wasm.ts by
 * tools/build-wasm.ts): the decoding of map tiles and the search for the
 * quickest way through the network of the whole map, measured to be about
 * twice as quick there as in JavaScript (Node on an ARM tablet: a tile 12 →
 * 7 ms, a route across the map 470 → 260 ms) – what counts on a weak phone.
 *
 * Every function here answers `null` (or undefined) when it cannot help –
 * no WebAssembly in this browser, switched off in the settings
 * (Settings.wasm), not compiled yet, or input it was not made for – and the
 * caller then does the same in JavaScript.  Both give the very same numbers
 * (tests/world/wasm.test.ts compares them).
 *
 * The module is compiled once (in the background, as soon as this file is
 * loaded); each user gets an instance with memory of its own: one for the
 * tiles, whose memory grows as the biggest tile needs, and one for each
 * large road network, whose arrays are moved into the memory of its instance
 * (the RouteGraph then holds views of it – no second copy) and which is
 * never grown again, so that those views stay valid.
 */
import { SOURCE_SHA256, WASM_BASE64 } from './kernels.wasm.ts';

export type WasmMode = 'auto' | 'off';
export const WASM_MODES: readonly WasmMode[] = ['auto', 'off'];

let mode: WasmMode = 'auto';
let compiled: WebAssembly.Module | null = null;
let broken = false;

function bytes(): Uint8Array {
  const s = atob(WASM_BASE64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Can this browser run WebAssembly at all? */
export function wasmSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function' && !broken;
}

// (compiled in the background straight away; until then the JavaScript does the work)
if (wasmSupported()) {
  WebAssembly.compile(bytes() as BufferSource).then(
    (m) => {
      compiled ??= m;
    },
    (err: unknown) => {
      broken = true;
      console.warn('WebAssembly not usable, the JavaScript does the work', err);
    },
  );
}

/** The module, compiled now if it is not yet (a small one may be compiled at once even in a page). */
function module(): WebAssembly.Module | null {
  if (mode === 'off' || broken) return null;
  if (compiled) return compiled;
  if (!wasmSupported()) return null;
  try {
    compiled = new WebAssembly.Module(bytes() as BufferSource);
  } catch {
    // (a browser that compiles only in the background: the next time)
    return null;
  }
  return compiled;
}

/** Settings.wasm: 'auto' – WebAssembly where the browser has it; 'off' – JavaScript only. */
export function setWasmMode(m: WasmMode): void {
  mode = WASM_MODES.includes(m) ? m : 'auto';
}

export function wasmMode(): WasmMode {
  return mode;
}

/** Is the WebAssembly in use now (for the settings: what 'auto' came to)? */
export function wasmActive(): boolean {
  return module() !== null;
}

/** the hash of the source the module was built from (tools/build-wasm.ts --check) */
export const WASM_SOURCE = SOURCE_SHA256;

interface Kernels {
  decode_section(bytes: number, out: number, n: number, type: number, coding: number, stride: number): void;
  unpack_faces(pos: number, run: number, nrun: number, uvx: number, nuvx: number, out: number): void;
  route_prepare(graph: number, secs: number, x1: number, z1: number, kind: number, cls: number): void;
  route_search(graph: number, start: number, goal: number, noMotorway: number, motorwayLink: number, useCost: number): number;
}

const PAGE = 65536;
/** (nothing lives at address 0: a pointer 0 means "none") */
const BOTTOM = 64;

function instantiate(memory: WebAssembly.Memory, wayCost: (way: number) => number): Kernels | null {
  const m = module();
  if (!m) return null;
  try {
    const inst = new WebAssembly.Instance(m, {
      env: { __linear_memory: memory, __indirect_function_table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }), way_cost: wayCost },
    });
    return inst.exports as unknown as Kernels;
  } catch (err) {
    broken = true;
    console.warn('WebAssembly not usable, the JavaScript does the work', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// map tiles

let tileMem: WebAssembly.Memory | null = null;
let tileKernels: Kernels | null = null;

/** The tiles' instance with at least `need` bytes of memory above BOTTOM. */
function tileInstance(need: number): { k: Kernels; mem: WebAssembly.Memory } | null {
  if (!module()) return null;
  if (!tileMem || !tileKernels) {
    tileMem = new WebAssembly.Memory({ initial: 16 });
    tileKernels = instantiate(tileMem, () => 0);
    if (!tileKernels) return null;
  }
  const have = tileMem.buffer.byteLength;
  if (BOTTOM + need > have) {
    try {
      tileMem.grow(Math.ceil((BOTTOM + need - have) / PAGE));
    } catch {
      return null;
    }
  }
  return { k: tileKernels, mem: tileMem };
}

const align8 = (n: number): number => (n + 7) & ~7;

export type IntSectionType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32';
const TYPE_CODE: Record<IntSectionType, number> = { u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 5 };
const SIZE: Record<IntSectionType, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

type IntArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array;

function arrayOf(t: IntSectionType, buf: ArrayBuffer, off: number, n: number): IntArray {
  switch (t) {
    case 'u8':
      return new Uint8Array(buf, off, n);
    case 'i8':
      return new Int8Array(buf, off, n);
    case 'u16':
      return new Uint16Array(buf, off, n);
    case 'i16':
      return new Int16Array(buf, off, n);
    case 'u32':
      return new Uint32Array(buf, off, n);
    default:
      return new Int32Array(buf, off, n);
  }
}

/** tilefmt.ts decodeSection in WebAssembly – null: let the JavaScript do it. */
export function wasmDecodeSection(bytes: Uint8Array, n: number, t: IntSectionType, coding: number, stride: number): IntArray | null {
  if (mode === 'off' || coding < 1 || coding > 3 || !(stride >= 1) || !Number.isInteger(stride) || !Number.isInteger(n) || n <= 0) return null;
  const groups = coding === 3 ? 1 : stride;
  if (n % groups !== 0) return null;
  const B = SIZE[t];
  if (bytes.length < n * B) return null;
  const outAt = BOTTOM + align8(n * B);
  const it = tileInstance(outAt - BOTTOM + n * B);
  if (!it) return null;
  const buf = it.mem.buffer;
  new Uint8Array(buf, BOTTOM, n * B).set(bytes.subarray(0, n * B));
  it.k.decode_section(BOTTOM, outAt, n, TYPE_CODE[t], coding, stride);
  return arrayOf(t, buf, outAt, n).slice();
}

/** facade.ts unpackFaces in WebAssembly – null: let the JavaScript do it. */
export function wasmUnpackFaces(pos: ArrayLike<number>, run: ArrayLike<number>, uvx: ArrayLike<number> | null): Int16Array | null {
  if (mode === 'off' || !(pos instanceof Int16Array) || !(run instanceof Uint16Array) || (uvx !== null && !(uvx instanceof Int16Array))) return null;
  if (pos.length % 3 !== 0) return null;
  const count = pos.length / 3;
  let corners = 0;
  for (let r = 0; r < run.length; r++) corners += run[r] >> 3;
  // (runs past the corners: what the JavaScript makes of them is the reference)
  if (corners > count) return null;
  const posAt = BOTTOM;
  const runAt = posAt + align8(pos.byteLength);
  const uvxAt = runAt + align8(run.byteLength);
  const outAt = uvxAt + align8(uvx ? uvx.byteLength : 0);
  const outLen = count * 4;
  const it = tileInstance(outAt - BOTTOM + outLen * 2);
  if (!it) return null;
  const buf = it.mem.buffer;
  new Int16Array(buf, posAt, pos.length).set(pos);
  new Uint16Array(buf, runAt, run.length).set(run);
  if (uvx) new Int16Array(buf, uvxAt, uvx.length).set(uvx);
  const out = new Int16Array(buf, outAt, outLen);
  out.fill(0);
  it.k.unpack_faces(posAt, runAt, run.length, uvx ? uvxAt : 0, uvx ? uvx.length : 0, outAt);
  return out.slice();
}

// ---------------------------------------------------------------------------
// the quickest way

/** What routegraph.ts quickestTimed reads of a RouteGraph. */
export interface SearchGraph {
  n: number;
  len: Float32Array;
  secs: Float32Array;
  kind: Uint8Array;
  cls: Uint8Array;
  x1: Float32Array;
  z1: Float32Array;
  first: Uint32Array;
  to: Uint32Array;
  turn: Uint8Array;
  across: Float32Array;
}

/** what a way costs on top (routeFor.wayCost), for the search running now */
let costNow: ((way: number) => number) | null = null;

interface Resident {
  k: Kernels;
  /** where the Graph struct lies (kernels.cpp) */
  at: number;
  /** the State of each way (kernels.cpp), 4 × 32 bits: dist (2), stamp, prev */
  state: Uint32Array;
  gen: Uint32Array;
}

const residents = new WeakMap<SearchGraph, Resident | null>();

/** the fields of the Graph struct (kernels.cpp) */
const GRAPH_FIELDS = 10;

/** Networks smaller than this are left to the JavaScript (they are searched in no time anyway). */
export const ROUTE_MIN_WAYS = 5000;

/** Move a network into memory of its own (null: it cannot be). */
function residentOf(g: SearchGraph): Resident | null {
  if (residents.has(g)) return residents.get(g) ?? null;
  if (!module()) return null;
  const n = g.n;
  const T = g.to.length;
  if (g.len.length !== n || g.first.length !== n + 1 || g.turn.length !== T || g.across.length !== T) {
    residents.set(g, null);
    return null;
  }
  // (the heap: pairs pushed and not yet popped – at most 2 % of the ways in the searches measured across
  // the whole map; should one need more, the JavaScript does that one)
  const heapCap = Math.max(65536, n >> 3);
  let at = BOTTOM;
  const take = (bytes: number): number => {
    const p = at;
    at = align8(at + bytes);
    return p;
  };
  const struct = take(GRAPH_FIELDS * 4);
  const lay = {
    // (the RouteGraph's own arrays, which move here)
    len: take(n * 4),
    secs: take(n * 4),
    x1: take(n * 4),
    z1: take(n * 4),
    first: take((n + 1) * 4),
    to: take(T * 4),
    across: take(T * 4),
    kind: take(n),
    cls: take(n),
    turn: take(T),
    // (the search's: Way, State, Entry – 16 bytes each)
    ways: take(n * 16),
    state: take(n * 16),
    heap: take(heapCap * 16),
  };
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: Math.ceil(at / PAGE) });
  } catch {
    residents.set(g, null);
    return null;
  }
  const k = instantiate(memory, (w) => (costNow ? costNow(w) : 0));
  if (!k) return null;
  const buf = memory.buffer;
  // the network's arrays move: the graph keeps views of the instance's memory
  const move = <A extends Float32Array | Uint32Array | Uint8Array>(a: A, make: (buf: ArrayBuffer, at: number, n: number) => A, at: number): A => {
    const v = make(buf, at, a.length);
    v.set(a as ArrayLike<number>);
    return v;
  };
  const f32 = (b: ArrayBuffer, o: number, l: number): Float32Array => new Float32Array(b, o, l);
  const u32 = (b: ArrayBuffer, o: number, l: number): Uint32Array => new Uint32Array(b, o, l);
  const u8 = (b: ArrayBuffer, o: number, l: number): Uint8Array => new Uint8Array(b, o, l);
  g.len = move(g.len, f32, lay.len);
  g.secs = move(g.secs, f32, lay.secs);
  g.x1 = move(g.x1, f32, lay.x1);
  g.z1 = move(g.z1, f32, lay.z1);
  g.first = move(g.first, u32, lay.first);
  g.to = move(g.to, u32, lay.to);
  g.across = move(g.across, f32, lay.across);
  g.kind = move(g.kind, u8, lay.kind);
  g.cls = move(g.cls, u8, lay.cls);
  g.turn = move(g.turn, u8, lay.turn);
  new Uint32Array(buf, struct, GRAPH_FIELDS).set([n, lay.ways, lay.first, lay.to, lay.turn, lay.across, lay.state, 0, lay.heap, heapCap]);
  k.route_prepare(struct, lay.secs, lay.x1, lay.z1, lay.kind, lay.cls);
  const r: Resident = { k, at: struct, state: new Uint32Array(buf, lay.state, n * 4), gen: new Uint32Array(buf, struct + 7 * 4, 1) };
  residents.set(g, r);
  return r;
}

/**
 * routegraph.ts quickestTimed in WebAssembly: the ways after `start` to
 * `goal` and their seconds, null when there is no way – undefined: let the
 * JavaScript search.  `start` ≠ `goal`.
 */
export function wasmQuickest(
  g: SearchGraph,
  start: number,
  goal: number,
  noMotorway: boolean,
  motorwayLink: number,
  wayCost: ((way: number) => number) | null,
): { ways: number[]; secs: number } | null | undefined {
  if (mode === 'off' || g.n < ROUTE_MIN_WAYS || !(start >= 0 && start < g.n && goal >= 0 && goal < g.n)) return undefined;
  const r = residentOf(g);
  if (!r) return undefined;
  // (the stamps start again before the counter runs over)
  if (r.gen[0] >= 0xfffffff0) {
    r.state.fill(0);
    r.gen[0] = 0;
  }
  costNow = wayCost;
  let secs: number;
  try {
    secs = r.k.route_search(r.at, start, goal, noMotorway ? 1 : 0, motorwayLink, wayCost ? 1 : 0);
  } finally {
    costNow = null;
  }
  if (secs === -1) return undefined;
  if (!Number.isFinite(secs)) return null;
  const gen = r.gen[0];
  const path: number[] = [];
  const st = r.state;
  for (let w = goal; w !== start; w = st[w * 4 + 2] === gen ? st[w * 4 + 3] | 0 : -1) {
    if (w < 0) return null;
    path.push(w);
  }
  return { ways: path.reverse(), secs };
}
