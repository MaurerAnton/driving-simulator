// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What stands between a front garden and the street, as simple low-poly
 * shapes in the tile's `struct` mesh (vertex colours): garden hedges of a
 * few heights, fences of the usual kinds and low garden walls.
 *
 * The third round of comparing the game with street photos (2026-11) found
 * the frontages of Baunatal's residential streets to be a mix, plot by plot:
 * low (0.8–1.2 m) and tall (1.5–2.5 m) hedges right behind the pavement,
 * white or dark metal railings, wooden picket and post-and-rail fences, mesh
 * fences, privacy panels, low brick, block or rendered walls – with a gap at
 * every driveway and now and then an open lawn.  `frontagePlan` cuts a side
 * of a street into plots and picks one of these for each, deterministically
 * from the road and the plot (the same on every build); `drawBarrier` draws
 * one along a line.  Used in the detail region only (mapgen/roadside.ts
 * addFrontage for frontage:<side>, mapgen/objects.ts for mapped barriers).
 */
import { mix01 } from './parking.ts';
import { addBand, addQuad } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';

type RGB = [number, number, number];

/** The kinds of barrier a plot may get. */
export type BarrierStyle =
  | 'hedge'
  | 'hedge_red'
  | 'picket'
  | 'post_rail'
  | 'railing_white'
  | 'railing_dark'
  | 'mesh'
  | 'panel'
  | 'wall_block'
  | 'wall_render'
  | 'wall_brick';

/** How a style is drawn: `solid` a box (half thickness `halfW`), else rails between posts. */
export interface BarrierLook {
  solid: boolean;
  halfW: number;
  /** how deep its foot goes below the ground line */
  y0: number;
  rgb: RGB;
  /** usual heights (m): from … to */
  h: [number, number];
}

export const BARRIER_STYLES: Record<BarrierStyle, BarrierLook> = {
  hedge: { solid: true, halfW: 0.32, y0: -0.2, rgb: [56, 88, 42], h: [0.8, 1.2] },
  hedge_red: { solid: true, halfW: 0.3, y0: -0.2, rgb: [96, 56, 46], h: [0.7, 1.1] },
  picket: { solid: true, halfW: 0.02, y0: -0.1, rgb: [128, 104, 78], h: [0.8, 1.1] },
  post_rail: { solid: false, halfW: 0.04, y0: -0.1, rgb: [110, 88, 66], h: [0.9, 1.2] },
  railing_white: { solid: false, halfW: 0.025, y0: -0.1, rgb: [226, 226, 220], h: [0.9, 1.2] },
  railing_dark: { solid: false, halfW: 0.025, y0: -0.1, rgb: [46, 50, 50], h: [0.9, 1.3] },
  mesh: { solid: true, halfW: 0.015, y0: -0.1, rgb: [72, 92, 74], h: [1.0, 1.3] },
  panel: { solid: true, halfW: 0.03, y0: -0.1, rgb: [124, 120, 114], h: [1.6, 1.9] },
  wall_block: { solid: true, halfW: 0.12, y0: -0.3, rgb: [168, 164, 156], h: [0.4, 0.8] },
  wall_render: { solid: true, halfW: 0.12, y0: -0.3, rgb: [214, 210, 200], h: [0.5, 0.8] },
  wall_brick: { solid: true, halfW: 0.12, y0: -0.3, rgb: [148, 84, 64], h: [0.4, 0.7] },
};

/** Is the style a hedge (counted, and drawn thick and green)? */
export function isHedge(s: BarrierStyle): boolean {
  return s === 'hedge' || s === 'hedge_red';
}

/** Is the style a wall? */
export function isWall(s: BarrierStyle): boolean {
  return s === 'wall_block' || s === 'wall_render' || s === 'wall_brick';
}

/** One plot along a side of a street: stations s0…s1, what stands there (null: an open lawn) and how high. */
export interface FrontPlot {
  s0: number;
  s1: number;
  style: BarrierStyle | null;
  h: number;
}

