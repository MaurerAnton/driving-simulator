// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic signs.  The official sign graphics (public-domain SVGs, bundled in
 * public/signs/signs.json) are rasterised into one texture atlas on demand;
 * town signs carry generated text.  Signs without a graphic fall back to a
 * simple procedural rendering, so the game never shows a blank plate.
 */
import * as THREE from 'three';
import type { SignPost } from '../world/tilefmt.ts';
import { artAspect, drawSignArt, splitCode } from './signart.ts';
import type { LoadedTile } from './tiles.ts';

// (cells of 192 px: a hundred of them in the atlas, a wide plate takes two – reused once no tile shows their sign)
const CELL = 192;
const COLS = 10;
const ROWS = 10;
const PAD = 5;

interface Slot {
  /** uv rectangle of the drawable area */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** width / height of the plate */
  aspect: number;
  /** its first cell in the atlas (-1: none – the atlas was full), and whether it takes the next one too */
  cell: number;
  wide: boolean;
  /** how many groups of posts show it now, and when the last of them went (it may be drawn over after that) */
  users: number;
  last: number;
}

/**
 * Graphics of other numbers that show the same sign: the 1992 numbers of the
 * bundled files for their 2017 numbers, and those that hold for the variants
 * with an arrow beneath.
 */
const ALIAS: Record<string, string> = {
  '1010-51': '1048-12',
  '1053-35': '1052-36',
  '286-10': '286',
  '286-20': '286',
  '286-30': '286',
  '315-50': '315',
  '315-55': '315',
  '350-10': '350',
  '350-20': '350',
};

/** Graphics that show a sign the other way round (Aufstellung links: the figure looks the other way). */
const MIRROR: Record<string, string> = {
  '133-20': '133-10',
  '136-20': '136-10',
  '138-20': '138-10',
  '142-20': '142-10',
  '156-20': '156-10',
  '159-20': '159-10',
  '162-20': '162-10',
  '241-31': '241-30',
};

/** How a sign is drawn: from a bundled graphic (mirrored or not), by signart.ts, as a town sign, or as the simple fallback. */
interface Plan {
  how: 'svg' | 'art' | 'town' | 'fallback';
  svg?: string;
  mirror?: boolean;
}

interface ManifestEntry {
  width: number;
  height: number;
  shape?: string;
}

const FONT = '"DIN 1451 Std", "DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Liberation Sans Narrow", "Helvetica Neue", Arial, sans-serif';

/** Plate size in metres for a sign code. */
export function signSize(code: string, aspect: number, big: boolean): [number, number] {
  const k = big ? 1.45 : 1;
  const base = code.split(':')[0];
  const n = Number.parseFloat(base);
  let w: number;
  if (base === '310' || base === '311') return [1.2 * k, 0.8 * k];
  // (the diversion that is announced at a closure: a wide yellow plate)
  if (base === '457.1') return [0.9 * k, 0.56 * k];
  // (a beacon stands tall and narrow, a guide plate or a barrier lies wide; the detour signs are a little larger)
  if (base.startsWith('605-')) return [0.25 * k, 1.0 * k];
  if (base.startsWith('626-') || base === '600') w = 1.0;
  else if (base.startsWith('454-') || base.startsWith('455.') || base === '457.2') w = 0.9;
  else if (n >= 1000) w = 0.6;
  else if (n < 200 || base === '205' || base === '301') w = 0.9;
  else if (base === '206') w = 0.9;
  else if (base === '306' || base === '307') w = 0.84;
  else if (base.startsWith('325') || base.startsWith('330') || base.startsWith('331')) w = 0.9;
  else if (base.startsWith('201')) w = 1.0;
  else w = 0.6;
  return [w * k, (w * k) / (aspect || 1)];
}

