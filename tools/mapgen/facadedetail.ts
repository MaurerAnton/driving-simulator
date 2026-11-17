// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The real details of single walls, where they were measured on site:
 * windows, doors, balconies, shop fronts and the plinth, wall by wall
 * (tools/mapgen/observed-facades.json), and the hedges, fences and garden
 * walls seen beside the buildings (tools/mapgen/observed-barriers.json).
 *
 * A wall of the official building models (LoD2) that has measured details
 * gets them as simple geometry of its own – a dark glass pane with a light
 * frame and a sill for a window, a door leaf in a frame, a slab with a
 * railing for a balcony, a large pane for a shop window, a coloured band for
 * the plinth – in the tile's mesh `fdet` (r, g, b per corner).  Its corners
 * in the building mesh are listed in `bldgObs` (first corner, how many): the
 * game draws no window grid of its own there (src/render/facadedetail.ts).
 * Both go into sections that versions before 1.6.0 never ask for, so they
 * read these tiles as before and draw the walls with their usual windows.
 *
 * The measured file: {"buildings":[{"id", "walls":[{"a":[x,z], "b":[x,z],
 * "base":y, "windows":[[u0,v0,u1,v1],…], "doors":[…], "balconies":
 * [[u0,u1,v,depth],…], "plinth":{"h","colour"}, "shopfront":[[u0,v0,u1,v1],…]}]}]}
 * – u in metres along a→b, v in metres up from base.  Only facts: sizes and
 * colours, no pictures.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SectionArray } from '../../src/world/tilefmt.ts';
import { meshSections } from './meshacc.ts';
import type { MeshAcc, TileData } from './meshacc.ts';
import { rgbOf } from './observed.ts';

type RGB = [number, number, number];
type XZ = [number, number];

/** One measured wall. */
export interface ObservedWall {
  a: XZ;
  b: XZ;
  base?: number;
  windows?: number[][];
  doors?: number[][];
  balconies?: number[][];
  plinth?: { h: number; colour?: string };
  shopfront?: number[][];
}

/** One hedge, fence or wall: its line (flat x, z …) and its height. */
export interface ObservedBarrier {
  kind: 'hedge' | 'fence' | 'wall';
  h: number;
  pts: number[];
}

/** how far the ends of a wall of the model may lie from the measured ends (metres) */
export const MATCH_TOLERANCE = 0.5;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isXZ = (p: unknown): p is XZ => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]);

