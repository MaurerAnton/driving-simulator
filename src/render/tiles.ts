// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Streams map tiles around the viewer and turns them into three.js objects:
 * terrain (with ground-cover texture and 3 detail levels), road surfaces,
 * paint, structures and buildings.  Also answers terrain height queries for
 * the physics.
 */
import * as THREE from 'three';
import { COVER_COLORS } from '../world/cover.ts';
import type { TileGrid } from '../world/loader.ts';
import { POS_XZ_SCALE, POS_Y_SCALE, tileKey, unpackTile } from '../world/tilefmt.ts';
import type { SectionArray, TileHeader, UnpackedTile } from '../world/tilefmt.ts';
import { makeBuildingMaterial, makeGroundMaterial, makeStructMaterial, makeTerrainMaterial } from './materials.ts';

export interface LoadedTile {
  key: string;
  header: TileHeader;
  group: THREE.Group;
  /** terrain heights in metres (terrainN × terrainN), absolute */
  heights: Float32Array;
  /** ground-cover raster (coverN × coverN) */
  cover: Uint8Array;
  data: UnpackedTile;
  disposables: Array<{ dispose(): void }>;
}

const COVER_RGB = COVER_COLORS.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);

async function fetchTile(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // gzip (unless the server already inflated it for us)
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }
  return buf;
}

export type TileListener = (tile: LoadedTile, loaded: boolean) => void;

export class TileManager {
  readonly group = new THREE.Group();
  readonly tiles = new Map<string, LoadedTile>();
  private readonly loading = new Set<string>();
  /** tiles that could not be fetched: how often it was tried, and when last (they are asked for again a few times) */
  private readonly failed = new Map<string, { n: number; at: number }>();
  /** where the tiles lie and which there are */
  private readonly grid: TileGrid;
  private readonly baseUrl: string;
  private readonly query: string;
  private readonly groundMat = makeGroundMaterial(false);
  private readonly paintMat = makeGroundMaterial(true);
  private readonly structMat = makeStructMaterial();
  private readonly bldgMat = makeBuildingMaterial();
  private readonly plainMat = makeBuildingMaterial(true);
  /** buildings with windows, doors and roof tiles (false: plain walls and roofs) */
  private facades = true;
  private readonly listeners: TileListener[] = [];
  /** tiles are kept within this distance (metres) of the viewer */
  viewRadius = 1400;

