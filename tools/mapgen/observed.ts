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
}

interface ObservedJson {
  buildings: Array<{ id: string; wall?: string; roof?: string; material?: string; note?: string }>;
}

const MATERIALS: Record<string, number> = { brick: BS.WALL_BRICK, render: BS.WALL_HOUSE, plain: BS.WALL_PLAIN };

/** "#b4583e" → [180, 88, 62]; anything else: undefined */
export function rgbOf(s: string | undefined): RGB | undefined {
  const m = s ? /^#([0-9a-f]{6})$/i.exec(s) : null;
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The list read (from `file`, or the one next to this module): building id → what was seen. */
export function loadObserved(file = fileURLToPath(new URL('./observed-buildings.json', import.meta.url))): Map<string, Observed> {
  const out = new Map<string, Observed>();
  if (!existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedJson;
  for (const b of j.buildings ?? []) {
    if (!b || typeof b.id !== 'string') continue;
    const style = b.material ? MATERIALS[b.material] : undefined;
    out.set(b.id, { wall: rgbOf(b.wall), roof: rgbOf(b.roof), style });
  }
  return out;
}

/** Trees seen on site (tools/mapgen/observed-trees.json): position and height. */
export function loadObservedTrees(file = fileURLToPath(new URL('./observed-trees.json', import.meta.url))): Array<{ x: number; z: number; h: number }> {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8')) as { trees?: Array<{ x: number; z: number; h: number }> };
  return (j.trees ?? []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.z) && Number.isFinite(t.h));
}
