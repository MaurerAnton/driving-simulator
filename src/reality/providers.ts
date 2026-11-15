// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Freely licensed street-level imagery services.
 *
 *  - Panoramax (panoramax.xyz): federated, community-run, no account needed.
 *  - KartaView (kartaview.org): no account needed.
 *  - Mapillary (mapillary.com, Meta): needs a free client access token.
 *
 * All three publish their pictures under CC BY-SA 4.0 (Panoramax instances may
 * also use the French Licence Ouverte) and allow requests from web pages.
 * The simulator only ever asks them when the player has switched them on.
 */
import { areaBox } from './types.ts';
import type { ImageSource, SearchArea, StreetImage } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};
/** Only ever hand https addresses on to the page. */
const https = (v: unknown): string => {
  const s = str(v);
  return s.startsWith('https://') ? s : '';
};
const okPos = (lat: number, lon: number): boolean => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function licenceName(id: string): string {
  const k = id.toLowerCase();
  if (k.startsWith('cc-by-sa-4')) return 'CC BY-SA 4.0';
  if (k.startsWith('cc-by-4')) return 'CC BY 4.0';
  if (k.startsWith('cc0')) return 'CC0';
  if (k.startsWith('etalab')) return 'Licence Ouverte 2.0';
  return id || 'CC BY-SA 4.0';
}

// ------------------------------------------------------------------ Panoramax
export function panoramaxUrl(a: SearchArea, limit = 60): string {
  const b = areaBox(a).map((v) => v.toFixed(6));
  return `https://api.panoramax.xyz/api/search?bbox=${b.join(',')}&limit=${limit}`;
}

export function parsePanoramax(json: unknown): StreetImage[] {
  const out: StreetImage[] = [];
  const features = isObj(json) && Array.isArray(json.features) ? json.features : [];
  for (const f of features) {
    if (!isObj(f) || !isObj(f.geometry) || !Array.isArray(f.geometry.coordinates)) continue;
    const lon = num(f.geometry.coordinates[0]);
    const lat = num(f.geometry.coordinates[1]);
    const id = str(f.id);
    const assets = isObj(f.assets) ? f.assets : {};
    const href = (k: string): string => {
      const a = assets[k];
      return isObj(a) ? https(a.href) : '';
    };
    const thumb = href('thumb') || href('sd');
    const url = href('sd') || href('hd');
    if (!id || !okPos(lat, lon) || !url) continue;
    const p = isObj(f.properties) ? f.properties : {};
    const io = isObj(p['pers:interior_orientation']) ? p['pers:interior_orientation'] : {};
    let author = str(p['geovisio:producer']);
    if (Array.isArray(f.providers)) {
      for (const pr of f.providers) {
        if (isObj(pr) && Array.isArray(pr.roles) && pr.roles.includes('producer') && str(pr.name)) author = str(pr.name);
      }
    }
    out.push({
      source: 'panoramax',
      id,
      lat,
      lon,
      heading: num(p['view:azimuth']),
      pano: num(io.field_of_view) === 360,
      time: Date.parse(str(p.datetime)),
      author,
      licence: licenceName(str(p.license)),
      thumb,
      url,
      full: href('hd') || url,
      page: `https://api.panoramax.xyz/#focus=pic&pic=${encodeURIComponent(id)}`,
      title: '',
      located: true,
    });
  }
  return out;
}

// ------------------------------------------------------------------ KartaView
/** The service accepts a radius of 1 … 500 m and at most 150 pictures per request. */
export function kartaviewUrl(a: SearchArea, limit = 60): string {
  const r = Math.max(1, Math.min(500, Math.round(a.radius)));
  return `https://api.kartaview.org/2.0/photo/?lat=${a.lat.toFixed(6)}&lng=${a.lon.toFixed(6)}&radius=${r}&itemsPerPage=${Math.min(150, limit)}`;
}

export function parseKartaView(json: unknown): StreetImage[] {
  const out: StreetImage[] = [];
  const result = isObj(json) && isObj(json.result) ? json.result : {};
  const data = Array.isArray(result.data) ? result.data : [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const lat = num(r.lat);
    const lon = num(r.lng);
    const id = str(r.id);
    const thumb = https(r.imageThUrl) || https(r.fileurlTh);
    const url = https(r.imageLthUrl) || https(r.fileurlLTh);
    if (!id || !okPos(lat, lon) || !url) continue;
    const seq = str(r.sequenceId);
    // "2025-08-04 17:05:50.000", UTC
    const shot = str(r.shotDate).trim().replace(' ', 'T');
    out.push({
      source: 'kartaview',
      id,
      lat,
      lon,
      heading: num(r.heading),
      pano: str(r.projection).toUpperCase() === 'SPHERE',
      time: shot ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(shot) ? shot : `${shot}Z`) : NaN,
      author: '',
      licence: 'CC BY-SA 4.0',
      thumb: thumb || url,
      url,
      full: https(r.imageProcUrl) || https(r.fileurlProc) || url,
      page: seq ? `https://kartaview.org/details/${encodeURIComponent(seq)}/${encodeURIComponent(str(r.sequenceIndex) || '0')}/track-info` : 'https://kartaview.org/',
      title: '',
      located: true,
    });
  }
  return out;
}

