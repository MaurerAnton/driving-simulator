// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ETRS89 / UTM <-> geographic coordinates, plus the simulator's local world
 * frame.
 *
 * Transverse Mercator via the Krüger n-series (sub-millimetre inside a zone).
 *
 * A UTM zone is 6° of longitude wide, its central meridian at the middle of it
 * (zone 32 is 6°E…12°E, central meridian 9°E).  The zone a place lies in is
 * `zoneForLon(lon)`; the conversion functions take it, so a map anywhere in the
 * world – Italy, France, Belgium, east Germany – projects correctly instead of
 * being forced through zone 32.  The zone-32 functions are kept as they were,
 * for the Baunatal map and its build tools.
 *
 * World frame (metres):  x = east, y = up (height above sea level, DHHN2016),
 * z = south.  North is therefore -Z, which matches three.js' default camera.
 * The frame's origin is the active region's (see setWorldOrigin) – the Baunatal
 * origin until a map says otherwise.
 */

const A_GRS80 = 6378137.0;
const F_GRS80 = 1 / 298.257222101;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const LON0_ZONE32 = (9 * Math.PI) / 180;

const N1 = F_GRS80 / (2 - F_GRS80);
const N2 = N1 * N1;
const N3 = N2 * N1;
const N4 = N2 * N2;
const A_RECT = (A_GRS80 / (1 + N1)) * (1 + N2 / 4 + N4 / 64);

const ALPHA = [
  N1 / 2 - (2 * N2) / 3 + (5 * N3) / 16,
  (13 * N2) / 48 - (3 * N3) / 5,
  (61 * N3) / 240,
];
const BETA = [
  N1 / 2 - (2 * N2) / 3 + (37 * N3) / 96,
  N2 / 48 + N3 / 15,
  (17 * N3) / 480,
];
const DELTA = [
  2 * N1 - (2 * N2) / 3 - 2 * N3,
  (7 * N2) / 3 - (8 * N3) / 5,
  (56 * N3) / 15,
];
const E_CONF = (2 * Math.sqrt(N1)) / (1 + N1);

/** The UTM zone (1…60) a longitude lies in: each zone is 6° wide, 180°W…180°E. */
export function zoneForLon(lonDeg: number): number {
  return Math.floor((lonDeg + 180) / 6) + 1;
}

/** The central meridian (radians) of a UTM zone: the middle of its 6° of longitude. */
export function lon0ForZone(zone: number): number {
  return (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
}

/** Geographic (degrees) -> UTM easting/northing (metres) in the given zone. */
export function latLonToUtm(latDeg: number, lonDeg: number, zone: number): [number, number] {
  const phi = (latDeg * Math.PI) / 180;
  const dLam = (lonDeg * Math.PI) / 180 - lon0ForZone(zone);
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - E_CONF * Math.atanh(E_CONF * sinPhi));
  const xiP = Math.atan2(t, Math.cos(dLam));
  const etaP = Math.atanh(Math.sin(dLam) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  for (let j = 0; j < 3; j++) {
    const k = 2 * (j + 1);
    xi += ALPHA[j] * Math.sin(k * xiP) * Math.cosh(k * etaP);
    eta += ALPHA[j] * Math.cos(k * xiP) * Math.sinh(k * etaP);
  }
  return [FALSE_EASTING + K0 * A_RECT * eta, K0 * A_RECT * xi];
}

/** UTM easting/northing (metres) in a zone -> geographic [lat, lon] in degrees. */
export function utmToLatLon(easting: number, northing: number, zone: number): [number, number] {
  const xi = northing / (K0 * A_RECT);
  const eta = (easting - FALSE_EASTING) / (K0 * A_RECT);
  let xiP = xi;
  let etaP = eta;
  for (let j = 0; j < 3; j++) {
    const k = 2 * (j + 1);
    xiP -= BETA[j] * Math.sin(k * xi) * Math.cosh(k * eta);
    etaP -= BETA[j] * Math.cos(k * xi) * Math.sinh(k * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 0; j < 3; j++) phi += DELTA[j] * Math.sin(2 * (j + 1) * chi);
  const lam = lon0ForZone(zone) + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [(phi * 180) / Math.PI, (lam * 180) / Math.PI];
}

/** Geographic (degrees) -> UTM32 easting/northing (metres) – zone 32 (EPSG:25832). */
export function latLonToUtm32(latDeg: number, lonDeg: number): [number, number] {
  return latLonToUtm(latDeg, lonDeg, 32);
}

/** UTM32 easting/northing (metres) -> geographic [lat, lon] in degrees. */
export function utm32ToLatLon(easting: number, northing: number): [number, number] {
  return utmToLatLon(easting, northing, 32);
}

/** UTM32 origin of the Baunatal world frame (close to the town centre). */
export const WORLD_ORIGIN_E = 528000;
export const WORLD_ORIGIN_N = 5678000;

/**
 * Extent of the simulated world in UTM32 kilometre squares.  It is the
 * bounding rectangle of the official 1 km DGM1 tiles published for Baunatal
 * and for the neighbouring city of Kassel (18 km × 18 km).
 */
export const WORLD_MIN_E = 522000;
export const WORLD_MAX_E = 540000;
export const WORLD_MIN_N = 5674000;
export const WORLD_MAX_N = 5692000;

/** The active world frame: where the world's (0,0) lies in UTM, and its zone. */
export interface WorldFrame {
  /** the UTM easting of world x = 0 (metres) */
  originE: number;
  /** the UTM northing of world z = 0 (metres) */
  originN: number;
  /** the UTM zone the frame's coordinates are in */
  zone: number;
}

/** The Baunatal frame – what the game uses until a map says otherwise. */
export const BAUNATAL_FRAME: WorldFrame = { originE: WORLD_ORIGIN_E, originN: WORLD_ORIGIN_N, zone: 32 };

let activeFrame: WorldFrame = BAUNATAL_FRAME;

/** The frame the world's coordinates are currently relative to. */
export function worldFrame(): WorldFrame {
  return activeFrame;
}

/**
 * Set the world frame – called when a map is loaded, with the origin (and zone)
 * its own map.json carries, so a map anywhere in the world puts its (0,0) at the
 * frame's origin instead of being forced through Baunatal's.  The default frame
 * is Baunatal's, so a map that does not say leaves things as they were.
 */
export function setWorldOrigin(originE: number, originN: number, zone = 32): WorldFrame {
  activeFrame = { originE, originN, zone };
  return activeFrame;
}

/** Put the frame back to Baunatal's (a map that is not one, or a test). */
export function resetWorldOrigin(): void {
  activeFrame = BAUNATAL_FRAME;
}

export function utmToWorld(easting: number, northing: number): [number, number] {
  const f = activeFrame;
  return [easting - f.originE, -(northing - f.originN)];
}

export function worldToUtm(x: number, z: number): [number, number] {
  const f = activeFrame;
  return [x + f.originE, f.originN - z];
}

export function latLonToWorld(latDeg: number, lonDeg: number): [number, number] {
  const f = activeFrame;
  const [e, n] = latLonToUtm(latDeg, lonDeg, f.zone);
  return [e - f.originE, -(n - f.originN)];
}

export function worldToLatLon(x: number, z: number): [number, number] {
  const f = activeFrame;
  const [e, n] = [x + f.originE, f.originN - z];
  return utmToLatLon(e, n, f.zone);
}
