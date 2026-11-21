// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The files of a region, read as the loader reads a map's (world/loader.ts).
 *
 * A region's files live in map-assets beside the tiles that carry them:
 *
 *   map-assets/regions/<id>/map.json             the index: extent, places, spawns, tile/chunk sets
 *   map-assets/regions/<id>/net.bin.gz           every road of it in a few numbers
 *   map-assets/regions/<id>/w/<cx>_<cz>.json.gz  the road network in chunks
 *
 * They are fetched from raw.githubusercontent.com, which answers with a CORS
 * header (a release asset does not), through the same `PartSource` the parts
 * use (world/partcache.ts) – so a region needs no separate delivery path.
 *
 * This is a `MapFiles`: the loader asks for `map.json`, then `w/…` and
 * `net.bin.gz` by path, and the paths are the ones inside the region's folder.
 *
 * The world frame is NOT set here.  Every region – Germany and abroad alike –
 * was built in one shared frame: origin E 528000 / N 5678000, UTM zone 32
 * (the site's own map; geo/utm.ts).  Bremen sits at z ≈ −215000, Rethel at
 * x ≈ −363500, all in that one frame, so the default frame serves them all and
 * a region loads with it as the site's map does.
 */
import type { MapFiles } from './loader.ts';

/** How a file of map-assets is had (a part's source: world/partcache.ts). */
export type RegionSource = (file: string) => Promise<Uint8Array | null>;

/** The folder a region's files live in, relative to map-assets/. */
export function regionDir(id: string): string {
  return `regions/${id}`;
}

/** The path of a file inside a region's folder. */
export function regionPath(id: string, file: string): string {
  return `${regionDir(id)}/${file}`;
}

/** Gunzip a buffer that is gzipped (magic 1f 8b), else return it as it is. */
async function inflateIfGzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } catch {
      // (not gzip after all, or a broken stream: give the bytes as they are)
    }
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The loader's `MapFiles` for one region: every path asked for is read from the
 * region's folder.  The world frame is left as it is – every region was built
 * in the same shared frame (see the note above), so the default serves them.
 */
export function regionFiles(id: string, source: RegionSource): MapFiles {
  return {
    async bytes(path: string): Promise<ArrayBuffer | null> {
      const bytes = await source(regionPath(id, path));
      if (!bytes) return null;
      return inflateIfGzip(bytes);
    },
  };
}

/**
 * A source that fetches a region's files from map-assets at `base` (the site's
 * map folder, or the raw.githubusercontent address of map-assets).  A file that
 * is not there is null (the loader treats it as missing).
 */
export function regionFetchSource(base: string, fetchFn: typeof fetch = fetch): RegionSource {
  const root = base.endsWith('/') ? base : `${base}/`;
  return async (file) => {
    try {
      const res = await fetchFn(`${root}${file}`);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
}

/** Where a region's files are had from: the repository over raw.githubusercontent (CORS ok), or the site. */
export interface RegionFetch {
  /** the repository that holds map-assets (owner/repo) */
  repo: string;
  /** the branch (raw serves it) */
  ref: string;
  /** the folder of map-assets in that repository */
  dir: string;
}

/**
 * The source for a region's files: from the repository over raw.githubusercontent
 * (the CORS-safe path the parts already use), or from the site when there is no
 * repository (a local build, `npm run map:fetch`).
 */
export function regionSourceFor(fetchOpt: RegionFetch | null, siteBase: string, fetchFn: typeof fetch = fetch): RegionSource {
  if (fetchOpt) {
    const root = `https://raw.githubusercontent.com/${fetchOpt.repo}/${fetchOpt.ref}/${fetchOpt.dir.replace(/\/+$/, '')}/`;
    return regionFetchSource(root, fetchFn);
  }
  return regionFetchSource(siteBase, fetchFn);
}
