// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A change to the road network as a small diff over the published one
 * (world/netfile.ts) – so a map part can carry a network change without
 * shipping the whole ~10 MB net (the width corrections of 2026-11-20: 66
 * `wayKind` records and 375 `across` values against 570 996 and 1 002 713).
 *
 * Why a diff and not the file: the net is one file for the whole region, while
 * a part holds 500 m tiles – a whole-file replacement would put ~10 MB in every
 * part that declares it, and two parts could each claim a different net with no
 * way to say which wins.  A diff is ~2 KB for a correction like that.
 *
 * A diff is only safe where the net has the **same structure**: same edges in
 * the same order, same ways, same turns.  A structural change (a road added,
 * re-routed, split) shifts every later index, so an index diff would list
 * nearly every entry – or worse, apply values to the wrong roads.  So a diff
 * carries a **fingerprint** of the structure it was made against, and
 * `applyNetDiff` refuses to apply it to a base whose fingerprint differs
 * (the caller then falls back to the whole file).
 *
 *   { v: 1, kind: 'netdiff', edges, ways, hash, set: { wayKind: [[i, v]…], across: [[i, v]…] } }
 */
import { packNet, unpackNet, type NetData } from './netfile.ts';

/** The arrays whose *values* a correction may change (never their length or order). */
const VALUE_SECTIONS = ['wayKind', 'waySpeed', 'turn', 'across', 'edgeCls'] as const;
type ValueSection = (typeof VALUE_SECTIONS)[number];

/** The arrays that make up the structure: their lengths and order must match. */
const STRUCTURE_SECTIONS = ['edgeA', 'edgeB', 'first', 'to', 'polyFirst'] as const;

/** A list of (index, value) pairs – the changed entries of one array. */
export type Changes = Partial<Record<ValueSection, Array<[number, number]>>>;

/** A network diff as it is stored in a part. */
export interface NetDiff {
  v: 1;
  kind: 'netdiff';
  /** the number of edges of the net it was made against */
  edges: number;
  /** a fingerprint of the structure (see fingerprint) – must match the base to apply */
  hash: string;
  /** the changed entries, per array */
  set: Changes;
}

/** A small string hash of the structure: lengths + a rolling sum of the positional arrays. */
export function fingerprint(d: NetData): string {
  let h = 2166136261; // FNV-1a
  const mix = (n: number): void => {
    h ^= n >>> 0;
    h = Math.imul(h, 16777619);
  };
  mix(d.edgeA.length);
  mix(d.first.length);
  mix(d.to.length);
  mix(d.polyFirst.length);
  for (const name of STRUCTURE_SECTIONS) {
    const a = d[name] as unknown as ArrayLike<number>;
    mix(a.length);
    // a stride, so a 1M-entry array is not walked in full but still differs when one entry moves
    const stride = Math.max(1, Math.floor(a.length / 4096));
    for (let i = 0; i < a.length; i += stride) mix(a[i]);
  }
  return (h >>> 0).toString(16);
}

/** Is `diff` made against the structure of `base`? */
export function matchesFingerprint(base: NetData, diff: NetDiff): boolean {
  return diff.edges === base.edgeA.length && diff.hash === fingerprint(base);
}

/**
 * The diff of `neu` against `base`: only the entries of the value sections
 * that differ.  Structural differences are not expressible this way – the
 * caller compares `fingerprint` first and ships the whole file instead.
 */
export function netDiff(base: NetData, neu: NetData): NetDiff {
  const set: Changes = {};
  for (const name of VALUE_SECTIONS) {
    const a = base[name] as unknown as ArrayLike<number>;
    const b = neu[name] as unknown as ArrayLike<number>;
    if (a.length !== b.length) throw new Error(`netDiff: "${name}" changed length (${a.length} → ${b.length}) – not a value correction`);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) pairs.push([i, b[i]]);
    if (pairs.length > 0) set[name] = pairs;
  }
  return { v: 1, kind: 'netdiff', edges: neu.edgeA.length, hash: fingerprint(base), set };
}

/**
 * The net of `base` with `diff` applied: a copy of every section, the value
 * sections overwritten at the changed indices.  Throws when the diff was made
 * against another structure (never applies values to the wrong roads).
 */
export function applyNetDiff(base: NetData, diff: NetDiff): NetData {
  if (diff.v !== 1 || diff.kind !== 'netdiff') throw new Error('applyNetDiff: not a network diff');
  if (!matchesFingerprint(base, diff)) throw new Error('applyNetDiff: the diff was made against another network');
  // a shallow copy: every section the same array, the changed ones replaced below
  const out = { ...base } as unknown as Record<string, unknown>;
  for (const [name, pairs] of Object.entries(diff.set)) {
    if (!VALUE_SECTIONS.includes(name as ValueSection)) throw new Error(`applyNetDiff: "${name}" is not a value section`);
    const src = base[name as keyof NetData] as unknown as ArrayLike<number>;
    // copy in the section's own type, so a Uint8 stays a Uint8, a Uint16 a Uint16
    const copy = Array.from(src);
    for (const [i, v] of pairs) {
      if (i < 0 || i >= copy.length) throw new Error(`applyNetDiff: "${name}[${i}]" is out of range`);
      copy[i] = v;
    }
    out[name] = fromArray(name, copy);
  }
  return out as unknown as NetData;
}

/** The typed array a section of the net is stored as (its type comes from the base). */
function fromArray(name: string, values: number[]): Uint8Array {
  switch (name) {
    case 'wayKind':
    case 'waySpeed':
    case 'turn':
    case 'edgeCls':
      return Uint8Array.from(values);
    case 'across':
      return Uint16Array.from(values) as unknown as Uint8Array;
    default:
      return Uint8Array.from(values);
  }
}

/** Pack a diff for a part (the bytes a part stores). */
export function packNetDiff(diff: NetDiff): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(diff));
}

/** Read a diff out of a part's bytes; null when it is not one. */
export function unpackNetDiff(bytes: Uint8Array): NetDiff | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as NetDiff;
    return o && o.v === 1 && o.kind === 'netdiff' && typeof o.hash === 'string' && typeof o.set === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** (kept for the caller that ships a whole file when the structure differs) */
export { packNet, unpackNet };
