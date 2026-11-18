// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What was seen on site: for single buildings, the colour of their walls and
 * roof and what the walls are made of, where the official building models
 * (which have shape and height, but no colour) and the palettes the map
 * build picks from would show something else.
 *
 * The list is tools/mapgen/observed-buildings.json – by the identifier of
 * the building in the LoD2 models.  Only facts are kept (a colour, "brick"),
 * no pictures.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BS } from '../../src/world/tilefmt.ts';

type RGB = [number, number, number];

export interface Observed {
  wall?: RGB;
  roof?: RGB;
  /** the walls' face style instead of the one the building's use gives (BS) */
  style?: number;
  /** the roof is flat (the model's sloped roof is cut off at its eaves): "roofShape": "flat", or a green roof */
  flat?: boolean;
  /** where the flat roof lies between the model's eaves (0, the default) and its ridge (1): "flatAt" */
  flatAt?: number;
  /** the roof's face style (BS) from "roofMaterial" */
  roofStyle?: number;
}

/** a building seen on the aerial photographs that the models lack: its outline (world x, z), height and look */
export interface ObservedAdd {
  id: string;
  pts: Array<[number, number]>;
  /** to the eaves (m) */
  height: number;
  roof: 'flat' | 'gable' | 'hip';
  /** the ridge above the eaves (m; gable and hip roofs – without: by the building's width) */
  ridge?: number;
  wall?: RGB;
  roofColour?: RGB;
  roofStyle?: number;
}

interface ObservedJson {
  buildings: Array<{ id: string; wall?: string; roof?: string; material?: string; roofShape?: string; roofMaterial?: string; flatAt?: number; note?: string }>;
  add?: Array<{ id: string; pts: Array<[number, number]>; height: number; roof?: string; ridge?: number; wall?: string; roofColour?: string; roofMaterial?: string; note?: string }>;
  remove?: Array<string | { id: string; note?: string }>;
}

/** the colour of a green (planted) roof when the list gives none */
export const GREEN_ROOF = '#5f7a4a';

/** "roofMaterial": the roof's face style (green and gravel roofs are flat) */
const ROOF_MATERIALS: Record<string, number> = { green: BS.ROOF_FLAT, flat: BS.ROOF_FLAT, gravel: BS.ROOF_FLAT, metal: BS.ROOF_METAL, tiles: BS.ROOF_TILES };

const DEFAULT_FILE = (): string => fileURLToPath(new URL('./observed-buildings.json', import.meta.url));

const MATERIALS: Record<string, number> = { brick: BS.WALL_BRICK, render: BS.WALL_HOUSE, plain: BS.WALL_PLAIN };

/** "#b4583e" → [180, 88, 62]; anything else: undefined */
export function rgbOf(s: string | undefined): RGB | undefined {
  const m = s ? /^#([0-9a-f]{6})$/i.exec(s) : null;
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The list read (from `file`, or the one next to this module): building id → what was seen. */
export function loadObserved(file = DEFAULT_FILE()): Map<string, Observed> {
  const out = new Map<string, Observed>();
  if (!existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedJson;
  for (const b of j.buildings ?? []) {
    if (!b || typeof b.id !== 'string') continue;
    const style = b.material ? MATERIALS[b.material] : undefined;
    const green = b.roofMaterial === 'green';
    const roofStyle = b.roofMaterial ? ROOF_MATERIALS[b.roofMaterial] : undefined;
    out.set(b.id, { wall: rgbOf(b.wall), roof: rgbOf(b.roof) ?? (green ? rgbOf(GREEN_ROOF) : undefined), style, flat: b.roofShape === 'flat' || green || undefined, flatAt: Number.isFinite(b.flatAt) ? Math.max(0, Math.min(1, b.flatAt as number)) : undefined, roofStyle });
  }
  return out;
}

/**
 * Buildings to add and to leave out (the same list's "add" and "remove"):
 * where the official models are older than what stands (or show what is no
 * longer there).  "remove" takes the identifiers of LoD2 models, or "w<n>"
 * for an OpenStreetMap footprint.
 */
export function loadObservedEdits(file = DEFAULT_FILE()): { add: ObservedAdd[]; remove: Set<string> } {
  const add: ObservedAdd[] = [];
  const remove = new Set<string>();
  if (!existsSync(file)) return { add, remove };
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedJson;
  for (const a of j.add ?? []) {
    if (!a || typeof a.id !== 'string' || !Array.isArray(a.pts) || a.pts.length < 3 || !(a.height > 0)) continue;
    if (!a.pts.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue;
    const green = a.roofMaterial === 'green';
    const roof = a.roof === 'gable' || a.roof === 'hip' ? a.roof : 'flat';
    add.push({
      id: a.id,
      pts: a.pts.map((p) => [p[0], p[1]] as [number, number]),
      height: a.height,
      roof: green ? 'flat' : roof,
      ridge: Number.isFinite(a.ridge) ? a.ridge : undefined,
      wall: rgbOf(a.wall),
      roofColour: rgbOf(a.roofColour) ?? (green ? rgbOf(GREEN_ROOF) : undefined),
      roofStyle: a.roofMaterial ? ROOF_MATERIALS[a.roofMaterial] : undefined,
    });
  }
  for (const r of j.remove ?? []) {
    const id = typeof r === 'string' ? r : r?.id;
    if (typeof id === 'string') remove.add(id);
  }
  return { add, remove };
}

/** Trees seen on site (tools/mapgen/observed-trees.json): position and height. */
export function loadObservedTrees(file = fileURLToPath(new URL('./observed-trees.json', import.meta.url))): Array<{ x: number; z: number; h: number }> {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8')) as { trees?: Array<{ x: number; z: number; h: number }> };
  return (j.trees ?? []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.z) && Number.isFinite(t.h));
}
