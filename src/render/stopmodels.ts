// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What stands at the stops of buses and trams, and the signals beside a
 * tram's track: the stop sign (Zeichen 224) with the name of the stop,
 * shelters, benches and bins, the board where the tram's front stops (Sh 7),
 * tram signals with their white lights (F 0 … F 5, BOStrab Anlage 4), the
 * signals at the points (W 1 … W 13), the signs to raise and lower the
 * pantograph (St 6, St 5), the masts and wires of the overhead line, raised
 * platforms and a small departure display.  Generic designs throughout: no
 * operator, no brand, no advertising.
 *
 * Every builder returns a new object with its origin at its foot on the
 * ground, facing −z (towards those who are meant to look at it) unless said
 * otherwise.  Geometries, materials and textures are made once and shared by
 * all objects of a kind; `mergeStatic` folds a whole stop into a handful of
 * meshes, so that a street full of stops stays cheap to draw.  The faces of
 * the signs are shapes, not pictures: they stay sharp from near and far.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEAT_HEIGHT } from './people.ts';

type V3 = [number, number, number];

// ------------------------------------------------------------------------------------ materials
/** painted metal, concrete, wood: lit, a colour per vertex */
const PAINT = new THREE.MeshLambertMaterial({ vertexColors: true });
/** the faces of signs: unlit like the traffic signs (render/signs.ts), so that they read alike in sun and shade */
const FACE = new THREE.MeshBasicMaterial({ vertexColors: true });
/** the glass of the shelters: colour and opacity per vertex (the frosted band on it is less clear) */
const GLASS = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, shininess: 90, specular: 0x8a9aa6 });
GLASS.forceSinglePass = true;
/** the overhead wires: lines a pixel wide at any distance, so that they neither vanish nor flicker far off */
const WIRE = new THREE.LineBasicMaterial({ color: 0x23272a });

const GALVANISED = 0xa3a8ac;
const ANTHRACITE = 0x3a3f44;
const HOUSING = 0x17191b;
const SIGN_BACK = 0x8d9296;
const WOOD = 0x8d6239;
const MAST_GREY = 0x6e767b;
const CONCRETE = 0x9b9a93;

const UP = new THREE.Vector3(0, 1, 0);

/** A geometry made ready for one of the merged meshes: no index, no uv, one colour (RGBA with `alpha`). */
function coloured(g: THREE.BufferGeometry, hex: number, alpha?: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const n = geo.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const size = alpha === undefined ? 3 : 4;
  const colour = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    colour[i * size] = c.r;
    colour[i * size + 1] = c.g;
    colour[i * size + 2] = c.b;
    if (alpha !== undefined) colour[i * size + 3] = alpha;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colour, size));
  return geo;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('stopmodels: pieces that do not fit together');
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** Collects coloured pieces into one geometry (one draw call). */
class Kit {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(g: THREE.BufferGeometry, hex: number, alpha?: number): this {
    this.parts.push(coloured(g, hex, alpha));
    return this;
  }

  /** a box from x0…x1, y0…y1, z0…z1 */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, hex: number): this {
    return this.add(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), hex);
  }

  /** an upright round post from y0 to y1, r0 thick at the foot and r1 at the top */
  cyl(x: number, z: number, y0: number, y1: number, r0: number, r1: number, hex: number, sides = 12): this {
    return this.add(new THREE.CylinderGeometry(r1, r0, y1 - y0, sides).translate(x, (y0 + y1) / 2, z), hex);
  }

  /** a round bar from a to b */
  rod(a: V3, b: V3, r: number, hex: number, sides = 8): this {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const g = new THREE.CylinderGeometry(r, r, d.length(), sides);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
    return this.add(g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), hex);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    return merged(this.parts.splice(0));
  }
}

/** A copy of a geometry seen from its other side (winding and normals turned round). */
function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.getAttribute(name);
    if (!a) continue;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k);
        a.setComponent(i + 1, k, a.getComponent(i + 2, k));
        a.setComponent(i + 2, k, t);
      }
    }
  }
  const n = geo.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return geo;
}

/** The outline of a circle, counter-clockwise. */
function circle(r: number, segments = 40): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

/** A rectangle w × h around its middle, counter-clockwise. */
function rect(w: number, h: number, x = 0, y = 0): THREE.Vector2[] {
  return [new THREE.Vector2(x - w / 2, y - h / 2), new THREE.Vector2(x + w / 2, y - h / 2), new THREE.Vector2(x + w / 2, y + h / 2), new THREE.Vector2(x - w / 2, y + h / 2)];
}

/** A shape from an outline and holes. */
function shape(outline: THREE.Vector2[], ...holes: THREE.Vector2[][]): THREE.Shape {
  const s = new THREE.Shape(outline);
  for (const h of holes) s.holes.push(new THREE.Path(h));
  return s;
}

/**
 * The flat face of a sign: a shape, its middle at (x, y), lying at z and facing −z
 * (`front`) or +z.  Shapes must be symmetric left and right (turning a face round mirrors it).
 */
function face(s: THREE.Shape, x: number, y: number, z: number, front: boolean, curve = 40): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(s, curve);
  if (front) g.rotateY(Math.PI);
  return g.translate(x, y, z);
}

/**
 * The plate behind a face: its edges and its back, between the face at zFace
 * and the back at zBack – but no front (the face is the front, so nothing lies
 * on top of anything else and nothing flickers from afar).
 */
function plate(kit: Kit, outline: THREE.Vector2[], x: number, y: number, zFace: number, zBack: number, hex: number): void {
  const pts = THREE.ShapeUtils.isClockWise(outline) ? [...outline].reverse() : outline;
  const z0 = Math.min(zFace, zBack);
  const z1 = Math.max(zFace, zBack);
  const pos: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pos.push(x + a.x, y + a.y, z0, x + b.x, y + b.y, z0, x + b.x, y + b.y, z1);
    pos.push(x + a.x, y + a.y, z0, x + b.x, y + b.y, z1, x + a.x, y + a.y, z1);
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sides.computeVertexNormals();
  kit.add(sides, hex);
  kit.add(face(new THREE.Shape(pts), x, y, zBack, zBack < zFace), hex);
}

/** A hood over a lamp: half a tube above the lens (at z0), reaching `len` forwards (−z); seen from above and below. */
function visor(kit: Kit, y: number, z0: number, r: number, len: number): void {
  const g = new THREE.CylinderGeometry(r, r, len, 14, 1, true, Math.PI / 2, Math.PI);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, z0 - len / 2);
  kit.add(flipped(g), HOUSING);
  kit.add(g, HOUSING);
}

