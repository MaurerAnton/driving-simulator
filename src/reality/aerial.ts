// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Aerial photographs under the map: the official digital orthophotos of the
 * State of Hesse (DOP20, 20 cm per pixel), served by the land survey (HVBG)
 * as a WMS.  "Any use … is permitted without restriction or condition"
 * (§ 24 HVGG) – free data like the terrain and the buildings of the map.
 *
 * The service speaks the map's own coordinate system (ETRS89 / UTM 32N), so
 * a picture asked for by its corner coordinates lies exactly on the roads.
 * Pictures are fetched from the survey's server by the player's browser and
 * only after the player has switched them on: the server learns the IP
 * address and the area looked at.
 */

export const AERIAL_SOURCE = {
  /** what to call it (a name, not translated) */
  name: 'Luftbilder DOP20 – HVBG',
  attribution: 'Luftbilder: © Hessische Verwaltung für Bodenmanagement und Geoinformation',
  info: 'https://hvbg.hessen.de/landesvermessung/geotopographie/luftbilder/digitale-orthophotos',
  wms: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows',
  /** all orthophoto layers, the service picks the one for the scale */
  layer: 'he_dop_rgb',
};

/** edge of a tile in pixels */
export const AERIAL_TILE_PX = 512;
/** ground resolution of the finest level in metres per pixel (that of the photographs) */
const FINEST = 0.2;
/** coarsest level: one pixel is 0.2 m · 2^8 = 51.2 m, a tile is 26 km wide */
export const AERIAL_MAX_LEVEL = 8;

export interface AerialTile {
  level: number;
  /** column and row of the tile in the UTM grid of its level (east, north) */
  col: number;
  row: number;
  /** its square in UTM metres */
  minE: number;
  minN: number;
  size: number;
}

/** Ground size of a tile of a level in metres. */
export const aerialTileSize = (level: number): number => AERIAL_TILE_PX * FINEST * 2 ** level;

/**
 * The level whose pictures are just fine enough for a map drawn with
 * `pxPerMetre` device pixels per metre.
 */
export function aerialLevel(pxPerMetre: number): number {
  const want = 1 / Math.max(pxPerMetre, 1e-6); // metres per pixel on the screen
  return Math.min(AERIAL_MAX_LEVEL, Math.max(0, Math.floor(Math.log2(want / FINEST) + 0.35)));
}

/** The tiles of a level that cover a rectangle (UTM metres), row by row. */
export function aerialTiles(level: number, minE: number, minN: number, maxE: number, maxN: number): AerialTile[] {
  const size = aerialTileSize(level);
  const out: AerialTile[] = [];
  for (let row = Math.floor(minN / size); row * size < maxN; row++) {
    for (let col = Math.floor(minE / size); col * size < maxE; col++) out.push({ level, col, row, minE: col * size, minN: row * size, size });
  }
  return out;
}

/** The address of a tile's picture (WMS 1.3.0 GetMap; EPSG:25832 counts east, north). */
export function aerialUrl(t: AerialTile): string {
  const bbox = [t.minE, t.minN, t.minE + t.size, t.minN + t.size].map((v) => String(Math.round(v * 100) / 100)).join(',');
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: AERIAL_SOURCE.layer,
    STYLES: '',
    CRS: 'EPSG:25832',
    BBOX: bbox,
    WIDTH: String(AERIAL_TILE_PX),
    HEIGHT: String(AERIAL_TILE_PX),
    FORMAT: 'image/jpeg',
  });
  return `${AERIAL_SOURCE.wms}?${q.toString()}`;
}

export const aerialKey = (t: AerialTile): string => `${t.level}/${t.col}/${t.row}`;

/**
 * Fetches tiles when they are asked for and keeps the most recently used
 * ones.  `onLoad` is called whenever a picture has arrived (draw again).
 */
export class AerialCache {
  private readonly tiles = new Map<string, { img: HTMLImageElement; ready: boolean; failed: boolean; used: number }>();
  private loading = 0;
  private tick = 0;
  private readonly queue: AerialTile[] = [];
  private readonly onLoad: () => void;
  private readonly max: number;

  constructor(onLoad: () => void, max = 90) {
    this.onLoad = onLoad;
    this.max = max;
  }

  /** The picture of a tile if it is there; otherwise it is ordered. */
  get(t: AerialTile): HTMLImageElement | null {
    const key = aerialKey(t);
    const have = this.tiles.get(key);
    if (have) {
      have.used = ++this.tick;
      return have.ready ? have.img : null;
    }
    if (!this.queue.some((q) => aerialKey(q) === key)) this.queue.push(t);
    this.pump();
    return null;
  }

  /** Forget what was ordered but is no longer in view (called before a new picture of the map is drawn). */
  beginFrame(): void {
    this.queue.length = 0;
  }

  private pump(): void {
    // a few at a time: the server is a public service
    while (this.loading < 4 && this.queue.length > 0) {
      const t = this.queue.shift()!;
      const key = aerialKey(t);
      if (this.tiles.has(key)) continue;
      const img = new Image();
      const entry = { img, ready: false, failed: false, used: ++this.tick };
      this.tiles.set(key, entry);
      this.loading++;
      const done = (ok: boolean): void => {
        this.loading--;
        entry.ready = ok;
        entry.failed = !ok;
        this.trim();
        this.pump();
        if (ok) this.onLoad();
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      // nothing but the picture's address is sent: no cookies, no referrer
      img.referrerPolicy = 'no-referrer';
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = aerialUrl(t);
    }
  }

  private trim(): void {
    if (this.tiles.size <= this.max) return;
    const old = [...this.tiles.entries()].filter(([, v]) => v.ready || v.failed).sort((a, b) => a[1].used - b[1].used);
    for (const [key] of old.slice(0, this.tiles.size - this.max)) this.tiles.delete(key);
  }
}
