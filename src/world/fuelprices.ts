// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Today's fuel prices at the real stations – where the player has a key of
 * Tankerkönig (https://creativecommons.tankerkoenig.de – the data of the
 * German Markttransparenzstelle für Kraftstoffe, CC BY 4.0; a key is free,
 * one asks for it there).  Without a key the game shows typical prices
 * (world/services.ts FUELS).  The browser asks the service directly; it
 * learns the IP address, the key and the area (25 km round the player).
 */

import { worldToLatLon, latLonToWorld } from '../geo/utm.ts';

export const FUEL_PRICE_SOURCE = {
  name: 'Tankerkönig (MTS-K)',
  url: 'https://creativecommons.tankerkoenig.de',
  licence: 'CC BY 4.0',
};

interface Live {
  x: number;
  z: number;
  open: boolean;
  /** € per litre: e5, e10, diesel */
  prices: Record<string, number>;
}

/** What one list of the service says about one station (the fields used). */
interface StationJson {
  lat: number;
  lng: number;
  isOpen?: boolean;
  e5?: number | false | null;
  e10?: number | false | null;
  diesel?: number | false | null;
}

/** The prices of a station of the service by the fuels of the game (Super = e5, Super E10 = e10, Diesel and the lorries' = diesel). */
export function pricesOf(s: StationJson): Record<string, number> {
  const out: Record<string, number> = {};
  const ok = (v: unknown): v is number => typeof v === 'number' && v > 0.3 && v < 5;
  if (ok(s.e5)) out.e5 = s.e5;
  if (ok(s.e10)) out.e10 = s.e10;
  if (ok(s.diesel)) {
    out.diesel = s.diesel;
    out.hgv = s.diesel;
  }
  return out;
}

export class FuelPrices {
  /** the player's key (settings); empty: no requests, typical prices */
  key = '';
  private live: Live[] = [];
  private asked = { x: NaN, z: NaN, at: -Infinity };
  private pending = false;
  /** when the last answer came (ms; 0: none yet) */
  updated = 0;
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.fetchFn = fetchFn;
  }

  /** Ask for the prices round (x, z) – at most every 10 minutes, or when the player is 10 km away from where they were asked for. */
  refresh(x: number, z: number, now = Date.now()): void {
    if (!this.key || this.pending) return;
    const moved = !Number.isFinite(this.asked.x) || Math.hypot(x - this.asked.x, z - this.asked.z) > 10000;
    if (!moved && now - this.asked.at < 10 * 60000) return;
    if (now - this.asked.at < 60000) return;
    this.asked = { x, z, at: now };
    const [lat, lon] = worldToLatLon(x, z);
    const url = `${FUEL_PRICE_SOURCE.url}/json/list.php?lat=${lat.toFixed(3)}&lng=${lon.toFixed(3)}&rad=25&sort=dist&type=all&apikey=${encodeURIComponent(this.key)}`;
    this.pending = true;
    void this.fetchFn(url, { referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; stations?: StationJson[] } | null) => {
        if (!j?.ok || !Array.isArray(j.stations)) return;
        this.live = j.stations
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
          .map((s) => {
            const [sx, sz] = latLonToWorld(s.lat, s.lng);
            return { x: sx, z: sz, open: s.isOpen !== false, prices: pricesOf(s) };
          });
        this.updated = now;
      })
      .catch(() => {})
      .finally(() => (this.pending = false));
  }

  /** Today's price of a fuel at the station at (x, z) – null where the service knows none (no key, too far, not that fuel). */
  priceAt(x: number, z: number, fuel: string): number | null {
    let best: Live | null = null;
    let bd = 150;
    for (const s of this.live) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best?.prices[fuel] ?? null;
  }

  /** For the tests: put the answer in directly. */
  setLive(list: Array<{ x: number; z: number; prices: Record<string, number> }>, now = Date.now()): void {
    this.live = list.map((s) => ({ ...s, open: true }));
    this.updated = now;
  }
}

/** The game's one price list (the services and the map ask it). */
export const fuelPrices = new FuelPrices();