function meshOf(geo: THREE.BufferGeometry, material: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

const shapes = new Map<string, THREE.BufferGeometry>();
/** A geometry made once and shared by all objects that use it. */
function shared(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = shapes.get(key);
  if (!g) shapes.set(key, (g = make()));
  return g;
}

const FONT = '"DIN 1451 Std", "DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Liberation Sans Narrow", "Helvetica Neue", Arial, sans-serif';

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ------------------------------------------------------------------------------------ the stop sign
export type StopKind = 'bus' | 'tram' | 'both';

const POLE_R = 0.038;
/** the faces of the plates, in front of and behind the pole */
const PLATE_Z = POLE_R + 0.014;
const SIGN_Y = 2.3;
const SIGN_R = 0.225;
const SYMBOL_H = 0.2;
const SYMBOL_Y = SIGN_Y - SIGN_R - 0.03 - SYMBOL_H / 2;
const NAME_W = 0.7;
const NAME_H = 0.2;
const NAME_Y = SYMBOL_Y - SYMBOL_H / 2 - 0.025 - NAME_H / 2;
/** the timetable in its case on the front of the pole */
const TIMETABLE_Y = 1.2;
const TIMETABLE_Z = POLE_R + 0.05;

function symbolWidth(kind: StopKind): number {
  return kind === 'both' ? 0.56 : 0.42;
}

/**
 * Zeichen 224 on both sides of the pole, from the official drawing: a yellow
 * disc with a thin yellow rim, a green ring and a green H.
 */
function sign224(): THREE.BufferGeometry {
  const kit = new Kit();
  const R = SIGN_R;
  const yellow = 0xf0c900;
  const green = 0x008754;
  // the H (from the drawing: stems 0.157 R wide, 1.035 R high, the bar 0.139 R high)
  const hx = 0.3698 * R;
  const hy = 0.5177 * R;
  const st = 0.2126 * R;
  const bar = 0.0693 * R;
  const h = [
    [-hx, -hy], [-st, -hy], [-st, -bar], [st, -bar], [st, -hy], [hx, -hy],
    [hx, hy], [st, hy], [st, bar], [-st, bar], [-st, hy], [-hx, hy],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  for (const front of [true, false]) {
    const z = front ? -PLATE_Z : PLATE_Z;
    kit.add(face(shape(circle(R, 48), circle(0.952 * R, 48)), 0, SIGN_Y, z, front), yellow);
    kit.add(face(shape(circle(0.952 * R, 48), circle(0.7014 * R, 48)), 0, SIGN_Y, z, front), green);
    kit.add(face(shape(circle(0.7014 * R, 48), [...h].reverse()), 0, SIGN_Y, z, front), yellow);
    kit.add(face(shape(h), 0, SIGN_Y, z, front), green);
  }
  return kit.geometry();
}

/** The pole with the plates' edges and backs, the clamps and the case of the timetable. */
function signPost(kind: StopKind): THREE.BufferGeometry {
  const kit = new Kit();
  kit.cyl(0, 0, 0, 2.56, POLE_R, POLE_R, GALVANISED);
  kit.cyl(0, 0, 2.56, 2.585, POLE_R + 0.004, POLE_R + 0.004, ANTHRACITE);
  const sw = symbolWidth(kind);
  for (const side of [-1, 1]) {
    const zFace = side * PLATE_Z;
    const zBack = side * (POLE_R + 0.002);
    plate(kit, circle(SIGN_R, 40), 0, SIGN_Y, zFace, zBack, SIGN_BACK);
    plate(kit, rect(sw, SYMBOL_H), 0, SYMBOL_Y, zFace, zBack, SIGN_BACK);
    plate(kit, rect(NAME_W, NAME_H), 0, NAME_Y, zFace, zBack, SIGN_BACK);
  }
  // the clamps that hold the plates to the pole
  for (const y of [SIGN_Y + 0.12, SIGN_Y - 0.12, SYMBOL_Y, NAME_Y]) kit.box(-0.05, 0.05, y - 0.015, y + 0.015, -POLE_R - 0.002, POLE_R + 0.002, ANTHRACITE);
  // the case of the timetable: a frame round the paper, its back behind it
  const w = 0.44;
  const h = 0.6;
  const b = 0.03;
  const z0 = -(POLE_R + 0.002);
  const z1 = -(POLE_R + 0.065);
  kit.box(-w / 2, w / 2, TIMETABLE_Y + h / 2 - b, TIMETABLE_Y + h / 2, z1, z0, ANTHRACITE);
  kit.box(-w / 2, w / 2, TIMETABLE_Y - h / 2, TIMETABLE_Y - h / 2 + b, z1, z0, ANTHRACITE);
  kit.box(-w / 2, -w / 2 + b, TIMETABLE_Y - h / 2 + b, TIMETABLE_Y + h / 2 - b, z1, z0, ANTHRACITE);
  kit.box(w / 2 - b, w / 2, TIMETABLE_Y - h / 2 + b, TIMETABLE_Y + h / 2 - b, z1, z0, ANTHRACITE);
  kit.box(-w / 2 + b, w / 2 - b, TIMETABLE_Y - h / 2 + b, TIMETABLE_Y + h / 2 - b, -(POLE_R + 0.03), z0, ANTHRACITE);
  return kit.geometry();
}

// ---- the pages that hold the pictures of the plates: the pictograms, a timetable and the names
const PAGE = 1024;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SYMBOL_RECTS: Record<StopKind, Rect> = {
  bus: { x: 0, y: 0, w: 340, h: 160 },
  tram: { x: 340, y: 0, w: 340, h: 160 },
  both: { x: 680, y: 0, w: 344, h: 160 },
};
const TIMETABLE_RECT: Rect = { x: 0, y: 160, w: 256, h: 368 };
const NAME_RECTS: readonly Rect[] = [
  ...[0, 1, 2].map((r) => ({ x: 256, y: 160 + 96 * r, w: 512, h: 96 })),
  ...[0, 1, 2, 3, 4].flatMap((r) => [0, 1].map((c) => ({ x: c * 512, y: 528 + 96 * r, w: 512, h: 96 }))),
];

/** A white plate with a black edge, like an additional sign (Zusatzzeichen). */
function plateBackground(c: CanvasRenderingContext2D, r: Rect): void {
  c.fillStyle = '#f4f4f0';
  c.fillRect(r.x, r.y, r.w, r.h);
  const m = Math.round(r.h * 0.06);
  c.strokeStyle = '#141414';
  c.lineWidth = Math.max(3, r.h * 0.035);
  c.beginPath();
  c.roundRect(r.x + m, r.y + m, r.w - 2 * m, r.h - 2 * m, r.h * 0.07);
  c.stroke();
}

/** A bus seen from the side, facing left: `s` is its height. */
function drawBus(c: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const L = 2.0 * s;
  const H = 0.78 * s;
  const x0 = cx - L / 2;
  const y0 = cy - H / 2 - 0.06 * s;
  c.fillStyle = '#141414';
  c.beginPath();
  c.roundRect(x0, y0, L, H, [0.24 * s, 0.08 * s, 0.05 * s, 0.05 * s]);
  c.fill();
  c.fillStyle = '#f4f4f0';
  c.beginPath();
  c.roundRect(x0 + 0.06 * s, y0 + 0.11 * s, 0.24 * s, 0.36 * s, [0.14 * s, 0.02 * s, 0.02 * s, 0.02 * s]);
  c.fill();
  const wx0 = x0 + 0.38 * s;
  const wx1 = x0 + L - 0.08 * s;
  const gap = 0.06 * s;
  const ww = (wx1 - wx0 - gap * 4) / 5;
  for (let i = 0; i < 5; i++) c.fillRect(wx0 + i * (ww + gap), y0 + 0.11 * s, ww, 0.3 * s);
  for (const wx of [x0 + 0.45 * s, x0 + L - 0.45 * s]) {
    c.fillStyle = '#f4f4f0';
    c.beginPath();
    c.arc(wx, y0 + H, 0.2 * s, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#141414';
    c.beginPath();
    c.arc(wx, y0 + H, 0.155 * s, 0, Math.PI * 2);
    c.fill();
  }
}

/** A tram seen from the side, facing left, with its pantograph under the wire: `s` is the height of its body. */
function drawTram(c: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const L = 2.3 * s;
  const H = 0.74 * s;
  const x0 = cx - L / 2;
  const y0 = cy - H / 2 + 0.06 * s;
  c.fillStyle = '#141414';
  c.beginPath();
  c.roundRect(x0, y0, L, H, [0.22 * s, 0.22 * s, 0.04 * s, 0.04 * s]);
  c.fill();
  c.fillStyle = '#f4f4f0';
  c.beginPath();
  c.roundRect(x0 + 0.05 * s, y0 + 0.1 * s, 0.22 * s, 0.34 * s, [0.13 * s, 0.02 * s, 0.02 * s, 0.02 * s]);
  c.fill();
  const wx0 = x0 + 0.36 * s;
  const wx1 = x0 + L - 0.3 * s;
  const gap = 0.06 * s;
  const ww = (wx1 - wx0 - gap * 4) / 5;
  for (let i = 0; i < 5; i++) c.fillRect(wx0 + i * (ww + gap), y0 + 0.1 * s, ww, 0.3 * s);
  c.beginPath();
  c.roundRect(x0 + L - 0.22 * s, y0 + 0.1 * s, 0.17 * s, 0.34 * s, [0.02 * s, 0.13 * s, 0.02 * s, 0.02 * s]);
  c.fill();
  // the bogies
  c.fillStyle = '#141414';
  for (const bx of [x0 + 0.42 * s, x0 + L - 0.42 * s]) {
    for (const dx of [-0.13, 0.13]) {
      c.beginPath();
      c.arc(bx + dx * s, y0 + H + 0.03 * s, 0.09 * s, 0, Math.PI * 2);
      c.fill();
    }
  }
  // the pantograph and the wire
  c.strokeStyle = '#141414';
  c.lineWidth = 0.05 * s;
  c.lineJoin = 'round';
  const top = y0 - 0.34 * s;
  c.beginPath();
  c.moveTo(cx - 0.2 * s, y0);
  c.lineTo(cx + 0.06 * s, y0 - 0.17 * s);
  c.lineTo(cx - 0.12 * s, top);
  c.moveTo(cx - 0.26 * s, top);
  c.lineTo(cx + 0.04 * s, top);
  c.stroke();
  c.lineWidth = 0.025 * s;
  c.beginPath();
  c.moveTo(x0 - 0.05 * s, top - 0.04 * s);
  c.lineTo(x0 + L + 0.05 * s, top - 0.04 * s);
  c.stroke();
}

function drawSymbols(c: CanvasRenderingContext2D, kind: StopKind): void {
  const r = SYMBOL_RECTS[kind];
  plateBackground(c, r);
  const cy = r.y + r.h * 0.52;
  if (kind === 'bus') drawBus(c, r.x + r.w / 2, cy, r.h * 0.5);
  else if (kind === 'tram') drawTram(c, r.x + r.w / 2, cy + r.h * 0.04, r.h * 0.44);
  else {
    drawTram(c, r.x + r.w * 0.28, cy + r.h * 0.04, r.h * 0.36);
    drawBus(c, r.x + r.w * 0.75, cy, r.h * 0.4);
  }
}

/** A timetable page: hours down the side, minutes beside them (made-up times). */
function drawTimetable(c: CanvasRenderingContext2D): void {
  const r = TIMETABLE_RECT;
  c.fillStyle = '#f6f6f2';
  c.fillRect(r.x, r.y, r.w, r.h);
  c.fillStyle = '#2c3e57';
  c.fillRect(r.x, r.y, r.w, 40);
  c.fillStyle = '#f6f6f2';
  c.font = `bold 24px ${FONT}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillText('Fahrplan', r.x + 12, r.y + 21);
  c.fillStyle = '#d4a017';
  c.fillRect(r.x + r.w - 52, r.y + 6, 40, 28);
  c.fillStyle = '#141414';
  c.textAlign = 'center';
  c.fillText('4', r.x + r.w - 32, r.y + 21);
  c.font = `14px ${FONT}`;
  for (let i = 0; i < 18; i++) {
    const y = r.y + 54 + i * 17.5;
    if (i % 2 === 0) {
      c.fillStyle = '#e4e6ea';
      c.fillRect(r.x + 6, y - 8, r.w - 12, 17);
    }
    c.fillStyle = '#141414';
    c.textAlign = 'right';
    c.font = `bold 14px ${FONT}`;
    c.fillText(String(5 + i), r.x + 30, y);
    c.font = `14px ${FONT}`;
    c.textAlign = 'left';
    const every = i < 2 || i > 14 ? 30 : 15;
    let text = '';
    for (let m = (i * 7) % every; m < 60; m += every) text += `${String(m).padStart(2, '0')}  `;
    c.fillText(text, r.x + 40, y);
  }
}

/** The name of the stop: one line if it fits, else two, made smaller until it fits. */
function drawName(c: CanvasRenderingContext2D, r: Rect, name: string): void {
  plateBackground(c, r);
  c.fillStyle = '#141414';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const room = r.w * 0.9;
  const fit = (lines: string[], size: number): number => {
    c.font = `bold ${size}px ${FONT}`;
    const w = Math.max(...lines.map((l) => c.measureText(l).width));
    return w > room ? (size * room) / w : size;
  };
  const one = fit([name], r.h * 0.5);
  let lines = [name];
  let size = one;
  if (one < r.h * 0.36) {
    // two lines, broken where they come out most even (before a bracket, after a dash, at a space)
    let best: string[] | null = null;
    let bestW = Infinity;
    for (let i = 1; i < name.length; i++) {
      const ch = name[i];
      const prev = name[i - 1];
      if (ch !== ' ' && ch !== '(' && prev !== '-' && prev !== '/') continue;
      const a = name.slice(0, i).trim();
      const b = name.slice(i).trim();
      if (!a || !b) continue;
      c.font = `bold 10px ${FONT}`;
      const w = Math.max(c.measureText(a).width, c.measureText(b).width);
      if (w < bestW) {
        bestW = w;
        best = [a, b];
      }
    }
    if (best) {
      const two = fit(best, r.h * 0.36);
      if (two > one) {
        lines = best;
        size = two;
      }
    }
  }
  c.font = `bold ${size}px ${FONT}`;
  const step = size * 1.08;
  lines.forEach((l, i) => c.fillText(l, r.x + r.w / 2, r.y + r.h / 2 + (i - (lines.length - 1) / 2) * step + size * 0.04));
}

/** A page of plate pictures (1024 × 1024): the pictograms, a timetable, and 13 places for names. */
class SignPage {
  readonly material: THREE.MeshBasicMaterial;
  /** free places for names, the next one last */
  readonly free: number[];
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE;
    canvas.height = PAGE;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.fillStyle = '#8d9296';
    this.ctx.fillRect(0, 0, PAGE, PAGE);
    for (const kind of ['bus', 'tram', 'both'] as const) drawSymbols(this.ctx, kind);
    drawTimetable(this.ctx);
    this.texture = canvasTexture(canvas);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    this.free = NAME_RECTS.map((_, i) => NAME_RECTS.length - 1 - i);
    MERGEABLE.add(this.material);
  }

  write(slot: number, name: string): void {
    drawName(this.ctx, NAME_RECTS[slot], name);
    this.texture.needsUpdate = true;
  }
}

const pages: SignPage[] = [];
const names = new Map<string, { page: SignPage; slot: number; users: number }>();

function takeName(name: string): { page: SignPage; slot: number } {
  let n = names.get(name);
  if (!n) {
    const page = pages.find((p) => p.free.length > 0) ?? new SignPage();
    if (!pages.includes(page)) pages.push(page);
    const slot = page.free.pop()!;
    page.write(slot, name);
    names.set(name, (n = { page, slot, users: 0 }));
  }
  n.users++;
  return n;
}

function releaseName(name: string): void {
  const n = names.get(name);
  if (!n || --n.users > 0) return;
  n.page.free.push(n.slot);
  names.delete(name);
}

/** A picture from a page on a plate w × h at (x, y, z), facing −z (`front`) or +z. */
function pictureQuad(r: Rect, w: number, h: number, x: number, y: number, z: number, front: boolean): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const u0 = (r.x + 3) / PAGE;
  const u1 = (r.x + r.w - 3) / PAGE;
  const v1 = 1 - (r.y + 3) / PAGE;
  const v0 = 1 - (r.y + r.h - 3) / PAGE;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2));
  if (front) g.rotateY(Math.PI);
  g.translate(x, y, z);
  const geo = g.toNonIndexed();
  g.dispose();
  return geo;
}

/** The pictures on the plates of a sign: pictograms and name on both sides, the timetable in front. */
function signPictures(kind: StopKind, slot: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const front of [true, false]) {
    const z = front ? -PLATE_Z : PLATE_Z;
    parts.push(pictureQuad(SYMBOL_RECTS[kind], symbolWidth(kind), SYMBOL_H, 0, SYMBOL_Y, z, front));
    parts.push(pictureQuad(NAME_RECTS[slot], NAME_W, NAME_H, 0, NAME_Y, z, front));
  }
  parts.push(pictureQuad(TIMETABLE_RECT, 0.38, 0.54, 0, TIMETABLE_Y, -TIMETABLE_Z, true));
  return merged(parts);
}

/**
 * The stop sign: Zeichen 224 "Haltestelle" on a pole (its middle 2.3 m up),
 * below it a plate with the bus and/or tram and one with the name of the stop
 * – all on both sides –, and a timetable on the front.  Long names are set
 * on two lines and made smaller until they fit.  Call `releaseModel` when the
 * sign is taken away, so that the place of its name can be used again.
 */
export function stopSign(kind: StopKind, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = `stop sign ${name}`;
  g.add(meshOf(shared(`sign-post:${kind}`, () => signPost(kind)), PAINT));
  g.add(meshOf(shared('sign-224', sign224), FACE, false, false));
  const n = takeName(name);
  g.add(meshOf(shared(`sign-pictures:${kind}:${n.slot}`, () => signPictures(kind, n.slot)), n.page.material, false, false));
  let released = false;
  g.userData.release = (): void => {
    if (released) return;
    released = true;
    releaseName(name);
  };
  return g;
}

// ------------------------------------------------------------------------------------ shelter, bench, bin
const SHELTER_DEPTH = 1.55;
const ROOF_Y = 2.4;

/**
 * Where people sit in a shelter of this width: points (x, z) in its frame for
 * a person sitting (PersonPose.sit) facing the same way as the shelter.
 */
export function shelterSeats(width = 3.6): Array<[number, number]> {
  const x0 = -width / 2 + 0.75;
  const x1 = width / 2 - 0.4;
  const n = Math.max(1, Math.floor((x1 - x0) / 0.6) + 1);
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i): [number, number] => [x0 + i * step, SHELTER_DEPTH / 2 - 0.24]);
}

/** Where people sit on a bench: points (x, z) in its frame, facing the same way as the bench. */
export function benchSeats(): Array<[number, number]> {
  return [
    [-0.55, 0.11],
    [0, 0.11],
    [0.55, 0.11],
  ];
}

// The posters of the shelters, on one page shared by all: a network map inside, a landscape outside.
let posterMaterial: THREE.MeshBasicMaterial | null = null;
const POSTER_W = 512;
const POSTER_H = 992;
/** v of the white strip at the foot of the page (for the lamp under the roof) */
const WHITE_V = 1 - 1012 / 1024;

function drawNetworkMap(c: CanvasRenderingContext2D, x0: number): void {
  c.save();
  c.translate(x0, 0);
  c.fillStyle = '#f3f2ec';
  c.fillRect(0, 0, POSTER_W, POSTER_H);
  // a river and a park
  c.strokeStyle = '#a9cbe0';
  c.lineWidth = 30;
  c.beginPath();
  c.moveTo(-10, 640);
  c.bezierCurveTo(160, 560, 300, 700, 530, 470);
  c.stroke();
  c.fillStyle = '#cfe3c0';
  c.beginPath();
  c.roundRect(300, 170, 170, 130, 36);
  c.fill();
  c.beginPath();
  c.roundRect(40, 760, 140, 90, 30);
  c.fill();
  const lines: Array<{ colour: string; pts: number[][] }> = [
    { colour: '#d23b2f', pts: [[40, 150], [170, 270], [256, 420], [256, 700], [400, 880]] },
    { colour: '#2f6fc4', pts: [[470, 160], [360, 330], [256, 420], [120, 560], [60, 900]] },
    { colour: '#e0a01f', pts: [[20, 420], [256, 420], [480, 420]] },
    { colour: '#2f9a55', pts: [[150, 120], [170, 270], [330, 560], [470, 760]] },
    { colour: '#8a4fb0', pts: [[60, 300], [170, 270], [360, 330], [440, 600], [300, 930]] },
    { colour: '#1f9aa0', pts: [[256, 120], [256, 420]] },
  ];
  c.lineJoin = 'round';
  c.lineCap = 'round';
  for (const l of lines) {
    c.strokeStyle = l.colour;
    c.lineWidth = 11;
    c.beginPath();
    l.pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
    c.stroke();
  }
  for (const l of lines) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, ay] = l.pts[i];
      const [bx, by] = l.pts[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 60));
      for (let k = 0; k <= n; k++) {
        c.fillStyle = '#ffffff';
        c.strokeStyle = '#222';
        c.lineWidth = 3;
        c.beginPath();
        c.arc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 7, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
    }
  }
  // the changes between lines
  for (const [x, y] of [[256, 420], [170, 270], [360, 330]]) {
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#222';
    c.lineWidth = 4;
    c.beginPath();
    c.roundRect(x - 16, y - 16, 32, 32, 10);
    c.fill();
    c.stroke();
  }
  // the head and the key
  c.fillStyle = '#2c3e57';
  c.fillRect(0, 0, POSTER_W, 86);
  c.fillStyle = '#ffffff';
  c.font = `bold 46px ${FONT}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillText('Liniennetz', 28, 45);
  c.font = `bold 26px ${FONT}`;
  lines.forEach((l, i) => {
    const x = 28 + i * 78;
    c.fillStyle = l.colour;
    c.fillRect(x, 940, 56, 38);
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.fillText(String([1, 2, 3, 4, 5, 7][i]), x + 28, 960);
  });
  c.restore();
}

function drawLandscape(c: CanvasRenderingContext2D, x0: number): void {
  c.save();
  c.translate(x0, 0);
  const sky = c.createLinearGradient(0, 0, 0, 560);
  sky.addColorStop(0, '#5d97d0');
  sky.addColorStop(1, '#e6eef2');
  c.fillStyle = sky;
  c.fillRect(0, 0, POSTER_W, POSTER_H);
  c.fillStyle = '#fff3c4';
  c.beginPath();
  c.arc(370, 230, 62, 0, Math.PI * 2);
  c.fill();
  const hill = (y: number, amp: number, colour: string, phase: number): void => {
    c.fillStyle = colour;
    c.beginPath();
    c.moveTo(0, POSTER_H);
    for (let x = 0; x <= POSTER_W; x += 16) c.lineTo(x, y - amp * Math.sin(x / 90 + phase) - amp * 0.5 * Math.sin(x / 37 + phase * 2));
    c.lineTo(POSTER_W, POSTER_H);
    c.fill();
  };
  hill(520, 40, '#a6c08e', 0.5);
  hill(600, 34, '#7da35e', 2.1);
  // a forest edge
  c.fillStyle = '#3f6b3a';
  for (let x = -10; x < POSTER_W + 20; x += 22) {
    const h = 50 + 25 * Math.sin(x * 0.7);
    c.beginPath();
    c.moveTo(x - 16, 690);
    c.lineTo(x, 690 - h);
    c.lineTo(x + 16, 690);
    c.fill();
  }
  hill(740, 22, '#6e9a55', 4.0);
  // a path through the meadow
  c.fillStyle = '#ddd2ab';
  c.beginPath();
  c.moveTo(220, POSTER_H);
  c.bezierCurveTo(250, 860, 330, 800, 300, 700);
  c.lineTo(312, 700);
  c.bezierCurveTo(360, 800, 330, 880, 330, POSTER_H);
  c.fill();
  c.restore();
}

function posters(): THREE.MeshBasicMaterial {
  if (posterMaterial) return posterMaterial;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, 1024, 1024);
  drawNetworkMap(c, 0);
  drawLandscape(c, 512);
  // (a little dimmer than white: a lit poster, not a lamp)
  posterMaterial = new THREE.MeshBasicMaterial({ map: canvasTexture(canvas), color: 0xdedede });
  MERGEABLE.add(posterMaterial);
  return posterMaterial;
}

/** A poster on the panel: a quad w × h at (x, y, z) facing +x (`side` 1) or −x. */
function posterQuad(u0: number, w: number, h: number, x: number, y: number, z: number, side: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const u1 = u0 + (POSTER_W - 4) / 1024;
  const v0 = 1 - (POSTER_H - 2) / 1024;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 1, u1, 1, u0, v0, u1, v0], 2));
  g.rotateY((side * Math.PI) / 2);
  g.translate(x, y, z);
  const geo = g.toNonIndexed();
  g.dispose();
  return geo;
}