// ------------------------------------------------------------------ Mapillary
const MLY_FIELDS = 'id,geometry,computed_geometry,compass_angle,computed_compass_angle,captured_at,is_pano,thumb_256_url,thumb_1024_url,thumb_2048_url,creator';

/** The box of an image search must stay below 0.01 square degrees – a few hundred metres are far inside that. */
export function mapillaryUrl(a: SearchArea, token: string, limit = 60): string {
  const b = areaBox({ ...a, radius: Math.min(a.radius, 2000) }).map((v) => v.toFixed(6));
  return `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}&fields=${MLY_FIELDS}&bbox=${b.join(',')}&limit=${limit}`;
}

export function parseMapillary(json: unknown): StreetImage[] {
  const out: StreetImage[] = [];
  const data = isObj(json) && Array.isArray(json.data) ? json.data : [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const g = isObj(r.computed_geometry) ? r.computed_geometry : isObj(r.geometry) ? r.geometry : null;
    if (!g || !Array.isArray(g.coordinates)) continue;
    const lon = num(g.coordinates[0]);
    const lat = num(g.coordinates[1]);
    const id = str(r.id);
    const url = https(r.thumb_1024_url) || https(r.thumb_2048_url);
    if (!id || !okPos(lat, lon) || !url) continue;
    const angle = num(r.computed_compass_angle);
    out.push({
      source: 'mapillary',
      id,
      lat,
      lon,
      heading: Number.isFinite(angle) ? angle : num(r.compass_angle),
      pano: r.is_pano === true,
      time: num(r.captured_at),
      author: isObj(r.creator) ? str(r.creator.username) : '',
      licence: 'CC BY-SA 4.0',
      thumb: https(r.thumb_256_url) || url,
      url,
      full: https(r.thumb_2048_url) || url,
      page: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`,
      title: '',
      located: true,
    });
  }
  return out;
}

/** What a service said when it refused (shown to the player). */
export function serviceError(json: unknown, status: number): string {
  if (isObj(json)) {
    if (isObj(json.error) && str(json.error.message)) return str(json.error.message);
    if (str(json.message)) return str(json.message);
    if (isObj(json.status) && str(json.status.apiMessage)) return str(json.status.apiMessage);
  }
  return `HTTP ${status}`;
}

export interface SearchOptions {
  /** Mapillary client token */
  token?: string;
  signal?: AbortSignal;
  /** for tests */
  fetch?: typeof fetch;
}

/** Ask one service for pictures around a place.  Rejects with a readable message. */
export async function searchImages(source: Exclude<ImageSource, 'local'>, area: SearchArea, opts: SearchOptions = {}): Promise<StreetImage[]> {
  const f = opts.fetch ?? fetch;
  let url: string;
  if (source === 'panoramax') url = panoramaxUrl(area);
  else if (source === 'kartaview') url = kartaviewUrl(area);
  else {
    if (!opts.token) throw new Error('token');
    url = mapillaryUrl(area, opts.token);
  }
  // no cookies, no referrer: the service learns the place asked for and the IP address, nothing else
  const res = await f(url, { signal: opts.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON: reported by the status below */
  }
  if (!res.ok) throw new Error(serviceError(json, res.status));
  return source === 'panoramax' ? parsePanoramax(json) : source === 'kartaview' ? parseKartaView(json) : parseMapillary(json);
}

export interface PlaceLink {
  id: string;
  label: string;
  url: string;
}

/**
 * The same place on the web sites of the imagery services – opened in a new
 * tab on request, so nothing is embedded and nothing has to be licensed.
 */
export function placeLinks(lat: number, lon: number, heading: number): PlaceLink[] {
  const la = lat.toFixed(6);
  const lo = lon.toFixed(6);
  const h = Number.isFinite(heading) ? Math.round(((heading % 360) + 360) % 360) : 0;
  return [
    // street-level photographs
    { id: 'kartaview', label: 'KartaView', url: `https://kartaview.org/map/@${la},${lo},18z` },
    { id: 'mapillary', label: 'Mapillary', url: `https://www.mapillary.com/app/?lat=${la}&lng=${lo}&z=18` },
    { id: 'panoramax', label: 'Panoramax', url: `https://api.panoramax.xyz/#focus=map&map=18/${la}/${lo}` },
    { id: 'google', label: 'Google Street View', url: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${la},${lo}&heading=${h}` },
    // from above
    { id: 'googlemaps', label: 'Google Maps', url: `https://www.google.com/maps/@?api=1&map_action=map&center=${la},${lo}&zoom=19&basemap=satellite` },
    { id: 'googleearth', label: 'Google Earth', url: `https://earth.google.com/web/@${la},${lo},0a,450d,35y,${h}h,45t,0r` },
    { id: 'osm', label: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=19/${la}/${lo}` },
  ];
}