/** The fences of the usual kinds, by how often they were seen. */
const FENCES: Array<[BarrierStyle, number]> = [
  ['picket', 0.22],
  ['post_rail', 0.18],
  ['railing_white', 0.16],
  ['railing_dark', 0.16],
  ['mesh', 0.16],
  ['panel', 0.12],
];
const WALLS: Array<[BarrierStyle, number]> = [
  ['wall_block', 0.45],
  ['wall_render', 0.3],
  ['wall_brick', 0.25],
];

function pick(list: Array<[BarrierStyle, number]>, r: number): BarrierStyle {
  let acc = 0;
  for (const [s, w] of list) {
    acc += w;
    if (r < acc) return s;
  }
  return list[list.length - 1][0];
}

/** What a frontage tag (FRONT.HEDGE 1, FENCE 2, WALL 3) makes of one plot, from a random number `r` and a second `q`. */
export function plotStyle(kind: number, r: number, q: number): { style: BarrierStyle | null; tall: boolean } {
  if (kind === 1) {
    // "hedge": hedges and fences and driveways, as the notes of the reviews say – a hedge on most plots
    if (r < 0.34) return { style: q < 0.12 ? 'hedge_red' : 'hedge', tall: false };
    if (r < 0.54) return { style: 'hedge', tall: true };
    if (r < 0.76) return { style: pick(FENCES, q), tall: false };
    if (r < 0.86) return { style: pick(WALLS, q), tall: false };
    return { style: null, tall: false };
  }
  if (kind === 2) {
    if (r < 0.72) return { style: pick(FENCES, q), tall: false };
    if (r < 0.84) return { style: 'hedge', tall: false };
    return { style: null, tall: false };
  }
  if (r < 0.8) return { style: pick(WALLS, q), tall: false };
  if (r < 0.9) return { style: 'hedge', tall: false };
  return { style: null, tall: false };
}

/**
 * The plots along one side of a road from station s0 to s1: 12–22 m each,
 * with a driveway gap of 3 m between most of them.  `seed`: the road (its
 * OSM id) and the side.  `fixedHeight`: a tagged height – then every plot
 * is of the tagged kind at that height (a fact seen on site), gaps aside.
 */
export function frontagePlan(kind: number, s0: number, s1: number, seed: number, side: number, fixedHeight?: number): FrontPlot[] {
  const plots: FrontPlot[] = [];
  let s = s0;
  let k = 0;
  while (s1 - s > 2) {
    const len = 12 + 10 * mix01(seed, side, k, 61);
    const end = Math.min(s1, s + len);
    let style: BarrierStyle | null;
    let h: number;
    if (fixedHeight !== undefined) {
      style = kind === 1 ? 'hedge' : kind === 2 ? 'picket' : 'wall_block';
      h = fixedHeight;
    } else {
      const pickd = plotStyle(kind, mix01(seed, side, k, 62), mix01(seed, side, k, 63));
      style = pickd.style;
      const t = mix01(seed, side, k, 64);
      if (style && pickd.tall) h = 1.5 + 0.8 * t;
      else if (style) {
        const [a, b] = BARRIER_STYLES[style].h;
        h = a + (b - a) * t;
      } else h = 0;
    }
    // (the rest of a short last piece goes with the plot before it)
    plots.push({ s0: s, s1: s1 - end < 4 ? s1 : end, style, h: Math.round(h * 100) / 100 });
    if (s1 - end < 4) break;
    // a driveway between most plots
    s = end + (mix01(seed, side, k, 65) < 0.65 ? 3 : 0);
    k++;
  }
  return plots;
}

/**
 * Draw a barrier of `style`, `h` high, along `line` (x, y, z per point – y
 * the ground, on which it stands), with the outward normal (ox, oz) of the
 * line's first piece for the shading hints.  A solid one is a box; a fence
 * of rails has two rails and a post every 2.4 m.  Returns the triangles
 * added.
 */