function shelterFrame(width: number): THREE.BufferGeometry {
  const kit = new Kit();
  const hw = width / 2;
  const hd = SHELTER_DEPTH / 2;
  const p = 0.035;
  // posts at the corners, one more in the middle of the back of a long one
  const posts: Array<[number, number]> = [[-hw + p, -hd + p], [hw - p, -hd + p], [-hw + p, hd - p], [hw - p, hd - p]];
  if (width > 3) posts.push([0, hd - p]);
  for (const [x, z] of posts) kit.box(x - p, x + p, 0, ROOF_Y, z - p, z + p, ANTHRACITE);
  // rails at the top and the foot of the glass walls
  for (const y of [0.06, ROOF_Y - 0.08]) {
    kit.box(-hw + p, hw - p, y, y + 0.06, hd - p - 0.02, hd - p + 0.02, ANTHRACITE);
    kit.box(hw - p - 0.02, hw - p + 0.02, y, y + 0.06, -hd + p, hd - p, ANTHRACITE);
  }
  kit.box(-hw + p, hw - p, ROOF_Y - 0.08, ROOF_Y, -hd + p - 0.02, -hd + p + 0.02, ANTHRACITE);
  // the rim of the roof (its glass is with the glass)
  const rx0 = -hw - 0.1;
  const rx1 = hw + 0.1;
  const rz0 = -hd - 0.22;
  const rz1 = hd + 0.08;
  const t = 0.07;
  kit.box(rx0, rx1, ROOF_Y, ROOF_Y + 0.12, rz0, rz0 + t, ANTHRACITE);
  kit.box(rx0, rx1, ROOF_Y, ROOF_Y + 0.12, rz1 - t, rz1, ANTHRACITE);
  kit.box(rx0, rx0 + t, ROOF_Y, ROOF_Y + 0.12, rz0 + t, rz1 - t, ANTHRACITE);
  kit.box(rx1 - t, rx1, ROOF_Y, ROOF_Y + 0.12, rz0 + t, rz1 - t, ANTHRACITE);
  for (const x of [-hw / 2, 0, hw / 2]) kit.box(x - 0.025, x + 0.025, ROOF_Y + 0.04, ROOF_Y + 0.1, rz0 + t, rz1 - t, ANTHRACITE);
  // the poster panel at the left end: a box, its two big faces left open for the posters, with a border round them
  const ax = -hw;
  const az0 = -0.62;
  const az1 = 0.66;
  const ay0 = 0.14;
  const ay1 = 2.2;
  const d = 0.065;
  const b = 0.05;
  kit.box(ax - d, ax + d, ay1 - 0.001, ay1 + 0.04, az0, az1, ANTHRACITE);
  kit.box(ax - d, ax + d, ay0 - 0.04, ay0 + 0.001, az0, az1, ANTHRACITE);
  kit.box(ax - d, ax + d, ay0, ay1, az0 - 0.04, az0, ANTHRACITE);
  kit.box(ax - d, ax + d, ay0, ay1, az1, az1 + 0.04, ANTHRACITE);
  for (const s of [-1, 1]) {
    const xf = ax + s * d;
    const fx0 = Math.min(xf, xf + s * 0.004);
    const fx1 = Math.max(xf, xf + s * 0.004);
    kit.box(fx0, fx1, ay1 - b, ay1, az0, az1, ANTHRACITE);
    kit.box(fx0, fx1, ay0, ay0 + b, az0, az1, ANTHRACITE);
    kit.box(fx0, fx1, ay0 + b, ay1 - b, az0, az0 + b, ANTHRACITE);
    kit.box(fx0, fx1, ay0 + b, ay1 - b, az1 - b, az1, ANTHRACITE);
  }
  for (const z of [az0 + 0.15, az1 - 0.15]) kit.box(ax - 0.03, ax + 0.03, 0, ay0 - 0.04, z - 0.03, z + 0.03, ANTHRACITE);
  // the bench along the back: wooden slats on two brackets
  const bx0 = -hw + 0.32;
  const bx1 = hw - 0.12;
  const sz0 = hd - 0.47;
  const sz1 = hd - 0.08;
  const slat = (sz1 - sz0 - 0.04) / 3;
  for (let i = 0; i < 3; i++) {
    const z = sz0 + i * (slat + 0.02);
    kit.box(bx0, bx1, SEAT_HEIGHT - 0.035, SEAT_HEIGHT, z, z + slat, WOOD);
  }
  for (const x of [bx0 + 0.35, bx1 - 0.35]) {
    kit.box(x - 0.025, x + 0.025, 0, SEAT_HEIGHT - 0.035, hd - 0.3, hd - 0.25, ANTHRACITE);
    kit.box(x - 0.025, x + 0.025, SEAT_HEIGHT - 0.075, SEAT_HEIGHT - 0.035, sz0 + 0.02, sz1, ANTHRACITE);
    kit.box(x - 0.08, x + 0.08, 0, 0.012, hd - 0.36, hd - 0.19, ANTHRACITE);
  }
  return kit.geometry();
}

