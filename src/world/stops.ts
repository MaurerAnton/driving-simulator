// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The stops of the map (stops.json.gz, made by tools/build-stops.ts from
 * OpenStreetMap): every tram and bus stop under its name, in its town, with
 * the poles people wait at and the platforms drawn on the map – what the
 * game draws, offers as start points for the tram, and drives the bus to.
 */
import type { StopsJson } from './types.ts';
import { STOP_FLAG } from './types.ts';

export interface StopPole {
  place: StopPlace;
  x: number;
  z: number;
  /** STOP_FLAG bits: what is there (shelter, bench, …) and who calls (tram, bus) */
  flags: number;
}

export interface StopPlatform {
  place: StopPlace;
  flags: number;
  /** metres; 0 where the map does not say */
  width: number;
  /** x, z, … along its edge, or round it (`area`) */
  pts: Float32Array;
  area: boolean;
}

export interface StopPlace {
  id: number;
  name: string;
  town: string;
  /** STOP_FLAG.TRAM | BUS | RAIL */
  kind: number;
  x: number;
  z: number;
  poles: StopPole[];
  platforms: StopPlatform[];
}

const CELL = 250;

export class Stops {
  readonly places: StopPlace[] = [];
  private readonly grid = new Map<number, StopPlace[]>();

  constructor(json: StopsJson) {
    for (const [name, town, kind, x, z] of json.places) {
      this.places.push({ id: this.places.length, name, town: json.towns[town] ?? '', kind, x, z, poles: [], platforms: [] });
    }
    for (const [pi, x, z, flags] of json.poles) {
      const place = this.places[pi];
      if (place) place.poles.push({ place, x, z, flags });
    }
    for (const [pi, flags, width, pts] of json.platforms) {
      const place = this.places[pi];
      if (place && pts.length >= 4) place.platforms.push({ place, flags, width, pts: Float32Array.from(pts), area: (flags & STOP_FLAG.AREA) !== 0 });
    }
    for (const p of this.places) {
      // a place is wherever its members are: listed in every cell they reach
      const cells = new Set<number>([this.key(p.x, p.z)]);
      for (const q of p.poles) cells.add(this.key(q.x, q.z));
      for (const f of p.platforms) for (let i = 0; i < f.pts.length; i += 2) cells.add(this.key(f.pts[i], f.pts[i + 1]));
      for (const k of cells) {
        const list = this.grid.get(k);
        if (list) list.push(p);
        else this.grid.set(k, [p]);
      }
    }
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);
  }

  /** The places with a member within `r` metres of (x, z) – each once. */
  near(x: number, z: number, r: number, out: StopPlace[] = []): StopPlace[] {
    out.length = 0;
    const seen = new Set<number>();
    const i0 = Math.floor((x - r) / CELL);
    const i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL);
    const j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const p of this.grid.get((i + 32768) * 65536 + (j + 32768)) ?? []) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
        }
      }
    }
    return out;
  }

  /** The stops trams call at, by town and name (the start points of the tram). */
  tramPlaces(): StopPlace[] {
    return this.places.filter((p) => (p.kind & STOP_FLAG.TRAM) !== 0);
  }

  /** The place of that name nearest to (x, z), or null. */
  named(name: string, x: number, z: number): StopPlace | null {
    let best: StopPlace | null = null;
    let bd = Infinity;
    for (const p of this.places) {
      if (p.name !== name) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }
}
