// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic signs.  The official sign graphics (public-domain SVGs, bundled in
 * public/signs/signs.json) are rasterised into one texture atlas on demand;
 * town signs carry generated text.  Signs without a graphic fall back to a
 * simple procedural rendering, so the game never shows a blank plate.
 */
import * as THREE from 'three';
import type { SignPost } from '../world/tilefmt.ts';
import type { LoadedTile } from './tiles.ts';

const CELL = 256;
const COLS = 8;
const ROWS = 8;
const PAD = 6;

interface Slot {
  /** uv rectangle of the drawable area */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** width / height of the plate */
  aspect: number;
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
  if (n >= 1000) w = 0.6;
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
  private next = 1; // slot 0 is the plain grey back side
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

  private aspectOf(code: string): number {
    const base = code.split(':')[0];
    if (base === '310' || base === '311') return 1.5;
    const m = this.manifest[base];
    if (m && m.width > 0 && m.height > 0) return m.width / m.height;
    const n = Number.parseFloat(base);
    if (n >= 1000) return 1.82;
    if (n < 200 || base === '205' || base === '301') return 1.14;
    if (base.startsWith('325') || base.startsWith('330')) return 1.5;
    return 1;
  }

  private slot(code: string): Slot {
    let s = this.slots.get(code);
    if (s) return s;
    const aspect = this.aspectOf(code);
    const wide = aspect > 1.3;
    // wide plates take two cells so that text stays legible
    if (wide && this.next % COLS === COLS - 1) this.next++;
    const index = this.next;
    this.next += wide ? 2 : 1;
    if (this.next > COLS * ROWS) {
      // atlas full: reuse the back side rather than crash
      console.warn('sign atlas full, dropping', code);
      s = { u0: 0.01, v0: 0.01, u1: 0.02, v1: 0.02, aspect };
      this.slots.set(code, s);
      return s;
    }
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
    s = { u0: x / W, v0: 1 - (y + h) / H, u1: (x + w) / W, v1: 1 - y / H, aspect };
    this.slots.set(code, s);
    this.draw(code, x, y, w, h);
    return s;
  }

  private draw(code: string, x: number, y: number, w: number, h: number): void {
    const base = code.split(':')[0];
    const svg = this.svgs[base];
    if (svg && base !== '310' && base !== '311') {
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
      img.onload = () => {
        this.ctx.clearRect(x - 1, y - 1, w + 2, h + 2);
        this.ctx.drawImage(img, x, y, w, h);
        this.dirty = true;
      };
      img.onerror = () => {
        this.missing.add(base);
        this.fallback(code, x, y, w, h);
        this.dirty = true;
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      // draw the fallback right away; the SVG replaces it once decoded
      this.fallback(code, x, y, w, h);
    } else {
      if (base !== '310' && base !== '311') this.missing.add(base);
      this.fallback(code, x, y, w, h);
    }
    this.dirty = true;
  }

  /** Simple procedural rendering of the most important signs. */
  private fallback(code: string, x: number, y: number, w: number, h: number): void {
    const c = this.ctx;
    const [base, arg = ''] = code.split(':');
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
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const idxBack: number[] = [];
    const group = new THREE.Group();
    const postMesh = new THREE.InstancedMesh(this.postGeo, this.postMat, posts.length);
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
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
    const cx = tile.header.cx;
    const cz = tile.header.cz;
    const rel = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      rel[i] = pos[i] - cx;
      rel[i + 1] = pos[i + 1] - tile.header.yBase;
      rel[i + 2] = pos[i + 2] - cz;
    }
    g.setAttribute('position', new THREE.BufferAttribute(rel, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx.concat(idxBack));
    g.addGroup(0, idx.length, 0);
    g.addGroup(idx.length, idxBack.length, 1);
    g.computeBoundingSphere();
    const plates = new THREE.Mesh(g, [this.material, this.backMaterial]);
    plates.position.set(cx, tile.header.yBase, cz);
    plates.updateMatrix();
    plates.matrixAutoUpdate = false;
    plates.name = 'signs';
    group.add(plates);
    tile.group.add(group);
    tile.disposables.push(g, postMesh);
    this.perTile.set(tile.key, group);
  }

  remove(tile: LoadedTile): void {
    this.perTile.delete(tile.key);
  }
}