function shelterGlass(width: number): THREE.BufferGeometry {
  const kit = new Kit();
  const hw = width / 2;
  const hd = SHELTER_DEPTH / 2;
  const p = 0.035;
  const y0 = 0.12;
  const y1 = ROOF_Y - 0.08;
  const tint = 0xc4d4dc;
  const pane = (w: number, h: number, x: number, y: number, z: number, turn: number, colour: number, alpha: number): void => {
    kit.add(new THREE.PlaneGeometry(w, h).rotateY(turn).translate(x, y, z), colour, alpha);
  };
  const back = width > 3 ? [[-hw + 2 * p, -p], [p, hw - 2 * p]] : [[-hw + 2 * p, hw - 2 * p]];
  for (const [a, b] of back) {
    pane(b - a, y1 - y0, (a + b) / 2, (y0 + y1) / 2, hd - p, 0, tint, 0.2);
    // a frosted band at eye height, so that nobody walks into the glass
    pane(b - a, 0.09, (a + b) / 2, 1.5, hd - p, 0, 0xf2f4f4, 0.55);
  }
  pane(SHELTER_DEPTH - 4 * p, y1 - y0, hw - p, (y0 + y1) / 2, 0, Math.PI / 2, tint, 0.2);
  pane(SHELTER_DEPTH - 4 * p, 0.09, hw - p, 1.5, 0, Math.PI / 2, 0xf2f4f4, 0.55);
  // the roof: glass, a little milky
  kit.add(new THREE.PlaneGeometry(width + 0.06, SHELTER_DEPTH + 0.16).rotateX(-Math.PI / 2).translate(0, ROOF_Y + 0.07, -0.07), 0xe4ecef, 0.42);
  return kit.geometry();
}

/** The posters on both faces of the panel, and the white lamp under the front of the roof. */
function shelterLights(width: number): THREE.BufferGeometry {
  const hw = width / 2;
  const hd = SHELTER_DEPTH / 2;
  const w = 0.66 + 0.62 - 0.1;
  const h = 2.2 - 0.14 - 0.1;
  const zc = (0.66 - 0.62) / 2;
  const yc = (2.2 + 0.14) / 2;
  const lamp = new THREE.BoxGeometry(width - 0.3, 0.025, 0.04).translate(0, ROOF_Y - 0.02, -hd + 0.035).toNonIndexed();
  const uv = lamp.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, WHITE_V);
  return merged([posterQuad(2 / 1024, w, h, -hw + 0.0655, yc, zc, 1), posterQuad(514 / 1024, w, h, -hw - 0.0655, yc, zc, -1), lamp]);
}

/**
 * A shelter for those waiting: posts and a glass roof, glass at the back and
 * on the right, a lit poster panel at the left end (a network map inside, a
 * landscape outside), a bench along the back.  The origin is the middle of
 * its floor; the open side faces −z; it is `width` wide and 1.55 m deep.
 * `shelterSeats(width)` tells where people sit in it.
 */
export function shelter(width = 3.6): THREE.Group {
  const w = Math.max(1.8, Math.round(width * 10) / 10);
  const g = new THREE.Group();
  g.name = 'shelter';
  g.add(meshOf(shared(`shelter-frame:${w}`, () => shelterFrame(w)), PAINT));
  g.add(meshOf(shared(`shelter-lights:${w}`, () => shelterLights(w)), posters(), false, false));
  const glass = meshOf(shared(`shelter-glass:${w}`, () => shelterGlass(w)), GLASS, false, false);
  // (drawn after what stands behind it)
  glass.renderOrder = 1;
  g.add(glass);
  return g;
}

function benchShape(): THREE.BufferGeometry {
  const kit = new Kit();
  for (let i = 0; i < 3; i++) {
    const z = -0.2 + i * 0.145;
    kit.box(-0.92, 0.92, SEAT_HEIGHT - 0.04, SEAT_HEIGHT, z, z + 0.125, WOOD);
  }
  // the back: two slats, leaning back a little
  for (const y of [0.6, 0.76]) {
    const back = new THREE.BoxGeometry(1.84, 0.11, 0.035).rotateX(-0.18).translate(0, y, 0.29 + (y - 0.6) * 0.18);
    kit.add(back, WOOD);
  }
  // the two cast frames: legs, the bearer under the seat, the post of the back, an armrest
  for (const x of [-0.8, 0.8]) {
    kit.box(x - 0.03, x + 0.03, 0, SEAT_HEIGHT - 0.04, -0.2, -0.15, ANTHRACITE);
    kit.box(x - 0.03, x + 0.03, SEAT_HEIGHT - 0.08, SEAT_HEIGHT - 0.04, -0.21, 0.27, ANTHRACITE);
    kit.add(new THREE.BoxGeometry(0.06, 0.88, 0.05).rotateX(-0.18).translate(x, 0.44, 0.25), ANTHRACITE);
    kit.box(x - 0.03, x + 0.03, 0.64, 0.68, -0.18, 0.28, ANTHRACITE);
    kit.box(x - 0.03, x + 0.03, SEAT_HEIGHT - 0.04, 0.64, -0.16, -0.12, ANTHRACITE);
  }
  return kit.geometry();
}