/** The measured walls (from `file`, or the one next to this module): building id → its walls. */
export function loadObservedFacades(file = fileURLToPath(new URL('./observed-facades.json', import.meta.url))): Map<string, ObservedWall[]> {
  const out = new Map<string, ObservedWall[]>();
  if (!existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as { buildings?: Array<{ id?: unknown; walls?: unknown[] }> };
  for (const b of j.buildings ?? []) {
    if (!b || typeof b.id !== 'string' || !Array.isArray(b.walls)) continue;
    const walls = (b.walls as ObservedWall[]).filter((w) => w && isXZ(w.a) && isXZ(w.b));
    if (walls.length) out.set(b.id, (out.get(b.id) ?? []).concat(walls));
  }
  return out;
}

/** The hedges, fences and walls seen on site (tools/mapgen/observed-barriers.json). */
export function loadObservedBarriers(file = fileURLToPath(new URL('./observed-barriers.json', import.meta.url))): ObservedBarrier[] {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8')) as { barriers?: Array<{ kind?: string; h?: number; pts?: unknown[] }> };
  const out: ObservedBarrier[] = [];
  for (const b of j.barriers ?? []) {
    if (!b || !(b.kind === 'hedge' || b.kind === 'fence' || b.kind === 'wall') || !Array.isArray(b.pts)) continue;
    const pts = b.pts.filter(isXZ).flatMap((p) => [p[0], p[1]]);
    if (pts.length < 4) continue;
    out.push({ kind: b.kind, h: finite(b.h) && b.h > 0.1 && b.h < 6 ? b.h : BARRIER_LOOK[b.kind].h, pts });
  }
  return out;
}

/** How a barrier of each kind is drawn: half its thickness, how deep its foot goes, its usual height, its colour. */
export const BARRIER_LOOK: Record<ObservedBarrier['kind'], { halfW: number; y0: number; h: number; rgb: RGB }> = {
  hedge: { halfW: 0.4, y0: -0.3, h: 1.4, rgb: [58, 92, 44] },
  fence: { halfW: 0.03, y0: -0.2, h: 1.2, rgb: [118, 104, 88] },
  wall: { halfW: 0.12, y0: -0.4, h: 1.2, rgb: [176, 170, 160] },
};

/**
 * The measured wall that is this wall of the model: both ends on the ground
 * (the corners furthest apart along it, seen from above) within
 * MATCH_TOLERANCE of the measured ends, either way round.  A and B: the
 * model's ends, A the one at the measured `a`.
 */
export function matchWall(poly: ArrayLike<number>, off: number, n: number, ux: number, uz: number, walls: ObservedWall[]): { wall: ObservedWall; A: XZ; B: XZ } | null {
  let lo = Infinity;
  let hi = -Infinity;
  let p: XZ = [0, 0];
  let q: XZ = [0, 0];
  // (the polygon's foot: walls stacked one above the other share their ground corners, and only the base tells them apart)
  let foot = Infinity;
  for (let i = 0; i < n; i++) foot = Math.min(foot, poly[off + i * 3 + 1]);
  for (let i = 0; i < n; i++) {
    const x = poly[off + i * 3];
    const z = poly[off + i * 3 + 2];
    const u = x * ux + z * uz;
    if (u < lo) {
      lo = u;
      p = [x, z];
    }
    if (u > hi) {
      hi = u;
      q = [x, z];
    }
  }
  const d = (s: XZ, t: XZ): number => Math.hypot(s[0] - t[0], s[1] - t[1]);
  for (const w of walls) {
    if (w.base !== undefined && Number.isFinite(w.base) && Math.abs(foot - w.base) > 0.3) continue;
    if (d(p, w.a) <= MATCH_TOLERANCE && d(q, w.b) <= MATCH_TOLERANCE) return { wall: w, A: p, B: q };
    if (d(q, w.a) <= MATCH_TOLERANCE && d(p, w.b) <= MATCH_TOLERANCE) return { wall: w, A: q, B: p };
  }
  return null;
}

// the colours of the parts
const GLASS: RGB = [38, 50, 62];
const FRAME: RGB = [226, 226, 220];
const SILL: RGB = [188, 184, 176];
const DOOR: RGB = [92, 70, 54];
const SHOP_GLASS: RGB = [62, 82, 96];
const SHOP_FRAME: RGB = [70, 72, 76];
const SLAB: RGB = [172, 170, 164];
const RAILING: RGB = [72, 74, 78];

/** how far in front of the wall the panes, frames and the plinth lie (metres; the tile stores positions to 2 cm) */
const D_PANE = 0.03;
const D_FRAME = 0.06;
const D_PLINTH = 0.025;
const FRAME_W = 0.07;

/**
 * The details of a measured wall into `m` (r, g, b per corner).  A → B: the
 * wall's foot (the model's ends), (nx, nz) the way it faces (level, of
 * length 1), `base` its foot, `top` its highest point (nothing is put above it),
 * `wallCol` its colour (the plinth's when none was measured).  Returns the
 * number of triangles.
 */
export function emitWallDetail(m: MeshAcc, w: ObservedWall, A: XZ, B: XZ, nx: number, nz: number, base: number, top: number, wallCol: RGB): number {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (L < 0.3) return 0;
  const tx = (B[0] - A[0]) / L;
  const tz = (B[1] - A[1]) / L;
  const H = top - base;
  const before = m.idx.length;
  const at = (u: number, v: number, d: number): [number, number, number] => [A[0] + tx * u + nx * d, base + v, A[1] + tz * u + nz * d];
  const v4 = (c: RGB, ...p: Array<[number, number, number]>): number[] => p.map((q) => m.vert(q[0], q[1], q[2], c[0], c[1], c[2]));
  /** a rectangle on the wall, `d` in front of it, facing out */
  const face = (u0: number, v0: number, u1: number, v1: number, d: number, c: RGB): void => {
    if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return;
    const [a, b, cc, dd] = v4(c, at(u0, v0, d), at(u1, v0, d), at(u1, v1, d), at(u0, v1, d));
    m.quad(a, b, cc, dd, nx, 0, nz);
  };
  /** a level rectangle at height v from d0 to d1 in front of the wall (up: facing up, else down) */
  const level = (u0: number, u1: number, v: number, d0: number, d1: number, up: boolean, c: RGB): void => {
    const [a, b, cc, dd] = v4(c, at(u0, v, d0), at(u1, v, d0), at(u1, v, d1), at(u0, v, d1));
    m.quad(a, b, cc, dd, 0, up ? 1 : -1, 0);
  };
  /** an upright rectangle across the wall at u, from d0 to d1 (facing towards +u if `plus`) */
  const end = (u: number, v0: number, v1: number, d0: number, d1: number, plus: boolean, c: RGB): void => {
    const [a, b, cc, dd] = v4(c, at(u, v0, d0), at(u, v0, d1), at(u, v1, d1), at(u, v1, d0));
    m.quad(a, b, cc, dd, plus ? tx : -tx, 0, plus ? tz : -tz);
  };
  /** a rectangle [u0, v0, u1, v1] kept on the wall (null: nothing of it left, or not numbers) */
  const rect = (r: unknown): [number, number, number, number] | null => {
    if (!Array.isArray(r) || r.length < 4 || !r.slice(0, 4).every(finite)) return null;
    const u0 = Math.max(0, Math.min(r[0], r[2]));
    const u1 = Math.min(L, Math.max(r[0], r[2]));
    const v0 = Math.max(0, Math.min(r[1], r[3]));
    const v1 = Math.min(H, Math.max(r[1], r[3]));
    return u1 - u0 >= 0.1 && v1 - v0 >= 0.1 ? [u0, v0, u1, v1] : null;
  };
  /** the four bars of a frame around an opening, `d` in front (`bottom`: the lower one too) */
  const frame = (u0: number, v0: number, u1: number, v1: number, d: number, c: RGB, bottom: boolean): void => {
    face(u0 - FRAME_W, v0 - (bottom ? FRAME_W : 0), u0, v1 + FRAME_W, d, c);
    face(u1, v0 - (bottom ? FRAME_W : 0), u1 + FRAME_W, v1 + FRAME_W, d, c);
    face(u0, v1, u1, v1 + FRAME_W, d, c);
    if (bottom) face(u0, v0 - FRAME_W, u1, v0, d, c);
  };

  // the plinth: a band of its colour along the whole foot (from below the ground up)
  if (w.plinth && finite(w.plinth.h) && w.plinth.h > 0.05) {
    const c = rgbOf(w.plinth.colour) ?? [Math.round(wallCol[0] * 0.72), Math.round(wallCol[1] * 0.72), Math.round(wallCol[2] * 0.72)];
    face(0, -0.5, L, Math.min(w.plinth.h, H), D_PLINTH, c);
  }
  for (const r of w.windows ?? []) {
    const q = rect(r);
    if (!q) continue;
    const [u0, v0, u1, v1] = q;
    // (the pane reaches under the frame: no gap to see the wall through)
    face(u0 - FRAME_W * 0.5, v0 - FRAME_W * 0.5, u1 + FRAME_W * 0.5, v1 + FRAME_W * 0.5, D_PANE, GLASS);
    frame(u0, v0, u1, v1, D_FRAME, FRAME, true);
    // the sill: a ledge under the window
    const sv = v0 - FRAME_W;
    face(u0 - 0.06, sv - 0.05, u1 + 0.06, sv, 0.13, SILL);
    level(u0 - 0.06, u1 + 0.06, sv, 0, 0.13, true, SILL);
  }
  for (const r of w.doors ?? []) {
    const q = rect(r);
    if (!q) continue;
    const [u0, v0, u1, v1] = q;
    face(u0 - FRAME_W * 0.5, v0, u1 + FRAME_W * 0.5, v1 + FRAME_W * 0.5, D_PANE, DOOR);
    frame(u0, v0, u1, v1, D_FRAME, FRAME, false);
  }
  for (const r of w.shopfront ?? []) {
    const q = rect(r);
    if (!q) continue;
    const [u0, v0, u1, v1] = q;
    face(u0 - FRAME_W * 0.5, v0 - FRAME_W * 0.5, u1 + FRAME_W * 0.5, v1 + FRAME_W * 0.5, D_PANE, SHOP_GLASS);
    frame(u0, v0, u1, v1, D_FRAME, SHOP_FRAME, true);
  }
  for (const r of w.balconies ?? []) {
    if (!Array.isArray(r) || r.length < 4 || !r.slice(0, 4).every(finite)) continue;
    const u0 = Math.max(0, Math.min(r[0], r[1]));
    const u1 = Math.min(L, Math.max(r[0], r[1]));
    const v = r[2];
    const depth = Math.min(3, r[3]);
    if (u1 - u0 < 0.3 || depth < 0.2 || v < 0.5 || v > H) continue;
    // the slab: a box out of the wall
    const s0 = v - 0.18;
    level(u0, u1, v, 0, depth, true, SLAB);
    level(u0, u1, s0, 0, depth, false, SLAB);
    face(u0, s0, u1, v, depth, SLAB);
    end(u0, s0, v, 0, depth, false, SLAB);
    end(u1, s0, v, 0, depth, true, SLAB);
    // the railing: panels along its edges (the material draws both sides)
    face(u0, v, u1, v + 1.0, depth - 0.03, RAILING);
    end(u0 + 0.02, v, v + 1.0, 0, depth - 0.03, false, RAILING);
    end(u1 - 0.02, v, v + 1.0, 0, depth - 0.03, true, RAILING);
  }
  return (m.idx.length - before) / 3;
}

/** The sections of a tile for the measured details: the mesh `fdet_*`, and `bldg_obs` (first corner, count per wall). */
export function detailSections(t: TileData, cx: number, cz: number, yBase: number, out: Record<string, SectionArray>): void {
  meshSections('fdet', t.fdet, cx, cz, yBase, out);
  if (t.bldgObs.length) out.bldg_obs = Uint32Array.from(t.bldgObs);
}
