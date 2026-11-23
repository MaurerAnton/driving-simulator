// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the player is, from their IP address alone (ui/geoip.ts).
 *
 * On the first start the game may load the region the player is in – but asking
 * the browser for the position means a permission prompt, and a game that opens
 * with "may we know where you are?" is a game that gets closed.  The IP says it
 * instead: a service that answers where an address is, without asking anyone.
 *
 * It is not as exact as the GPS (a city at best, and a wrong guess now and then),
 * which is enough: a region is a land of tens of kilometres, not a street.
 *
 * `whois()` asks ipwho.is (free, no key, CORS open); `ipRegion()` turns the
 * answer into the region whose box holds it (world/regions.ts).  Both fail
 * quietly – no region is chosen, the site's own map loads as always.
 */
import { latLonToWorld } from '../geo/utm.ts';
import { regionAt } from '../world/regions.ts';
import type { Region, RegionIndex } from '../world/regions.ts';

/** Where an IP address is: its latitude and longitude, or why not. */
export type IpPlace = { lat: number; lon: number } | null;

/**
 * Where this browser's IP address is, from ipwho.is – null when the service is
 * unreachable, refuses, or gives no coordinates.  Never throws: the caller goes
 * on without a place.
 */
export async function ipPlace(fetchFn: typeof fetch = fetch): Promise<IpPlace> {
  try {
    const res = await fetchFn('https://ipwho.is/', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { latitude?: unknown; longitude?: unknown; success?: unknown };
    if (j.success === false) return null;
    const lat = typeof j.latitude === 'number' ? j.latitude : Number(j.latitude);
    const lon = typeof j.longitude === 'number' ? j.longitude : Number(j.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

/**
 * The region the IP address lies in, or null (the place is in none of them, or
 * there was no place).  The index is the regions of map-assets (regions.json).
 */
export function ipRegion(index: RegionIndex | null, place: IpPlace): Region | null {
  if (!index || !place) return null;
  const [x, z] = latLonToWorld(place.lat, place.lon);
  return regionAt(index, x, z);
}