/** A park bench of wooden slats on two cast frames, 1.84 m long; the sitter faces −z.  See `benchSeats`. */
export function bench(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'bench';
  g.add(meshOf(shared('bench', benchShape), PAINT));
  return g;
}

function binShape(): THREE.BufferGeometry {
  const kit = new Kit();
  kit.cyl(0, 0, 0, 0.05, 0.17, 0.16, 0x2a2e31, 14);
  kit.cyl(0, 0, 0.05, 0.84, 0.205, 0.225, 0x46524b, 16);
  kit.cyl(0, 0, 0.84, 0.87, 0.235, 0.235, 0x2a2e31, 16);
  kit.add(new THREE.SphereGeometry(0.235, 16, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.32, 1).translate(0, 0.87, 0), 0x2a2e31);
  // the opening at the front
  kit.box(-0.11, 0.11, 0.7, 0.8, -0.235, -0.2, 0x0e0f10);
  return kit.geometry();
}

/** A litter bin with a rain cap, 0.95 m high, its opening towards −z. */
export function bin(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'bin';
  g.add(meshOf(shared('bin', binShape), PAINT));
  return g;
}

// ------------------------------------------------------------------------------------ Sh 7
const BOARD_Y = 2.0;

function boardPost(): THREE.BufferGeometry {
  const kit = new Kit();
  kit.cyl(0, 0, 0, BOARD_Y + 0.32, 0.035, 0.035, GALVANISED);
  kit.cyl(0, 0, BOARD_Y + 0.32, BOARD_Y + 0.34, 0.039, 0.039, ANTHRACITE);
  plate(kit, rect(0.5, 0.6), 0, BOARD_Y, -0.049, -0.037, SIGN_BACK);
  for (const y of [BOARD_Y - 0.2, BOARD_Y + 0.2]) kit.box(-0.045, 0.045, y - 0.015, y + 0.015, -0.04, 0.04, ANTHRACITE);
  return kit.geometry();
}

