// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The players' photos and 360° panoramas on the server (server/PROTOCOL.md,
 * "Images"): uploading one from the device – where it was taken from its
 * own EXIF GPS position (read here, in the browser: reality/imagemeta.ts),
 * else from the game or a place picked on the map –, with a small preview
 * made here; and those near a place, for the big map's layer and the
 * reality view.  The server strips the metadata from what it stores.
 */
import { readImageMeta, looksLikePanorama } from '../reality/imagemeta.ts';
import type { ImageMeta } from '../reality/imagemeta.ts';
import { ServerError, backoff } from './client.ts';
import type { ServerClient } from './client.ts';

export type ImageKind = 'photo' | 'pano360';

/** An image as the server lists it. */
export interface ServerImage {
  id: string;
  lat: number;
  lon: number;
  /** compass degrees, NaN unknown */
  heading: number;
  pitch: number;
  kind: ImageKind;
  /** ISO, '' unknown */
  taken: string;
  title: string;
  visibility: 'private' | 'public';
  /** the uploader's account id and name */
  owner: string;
  ownerName: string;
  created: string;
  width: number;
  height: number;
  /** a preview was uploaded with it (else the file itself serves as one) */
  hasThumb: boolean;
}

export interface UploadMeta {
  lat: number;
  lon: number;
  heading?: number;
  pitch?: number;
  kind: ImageKind;
  taken?: string;
  title?: string;
  visibility: 'private' | 'public';
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const fin = (v: unknown, d = NaN): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function parseImage(j: unknown): ServerImage | null {
  const o = (j && typeof j === 'object' && 'image' in j ? (j as { image: unknown }).image : j) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.id === undefined) return null;
  const lat = fin(o.lat);
  const lon = fin(o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const owner = o.owner && typeof o.owner === 'object' ? (o.owner as { id?: unknown; name?: unknown }) : null;
  return {
    id: String(o.id),
    lat,
    lon,
    heading: fin(o.heading),
    pitch: fin(o.pitch, 0),
    kind: o.kind === 'pano360' ? 'pano360' : 'photo',
    taken: typeof o.taken === 'string' ? o.taken : '',
    title: typeof o.title === 'string' ? o.title.slice(0, 120) : '',
    visibility: o.visibility === 'public' ? 'public' : 'private',
    owner: String(owner ? (owner.id ?? '') : (o.owner ?? o.account ?? '')),
    ownerName: String(owner ? (owner.name ?? '') : (o.ownerName ?? '')),
    created: typeof o.created === 'string' ? o.created : '',
    width: fin(o.width, 0),
    height: fin(o.height, 0),
    hasThumb: o.thumb !== null,
  };
}

/** Is the picture a 2:1 panorama, as the server asks of a pano360 (a pixel of tolerance)? */
export function twoToOne(w: number, h: number): boolean {
  return w > 0 && h > 0 && Math.abs(w - 2 * h) <= 2;
}

/** What the file says of itself (position, direction, time, panorama?), from its first 512 kB. */
export async function fileMeta(file: Blob): Promise<ImageMeta> {
  const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  return readImageMeta(head);
}

/** The kind a file is to be uploaded as: a panorama when its metadata says so, or it is 2:1 and wide. */
export function kindOf(meta: Pick<ImageMeta, 'pano' | 'width' | 'height'>): ImageKind {
  return looksLikePanorama(meta) && twoToOne(meta.width, meta.height) ? 'pano360' : 'photo';
}

/** The checks before an upload: null if fine, else the key of the text saying what is wrong. */
export function checkUpload(file: { type: string; size: number }, meta: UploadMeta, maxBytes: number, size: { width: number; height: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'net.imgBadType';
  if (maxBytes > 0 && file.size > maxBytes) return 'net.imgTooBig';
  if (!(Math.abs(meta.lat) <= 90 && Math.abs(meta.lon) <= 180)) return 'net.imgNoPlace';
  if (meta.kind === 'pano360' && size.width > 0 && !twoToOne(size.width, size.height)) return 'net.imgNot21';
  return null;
}

/** A small JPEG preview (longest side `max` px) made in the browser – and the picture's size. */
export async function makeThumb(file: Blob, max = 320): Promise<{ thumb: Blob | null; width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d');
    if (!g) return { thumb: null, width: bmp.width, height: bmp.height };
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    const thumb = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return { thumb, ...size };
  } catch {
    return { thumb: null, width: 0, height: 0 };
  }
}

/** Upload: the file, its meta – and the preview as a part `thumb` (a server that makes its own ignores it). */
export async function uploadImage(c: ServerClient, file: Blob, meta: UploadMeta, thumb: Blob | null): Promise<ServerImage | null> {
  const form = new FormData();
  const m: Record<string, unknown> = { lat: meta.lat, lon: meta.lon, kind: meta.kind, visibility: meta.visibility };
  if (meta.heading !== undefined && Number.isFinite(meta.heading)) m.heading = Math.round(meta.heading * 10) / 10;
  if (meta.pitch !== undefined && Number.isFinite(meta.pitch)) m.pitch = meta.pitch;
  if (meta.taken) m.taken = meta.taken;
  if (meta.title) m.title = meta.title.slice(0, 120);
  form.append('meta', JSON.stringify(m));
  form.append('file', file, (file as File).name || 'image');
  if (thumb) form.append('thumb', thumb, 'thumb.jpg');
  // (503: the server is busy with other uploads – again after a pause, twice)
  for (let n = 0; ; n++) {
    try {
      return parseImage(await c.request('POST', '/images', undefined, { form, timeout: 180_000 }));
    } catch (e) {
      if (!(e instanceof ServerError) || e.status !== 503 || n >= 2) throw e;
      await new Promise((r) => setTimeout(r, backoff(n + 1)));
    }
  }
}

export async function listImages(c: ServerClient, bbox: [number, number, number, number], kind?: ImageKind): Promise<ServerImage[]> {
  const q = `bbox=${bbox.map((v) => v.toFixed(5)).join(',')}${kind ? `&kind=${kind}` : ''}`;
  const r = await c.request('GET', `/images?${q}`, undefined, { retries: 1 });
  const list = Array.isArray(r) ? r : (r as { images?: unknown })?.images;
  return Array.isArray(list) ? list.map(parseImage).filter((i): i is ServerImage => i !== null) : [];
}

export async function deleteImage(c: ServerClient, id: string): Promise<void> {
  await c.request('DELETE', `/images/${encodeURIComponent(id)}`);
}

export async function patchImage(c: ServerClient, id: string, p: Partial<Pick<UploadMeta, 'title' | 'visibility' | 'heading'>>): Promise<void> {
  await c.request('PATCH', `/images/${encodeURIComponent(id)}`, p);
}

/**
 * The pictures' bytes as addresses an <img> can show: a public one straight
 * from the server; a private one fetched with the token (an <img> cannot send
 * it) and kept as a blob: address while the page is open.
 */
export class ImageUrls {
  private readonly c: ServerClient;
  private readonly blobs = new Map<string, Promise<string>>();
  constructor(c: ServerClient) {
    this.c = c;
  }

