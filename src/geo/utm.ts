// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ETRS89 / UTM zone 32N (EPSG:25832) <-> geographic coordinates, plus the
 * simulator's local world frame.
 *
 * Transverse Mercator via the Krüger n-series (sub-millimetre inside a zone).
 *
 * World frame (metres):  x = east, y = up (height above sea level, DHHN2016),
 * z = south.  North is therefore -Z, which matches three.js' default camera.
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

/** Geographic (degrees) -> UTM32 easting/northing (metres). */
export function latLonToUtm32(latDeg: number, lonDeg: number): [number, number] {
  const phi = (latDeg * Math.PI) / 180;
  const dLam = (lonDeg * Math.PI) / 180 - LON0_ZONE32;
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

/** UTM32 easting/northing (metres) -> geographic [lat, lon] in degrees. */
export function utm32ToLatLon(easting: number, northing: number): [number, number] {
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
  const lam = LON0_ZONE32 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [(phi * 180) / Math.PI, (lam * 180) / Math.PI];
}

/** UTM32 origin of the Baunatal world frame (close to the town centre). */
export const WORLD_ORIGIN_E = 528000;
export const WORLD_ORIGIN_N = 5678000;

/**
 * Extent of the simulated world in UTM32 kilometre squares.  It is the
 * bounding rectangle of the official 1 km DGM1 tiles published for Baunatal.
 */
export const WORLD_MIN_E = 522000;
export const WORLD_MAX_E = 534000;
export const WORLD_MIN_N = 5674000;
export const WORLD_MAX_N = 5682000;

export function utmToWorld(easting: number, northing: number): [number, number] {
  return [easting - WORLD_ORIGIN_E, -(northing - WORLD_ORIGIN_N)];
}

export function worldToUtm(x: number, z: number): [number, number] {
  return [x + WORLD_ORIGIN_E, WORLD_ORIGIN_N - z];
}

export function latLonToWorld(latDeg: number, lonDeg: number): [number, number] {
  const [e, n] = latLonToUtm32(latDeg, lonDeg);
  return utmToWorld(e, n);
}

export function worldToLatLon(x: number, z: number): [number, number] {
  const [e, n] = worldToUtm(x, z);
  return utm32ToLatLon(e, n);
}
