// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "My location": where the player is now, asked of the browser (which asks
 * the player first).  The position stays in this browser – nothing is sent
 * anywhere; it only says where on the map to start, to go, or to drive to.
 */

import { latLonToWorld } from '../geo/utm.ts';

export type LocateResult =
  | { ok: true; x: number; z: number; accuracy: number }
  | { ok: false; why: 'unsupported' | 'denied' | 'unavailable' | 'outside' };

/** The bounds of the map (world.json meta). */
export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Is a world point on the map (with a margin)? */
export function onMap(x: number, z: number, b: MapBounds, margin = 0): boolean {
  return x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;
}

/** Where the player is, on the map – or why not. */
export function locate(bounds: MapBounds, geo: Geolocation | undefined = globalThis.navigator?.geolocation): Promise<LocateResult> {
  return new Promise((resolve) => {
    if (!geo) {
      resolve({ ok: false, why: 'unsupported' });
      return;
    }
    geo.getCurrentPosition(
      (p) => {
        const [x, z] = latLonToWorld(p.coords.latitude, p.coords.longitude);
        resolve(onMap(x, z, bounds) ? { ok: true, x, z, accuracy: p.coords.accuracy } : { ok: false, why: 'outside' });
      },
      (e) => resolve({ ok: false, why: e.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}