export function drawBarrier(ts: TileSet, line: number[], style: BarrierStyle, h: number): number {
  const look = BARRIER_STYLES[style];
  const n = line.length / 3;
  if (n < 2) return 0;
  // the across direction at each point
  const across: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = line[b * 3] - line[a * 3];
    let tz = line[b * 3 + 2] - line[a * 3 + 2];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    across.push(tz, -tx);
  }
  const off = (w: number, y: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(line[i * 3] + across[i * 2] * w, line[i * 3 + 1] + y, line[i * 3 + 2] + across[i * 2 + 1] * w);
    return out;
  };
  const ox = across[0];
  const oz = across[1];
  let tris = 0;
  const band = (y0: number, y1: number, w: number, top: boolean): void => {
    addBand(ts, 'struct', off(w, y0), off(w, y1), look.rgb, ox, 0, oz);
    addBand(ts, 'struct', off(-w, y0), off(-w, y1), look.rgb, -ox, 0, -oz);
    tris += 4 * (n - 1);
    if (top) {
      addBand(ts, 'struct', off(-w, y1), off(w, y1), look.rgb, 0, 1, 0);
      tris += 2 * (n - 1);
    }
  };
  const end = (i: number, dir: number, w: number, y0: number, y1: number): void => {
    const x = line[i * 3];
    const y = line[i * 3 + 1];
    const z = line[i * 3 + 2];
    const ax = across[i * 2] * w;
    const az = across[i * 2 + 1] * w;
    addQuad(ts, 'struct', [x - ax, y + y0, z - az, x + ax, y + y0, z + az, x + ax, y + y1, z + az, x - ax, y + y1, z - az], look.rgb, -az * dir, 0, ax * dir);
    tris += 2;
  };
  if (look.solid) {
    band(look.y0, h, look.halfW, look.halfW > 0.05);
    if (look.halfW > 0.05) {
      end(0, -1, look.halfW, look.y0, h);
      end(n - 1, 1, look.halfW, look.y0, h);
    }
    return tris;
  }
  // rails: a top rail and one lower down; posts every 2.4 m
  const railH = style === 'post_rail' ? 0.12 : 0.06;
  band(h - railH, h, look.halfW, false);
  band(style === 'post_rail' ? h * 0.45 : 0.12, (style === 'post_rail' ? h * 0.45 : 0.12) + railH, look.halfW, false);
  let carry = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) carry += Math.hypot(line[i * 3] - line[i * 3 - 3], line[i * 3 + 2] - line[i * 3 - 1]);
    if (i > 0 && i < n - 1 && carry < 2.4) continue;
    carry = 0;
    const x = line[i * 3];
    const y = line[i * 3 + 1];
    const z = line[i * 3 + 2];
    const r = style === 'post_rail' ? 0.05 : 0.03;
    const c = [
      [x - r, z - r],
      [x + r, z - r],
      [x + r, z + r],
      [x - r, z + r],
    ];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = c[k];
      const [bx, bz] = c[(k + 1) % 4];
      addQuad(ts, 'struct', [ax, y + look.y0, az, bx, y + look.y0, bz, bx, y + h + 0.03, bz, ax, y + h + 0.03, az], look.rgb, (ax + bx) / 2 - x, 0, (az + bz) / 2 - z);
      tris += 2;
    }
  }
  return tris;
}

/**
 * The style of a mapped fence (barrier=fence) from fence_type, material and
 * colour; one without a kind gets one of the usual garden fences, picked by
 * its way id.
 */
export function fenceStyle(t: Record<string, string>, id: number): BarrierStyle {
  const k = `${t.fence_type ?? ''}|${t.material ?? ''}`.toLowerCase();
  const white = /white/.test(`${t.colour ?? ''}`.toLowerCase());
  if (/chain_link|mesh|wire_mesh|welded/.test(k)) return 'mesh';
  if (/railing|bars|metal|steel|iron|wrought/.test(k)) return white ? 'railing_white' : 'railing_dark';
  if (/split_rail|post_rail|rail|paling|log/.test(k)) return 'post_rail';
  if (/pale|picket|wood|lattice/.test(k)) return 'picket';
  if (/panel|privacy|board|concrete|plastic|noise/.test(k)) return 'panel';
  return pick(FENCES, mix01(id, 66));
}

/** The style of a mapped wall: brick or rendered by material / colour, else concrete blocks. */
export function wallStyle(t: Record<string, string>): BarrierStyle {
  const k = `${t.material ?? ''}|${t.wall ?? ''}|${t.colour ?? ''}`.toLowerCase();
  if (/brick|red/.test(k)) return 'wall_brick';
  if (/plaster|render|white/.test(k)) return 'wall_render';
  return 'wall_block';
}