function boardFace(): THREE.BufferGeometry {
  const kit = new Kit();
  const z = -0.049;
  const inner = rect(0.44, 0.54);
  const hx = 0.13;
  const hy = 0.19;
  const st = 0.07;
  const bar = 0.028;
  const h = [
    [-hx, -hy], [-st, -hy], [-st, -bar], [st, -bar], [st, -hy], [hx, -hy],
    [hx, hy], [st, hy], [st, bar], [-st, bar], [-st, hy], [-hx, hy],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  kit.add(face(shape(rect(0.5, 0.6), [...inner].reverse()), 0, BOARD_Y, z, true), 0x111111);
  kit.add(face(shape(inner, [...h].reverse()), 0, BOARD_Y, z, true), 0xf2f2ee);
  kit.add(face(shape(h), 0, BOARD_Y, z, true), 0x111111);
  return kit.geometry();
}

/** BOStrab Sh 7, the stop board where the front of the tram stops: a black H on white (0.5 × 0.6 m) on a post. */
export function stopBoard(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'stop board Sh 7';
  g.add(meshOf(shared('board-post', boardPost), PAINT));
  g.add(meshOf(shared('board-face', boardFace), FACE, false, false));
  return g;
}

// ------------------------------------------------------------------------------------ light signals
// The lit symbols of the tram signals: white on black, with a soft glow, on one shared page of
// 4 × 2 cells: bar, point, triangle, A, angle, short bar.
let glowMaterial: THREE.MeshBasicMaterial | null = null;
const GLOW_CELL = 128;

function drawGlows(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = GLOW_CELL * 4;
  canvas.height = GLOW_CELL * 2;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#000000';
  c.fillRect(0, 0, canvas.width, canvas.height);
  const cell = (i: number, draw: () => void): void => {
    c.save();
    c.translate((i % 4) * GLOW_CELL + GLOW_CELL / 2, Math.floor(i / 4) * GLOW_CELL + GLOW_CELL / 2);
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#ffffff';
    // a faint halo, a narrow bright one, the light itself: little glow, so that the shape still
    // shows when the symbol is only a few pixels big
    for (const [blur, alpha] of [[14, 0.45], [5, 0.9], [0, 1]]) {
      c.shadowColor = `rgba(255, 255, 255, ${alpha})`;
      c.shadowBlur = blur;
      draw();
    }
    c.restore();
  };
  const C = GLOW_CELL;
  // the bar (0.30 × 0.07 m in a 0.40 m cell)
  cell(0, () => {
    c.beginPath();
    c.roundRect(-0.375 * C, -0.085 * C, 0.75 * C, 0.17 * C, 0.05 * C);
    c.fill();
  });
  // the point (0.10 m in a 0.24 m cell)
  cell(1, () => {
    c.beginPath();
    c.arc(0, 0, 0.21 * C, 0, Math.PI * 2);
    c.fill();
  });
  // the triangle pointing down (0.24 m wide in a 0.36 m cell)
  cell(2, () => {
    c.beginPath();
    c.moveTo(-0.34 * C, -0.22 * C);
    c.lineTo(0.34 * C, -0.22 * C);
    c.lineTo(0, 0.37 * C);
    c.closePath();
    c.fill();
  });
  // the A
  cell(3, () => {
    c.font = `bold ${0.62 * C}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('A', 0, 0.03 * C);
  });
  // the angle, its tip up (0.16 m wide in a 0.26 m cell)
  cell(4, () => {
    c.lineWidth = 0.12 * C;
    c.lineJoin = 'miter';
    c.lineCap = 'butt';
    c.beginPath();
    c.moveTo(-0.3 * C, 0.2 * C);
    c.lineTo(0, -0.18 * C);
    c.lineTo(0.3 * C, 0.2 * C);
    c.stroke();
  });
  // the short bar below the angle
  cell(5, () => {
    c.fillRect(-0.3 * C, -0.06 * C, 0.6 * C, 0.12 * C);
  });
  return canvas;
}

/** the height of the picture being drawn (pixels): set before each lit symbol is drawn */
const glowView = { value: 1080 };
const viewport = new THREE.Vector4();

/**
 * The material of the lit symbols: added light, not tone-mapped.  Far off a
 * symbol grows and comes a little towards the viewer, as a bright light
 * glares: so much that the bar of a tram signal stays some 11 pixels long
 * (up to five times its size) – its direction can still be told at 100 m,
 * where the head itself is only a few pixels wide.  Near by (in a 60° view of
 * 1080 pixels: closer than about 26 m) it keeps its own size.
 */
function glows(): THREE.MeshBasicMaterial {
  if (glowMaterial) return glowMaterial;
  const tex = canvasTexture(drawGlows());
  const m = new THREE.MeshBasicMaterial({ map: tex, color: 0xfff6ea, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFsViewH = glowView;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uFsViewH;').replace(
      '#include <project_vertex>',
      /* glsl */ `vec4 fsCentre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      // pixels per metre at the symbol; grow until a metre is 36 pixels (the bar 11)
      float fsPixels = 0.5 * uFsViewH * projectionMatrix[1][1] / max(0.1, -fsCentre.z);
      float fsGrow = clamp(36.0 / fsPixels, 1.0, 5.0);
      vec4 mvPosition = fsCentre + modelViewMatrix * vec4(transformed * fsGrow, 0.0);
      mvPosition.z += (fsGrow - 1.0) * 0.25;
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => 'fs-signal-glow';
  glowMaterial = m;
  return m;
}

/** A lit symbol: a quad `size` wide facing −z, around its middle, showing cell i of the glow page. */
function glowQuad(i: number, size: number): THREE.BufferGeometry {
  return shared(`glow:${i}:${size}`, () => {
    const g = new THREE.PlaneGeometry(size, size);
    const u0 = ((i % 4) * GLOW_CELL + 1) / (GLOW_CELL * 4);
    const u1 = ((i % 4) * GLOW_CELL + GLOW_CELL - 1) / (GLOW_CELL * 4);
    const v1 = 1 - (Math.floor(i / 4) * GLOW_CELL + 1) / (GLOW_CELL * 2);
    const v0 = 1 - (Math.floor(i / 4) * GLOW_CELL + GLOW_CELL - 1) / (GLOW_CELL * 2);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2));
    return g.rotateY(Math.PI);
  });
}

function glowMesh(i: number, size: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(glowQuad(i, size), glows());
  m.position.set(x, y, z);
  m.visible = false;
  m.onBeforeRender = (renderer): void => {
    glowView.value = renderer.getCurrentViewport(viewport).w;
  };
  // (after the glass of the shelters, like the other added light)
  m.renderOrder = 2;
  return m;
}

export type TramAspect = 'F0' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'dark';

/** The heights of the lamps of a tram signal's head (above its middle) and the depth of its housing. */
const TRAM_LAMP_Y = 0.24;
const TRAM_POINT_Y = -0.15;
const TRAM_A_Y = -0.38;
const TRAM_DEPTH = 0.2;
const TRAM_BACK_H = 1.16;
const TRAM_POLE = 3.5;
/** the slant of the bar: as the driver sees it, F 2 rises to the right and F 3 to the left */
const BAR_ANGLE: Record<'F0' | 'F1' | 'F2' | 'F3', number> = { F0: 0, F1: Math.PI / 2, F2: -Math.PI / 4, F3: Math.PI / 4 };

function tramHead(): THREE.BufferGeometry {
  const kit = new Kit();
  // the back plate: black with a white rim, so that the head stands out against anything behind it
  const bw = 0.62;
  const bh = TRAM_BACK_H;
  const r = 0.045;
  kit.box(-bw / 2 + r, bw / 2 - r, -bh / 2 + r, bh / 2 - r, 0, 0.02, HOUSING);
  kit.box(-bw / 2, bw / 2, bh / 2 - r, bh / 2, 0, 0.02, 0xe8e8e4);
  kit.box(-bw / 2, bw / 2, -bh / 2, -bh / 2 + r, 0, 0.02, 0xe8e8e4);
  kit.box(-bw / 2, -bw / 2 + r, -bh / 2 + r, bh / 2 - r, 0, 0.02, 0xe8e8e4);
  kit.box(bw / 2 - r, bw / 2, -bh / 2 + r, bh / 2 - r, 0, 0.02, 0xe8e8e4);
  // the housing, the lenses (black when dark), the hoods over them
  kit.box(-0.21, 0.21, -0.5, 0.52, -TRAM_DEPTH, 0, HOUSING);
  for (const [y, rl, len] of [[TRAM_LAMP_Y, 0.18, 0.2], [TRAM_POINT_Y, 0.1, 0.13], [TRAM_A_Y, 0.085, 0.1]]) {
    kit.add(new THREE.CircleGeometry(rl, 24).rotateY(Math.PI).translate(0, y, -TRAM_DEPTH - 0.004), 0x0b0c0d);
    visor(kit, y, -TRAM_DEPTH, rl + 0.015, len);
  }
  return kit.geometry();
}

/**
 * A BOStrab tram signal (Fahrsignal): a black head with three lamps – the bar
 * (F 0 to F 3) and the triangle (F 5) above, the point (F 4) in the middle,
 * the "A" (request accepted) below – on a pole 3.5 m high, facing −z.  With
 * `pole` false the head alone: `head` has its origin in the middle of the back
 * of its plate (fix it to a mast or a span wire there).  Switching costs
 * nothing but a visibility and a rotation.
 */
export class TramSignal {
  readonly group = new THREE.Group();
  readonly head = new THREE.Group();
  private readonly bar: THREE.Mesh;
  private readonly triangle: THREE.Mesh;
  private readonly point: THREE.Mesh;
  private readonly request: THREE.Mesh;
  private current: TramAspect = 'dark';

  constructor(pole = true) {
    this.group.name = 'tram signal';
    this.group.userData.dynamic = true;
    this.head.add(meshOf(shared('tram-head', tramHead), PAINT));
    const z = -TRAM_DEPTH - 0.012;
    this.bar = glowMesh(0, 0.4, 0, TRAM_LAMP_Y, z);
    this.triangle = glowMesh(2, 0.36, 0, TRAM_LAMP_Y, z);
    this.point = glowMesh(1, 0.24, 0, TRAM_POINT_Y, z);
    this.request = glowMesh(3, 0.17, 0, TRAM_A_Y, z);
    this.head.add(this.bar, this.triangle, this.point, this.request);
    if (pole) {
      this.group.add(meshOf(shared('tram-pole', () => new Kit().cyl(0, 0, 0, TRAM_POLE, 0.06, 0.05, 0x4a4f54).cyl(0, 0, 0, 0.04, 0.12, 0.12, 0x4a4f54).geometry()), PAINT));
      this.head.position.set(0, TRAM_POLE - TRAM_BACK_H / 2, -0.06);
    }
    this.group.add(this.head);
  }

  get aspect(): TramAspect {
    return this.current;
  }

  /** Show a Fahrsignal (or nothing). */
  set(aspect: TramAspect): void {
    this.current = aspect;
    const isBar = aspect === 'F0' || aspect === 'F1' || aspect === 'F2' || aspect === 'F3';
    this.bar.visible = isBar;
    if (isBar) this.bar.rotation.z = BAR_ANGLE[aspect];
    this.triangle.visible = aspect === 'F5';
    this.point.visible = aspect === 'F4';
  }

  /** The "A" lamp: the request of the tram has been accepted. */
  setRequest(on: boolean): void {
    this.request.visible = on;
  }
}

export type SwitchAspect = 'W1' | 'W2' | 'W3' | 'W11' | 'W12' | 'W13' | 'dark';

const SWITCH_Y = 1.42;
const SWITCH_DEPTH = 0.15;

function switchHead(): THREE.BufferGeometry {
  const kit = new Kit();
  kit.box(-0.17, 0.17, -0.18, 0.18, -SWITCH_DEPTH, 0, HOUSING);
  kit.add(new THREE.CircleGeometry(0.14, 24).rotateY(Math.PI).translate(0, 0, -SWITCH_DEPTH - 0.004), 0x0b0c0d);
  visor(kit, 0, -SWITCH_DEPTH, 0.155, 0.1);
  return kit.geometry();
}

/**
 * A BOStrab points signal (Weichensignal) in a small black box on a post
 * beside the track, facing −z: a white angle with its tip up (W 1, straight
 * on), to the right (W 2) or to the left (W 3); W 11 to W 13 the same over a
 * bar (the points locked).  `head` has its origin in the middle of the back
 * of the box.
 */
export class SwitchSignal {
  readonly group = new THREE.Group();
  readonly head = new THREE.Group();
  private readonly angle: THREE.Mesh;
  private readonly bar: THREE.Mesh;
  private current: SwitchAspect = 'dark';

  constructor(pole = true) {
    this.group.name = 'points signal';
    this.group.userData.dynamic = true;
    this.head.add(meshOf(shared('switch-head', switchHead), PAINT));
    this.angle = glowMesh(4, 0.24, 0, 0.025, -SWITCH_DEPTH - 0.012);
    this.bar = glowMesh(5, 0.24, 0, -0.085, -SWITCH_DEPTH - 0.012);
    this.head.add(this.angle, this.bar);
    if (pole) {
      this.group.add(meshOf(shared('switch-post', () => new Kit().cyl(0, 0, 0, SWITCH_Y, 0.04, 0.04, GALVANISED).geometry()), PAINT));
      this.head.position.set(0, SWITCH_Y, -0.045);
    }
    this.group.add(this.head);
  }

  get aspect(): SwitchAspect {
    return this.current;
  }

  set(aspect: SwitchAspect): void {
    this.current = aspect;
    this.angle.visible = aspect !== 'dark';
    // (seen by the driver: to the right is −x)
    this.angle.rotation.z = aspect === 'W2' || aspect === 'W12' ? Math.PI / 2 : aspect === 'W3' || aspect === 'W13' ? -Math.PI / 2 : 0;
    this.bar.visible = aspect === 'W11' || aspect === 'W12' || aspect === 'W13';
  }
}

// ------------------------------------------------------------------------------------ pantograph signs
const DIAMOND_Y = 2.95;

const DIAMOND = 0.354;
const DIAMOND_Z = -0.054;

function diamond(r: number): THREE.Vector2[] {
  return [new THREE.Vector2(0, -r), new THREE.Vector2(r, 0), new THREE.Vector2(0, r), new THREE.Vector2(-r, 0)];
}

function pantographPost(): THREE.BufferGeometry {
  const kit = new Kit();
  kit.cyl(0, 0, 0, DIAMOND_Y + 0.42, 0.04, 0.04, GALVANISED);
  kit.cyl(0, 0, DIAMOND_Y + 0.42, DIAMOND_Y + 0.44, 0.044, 0.044, ANTHRACITE);
  plate(kit, diamond(DIAMOND), 0, DIAMOND_Y, DIAMOND_Z, -0.042, SIGN_BACK);
  for (const y of [DIAMOND_Y - 0.17, DIAMOND_Y + 0.17]) kit.box(-0.05, 0.05, y - 0.015, y + 0.015, -0.045, 0.045, ANTHRACITE);
  return kit.geometry();
}

/** A blue diamond with a white rim and a white stripe, upright or across. */
function pantographFace(raise: boolean): THREE.BufferGeometry {
  const kit = new Kit();
  const inner = DIAMOND - 0.035;
  // the stripe, 0.075 m wide, cut to the diamond (a hair short of its corners)
  const w = 0.0375;
  const t = inner - 0.004;
  let stripe = [new THREE.Vector2(0, -t), new THREE.Vector2(w, -t + w), new THREE.Vector2(w, t - w), new THREE.Vector2(0, t), new THREE.Vector2(-w, t - w), new THREE.Vector2(-w, -t + w)];
  if (!raise) stripe = stripe.map((p) => new THREE.Vector2(-p.y, p.x));
  kit.add(face(shape(diamond(DIAMOND), diamond(inner)), 0, DIAMOND_Y, DIAMOND_Z, true), 0xf2f2ee);
  kit.add(face(shape(diamond(inner), stripe), 0, DIAMOND_Y, DIAMOND_Z, true), 0x1f4f9a);
  kit.add(face(shape(stripe), 0, DIAMOND_Y, DIAMOND_Z, true), 0xf2f2ee);
  return kit.geometry();
}

/**
 * BOStrab St 6 "Stromabnehmer heben" (`raise`: a blue diamond with a white
 * upright stripe) or St 5 "Stromabnehmer senken" (the stripe across), on a
 * pole, facing −z.
 */
export function pantographSign(raise: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = raise ? 'St 6 raise pantograph' : 'St 5 lower pantograph';
  g.add(meshOf(shared('pantograph-post', pantographPost), PAINT));
  g.add(meshOf(shared(`pantograph-face:${raise}`, () => pantographFace(raise)), FACE, false, false));
  return g;
}

// ------------------------------------------------------------------------------------ overhead line
/** The height of the contact wire above the rail (m), and of the messenger wire above it. */
export const CONTACT_WIRE_HEIGHT = 5.6;
export const MESSENGER_ABOVE = 0.6;
/** the distance between the droppers that hang the contact wire from the messenger */
const DROPPER = 4.5;

function mastShape(arm: number): THREE.BufferGeometry {
  const kit = new Kit();
  const top = 7.0;
  const yArm = CONTACT_WIRE_HEIGHT + MESSENGER_ABOVE + 0.05;
  kit.box(-0.25, 0.25, -0.02, 0.1, -0.25, 0.25, CONCRETE);
  kit.cyl(0, 0, 0.1, 0.13, 0.17, 0.17, MAST_GREY, 14);
  kit.cyl(0, 0, 0.13, top, 0.12, 0.085, MAST_GREY, 14);
  kit.cyl(0, 0, top, top + 0.04, 0.095, 0.095, ANTHRACITE, 14);
  // the bracket arm, its stay, the insulators near the mast
  const x0 = 0.08;
  const x1 = Math.max(0.4, arm + 0.12);
  kit.rod([x0, yArm, 0], [x1, yArm, 0], 0.03, MAST_GREY);
  kit.rod([x0, yArm + 0.62, 0], [Math.max(0.35, arm * 0.72), yArm + 0.02, 0], 0.022, MAST_GREY);
  kit.cyl(0, 0, yArm - 0.06, yArm + 0.7, 0.13, 0.13, ANTHRACITE, 14);
  kit.add(new THREE.CylinderGeometry(0.048, 0.048, 0.22, 10).rotateZ(Math.PI / 2).translate(0.32, yArm, 0), 0x6b4f3f);
  // where the wires hang: the clamp of the messenger, the dropper, the clamp of the contact wire,
  // and a light registration arm that holds the contact wire sideways
  kit.box(arm - 0.03, arm + 0.03, yArm - 0.08, yArm - 0.03, -0.05, 0.05, ANTHRACITE);
  kit.rod([arm, yArm - 0.05, 0], [arm, CONTACT_WIRE_HEIGHT + 0.02, 0], 0.007, 0x50565c, 5);
  kit.box(arm - 0.02, arm + 0.02, CONTACT_WIRE_HEIGHT - 0.01, CONTACT_WIRE_HEIGHT + 0.03, -0.04, 0.04, ANTHRACITE);
  const xr = Math.max(0.3, arm - 0.6);
  kit.rod([xr, CONTACT_WIRE_HEIGHT + 0.25, 0], [arm, CONTACT_WIRE_HEIGHT + 0.02, 0], 0.012, 0x50565c, 6);
  kit.rod([x0, CONTACT_WIRE_HEIGHT + 0.25, 0], [xr, CONTACT_WIRE_HEIGHT + 0.25, 0], 0.016, MAST_GREY, 6);
  kit.add(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 10).rotateZ(Math.PI / 2).translate(Math.min(xr, 0.3), CONTACT_WIRE_HEIGHT + 0.25, 0), 0x6b4f3f);
  return kit.geometry();
}

