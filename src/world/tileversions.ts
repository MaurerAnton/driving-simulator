// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The kinds a map part (map-assets/*.tar) can be, and the version of a tile
 * among them – the developer mode's model (settings: devMap).
 *
 * A part is one build of some tiles.  Its `type` (in map-assets/index.json)
 * says what kind of build it is:
 *
 *   base       the tiles as the first release had them
 *   modified   a stable patch – what the game loads by default
 *   unstable   a test build, to try against the stable one
 *
 * The two "latest" kinds are not stored anywhere: they are the newest part of
 * a class, worked out from the list (modifiedLatest, unstableLatest).  So a
 * tile has these versions, in order:
 *
 *   base  <  modified …  <  modified-latest-stable   (the default)  <  unstable …  <  unstable-latest
 */

/** What kind of build a part is. */
export type PatchType = 'base' | 'modified' | 'unstable';

/** The version of a tile as the developer chooses it: a part, or the newest of a class. */
export type VersionChoice = number | 'modified-latest-stable' | 'unstable-latest';

/**
 * The kind a part's `type` names.  Unknown or absent: 'modified' – a stable
 * patch, the same as the game loads today.  A few spellings are accepted so a
 * hand-written index need not be exact.
 */
export function parsePatchType(type: string | undefined | null): PatchType {
  const t = (type ?? '').trim().toLowerCase();
  if (t === 'base' || t === 'b' || t === 'original') return 'base';
  if (t === 'unstable' || t === 'dev' || t === 'test' || t === 'experimental') return 'unstable';
  // 'modified', 'stable', 'patch', 'release', '' and anything unknown
  return 'modified';
}

/** One file of map-assets/index.json. */
export interface PartFile {
  /** its number, and the file to fetch (the index decides the name) */
  n: number;
  file: string;
  /** what kind of build it is */
  type: PatchType;
  /** how its entries are stored (a codec of world/tarcodecs.ts) */
  codec?: string;
  /** the tiles it holds (the keys of the 500 m grid, "412_398") */
  tiles?: string[];
  /**
   * map files other than tiles it holds, by their path in the map
   * ("net.bin.gz", "w/50_49.json.gz") – a network change goes with its tiles,
   * so that geometry and driving logic reach the player as one build
   * (world/netdiff.ts for the net, which travels as a diff).
   */
  maps?: string[];
}

/** The index of map-assets: what exists, what is newest, how each is stored. */
export interface PartIndex {
  /** the newest part, whatever its type */
  latest: number;
  files: PartFile[];
}

/** A part as the game holds it: its number, its kind, and whether it is loaded now. */
export interface PartVersion extends PartFile {
  /** the tile keys it holds */
  tiles: string[];
}

/** The index the game reads: nothing but the newest number and the files. */
export function parseIndex(json: unknown): PartIndex | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as { latest?: unknown; files?: unknown };
  if (!Array.isArray(o.files)) return null;
  const files: PartFile[] = [];
  for (const f of o.files) {
    if (typeof f !== 'object' || f === null) continue;
    const e = f as { n?: unknown; file?: unknown; type?: unknown; codec?: unknown; tiles?: unknown };
    const n = typeof e.n === 'number' ? e.n : Number(e.n);
    const file = typeof e.file === 'string' ? e.file : undefined;
    if (!Number.isFinite(n) || !file) continue;
    const e2 = e as { maps?: unknown };
    files.push({
      n,
      file,
      type: parsePatchType(typeof e.type === 'string' ? e.type : undefined),
      codec: typeof e.codec === 'string' ? e.codec : undefined,
      tiles: Array.isArray(e.tiles) ? e.tiles.filter((t): t is string => typeof t === 'string') : [],
      maps: Array.isArray(e2.maps) ? e2.maps.filter((t): t is string => typeof t === 'string') : undefined,
    });
  }
  files.sort((a, b) => a.n - b.n);
  const latest = typeof o.latest === 'number' && Number.isFinite(o.latest) ? o.latest : files.length ? files[files.length - 1].n : 0;
  return { latest, files };
}

/** Every tile key any part holds – where the HUD offers the version list. */
export function versionedTiles(index: PartIndex): Set<string> {
  const out = new Set<string>();
  for (const f of index.files) for (const t of f.tiles ?? []) out.add(t);
  return out;
}

/** The parts of one kind, oldest first. */
export function ofKind(index: PartIndex, kind: PatchType): PartVersion[] {
  return index.files.filter((f) => f.type === kind).map((f) => ({ ...f, tiles: f.tiles ?? [] }));
}

/** The newest part of a kind, or null when there is none. */
export function latestOf(index: PartIndex, kind: PatchType): PartVersion | null {
  const list = ofKind(index, kind);
  return list.length ? list[list.length - 1] : null;
}

/** The newest stable patch – the one the game loads by default. */
export function modifiedLatest(index: PartIndex): PartVersion | null {
  return latestOf(index, 'modified');
}

/** The newest test build. */
export function unstableLatest(index: PartIndex): PartVersion | null {
  return latestOf(index, 'unstable');
}

/**
 * The list a version of a tile is chosen from, in the order they are shown:
 * base first, then the modified ones, then the unstable ones, each class with
 * its newest last – and every part that holds this tile.  The one loaded now
 * is marked.
 */
export function versionsOfTile(index: PartIndex, tile: string, loadedN: number | null): Array<PartVersion & { loaded: boolean; label: string }> {
  const order: PatchType[] = ['base', 'modified', 'unstable'];
  const out: Array<PartVersion & { loaded: boolean; label: string }> = [];
  for (const kind of order) {
    for (const f of ofKind(index, kind)) {
      if (!(f.tiles ?? []).includes(tile)) continue;
      out.push({ ...f, loaded: f.n === loadedN, label: kind === 'base' ? 'base' : kind === 'modified' ? `modified ${f.n}` : `unstable ${f.n}` });
    }
  }
  // the two derived slots, as choices beside the parts they stand for
  const m = modifiedLatest(index);
  if (m && (m.tiles ?? []).includes(tile)) out.push({ ...m, loaded: loadedN === m.n, label: 'modified-latest-stable' });
  const u = unstableLatest(index);
  if (u && (u.tiles ?? []).includes(tile)) out.push({ ...u, loaded: loadedN === u.n, label: 'unstable-latest' });
  return out;
}
