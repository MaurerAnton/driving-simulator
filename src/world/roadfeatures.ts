// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Small things built into a road that the wheels feel or the junction shape
 * follows:
 *
 * - traffic calming across the carriageway – raised tables with their ramps,
 *   speed humps, bumps and cushions (OpenStreetMap traffic_calming=…), stored
 *   with each road as EdgeJson.cm and lifting its carriageway (not its
 *   pavements) where they are: the physics (World.surfaceAt) and the road
 *   mesh of the map build (tools/mapgen/roadmesh.ts) use the same lift;
 * - mouths over a continuous pavement (EdgeJson.mk): a living street or a
 *   driveway that meets a road over a lowered kerb, with the pavement
 *   running on across it and no kerbed corner radii.
 */

/** traffic_calming=… across the carriageway (EdgeJson.cm kinds) */
export const CALM = { TABLE: 1, HUMP: 2, BUMP: 3, CUSHION: 4 } as const;

/** numbers per entry of EdgeJson.cm: station of the middle, CALM kind, length (a table: its flat top), height */
export const CALM_STRIDE = 4;

/** the ramp of a raised table (m along the road) */
export const TABLE_RAMP = 1.2;

/** Usual length and height of each kind (m), when the map says nothing. */
export const CALM_DEFAULTS: Readonly<Record<number, { len: number; h: number }>> = {
  [CALM.TABLE]: { len: 4, h: 0.08 },
  [CALM.HUMP]: { len: 3.7, h: 0.08 },
  [CALM.BUMP]: { len: 0.6, h: 0.06 },
  [CALM.CUSHION]: { len: 2.5, h: 0.06 },
};

/** The CALM kind of a traffic_calming value (0: not one across the carriageway). */
export function calmKind(v: string | undefined): number {
  switch (v) {
    case 'table':
    case 'raised_table':
      return CALM.TABLE;
    case 'hump':
      return CALM.HUMP;
    case 'bump':
      return CALM.BUMP;
    case 'cushion':
      return CALM.CUSHION;
    default:
      return 0;
  }
}

/** How far each entry reaches from its middle along the road (m). */
export function calmHalfLength(kind: number, len: number): number {
  return kind === CALM.TABLE ? len / 2 + TABLE_RAMP : len / 2;
}

/** What a road needs for the lift: its calming entries and where its junction areas begin. */
export interface CalmedRoad {
  calm: readonly number[] | null;
  len: number;
  cutA: number;
  cutB: number;
}

/**
 * Where the middle of entry `i` lies: as stored, but moved off the junction
 * areas (whose surface is the junction's plane) so that the whole of it lies
 * on the road between them.  NaN: no room.
 */
export function calmCentre(e: CalmedRoad, i: number): number {
  const c = e.calm!;
  const half = calmHalfLength(c[i + 1], c[i + 2]);
  const lo = e.cutA + half + 0.3;
  const hi = e.len - e.cutB - half - 0.3;
  if (lo > hi) return Number.NaN;
  return Math.min(hi, Math.max(lo, c[i]));
}

/** How much the carriageway is raised at station `s` (m; 0 almost everywhere). */
export function calmLift(e: CalmedRoad, s: number): number {
  const c = e.calm;
  if (!c) return 0;
  let lift = 0;
  for (let i = 0; i + CALM_STRIDE <= c.length; i += CALM_STRIDE) {
    const kind = c[i + 1];
    const len = c[i + 2];
    const h = c[i + 3];
    const half = calmHalfLength(kind, len);
    const mid = calmCentre(e, i);
    const d = Math.abs(s - mid);
    if (!(d < half)) continue;
    let y: number;
    if (kind === CALM.TABLE) y = d <= len / 2 ? h : h * (1 - (d - len / 2) / TABLE_RAMP);
    else {
      const k = Math.cos((Math.PI * d) / len);
      y = h * k * k;
    }
    if (y > lift) lift = y;
  }
  return lift;
}

/** The stations where the lift bends (for meshes that follow it): ramp feet and tops, and steps over humps. */
export function calmBreaks(e: CalmedRoad): number[] {
  const c = e.calm;
  if (!c) return [];
  const out: number[] = [];
  for (let i = 0; i + CALM_STRIDE <= c.length; i += CALM_STRIDE) {
    const mid = calmCentre(e, i);
    if (Number.isNaN(mid)) continue;
    const kind = c[i + 1];
    const len = c[i + 2];
    if (kind === CALM.TABLE) out.push(mid - len / 2 - TABLE_RAMP, mid - len / 2, mid + len / 2, mid + len / 2 + TABLE_RAMP);
    else {
      const n = Math.max(4, Math.ceil(len / 0.3));
      for (let k = 0; k <= n; k++) out.push(mid - len / 2 + (len * k) / n);
    }
  }
  return out.sort((p, q) => p - q);
}

/** What the mouth test needs of a junction arm. */
export interface MouthArm {
  edge: { mouth: number };
  node: { arms: ReadonlyArray<{ edge: { mouth: number } }> };
}

/**
 * Does this arm meet its junction over a continuous pavement (a lowered kerb
 * across its mouth, no kerbed corners)?  Where its road says so (EdgeJson.mk)
 * and at least two other roads that do not meet there in the same way go on
 * through the junction.
 */
export function flushMouth(arm: MouthArm): boolean {
  if (!arm.edge.mouth) return false;
  let through = 0;
  for (const a of arm.node.arms) if (a.edge !== arm.edge && !a.edge.mouth) through++;
  return through >= 2;
}