/**
 * A steel mast of the overhead line, 7 m high, with a bracket arm reaching
 * `arm` metres to +x: at its end the messenger wire hangs MESSENGER_ABOVE
 * over the contact wire, whose clamp is at (arm, CONTACT_WIRE_HEIGHT, 0) –
 * on the rail's level, as the mast's foot.
 */
export function catenaryMast(arm: number): THREE.Group {
  const a = Math.round(Math.max(0, arm) * 20) / 20;
  const g = new THREE.Group();
  g.name = 'overhead line mast';
  g.add(meshOf(shared(`mast:${a}`, () => mastShape(a)), PAINT));
  return g;
}

/**
 * The overhead line along a polyline (x, y, z, … – the contact wire's own
 * points, world coordinates): the contact wire, and with `messenger` the
 * messenger wire MESSENGER_ABOVE over it with a dropper every 4.5 m.  Lines a
 * pixel wide: thin and dark against the sky, and steady far off.  The object
 * sits at the first point (for the precision of the numbers).
 */
export function contactWire(points: Float32Array, messenger = true): THREE.Object3D {
  const n = Math.floor(points.length / 3);
  const ox = n > 0 ? points[0] : 0;
  const oy = n > 0 ? points[1] : 0;
  const oz = n > 0 ? points[2] : 0;
  const seg: number[] = [];
  let next = DROPPER / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = points[i * 3] - ox;
    const ay = points[i * 3 + 1] - oy;
    const az = points[i * 3 + 2] - oz;
    const bx = points[i * 3 + 3] - ox;
    const by = points[i * 3 + 4] - oy;
    const bz = points[i * 3 + 5] - oz;
    seg.push(ax, ay, az, bx, by, bz);
    if (!messenger) continue;
    seg.push(ax, ay + MESSENGER_ABOVE, az, bx, by + MESSENGER_ABOVE, bz);
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    for (; next <= len; next += DROPPER) {
      const t = next / len;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      seg.push(x, y, z, x, y + MESSENGER_ABOVE, z);
    }
    next -= len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  g.userData.own = true;
  const lines = new THREE.LineSegments(g, WIRE);
  lines.position.set(ox, oy, oz);
  lines.name = 'overhead line';
  return lines;
}

// ------------------------------------------------------------------------------------ platform
const PLATFORM_GLSL = /* glsl */ `
float pfHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// 1 on the joints of a grid of 'size' metres (w wide), faded out where a pixel is too coarse for them
float pfJoints(vec2 p, vec2 size, float w, float fw) {
  vec2 f = fract(p / size);
  vec2 d = min(f, 1.0 - f) * size;
  return (1.0 - smoothstep(w * 0.5, w, min(d.x, d.y))) * (1.0 - smoothstep(w, w * 4.0, fw));
}
// pf.x: metres along the platform; on top pf.y = metres from the edge at the track, on the sides metres below the top
vec3 fsPlatform(vec2 pf, float side) {
  float fw = max(fwidth(pf.x), fwidth(pf.y));
  vec3 c;
  if (side < 0.5) {
    float e = pf.y;
    if (e < 0.3) {
      // the kerb along the edge: light concrete blocks of 1 m
      c = vec3(0.80, 0.80, 0.77) * (1.0 - 0.3 * pfJoints(vec2(pf.x, 0.5), vec2(1.0, 1.0), 0.012, fw));
    } else if (e < 0.6) {
      // the white tactile strip, its ribs along the edge
      float rib = smoothstep(0.25, 0.45, abs(fract((e - 0.3) / 0.06) - 0.5));
      c = vec3(0.93, 0.93, 0.91) * (1.0 - 0.14 * rib * (1.0 - smoothstep(0.006, 0.02, fw)));
      c *= 1.0 - 0.3 * pfJoints(vec2(pf.x, e - 0.3), vec2(0.3, 0.3), 0.01, fw);
    } else {
      // grey slabs, each a little different
      vec2 q = vec2(pf.x, e - 0.6);
      float v = pfHash(floor(q / 0.4));
      c = vec3(0.62, 0.62, 0.6) * (0.92 + 0.14 * v);
      c *= 1.0 - 0.32 * pfJoints(q, vec2(0.4, 0.4), 0.01, fw);
    }
  } else {
    // the faces of the kerbs: concrete, darker towards the ground
    c = vec3(0.6, 0.6, 0.58) * (1.0 - 0.22 * smoothstep(0.1, 0.35, pf.y));
  }
  return pow(c, vec3(2.2));
}
`;

const PLATFORM = new THREE.MeshLambertMaterial({ color: 0xffffff });
PLATFORM.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aPf;\nattribute float aSide;\nvarying vec2 vPf;\nvarying float vSide;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPf = aPf;\nvSide = aSide;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec2 vPf;\nvarying float vSide;\n${PLATFORM_GLSL}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = fsPlatform(vPf, vSide);');
};
PLATFORM.customProgramCacheKey = () => 'fs-platform';

/**
 * A raised platform along a polyline (its middle line, points on the ground):
 * a slab `width` wide and `height` high with its sides and ends, paved in light
 * grey, with a light kerb and a white tactile strip along the edge at the
 * track – to the right of the polyline's direction (`edgeSide` 1) or to its
 * left (−1).  The mesh sits at the first point; its sides reach 0.15 m into
 * the ground.
 */