  url(img: ServerImage, want: 'file' | 'thumb'): Promise<string> {
    const part = want === 'thumb' && !img.hasThumb ? 'file' : want;
    const path = `/images/${encodeURIComponent(img.id)}/${part}`;
    if (img.visibility === 'public') return Promise.resolve(this.c.href(path));
    const key = `${img.id}/${part}`;
    let p = this.blobs.get(key);
    if (!p) {
      p = this.c.request<Blob>('GET', path, undefined, { blob: true, retries: 1, timeout: 120_000 }).then((b) => URL.createObjectURL(b));
      p.catch(() => this.blobs.delete(key));
      this.blobs.set(key, p);
    }
    return p;
  }

  forget(id: string): void {
    for (const part of ['file', 'thumb']) {
      const p = this.blobs.get(`${id}/${part}`);
      if (p) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      this.blobs.delete(`${id}/${part}`);
    }
  }
}

/**
 * The pictures round a place, fetched by squares of `CELL` degrees (once per
 * a few minutes each) – for the map layer and the reality view.
 */
export class ImageCache {
  private readonly c: ServerClient;
  private readonly cells = new Map<string, number>();
  private readonly byId = new Map<string, ServerImage>();
  private busy = 0;
  /** called when new pictures came */
  onChange: () => void = () => {};
  static readonly CELL = 0.05;
  constructor(c: ServerClient) {
    this.c = c;
  }

  get all(): Iterable<ServerImage> {
    return this.byId.values();
  }

  get(id: string): ServerImage | undefined {
    return this.byId.get(id);
  }

  add(img: ServerImage): void {
    this.byId.set(img.id, img);
    this.onChange();
  }

  remove(id: string): void {
    this.byId.delete(id);
    this.onChange();
  }

  clear(): void {
    this.cells.clear();
    this.byId.clear();
    this.onChange();
  }

  /** Make sure the area is fetched (at most 9 squares per call, 2 requests at a time). */
  want(west: number, south: number, east: number, north: number, now = Date.now()): void {
    if (!this.c.has('images')) return;
    const C = ImageCache.CELL;
    const x0 = Math.floor(west / C);
    const x1 = Math.floor(east / C);
    const y0 = Math.floor(south / C);
    const y1 = Math.floor(north / C);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}|${y}`;
        const t = this.cells.get(key);
        if (t !== undefined && now - t < 180_000) continue;
        if (this.busy >= 2) return;
        this.cells.set(key, now);
        this.busy++;
        listImages(this.c, [x * C, y * C, (x + 1) * C, (y + 1) * C])
          .then((list) => {
            for (const i of list) this.byId.set(i.id, i);
            if (list.length > 0) this.onChange();
          })
          .catch(() => this.cells.delete(key))
          .finally(() => this.busy--);
      }
    }
  }

  /** Those within `r` metres of a place. */
  near(lat: number, lon: number, r: number): ServerImage[] {
    const out: ServerImage[] = [];
    const k = Math.cos((lat * Math.PI) / 180);
    for (const i of this.byId.values()) {
      const d = Math.hypot((i.lat - lat) * 111320, (i.lon - lon) * 111320 * k);
      if (d <= r) out.push(i);
    }
    return out;
  }
}