  /** Buildings with their windows, doors and roof tiles – or plain (graphics setting). */
  setFacades(on: boolean): void {
    if (on === this.facades) return;
    this.facades = on;
    const mat = on ? this.bldgMat : this.plainMat;
    this.group.traverse((o) => {
      if (o.name === 'bldg' && (o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat;
    });
  }
  maxConcurrent = 3;
  private wantCount = 0;

  /** `version`: which build of the map (see MapLoader.version) – part of the address of each tile */
  constructor(grid: TileGrid, baseUrl: string, version = '') {
    this.grid = grid;
    this.baseUrl = baseUrl;
    this.query = version ? `?v=${version}` : '';
    this.group.name = 'tiles';
  }

  onTile(l: TileListener): void {
    this.listeners.push(l);
  }

  /** True when every tile wanted for the current position has arrived. */
  get settled(): boolean {
    return this.loading.size === 0 && this.wantCount === 0;
  }

  /** the share of the tiles around the current position that are there (0 … 1: for a progress bar) */
  progress = 1;

  update(x: number, z: number): void {
    const { x0: minX, z0: minZ, size: tileSize } = this.grid;
    const r = this.viewRadius;
    const ix0 = Math.floor((x - r - minX) / tileSize);
    const ix1 = Math.floor((x + r - minX) / tileSize);
    const iz0 = Math.floor((z - r - minZ) / tileSize);
    const iz1 = Math.floor((z + r - minZ) / tileSize);
    const wanted: Array<{ key: string; d: number }> = [];
    const keep = new Set<string>();
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (!this.grid.has(ix, iz)) continue;
        const key = tileKey(ix, iz);
        const cx = minX + (ix + 0.5) * tileSize;
        const cz = minZ + (iz + 0.5) * tileSize;
        const d = Math.hypot(cx - x, cz - z);
        if (d > r + tileSize * 0.75) continue;
        keep.add(key);
        if (!this.tiles.has(key) && !this.loading.has(key) && this.mayLoad(key)) wanted.push({ key, d });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    this.wantCount = wanted.length;
    let have = 0;
    for (const key of keep) if (this.tiles.has(key)) have++;
    this.progress = keep.size > 0 ? have / keep.size : 1;
    for (const w of wanted) {
      if (this.loading.size >= this.maxConcurrent) break;
      this.wantCount--;
      void this.load(w.key);
    }
    for (const [key, tile] of this.tiles) {
      if (keep.has(key)) continue;
      const dx = tile.header.cx - x;
      const dz = tile.header.cz - z;
      if (Math.hypot(dx, dz) > r + tileSize * 1.6) this.unload(tile);
    }
  }

  /** May a tile be asked for (again)?  After a failure only after a while, and not for ever: a connection on the road comes and goes. */
  private mayLoad(key: string): boolean {
    const f = this.failed.get(key);
    return !f || (f.n < 5 && performance.now() - f.at > 1500 * 2 ** (f.n - 1));
  }

  private async load(key: string): Promise<void> {
    this.loading.add(key);
    try {
      const buf = await fetchTile(`${this.baseUrl}tiles/${key}.fsb${this.query}`);
      this.failed.delete(key);
      const data = unpackTile(buf);
      const tile = this.build(key, data);
      this.tiles.set(key, tile);
      this.group.add(tile.group);
      for (const l of this.listeners) l(tile, true);
    } catch (err) {
      console.warn('tile failed', key, err);
      this.failed.set(key, { n: (this.failed.get(key)?.n ?? 0) + 1, at: performance.now() });
    } finally {
      this.loading.delete(key);
    }
  }

  private unload(tile: LoadedTile): void {
    for (const l of this.listeners) l(tile, false);
    this.group.remove(tile.group);
    for (const d of tile.disposables) d.dispose();
    this.tiles.delete(tile.key);
  }

  private build(key: string, data: UnpackedTile): LoadedTile {
    const h = data.header;
    const group = new THREE.Group();
    group.name = `tile ${key}`;
    const disposables: Array<{ dispose(): void }> = [];

    // ---- terrain ----------------------------------------------------------
    const n = h.terrainN;
    const hgt = data.get('hgt') as Uint16Array;
    const heights = new Float32Array(n * n);
    for (let i = 0; i < heights.length; i++) heights[i] = h.terrainMin + hgt[i] * h.terrainScale;
    const step = h.size / (n - 1);
    const half = h.size / 2;
    const skirtBase = n * n;
    const pos = new Float32Array((n * n + 4 * n) * 3);
    const nor = new Float32Array((n * n + 4 * n) * 3);
    const uv = new Float32Array((n * n + 4 * n) * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos[k * 3] = -half + i * step;
        pos[k * 3 + 1] = heights[k] - h.yBase;
        pos[k * 3 + 2] = -half + j * step;
        uv[k * 2] = i / (n - 1);
        uv[k * 2 + 1] = j / (n - 1);
        const hl = heights[j * n + Math.max(0, i - 1)];
        const hr = heights[j * n + Math.min(n - 1, i + 1)];
        const hu = heights[Math.max(0, j - 1) * n + i];
        const hd = heights[Math.min(n - 1, j + 1) * n + i];
        const sx = (i > 0 && i < n - 1 ? 2 : 1) * step;
        const sz = (j > 0 && j < n - 1 ? 2 : 1) * step;
        const nx = -(hr - hl) / sx;
        const nz = -(hd - hu) / sz;
        const l = Math.hypot(nx, 1, nz);
        nor[k * 3] = nx / l;
        nor[k * 3 + 1] = 1 / l;
        nor[k * 3 + 2] = nz / l;
      }
    }
    // skirt vertices (copies of the rim, pushed down) hide cracks between detail levels
    const rim = (side: number, t: number): number =>
      side === 0 ? t : side === 1 ? (n - 1) * n + t : side === 2 ? t * n : t * n + n - 1;
    for (let side = 0; side < 4; side++) {
      for (let t = 0; t < n; t++) {
        const src = rim(side, t);
        const dst = skirtBase + side * n + t;
        pos[dst * 3] = pos[src * 3];
        pos[dst * 3 + 1] = pos[src * 3 + 1] - 12;
        pos[dst * 3 + 2] = pos[src * 3 + 2];
        nor[dst * 3] = nor[src * 3];
        nor[dst * 3 + 1] = nor[src * 3 + 1];
        nor[dst * 3 + 2] = nor[src * 3 + 2];
        uv[dst * 2] = uv[src * 2];
        uv[dst * 2 + 1] = uv[src * 2 + 1];
      }
    }
    const posAttr = new THREE.BufferAttribute(pos, 3);
    const norAttr = new THREE.BufferAttribute(nor, 3);
    const uvAttr = new THREE.BufferAttribute(uv, 2);
    const indexFor = (stride: number): THREE.BufferAttribute => {
      const m = (n - 1) / stride;
      const idx: number[] = [];
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          const a = j * stride * n + i * stride;
          const b = a + stride;
          const c = a + stride * n;
          const d = c + stride;
          // diagonal b–c: must match TerrainGrid.at / heightAt
          idx.push(a, c, b, b, c, d);
        }
      }
      for (let side = 0; side < 4; side++) {
        for (let t = 0; t < n - 1; t += stride) {
          const a = rim(side, t);
          const b = rim(side, t + stride);
          const sa = skirtBase + side * n + t;
          const sb = skirtBase + side * n + t + stride;
          idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb); // both windings: visible from either side
        }
      }
      return new THREE.BufferAttribute(new Uint32Array(idx), 1);
    };
    const cov = data.get('cov') as Uint8Array;
    const cn = h.coverN;
    const tex = new Uint8Array(cn * cn * 4);
    for (let i = 0; i < cn * cn; i++) {
      const c = COVER_RGB[cov[i]] ?? COVER_RGB[0];
      tex[i * 4] = c[0];
      tex[i * 4 + 1] = c[1];
      tex[i * 4 + 2] = c[2];
      tex[i * 4 + 3] = 255;
    }
    const coverTex = new THREE.DataTexture(tex, cn, cn, THREE.RGBAFormat);
    coverTex.colorSpace = THREE.SRGBColorSpace;
    coverTex.magFilter = THREE.LinearFilter;
    coverTex.minFilter = THREE.LinearMipmapLinearFilter;
    coverTex.generateMipmaps = true;
    coverTex.needsUpdate = true;
    const terrainMat = makeTerrainMaterial(coverTex);
    disposables.push(coverTex, terrainMat);
    const lod = new THREE.LOD();
    const strides = (n - 1) % 4 === 0 ? [1, 2, 4] : [1];
    const dists = [0, 650, 1150];
    strides.forEach((stride, li) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr);
      g.setAttribute('normal', norAttr);
      g.setAttribute('uv', uvAttr);
      g.setIndex(indexFor(stride));
      g.computeBoundingSphere();
      disposables.push(g);
      const mesh = new THREE.Mesh(g, terrainMat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      lod.addLevel(mesh, dists[li]);
    });
    lod.position.set(h.cx, h.yBase, h.cz);
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    group.add(lod);

    // ---- indexed meshes ---------------------------------------------------
    const mesh = (name: string, mat: THREE.Material, setup?: (g: THREE.BufferGeometry) => void): THREE.Mesh | null => {
      const p = data.get(`${name}_pos`) as Int16Array | null;
      const idx = data.get(`${name}_idx`) as Uint16Array | Uint32Array | null;
      if (!p || !idx) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      setup?.(g);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      disposables.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.set(h.cx, h.yBase, h.cz);
      m.scale.set(POS_XZ_SCALE, POS_Y_SCALE, POS_XZ_SCALE);
      m.updateMatrix();
      m.matrixAutoUpdate = false;
      m.name = name;
      group.add(m);
      return m;
    };
    const a8 = (name: string): SectionArray | null => data.get(`${name}_a8`);
    const ground = mesh('ground', this.groundMat, (g) => {
      g.setAttribute('amat', new THREE.BufferAttribute(a8('ground') as Uint8Array, 1));
    });
    if (ground) ground.receiveShadow = true;
    const mark = mesh('mark', this.paintMat, (g) => {
      g.setAttribute('amat', new THREE.BufferAttribute(a8('mark') as Uint8Array, 1));
    });
    if (mark) mark.renderOrder = 1;
    const struct = mesh('struct', this.structMat, (g) => {
      g.setAttribute('color', new THREE.BufferAttribute(a8('struct') as Uint8Array, 3, true));
    });
    if (struct) {
      struct.castShadow = true;
      struct.receiveShadow = true;
    }
    const bldg = mesh('bldg', this.facades ? this.bldgMat : this.plainMat, (g) => {
      g.setAttribute('astyle', new THREE.BufferAttribute(a8('bldg') as Uint8Array, 4));
      g.setAttribute('auvd', new THREE.BufferAttribute(data.get('bldg_a16') as Int16Array, 4));
    });
    if (bldg) {
      bldg.castShadow = true;
      bldg.receiveShadow = true;
    }

    group.matrixAutoUpdate = false;
    return { key, header: h, group, heights, cover: cov, data, disposables };
  }

  /** Ground-cover class at a world position (COVER.MEADOW if the tile is not loaded). */
  coverAt(x: number, z: number): number {
    const { x0: minX, z0: minZ, size: tileSize } = this.grid;
    const ix = Math.floor((x - minX) / tileSize);
    const iz = Math.floor((z - minZ) / tileSize);
    const tile = this.tiles.get(tileKey(ix, iz));
    if (!tile) return 0;
    const cn = tile.header.coverN;
    const cov = tile.cover;
    const cx = Math.max(0, Math.min(cn - 1, Math.floor(((x - (minX + ix * tileSize)) / tileSize) * cn)));
    const cz = Math.max(0, Math.min(cn - 1, Math.floor(((z - (minZ + iz * tileSize)) / tileSize) * cn)));
    return cov[cz * cn + cx];
  }

  /** Terrain height at a world position, or NaN if that tile is not loaded. */
  heightAt(x: number, z: number): number {
    const { x0: minX, z0: minZ, size: tileSize } = this.grid;
    const ix = Math.floor((x - minX) / tileSize);
    const iz = Math.floor((z - minZ) / tileSize);
    const tile = this.tiles.get(tileKey(ix, iz));
    if (!tile) return NaN;
    const n = tile.header.terrainN;
    const step = tileSize / (n - 1);
    const fx = Math.max(0, Math.min(n - 1.0001, (x - (minX + ix * tileSize)) / step));
    const fz = Math.max(0, Math.min(n - 1.0001, (z - (minZ + iz * tileSize)) / step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const hh = tile.heights;
    const k = j * n + i;
    const h00 = hh[k];
    const h10 = hh[k + 1];
    const h01 = hh[k + n];
    const h11 = hh[k + n + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}