export function platform(centreline: Array<[number, number, number]>, width: number, height: number, edgeSide: 1 | -1): THREE.Mesh {
  // (points closer than 1 cm together are one)
  const pts: Array<[number, number, number]> = [];
  for (const p of centreline) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[2] - last[2]) > 0.01) pts.push(p);
  }
  const g = new THREE.BufferGeometry();
  g.userData.own = true;
  const mesh = new THREE.Mesh(g, PLATFORM);
  mesh.name = 'platform';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (pts.length < 2) {
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    return mesh;
  }
  const [ox, oy, oz] = pts[0];
  const n = pts.length;
  const hw = width / 2;
  // each point: its place, the direction across (to the right), how far along, the edges
  const dirs: Array<[number, number, number]> = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][2] - pts[i][2];
    const l = Math.hypot(dx, dz);
    dirs.push([dx / l, dz / l, l]);
  }
  const L: V3[] = [];
  const R: V3[] = [];
  const right: V3[] = [];
  const along: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = dirs[Math.max(0, i - 1)];
    const b = dirs[Math.min(n - 2, i)];
    let tx = a[0] + b[0];
    let tz = a[1] + b[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // the mitre: wider where the line bends, so that the edges stay parallel
    const miter = 1 / Math.max(0.5, tx * b[0] + tz * b[1]);
    const rx = -tz * miter;
    const rz = tx * miter;
    const [px, py, pz] = pts[i];
    right.push([-tz, 0, tx]);
    L.push([px - ox - rx * hw, py - oy, pz - oz - rz * hw]);
    R.push([px - ox + rx * hw, py - oy, pz - oz + rz * hw]);
    along.push(s);
    if (i + 1 < n) s += dirs[i][2];
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const pf: number[] = [];
  const side: number[] = [];
  const vert = (p: V3, y: number, nx: number, ny: number, nz: number, u: number, v: number, k: number): void => {
    pos.push(p[0], y, p[2]);
    nor.push(nx, ny, nz);
    pf.push(u, v);
    side.push(k);
  };
  const deep = height + 0.15;
  // across the top: distance from the edge at the track
  const vL = edgeSide > 0 ? width : 0;
  const vR = edgeSide > 0 ? 0 : width;
  for (let i = 0; i + 1 < n; i++) {
    const j = i + 1;
    const top = (p: V3): number => p[1] + height;
    const bot = (p: V3): number => p[1] - 0.15;
    // the top
    vert(L[i], top(L[i]), 0, 1, 0, along[i], vL, 0);
    vert(R[i], top(R[i]), 0, 1, 0, along[i], vR, 0);
    vert(R[j], top(R[j]), 0, 1, 0, along[j], vR, 0);
    vert(L[i], top(L[i]), 0, 1, 0, along[i], vL, 0);
    vert(R[j], top(R[j]), 0, 1, 0, along[j], vR, 0);
    vert(L[j], top(L[j]), 0, 1, 0, along[j], vL, 0);
    // the right side, facing right
    const [ax, , az] = right[i];
    const [bx, , bz] = right[j];
    vert(R[i], bot(R[i]), ax, 0, az, along[i], deep, 1);
    vert(R[j], bot(R[j]), bx, 0, bz, along[j], deep, 1);
    vert(R[j], top(R[j]), bx, 0, bz, along[j], 0, 1);
    vert(R[i], bot(R[i]), ax, 0, az, along[i], deep, 1);
    vert(R[j], top(R[j]), bx, 0, bz, along[j], 0, 1);
    vert(R[i], top(R[i]), ax, 0, az, along[i], 0, 1);
    // the left side, facing left
    vert(L[i], bot(L[i]), -ax, 0, -az, along[i], deep, 1);
    vert(L[j], top(L[j]), -bx, 0, -bz, along[j], 0, 1);
    vert(L[j], bot(L[j]), -bx, 0, -bz, along[j], deep, 1);
    vert(L[i], bot(L[i]), -ax, 0, -az, along[i], deep, 1);
    vert(L[i], top(L[i]), -ax, 0, -az, along[i], 0, 1);
    vert(L[j], top(L[j]), -bx, 0, -bz, along[j], 0, 1);
  }
  // the two ends
  for (const [i, out] of [[0, -1], [n - 1, 1]] as const) {
    const d = dirs[Math.min(n - 2, i)];
    const nx = d[0] * out;
    const nz = d[1] * out;
    const lb = L[i][1] - 0.15;
    const rb = R[i][1] - 0.15;
    const lt = L[i][1] + height;
    const rt = R[i][1] + height;
    const quad: Array<[V3, number, number, number]> =
      out < 0
        ? [[L[i], lb, 0, deep], [R[i], rb, width, deep], [R[i], rt, width, 0], [L[i], lb, 0, deep], [R[i], rt, width, 0], [L[i], lt, 0, 0]]
        : [[L[i], lb, 0, deep], [R[i], rt, width, 0], [R[i], rb, width, deep], [L[i], lb, 0, deep], [L[i], lt, 0, 0], [R[i], rt, width, 0]];
    for (const [p, y, u, v] of quad) vert(p, y, nx, 0, nz, u, v, 1);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPf', new THREE.Float32BufferAttribute(pf, 2));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.computeBoundingSphere();
  mesh.position.set(ox, oy, oz);
  return mesh;
}

// ------------------------------------------------------------------------------------ departure board
export interface DepartureRow {
  line: string;
  destination: string;
  /** minutes until it leaves (0: "sofort"), or a text of its own */
  minutes: number | string;
}

const BOARD_W = 1.0;
const BOARD_H = 0.42;
const BOARD_TOP = 2.72;

function departurePost(pole: boolean): THREE.BufferGeometry {
  const kit = new Kit();
  const y0 = BOARD_TOP - BOARD_H;
  if (pole) kit.cyl(0, 0, 0, y0 + 0.05, 0.05, 0.05, ANTHRACITE);
  const d = 0.07;
  const b = 0.04;
  // the housing: a frame round the two screens, a little roof on top
  kit.box(-BOARD_W / 2, BOARD_W / 2, BOARD_TOP - b, BOARD_TOP, -d, d, ANTHRACITE);
  kit.box(-BOARD_W / 2, BOARD_W / 2, y0, y0 + b, -d, d, ANTHRACITE);
  kit.box(-BOARD_W / 2, -BOARD_W / 2 + b, y0 + b, BOARD_TOP - b, -d, d, ANTHRACITE);
  kit.box(BOARD_W / 2 - b, BOARD_W / 2, y0 + b, BOARD_TOP - b, -d, d, ANTHRACITE);
  kit.box(-BOARD_W / 2 + b, BOARD_W / 2 - b, y0 + b, BOARD_TOP - b, -d + 0.02, d - 0.02, 0x101112);
  kit.box(-BOARD_W / 2 - 0.03, BOARD_W / 2 + 0.03, BOARD_TOP, BOARD_TOP + 0.025, -d - 0.04, d + 0.04, ANTHRACITE);
  return kit.geometry();
}

function departureScreens(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const front of [true, false]) {
    const g = new THREE.PlaneGeometry(BOARD_W - 0.08, BOARD_H - 0.08);
    if (front) g.rotateY(Math.PI);
    g.translate(0, BOARD_TOP - BOARD_H / 2, front ? -0.0705 : 0.0705);
    parts.push(g.toNonIndexed());
    g.dispose();
  }
  return merged(parts);
}

/**
 * A small departure display (both faces) on a pole: up to three rows of line,
 * destination and minutes, amber on black, and a clock.  Drawn again only
 * when what it shows changes.  `group` faces −z; call `dispose` (or
 * `releaseModel`) when it is taken away.
 */
export class DepartureBoard {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private shown = '';

  constructor(pole = true) {
    this.canvas.width = 512;
    this.canvas.height = 192;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = canvasTexture(this.canvas);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    this.group.name = 'departure board';
    this.group.userData.dynamic = true;
    this.group.userData.release = (): void => this.dispose();
    this.group.add(meshOf(shared(`departure-post:${pole}`, () => departurePost(pole)), PAINT));
    this.group.add(meshOf(shared('departure-screens', departureScreens), this.material, false, false));
    this.draw([], '');
  }

  /** What it shows: the next departures (three at most) and the time of day ("12:34"). */
  set(rows: readonly DepartureRow[], clock = ''): void {
    let key = clock;
    for (const r of rows.slice(0, 3)) key += `\n${r.line}\t${r.destination}\t${r.minutes}`;
    if (key === this.shown) return;
    this.shown = key;
    this.draw(rows, clock);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
  }

  private draw(rows: readonly DepartureRow[], clock: string): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.fillStyle = '#050505';
    c.fillRect(0, 0, W, H);
    const amber = '#ffb02e';
    c.fillStyle = amber;
    c.textBaseline = 'middle';
    c.font = `bold 30px ${FONT}`;
    c.textAlign = 'right';
    c.fillText(clock, W - 14, 26);
    rows.slice(0, 3).forEach((r, i) => {
      const y = 76 + i * 46;
      c.fillStyle = amber;
      c.textAlign = 'left';
      c.font = `bold 34px ${FONT}`;
      c.fillText(r.line, 14, y, 70);
      const minutes = typeof r.minutes === 'number' ? (r.minutes <= 0 ? 'sofort' : `${Math.round(r.minutes)} min`) : r.minutes;
      c.textAlign = 'right';
      c.fillText(minutes, W - 14, y, 120);
      c.textAlign = 'left';
      c.fillText(r.destination, 96, y, W - 96 - 150);
    });
    // the grid of the light-emitting diodes
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    for (let x = 0; x < W; x += 3) c.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 3) c.fillRect(0, y, W, 1);
    this.texture.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------ merging and releasing
/** The materials whose meshes `mergeStatic` folds together (pages of names join when they are made). */
const MERGEABLE = new Set<THREE.Material>([PAINT, FACE, GLASS, WIRE, PLATFORM]);

/**
 * Folds everything static under `root` (a stop with its sign, shelter,
 * benches, boards, platforms, masts and wires) into one mesh per material: a
 * handful of draw calls for the whole stop.  Signals and departure boards
 * (`userData.dynamic`) are kept as they are and moved along.  The result
 * takes the place of `root` (same transform); `root` is left empty of what
 * was folded.  Call `releaseModel` on the result when it is taken away.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const out = new THREE.Group();
  out.name = root.name ? `${root.name} (merged)` : 'merged';
  out.position.copy(root.position);
  out.quaternion.copy(root.quaternion);
  out.scale.copy(root.scale);
  const byMaterial = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; lines: boolean; cast: boolean; receive: boolean; order: number }>();
  const releases: Array<() => void> = [];
  const keep: THREE.Object3D[] = [];
  const own: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const visit = (o: THREE.Object3D): void => {
    if (o !== root && o.userData.dynamic) {
      keep.push(o);
      return;
    }
    if (typeof o.userData.release === 'function') releases.push(o.userData.release as () => void);
    const isMesh = o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh);
    const isLines = o instanceof THREE.LineSegments;
    if ((isMesh || isLines) && !Array.isArray(o.material) && MERGEABLE.has(o.material as THREE.Material)) {
      const material = o.material as THREE.Material;
      let entry = byMaterial.get(material);
      if (!entry) byMaterial.set(material, (entry = { geos: [], lines: isLines, cast: false, receive: false, order: o.renderOrder }));
      const geo = o.geometry as THREE.BufferGeometry;
      const copy = geo.index ? geo.toNonIndexed() : geo.clone();
      copy.applyMatrix4(m.multiplyMatrices(toRoot, o.matrixWorld));
      entry.geos.push(copy);
      entry.cast ||= o.castShadow;
      entry.receive ||= o.receiveShadow;
      if (geo.userData.own) own.push(geo);
    } else if (o !== root && (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite)) {
      keep.push(o);
      return;
    }
    for (const c of [...o.children]) visit(c);
  };
  visit(root);
  for (const [material, e] of byMaterial) {
    const geo = mergeGeometries(e.geos, false);
    for (const g of e.geos) g.dispose();
    if (!geo) continue;
    geo.userData.own = true;
    geo.computeBoundingSphere();
    const obj = e.lines ? new THREE.LineSegments(geo, material) : meshOf(geo, material, e.cast, e.receive);
    obj.renderOrder = e.order;
    out.add(obj);
  }
  for (const o of keep) {
    // the same place relative to the root as before
    m.multiplyMatrices(toRoot, o.matrixWorld);
    o.removeFromParent();
    m.decompose(o.position, o.quaternion, o.scale);
    out.add(o);
  }
  for (const g of own) g.dispose();
  root.clear();
  if (releases.length) out.userData.release = (): void => releases.splice(0).forEach((r) => r());
  return out;
}

/**
 * Gives back what an object built here holds for itself alone – the place of
 * a stop's name, the picture of a departure board, the geometry of a
 * platform, a wire or a merged stop.  What is shared stays.
 */
export function releaseModel(object: THREE.Object3D): void {
  object.traverse((o) => {
    const release = o.userData.release;
    if (typeof release === 'function') {
      delete o.userData.release;
      (release as () => void)();
    }
    if ((o instanceof THREE.Mesh || o instanceof THREE.Line) && (o.geometry as THREE.BufferGeometry).userData.own) o.geometry.dispose();
  });
}
