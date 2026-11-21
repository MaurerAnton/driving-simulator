// SPDX-License-Identifier: AGPL-3.0-only
/** Rendering core shared by the game and the debug viewer. */
import * as THREE from 'three';
import { Sky } from '../render/sky.ts';
import { TileManager } from '../render/tiles.ts';
import { lightsOutBy } from '../sim/signals.ts';
import { MapLoader, type MapFiles } from '../world/loader.ts';
import { mapFetch, siteBytes, useMapPack } from '../world/mappack.ts';
import { applyNetDiff, unpackNetDiff } from '../world/netdiff.ts';
import { packNet, unpackNet } from '../world/netfile.ts';
import { regionFiles, type RegionSource } from '../world/regionfiles.ts';
import { loadSettings } from './settings.ts';

/** A region chosen to load instead of the site's own map: its files and its zone. */
export interface LoadedRegion {
  /** the region's id (its folder under map-assets/regions/) */
  id: string;
  /** how its files are had (from map-assets) */
  source: RegionSource;
  /** the UTM zone its coordinates are in */
  zone: number;
}

/** The bytes of a typed array as an ArrayBuffer (what the loader is handed). */
function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** gzip bytes to plain bytes (the map's files come gzipped). */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
import type { World } from '../world/world.ts';

/** the share of the traffic lights that are out of order on any one day */
const LIGHTS_OUT = 0.06;

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.08, 4500);
  readonly sky = new Sky();
  map!: MapLoader;
  world!: World;
  tiles!: TileManager;
  readonly baseUrl: string;
  pixelRatioCap = 1.5;
  /** fraction of the screen's pixels that is drawn (below 1: a softer picture that costs less) */
  renderScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.baseUrl = new URL('map/', document.baseURI).href;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    // shadows are switched by the light (see setShadows): the renderer is always ready for them
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.dome, this.sky.sun, this.sky.sun.target, this.sky.hemi);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async loadWorld(onProgress?: (text: string) => void, region?: LoadedRegion): Promise<void> {
    onProgress?.('world');
    // the map: in one piece, or an index with the road network in chunks around the car (world/loader.ts)
    const base = this.baseUrl;
    // (a map stored in this browser from files, if one is chosen: its files then come from there – world/mappack.ts)
    await useMapPack(loadSettings().mapPack, base);
    // (every file but the index is asked for with the version of the map the index names: see MapLoader.version)
    let version = '';
    // Some traffic lights are out of order – other ones every day.  (?lightsout=0.5 for more of them, 0 for none.)
    const asked = Number(new URLSearchParams(location.search).get('lightsout') ?? NaN);
    const share = Number.isFinite(asked) ? Math.max(0, Math.min(1, asked)) : LIGHTS_OUT;
    const today = new Date();
    const day = today.getFullYear() * 372 + today.getMonth() * 31 + today.getDate();
    // a region chosen (settings: region) comes from map-assets beside its tiles: its own
    // map.json/network, and its own origin sets the world frame (world/regionfiles.ts)
    const regionFilesMap: MapFiles | null = region ? regionFiles(region.id, region.source, region.zone) : null;
    this.map = await MapLoader.open({
      async bytes(path: string): Promise<ArrayBuffer | null> {
        if (regionFilesMap) return regionFilesMap.bytes(path);
        const res = await mapFetch(base + path + (version ? `?v=${version}` : ''), path === 'map.json' ? { cache: 'no-cache' } : undefined);
        // (not there: a 404 – or, from a development server, the start page in its place)
        if (res.status === 404 || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        let buf = await res.arrayBuffer();
        let head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
        // gzip (unless the server already inflated it for us)
        if (head[0] === 0x1f && head[1] === 0x8b) {
          buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
          head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
        }
        // the road network a part changed comes as a diff over the site's net (world/netdiff.ts):
        // read the base (bypassing the parts) and apply it, so geometry and driving logic match
        if (path === 'net.bin.gz') {
          const diff = unpackNetDiff(new Uint8Array(buf));
          if (diff) {
            const baseBytes = await siteBytes(base, 'net.bin.gz');
            if (baseBytes) {
              try {
                const inflated = await gunzip(baseBytes);
                const baseNet = unpackNet(toArrayBuffer(inflated));
                const net = packNet(applyNetDiff(baseNet, diff));
                return toArrayBuffer(net);
              } catch (e) {
                // the diff was made against another network: keep the site's net
                console.warn('[map] net diff not applied:', (e as Error).message);
              }
            }
          }
        }
        return buf;
      },
    }, { lightsOut: lightsOutBy(day, share) });
    // (a breath for the page between the big steps, so that the loading screen is drawn)
    await new Promise((r) => setTimeout(r));
    version = this.map.version;
    this.world = this.map.world;
    this.tiles = new TileManager(this.map.tiles, this.baseUrl, version);
    this.scene.add(this.tiles.group);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Shadows of the sun around the car: `mapSize` pixels square (0 = none)
   * for a box reaching `reach` metres from the car to every side.
   */
  setShadows(mapSize: number, reach: number): void {
    const sun = this.sky.sun;
    sun.castShadow = mapSize > 0;
    if (mapSize === 0) return;
    const cam = sun.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 60;
    cam.far = 640;
    cam.updateProjectionMatrix();
    if (sun.shadow.mapSize.x !== mapSize) {
      sun.shadow.mapSize.set(mapSize, mapSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // enough to keep surfaces from shadowing themselves, little enough to keep shadows attached to what casts them
    const texel = (2 * reach) / mapSize;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = Math.max(0.05, texel * 1.6);
    sun.shadow.radius = 1.6;
  }

  render(focus: THREE.Vector3): void {
    this.sky.follow(this.camera, focus);
    this.renderer.render(this.scene, this.camera);
  }
}
