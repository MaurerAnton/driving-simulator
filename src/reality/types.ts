// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "Reality view": real street-level photographs of the place the car is at.
 *
 * Nothing of this is part of the map or shipped with the simulator.  Pictures
 * come either from the player's own files (panoramas saved with any street-view
 * download tool, dashcam stills, phone photos) or, if the player switches a
 * service on, live from freely licensed street-level imagery projects.
 */

export type ImageSource = 'panoramax' | 'kartaview' | 'mapillary' | 'local';

export interface StreetImage {
  source: ImageSource;
  id: string;
  lat: number;
  lon: number;
  /** compass direction of the middle of the picture, degrees clockwise from north; NaN if unknown */
  heading: number;
  /** full 360° equirectangular panorama (looked around in), not a flat photograph */
  pano: boolean;
  /** when it was taken, milliseconds since 1970; NaN if unknown */
  time: number;
  /** who took it ('' if the service does not say) */
  author: string;
  licence: string;
  /** small preview */
  thumb: string;
  /** picture in a size that suits a screen */
  url: string;
  /** largest version on offer (used for panoramas, where every pixel counts) */
  full: string;
  /** page of the picture at its source, '' for own files */
  page: string;
  /** file name of an own picture */
  title: string;
  /** false: an own picture without any position – it can be pinned to where the car is */
  located: boolean;
}

export interface SearchArea {
  lat: number;
  lon: number;
  /** metres */
  radius: number;
}

export const SOURCE_NAME: Record<ImageSource, string> = {
  panoramax: 'Panoramax',
  kartaview: 'KartaView',
  mapillary: 'Mapillary',
  local: '',
};

const M_PER_DEG = 111320;

/** Distance in metres between two points that are close together. */
export function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * M_PER_DEG;
  const dx = (lon2 - lon1) * M_PER_DEG * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
}

/** [west, south, east, north] of the square around the area. */
export function areaBox(a: SearchArea): [number, number, number, number] {
  const dLat = a.radius / M_PER_DEG;
  const dLon = a.radius / (M_PER_DEG * Math.cos(a.lat * (Math.PI / 180)));
  return [a.lon - dLon, a.lat - dLat, a.lon + dLon, a.lat + dLat];
}

/** Smallest angle between two compass directions, 0 … 180 degrees. */
export function headingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Nearest first – but a photograph looking the way the driver looks is worth
 * a few metres more, and so is a panorama, in which one can turn round.
 */
export function rankImages(images: StreetImage[], lat: number, lon: number, heading: number): Array<{ image: StreetImage; dist: number }> {
  const out: Array<{ image: StreetImage; dist: number; score: number }> = [];
  for (const image of images) {
    if (!image.located) continue;
    const dist = metresBetween(lat, lon, image.lat, image.lon);
    let score = dist;
    if (image.pano) score -= 6;
    else if (Number.isNaN(image.heading) || Number.isNaN(heading)) score += 9;
    else score += Math.min(headingDiff(image.heading, heading), 120) * 0.22;
    out.push({ image, dist, score });
  }
  out.sort((p, q) => p.score - q.score);
  return out.map(({ image, dist }) => ({ image, dist }));
}