export class SignRenderer {
  private readonly baseUrl: string;
  private svgs: Record<string, string> = {};
  private manifest: Record<string, ManifestEntry> = {};
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  readonly backMaterial: THREE.MeshBasicMaterial;
  private readonly postMat = new THREE.MeshLambertMaterial({ color: 0x8b9094 });
  private readonly postGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 6, 1, true).translate(0, 0.5, 0);
  private readonly slots = new Map<string, Slot>();
  /** which cells of the atlas are taken (cell 0 is the plain grey back side) */
  private readonly taken = new Uint8Array(COLS * ROWS);
  /** counts the groups that went, to know which unused sign went longest ago */
  private gone = 0;
  /** the codes each group of posts shows (released when its tile goes) */
  private readonly groupCodes = new Map<THREE.Object3D, string[]>();
  private readonly perTile = new Map<string, THREE.Object3D>();
  private dirty = false;
  missing = new Set<string>();

  constructor(baseUrl: string, maxAnisotropy: number) {
    this.baseUrl = baseUrl;
    this.canvas.width = CELL * COLS;
    this.canvas.height = CELL * ROWS;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = '#9a9fa3';
    this.ctx.fillRect(0, 0, CELL, CELL);
    this.taken[0] = 1;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = Math.min(8, maxAnisotropy);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, alphaTest: 0.45, transparent: false });
    // back sides keep the plate's silhouette (alpha) but show bare metal
    this.backMaterial = new THREE.MeshBasicMaterial({ map: this.texture, alphaTest: 0.45 });
    this.backMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = vec3(0.30, 0.32, 0.33);',
      );
    };
    this.backMaterial.customProgramCacheKey = () => 'fs-sign-back';
  }

  async init(): Promise<void> {
    try {
      const [a, b] = await Promise.all([fetch(`${this.baseUrl}signs.json`), fetch(`${this.baseUrl}manifest.json`)]);
      if (a.ok) this.svgs = (await a.json()) as Record<string, string>;
      if (b.ok) this.manifest = (await b.json()) as Record<string, ManifestEntry>;
    } catch (err) {
      console.warn('sign graphics unavailable, using procedural fallbacks', err);
    }
  }

  /** Call once per frame: uploads the atlas after new signs were drawn. */
  flush(): void {
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  /**
   * How a sign is drawn: its own graphic where there is one and the plate
   * shows nothing the map adds (a time, a value) – mirrored, or of another
   * number, where that is the same sign –, else by signart.ts, else the
   * graphic of the sign it is a variant of (101-12 → 101), else the simple
   * fallback.
   */
  private plan(code: string): Plan {
    const [base, arg] = splitCode(code);
    if (base === '310' || base === '311') return { how: 'town' };
    if (!arg) {
      if (this.svgs[base]) return { how: 'svg', svg: base };
      const alias = ALIAS[base];
      if (alias && this.svgs[alias]) return { how: 'svg', svg: alias };
      const mirror = MIRROR[base];
      if (mirror && this.svgs[mirror]) return { how: 'svg', svg: mirror, mirror: true };
    }
    // (the diversion of a closure is drawn by the fallback: sim/roadevents.ts)
    if (base !== '457.1' && artAspect(code) !== null) return { how: 'art' };
    const parent = /^(\d+(?:\.\d+)?)-\d+$/.exec(base)?.[1];
    if (arg && this.svgs[base]) return { how: 'svg', svg: base };
    if (parent && this.svgs[parent] && !parent.startsWith('274') && !parent.startsWith('278')) return { how: 'svg', svg: parent };
    return { how: 'fallback' };
  }

  private aspectOf(code: string): number {
    const base = splitCode(code)[0];
    if (base === '310' || base === '311') return 1.5;
    if (base === '457.1') return 1.6;
    const plan = this.plan(code);
    const m = plan.svg ? this.manifest[plan.svg] : undefined;
    if (m && m.width > 0 && m.height > 0) return m.width / m.height;
    if (plan.how === 'art') return artAspect(code) ?? 1;
    const n = Number.parseFloat(base);
    if (n >= 1000) return 1.82;
    if (n < 200 || base === '205' || base === '301') return 1.14;
    if (base.startsWith('325') || base.startsWith('330')) return 1.5;
    return 1;
  }

  /** A free cell (or two side by side for a wide plate) – drawing over signs no group shows any more, those that went longest ago first; -1 if there is none. */
  private freeCell(wide: boolean): number {
    const find = (): number => {
      for (let i = 1; i < COLS * ROWS; i++) {
        if (this.taken[i]) continue;
        if (!wide) return i;
        if (i % COLS !== COLS - 1 && !this.taken[i + 1]) return i;
      }
      return -1;
    };
    let cell = find();
    while (cell < 0) {
      let oldest: [string, Slot] | null = null;
      for (const e of this.slots) if (e[1].users === 0 && e[1].cell >= 0 && (!oldest || e[1].last < oldest[1].last)) oldest = e;
      if (!oldest) return -1;
      this.slots.delete(oldest[0]);
      this.taken[oldest[1].cell] = 0;
      if (oldest[1].wide) this.taken[oldest[1].cell + 1] = 0;
      cell = find();
    }
    return cell;
  }

  private slot(code: string): Slot {
    let s = this.slots.get(code);
    // (one that found the atlas full is tried again once nothing shows it)
    if (s && (s.cell >= 0 || s.users > 0)) return s;
    if (s) this.slots.delete(code);
    const aspect = this.aspectOf(code);
    // wide plates take two cells so that text stays legible
    const wide = aspect > 1.3;
    const index = this.freeCell(wide);
    if (index < 0) {
      // atlas full: reuse the back side rather than crash
      console.warn('sign atlas full, dropping', code);
      s = { u0: 0.01, v0: 0.01, u1: 0.02, v1: 0.02, aspect, cell: -1, wide: false, users: 0, last: 0 };
      this.slots.set(code, s);
      return s;
    }
    this.taken[index] = 1;
    if (wide) this.taken[index + 1] = 1;
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const cw = CELL * (wide ? 2 : 1) - PAD * 2;
    const ch = CELL - PAD * 2;
    // fit the plate into the cell keeping its aspect
    let w = cw;
    let h = cw / aspect;
    if (h > ch) {
      h = ch;
      w = ch * aspect;
    }
    const x = col * CELL + PAD + (cw - w) / 2;
    const y = row * CELL + PAD + (ch - h) / 2;
    const W = this.canvas.width;
    const H = this.canvas.height;
    s = { u0: x / W, v0: 1 - (y + h) / H, u1: (x + w) / W, v1: 1 - y / H, aspect, cell: index, wide, users: 0, last: 0 };
    this.slots.set(code, s);
    // (whatever was drawn in the cells before goes)
    this.ctx.clearRect(col * CELL, row * CELL, CELL * (wide ? 2 : 1), CELL);
    this.draw(code, x, y, w, h);
    return s;
  }

  private draw(code: string, x: number, y: number, w: number, h: number): void {
    const base = splitCode(code)[0];
    const plan = this.plan(code);
    const svg = plan.svg ? this.svgs[plan.svg] : undefined;
    if (plan.how === 'svg' && svg) {
      let text = svg;
      // browsers need an intrinsic size to rasterise an SVG image
      if (!/<svg[^>]*\swidth=/.test(text)) {
        const vb = /viewBox="([\d.\s,-]+)"/.exec(text);
        if (vb) {
          const p = vb[1].trim().split(/[\s,]+/).map(Number);
          text = text.replace('<svg', `<svg width="${p[2]}" height="${p[3]}"`);
        }
      }
      const img = new Image();
      const mine = this.slots.get(code);
      img.onload = () => {
        // (the cell may have been given to another sign meanwhile)
        if (this.slots.get(code) !== mine) return;
        this.ctx.clearRect(x - 1, y - 1, w + 2, h + 2);
        if (plan.mirror) {
          this.ctx.save();
          this.ctx.translate(2 * x + w, 0);
          this.ctx.scale(-1, 1);
          this.ctx.drawImage(img, x, y, w, h);
          this.ctx.restore();
        } else this.ctx.drawImage(img, x, y, w, h);
        this.dirty = true;
      };
      img.onerror = () => {
        if (this.slots.get(code) !== mine) return;
        this.missing.add(base);
        this.ctx.clearRect(x - 1, y - 1, w + 2, h + 2);
        if (!drawSignArt(this.ctx, code, x, y, w, h)) this.fallback(code, x, y, w, h);
        this.dirty = true;
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      // draw something right away; the SVG replaces it once decoded
      if (!drawSignArt(this.ctx, code, x, y, w, h)) this.fallback(code, x, y, w, h);
    } else if (plan.how === 'art' && drawSignArt(this.ctx, code, x, y, w, h)) {
      /* drawn by signart.ts */
    } else {
      if (plan.how !== 'town' && base !== '457.1') this.missing.add(base);
      this.fallback(code, x, y, w, h);
    }
    this.dirty = true;
  }

  /** Simple procedural rendering of the most important signs. */
  private fallback(code: string, x: number, y: number, w: number, h: number): void {
    const c = this.ctx;
    const [base, arg] = splitCode(code);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    c.save();
    c.lineJoin = 'round';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const ring = (fill: string, rim: string, rimW: number): void => {
      c.beginPath();
      c.arc(cx, cy, r - 1, 0, Math.PI * 2);
      c.fillStyle = rim;
      c.fill();
      c.beginPath();
      c.arc(cx, cy, r * (1 - rimW), 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
    };
    const poly = (pts: number[], fill: string): void => {
      c.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const px = x + pts[i] * w;
        const py = y + pts[i + 1] * h;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    };
    const label = (t: string, size: number, color = '#111', dy = 0): void => {
      c.fillStyle = color;
      c.font = `bold ${size}px ${FONT}`;
      c.fillText(t, cx, cy + dy, w * 0.92);
    };
    if (base === '310' || base === '311') {
      const [l1 = '', l2 = ''] = arg.split('|');
      c.fillStyle = '#111';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#f6d417';
      c.fillRect(x + 5, y + 5, w - 10, h - 10);
      if (base === '310') {
        label(l1, h * 0.3, '#111', l2 ? -h * 0.12 : 0);
        if (l2) label(l2, h * 0.15, '#111', h * 0.22);
      } else {
        c.fillStyle = '#111';
        c.fillRect(x + 5, cy - 2, w - 10, 4);
        label(l1, h * 0.26, '#111', h * 0.22);
        c.strokeStyle = '#d0141e';
        c.lineWidth = h * 0.07;
        c.beginPath();
        c.moveTo(x + w * 0.06, y + h * 0.94);
        c.lineTo(x + w * 0.94, y + h * 0.56);
        c.stroke();
      }
    } else if (base === '457.1') {
      // Umleitung (a diversion ahead): black on yellow, as the temporary signs of a closure are
      c.fillStyle = '#111';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#f6c21c';
      c.fillRect(x + 6, y + 6, w - 12, h - 12);
      label('Umleitung', h * 0.3, '#111', -h * 0.08);
      c.fillStyle = '#111';
      c.fillRect(x + w * 0.2, y + h * 0.72, w * 0.6, h * 0.05);
    } else if (base.startsWith('274.') || base.startsWith('290')) {
      c.fillStyle = '#111';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#fff';
      c.fillRect(x + 4, y + 4, w - 8, h - 8);
      const speed = base.endsWith('-20') ? '20' : '30';
      c.beginPath();
      c.arc(cx, cy - h * 0.1, r * 0.6, 0, Math.PI * 2);
      c.fillStyle = base.startsWith('274.2') ? '#888' : '#d0141e';
      c.fill();
      c.beginPath();
      c.arc(cx, cy - h * 0.1, r * 0.46, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
      label(speed, r * 0.5, base.startsWith('274.2') ? '#888' : '#111', -h * 0.1);
      label('ZONE', r * 0.3, base.startsWith('274.2') ? '#888' : '#111', h * 0.33);
    } else if (base.startsWith('274-')) {
      ring('#fff', '#d0141e', 0.2);
      label(base.slice(4), r * (base.length > 6 ? 0.78 : 0.95));
    } else if (base.startsWith('278-') || base === '282') {
      ring('#fff', '#444', 0.06);
      if (base !== '282') label(base.slice(4), r * 0.8, '#666');
      c.strokeStyle = '#333';
      c.lineWidth = r * 0.05;
      for (let i = -2; i <= 2; i++) {
        c.beginPath();
        c.moveTo(cx - r * 0.62 + i * r * 0.09, cy + r * 0.62 + i * r * 0.09);
        c.lineTo(cx + r * 0.62 + i * r * 0.09, cy - r * 0.62 + i * r * 0.09);
        c.stroke();
      }
    } else if (base === '205') {
      poly([0, 0, 1, 0, 0.5, 1], '#d0141e');
      poly([0.17, 0.1, 0.83, 0.1, 0.5, 0.8], '#fff');
    } else if (base === '206') {
      const o = 0.293;
      poly([o, 0, 1 - o, 0, 1, o, 1, 1 - o, 1 - o, 1, o, 1, 0, 1 - o, 0, o], '#fff');
      const i = 0.03;
      poly([o + i * 0.4, i, 1 - o - i * 0.4, i, 1 - i, o + i * 0.4, 1 - i, 1 - o - i * 0.4, 1 - o - i * 0.4, 1 - i, o + i * 0.4, 1 - i, i, 1 - o - i * 0.4, i, o + i * 0.4], '#d0141e');
      label('STOP', r * 0.62, '#fff');
    } else if (base === '306' || base === '307') {
      poly([0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5], '#fff');
      poly([0.5, 0.12, 0.88, 0.5, 0.5, 0.88, 0.12, 0.5], '#f6c817');
    } else if (base === '301' || Number.parseFloat(base) < 200) {
      poly([0.5, 0, 1, 1, 0, 1], '#d0141e');
      poly([0.5, 0.2, 0.83, 0.9, 0.17, 0.9], '#fff');
      label(base === '301' ? '▲' : '!', r * 0.7, '#111', h * 0.18);
    } else if (base === '267') {
      ring('#d0141e', '#fff', 0.05);
      c.fillStyle = '#fff';
      c.fillRect(cx - r * 0.66, cy - r * 0.13, r * 1.32, r * 0.26);
    } else if (base === '250' || base === '260' || base === '253' || base === '251') {
      ring('#fff', '#d0141e', 0.18);
    } else if (base === '215' || base.startsWith('209') || base.startsWith('211') || base.startsWith('214') || base.startsWith('222') || base === '237' || base === '240') {
      ring('#1b5fa8', '#fff', 0.04);
      label(base === '215' ? '↺' : '↑', r * 1.1, '#fff');
    } else if (base === '224') {
      ring('#f6d417', '#1d7a34', 0.14);
      label('H', r * 1.0, '#1d7a34');
    } else if (Number.parseFloat(base) >= 1000) {
      c.fillStyle = '#111';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#fff';
      c.fillRect(x + 4, y + 4, w - 8, h - 8);
      const texts: Record<string, string> = {
        '1020-30': 'Anlieger frei',
        '1026-38': 'Land- u. forstw. Verkehr frei',
        '1026-36': 'Landw. Verkehr frei',
        '1022-10': 'Rad frei',
        '1012-31': 'Ende',
        '1012-30': 'Anfang',
      };
      label(texts[base] ?? base, h * 0.3);
    } else {
      c.fillStyle = '#fff';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#1b5fa8';
      c.fillRect(x + 4, y + 4, w - 8, h - 8);
      label(base, h * 0.3, '#fff');
    }
    c.restore();
  }

  add(tile: LoadedTile): void {
    const posts = tile.header.signs;
    if (!posts || posts.length === 0) return;
    const { group, disposables } = this.build(posts, tile.header.cx, tile.header.yBase, tile.header.cz);
    tile.group.add(group);
    tile.disposables.push(...disposables);
    this.perTile.set(tile.key, group);
  }

  /**
   * The posts and plates of these signs as one group (positions relative to
   * cx, yBase, cz for float precision) – for a tile, or for signs that stand
   * only today (sim/roadevents.ts).  Whoever takes the group disposes of
   * `disposables` when it goes.
   */
  build(posts: readonly SignPost[], cx: number, yBase: number, cz: number): { group: THREE.Group; disposables: Array<{ dispose(): void }> } {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const idxBack: number[] = [];
    const group = new THREE.Group();
    const postMesh = new THREE.InstancedMesh(this.postGeo, this.postMat, posts.length);
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    // (each sign the group shows is counted at once: its cell is not drawn over while the group is there)
    const used = new Set<string>();
    posts.forEach((p: SignPost, pi: number) => {
      const s = Math.sin(p.yaw);
      const c = Math.cos(p.yaw);
      // facing vector f = (-s, 0, -c); the viewer's right is (-c, 0, s)
      const rx = -c;
      const rz = s;
      let y = p.y + p.h;
      for (let k = p.s.length - 1; k >= 0; k--) {
        const code = p.s[k];
        const slot = this.slot(code);
        if (!used.has(code)) {
          used.add(code);
          slot.users++;
        }
        const [w, h] = signSize(code, slot.aspect, p.big === 1);
        const y0 = y;
        const y1 = y + h;
        const hw = w / 2;
        const fx = -s * 0.035;
        const fz = -c * 0.035;
        const base = pos.length / 3;
        // front
        pos.push(p.x - rx * hw + fx, y0, p.z - rz * hw + fz, p.x + rx * hw + fx, y0, p.z + rz * hw + fz, p.x + rx * hw + fx, y1, p.z + rz * hw + fz, p.x - rx * hw + fx, y1, p.z - rz * hw + fz);
        uv.push(slot.u0, slot.v0, slot.u1, slot.v0, slot.u1, slot.v1, slot.u0, slot.v1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        // back: same outline, drawn with the bare-metal material
        pos.push(p.x - rx * hw - fx * 0.2, y0, p.z - rz * hw - fz * 0.2, p.x + rx * hw - fx * 0.2, y0, p.z + rz * hw - fz * 0.2, p.x + rx * hw - fx * 0.2, y1, p.z + rz * hw - fz * 0.2, p.x - rx * hw - fx * 0.2, y1, p.z - rz * hw - fz * 0.2);
        uv.push(slot.u0, slot.v0, slot.u1, slot.v0, slot.u1, slot.v1, slot.u0, slot.v1);
        idxBack.push(base + 4, base + 6, base + 5, base + 4, base + 7, base + 6);
        y = y1 + 0.03;
      }
      quat.identity();
      m4.compose(new THREE.Vector3(p.x, p.y - 0.3, p.z), quat, new THREE.Vector3(1, y - p.y + 0.3, 1));
      postMesh.setMatrixAt(pi, m4);
    });
    postMesh.instanceMatrix.needsUpdate = true;
    postMesh.computeBoundingSphere();
    group.add(postMesh);
    const g = new THREE.BufferGeometry();
    // tile-relative positions keep float precision
    const rel = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      rel[i] = pos[i] - cx;
      rel[i + 1] = pos[i + 1] - yBase;
      rel[i + 2] = pos[i + 2] - cz;
    }
    g.setAttribute('position', new THREE.BufferAttribute(rel, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx.concat(idxBack));
    g.addGroup(0, idx.length, 0);
    g.addGroup(idx.length, idxBack.length, 1);
    g.computeBoundingSphere();
    const plates = new THREE.Mesh(g, [this.material, this.backMaterial]);
    plates.position.set(cx, yBase, cz);
    plates.updateMatrix();
    plates.matrixAutoUpdate = false;
    plates.name = 'signs';
    group.add(plates);
    this.groupCodes.set(group, [...used]);
    return { group, disposables: [g, postMesh] };
  }

  remove(tile: LoadedTile): void {
    const group = this.perTile.get(tile.key);
    if (group) this.release(group);
    this.perTile.delete(tile.key);
  }

  /**
   * A group of posts made by `build` is gone: the signs it showed may be
   * drawn over in the atlas once no other group shows them (a group never
   * released keeps its signs there).
   */
  release(group: THREE.Object3D): void {
    const codes = this.groupCodes.get(group);
    if (!codes) return;
    this.groupCodes.delete(group);
    this.gone++;
    for (const c of codes) {
      const s = this.slots.get(c);
      if (s && s.users > 0) {
        s.users--;
        s.last = this.gone;
      }
    }
  }
}
