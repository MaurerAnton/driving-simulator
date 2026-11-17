// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the town signs stand – Zeichen 310 (the yellow place-name sign where
 * a built-up area begins) and 311 (its back, crossed out, where it ends).
 *
 * The rules of the game take the speed limit of a road from whether it lies
 * inside a built-up area: 50 km/h inside, 100 outside.  Wherever the road a
 * driver is on changes from the one to the other, a town sign has to say so
 * – not only where one road goes on into the next, but also at a junction
 * where the town begins, and on the small roads that lead into a town.
 *
 * `townSignsAt` decides it for one junction from its arms: where the town
 * lies behind a single arm, the signs stand on that arm just beyond the
 * junction (310 for those who turn into it, 311 for those who come out of
 * it); where the junction lies in the town and only the country lies behind
 * single arms, they stand on those arms just before the junction – so that
 * nobody who drives through the town itself passes a sign that says the town
 * begins.  `townSignNear` keeps one sign where there is one already (one
 * mapped in OpenStreetMap, one the map build put up).
 *
 * Used by the map build (tools/mapgen/signs.ts) and by tools/build-signs.ts,
 * which adds what maps built before lack.
 */

/** An arm of a junction as the town signs see it. */
export interface TownArm {
  /** its road lies inside a built-up area (EF.URBAN) */
  urban: boolean;
  /** a road that counts: a road of the network with a limit by place (not a track, a car park, a living street, a motorway or a road for motor vehicles) */
  counts: boolean;
  /** a sign may stand on it: not a slip road, not a roundabout's ring */
  signable: boolean;
  /** vehicles come to the junction on it */
  approach: boolean;
  /** vehicles leave the junction on it */
  exit: boolean;
}

/** A town sign at a junction. */
export interface TownSignAt {
  /** the arm it stands on (index into the arms given) */
  arm: number;
  /** 'enter': Zeichen 310, for those who drive into the town – 'leave': 311 */
  kind: 'enter' | 'leave';
  /** 'away': beyond the junction, for traffic that has just left it on that arm – 'toward': before it, for traffic coming to it on that arm */
  side: 'away' | 'toward';
}

/** The town signs a junction needs (none where the town neither begins nor ends there). */
export function townSignsAt(arms: readonly TownArm[]): TownSignAt[] {
  const counted = arms.map((a, i) => ({ a, i })).filter(({ a }) => a.counts);
  const inside = counted.filter(({ a }) => a.urban);
  const outside = counted.filter(({ a }) => !a.urban);
  if (inside.length === 0 || outside.length === 0) return [];
  const out: TownSignAt[] = [];
  if (inside.length === 1 && inside[0].a.signable) {
    // the town lies behind its one arm: the signs stand on it, just beyond the junction
    const u = inside[0];
    if (u.a.exit && outside.some(({ a }) => a.approach)) out.push({ arm: u.i, kind: 'enter', side: 'away' });
    if (u.a.approach && outside.some(({ a }) => a.exit)) out.push({ arm: u.i, kind: 'leave', side: 'toward' });
    return out;
  }
  // The junction lies in the town (or the town's arm is a ring or a slip road): the signs stand on the
  // arms that lead out into the country, before the junction for those who come in on them.
  for (const r of outside) {
    if (!r.a.signable) continue;
    if (r.a.approach && inside.some(({ a }) => a.exit)) out.push({ arm: r.i, kind: 'enter', side: 'toward' });
    if (r.a.exit && inside.some(({ a }) => a.approach)) out.push({ arm: r.i, kind: 'leave', side: 'away' });
  }
  return out;
}

/** A town sign where it stands: its kind, its place, the way its plate faces (yaw, 0 = north, as the sign posts have it). */
export interface TownSignSpot {
  kind: 'enter' | 'leave';
  x: number;
  z: number;
  yaw: number;
}

/**
 * Is there a town sign for the same traffic near `s` already – facing the
 * same way within 60°, no more than 15 m beside the way that traffic goes
 * (the same road; one a little further off has signs of its own), and of the
 * same kind up to `reach` metres ahead or behind, of the other kind up to 60
 * m (there the map has decided the other way: no sign that says the
 * opposite)?
 */
export function townSignNear(spots: Iterable<TownSignSpot>, s: TownSignSpot, reach = 100): boolean {
  // the way traffic reading the sign travels: against the way its plate faces
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  for (const o of spots) {
    const within = o.kind === s.kind ? reach : Math.min(reach, 60);
    const dx = o.x - s.x;
    const dz = o.z - s.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
    const turn = Math.abs(Math.atan2(Math.sin(o.yaw - s.yaw), Math.cos(o.yaw - s.yaw)));
    if (turn > Math.PI / 3) continue;
    const along = dx * fx + dz * fz;
    const beside = Math.abs(dx * fz - dz * fx);
    if (Math.abs(along) <= within && beside <= 15) return true;
  }
  return false;
}
