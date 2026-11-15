// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's own pictures: panoramas saved with a street-view download
 * tool, stills from a dashcam, phone photos.  They stay on the player's
 * machine – the simulator only reads them.
 *
 * Where a picture belongs is taken from, in this order,
 *   1. its own metadata (EXIF GPS, XMP),
 *   2. a list lying next to it (JSON, GeoJSON or CSV with a name or panorama
 *      id and a position per picture – what download tools write),
 *   3. its file name ("51.25529,9.41110.jpg", "…_h090.jpg", "<id>_090.jpg").
 * A picture without any position can be pinned to where the car is.
 */
import { looksLikePanorama } from './imagemeta.ts';
import type { ImageMeta } from './imagemeta.ts';
import type { StreetImage } from './types.ts';

export interface NameInfo {
  /** name without folder, extension and heading suffix – what lists refer to */
  id: string;
  lat: number;
  lon: number;
  heading: number;
}

const baseName = (name: string): string =>
  name
    .replace(/^.*[\\/]/, '')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '');

/**
 * `plausible` tells whether a position can be meant (inside the map): it
 * settles whether "9.4111_51.2553" is longitude first.
 */
export function parseFileName(name: string, plausible: (lat: number, lon: number) => boolean = () => true): NameInfo {
  const base = baseName(name);
  const out: NameInfo = { id: base, lat: NaN, lon: NaN, heading: NaN };
  const c = /(-?\d{1,3}\.\d{3,})[\s_,;x@+]+(-?\d{1,3}\.\d{3,})/.exec(base);
  if (c) {
    const a = Number(c[1]);
    const b = Number(c[2]);
    const latFirst = Math.abs(a) <= 90 && Math.abs(b) <= 180;
    const lonFirst = Math.abs(b) <= 90 && Math.abs(a) <= 180;
    if (latFirst && (plausible(a, b) || !lonFirst || !plausible(b, a))) {
      out.lat = a;
      out.lon = b;
    } else if (lonFirst) {
      out.lat = b;
      out.lon = a;
    }
  }
  const rest = c ? base.replace(c[0], ' ') : base;
  const named = /(?:^|[\s_\-.])(?:h|hdg|head|heading|yaw|dir|az|azimuth|bearing)[_=\-]?(\d{1,3}(?:\.\d+)?)(?![\d.])/i.exec(rest);
  if (named && Number(named[1]) <= 360) out.heading = Number(named[1]) % 360;
  else {
    // "<panorama id>_090": one picture per direction
    const tail = /^(.{6,})_(\d{3})$/.exec(base);
    if (tail && Number(tail[2]) <= 360) {
      out.heading = Number(tail[2]) % 360;
      out.id = tail[1];
    }
  }
  return out;
}

export interface ListEntry {
  /** file name or panorama id, lower case, without extension */
  key: string;
  lat: number;
  lon: number;
  heading: number;
  time: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(r: Rec, names: string[]): unknown {
  for (const k of Object.keys(r)) {
    if (names.includes(k.toLowerCase().replace(/[\s_-]/g, ''))) {
      const v = r[k];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return undefined;
}

const toNum = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN);

function toTime(v: unknown): number {
  if (typeof v === 'number') return v > 1e11 ? v : v > 1e8 ? v * 1000 : NaN;
  if (typeof v !== 'string' || !v.trim()) return NaN;
  const s = v.trim();
  // "2023-09" (as street-view metadata gives it) or anything Date understands
  const ym = /^(\d{4})-(\d{1,2})$/.exec(s);
  return ym ? Date.UTC(+ym[1], +ym[2] - 1, 1) : Date.parse(s);
}

const KEY = ['file', 'filename', 'path', 'image', 'name', 'panoid', 'pano', 'panoramaid', 'id'];
const LAT = ['lat', 'latitude', 'y'];
const LON = ['lon', 'lng', 'long', 'longitude', 'x'];
const HEAD = ['heading', 'yaw', 'bearing', 'azimuth', 'compassangle', 'north', 'rotation', 'direction'];
const TIME = ['date', 'time', 'datetime', 'capturedat', 'timestamp', 'shotdate'];

function entryOf(r: Rec, lat?: number, lon?: number, key?: string): ListEntry | null {
  let la = lat ?? toNum(pick(r, LAT));
  let lo = lon ?? toNum(pick(r, LON));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    const loc = pick(r, ['location', 'position', 'coordinates', 'latlng']);
    if (isRec(loc)) {
      la = toNum(pick(loc, LAT));
      lo = toNum(pick(loc, LON));
    } else if (Array.isArray(loc) && loc.length >= 2) {
      la = toNum(loc[0]);
      lo = toNum(loc[1]);
    }
  }
  const k = key ?? pick(r, KEY);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (typeof k !== 'string' && typeof k !== 'number')) return null;
  return { key: baseName(String(k)).toLowerCase(), lat: la, lon: lo, heading: toNum(pick(r, HEAD)), time: toTime(pick(r, TIME)) };
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/** A list of pictures with positions: JSON (array, object of records), GeoJSON or CSV/TSV with a header line. */
export function parseList(text: string): ListEntry[] {
  const out: ListEntry[] = [];
  const add = (e: ListEntry | null): void => {
    if (e && e.key) out.push(e);
  };
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      return out;
    }
    const visit = (v: unknown, key?: string): void => {
      if (Array.isArray(v)) for (const x of v) visit(x);
      else if (isRec(v)) {
        if (Array.isArray(v.features)) {
          for (const f of v.features) {
            if (!isRec(f) || !isRec(f.geometry) || f.geometry.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
            const props = isRec(f.properties) ? f.properties : {};
            const id = pick(props, KEY) ?? f.id;
            add(entryOf(props, toNum(f.geometry.coordinates[1]), toNum(f.geometry.coordinates[0]), id === undefined ? undefined : String(id)));
          }
          return;
        }
        const e = entryOf(v, undefined, undefined, pick(v, KEY) === undefined ? key : undefined);
        if (e) add(e);
        else {
          // { "<id>": { lat, lng, … }, … } or a wrapper such as { panoramas: [ … ] }
          for (const [k, x] of Object.entries(v)) if (isRec(x) || Array.isArray(x)) visit(x, k);
        }
      }
    };
    visit(json);
    return out;
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return out;
  const sep = lines[0].includes('\t') ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const header = splitCsvLine(lines[0], sep);
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], sep);
    const r: Rec = {};
    header.forEach((h, j) => (r[h] = cells[j] ?? ''));
    add(entryOf(r));
  }
  return out;
}

/** The list entry that speaks about the picture `name`, if any. */
export function findInList(list: ListEntry[], name: string, info: NameInfo): ListEntry | null {
  const base = baseName(name).toLowerCase();
  const id = info.id.toLowerCase();
  let prefix: ListEntry | null = null;
  for (const e of list) {
    if (e.key === base || e.key === id) return e;
    if (!prefix && e.key.length >= 8 && (base.startsWith(e.key) || base.includes(e.key))) prefix = e;
  }
  return prefix;
}

export interface LocalSource {
  /** file name with folder, as the player sees it */
  name: string;
  meta: ImageMeta;
  url: string;
  thumb?: string;
}

/** Put together what metadata, list and file name know about one picture. */
export function describeLocal(src: LocalSource, list: ListEntry[], plausible: (lat: number, lon: number) => boolean = () => true): StreetImage {
  const info = parseFileName(src.name, plausible);
  const entry = findInList(list, src.name, info);
  const m = src.meta;
  const first = (...v: number[]): number => v.find((x) => Number.isFinite(x)) ?? NaN;
  let lat = m.lat;
  let lon = m.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    lat = entry ? entry.lat : info.lat;
    lon = entry ? entry.lon : info.lon;
  }
  const located = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    source: 'local',
    id: src.name,
    lat: located ? lat : NaN,
    lon: located ? lon : NaN,
    heading: first(m.heading, entry ? entry.heading : NaN, info.heading),
    pano: looksLikePanorama(m),
    time: first(m.time, entry ? entry.time : NaN),
    author: '',
    licence: '',
    thumb: src.thumb ?? src.url,
    url: src.url,
    full: src.url,
    page: '',
    title: src.name.replace(/^.*[\\/]/, ''),
    located,
  };
}

export const IMAGE_FILE = /\.(jpe?g|png|webp|avif)$/i;
export const LIST_FILE = /\.(json|geojson|csv|tsv)$/i;

/** What the indexing tool writes to `public/panos/index.json` (and the game reads). */
export interface PanoIndex {
  images: Array<{ file: string; lat: number | null; lon: number | null; heading: number | null; time: number | null; pano: boolean }>;
}

/** Pictures a self-hosted copy offers in its `panos/` folder. */
export function imagesFromIndex(index: unknown, baseUrl: string): StreetImage[] {
  const out: StreetImage[] = [];
  const list = isRec(index) && Array.isArray(index.images) ? index.images : [];
  for (const r of list) {
    if (!isRec(r) || typeof r.file !== 'string' || !IMAGE_FILE.test(r.file) || r.file.includes('..')) continue;
    const lat = toNum(r.lat);
    const lon = toNum(r.lon);
    const located = Number.isFinite(lat) && Number.isFinite(lon);
    const url = baseUrl + r.file.split('/').map(encodeURIComponent).join('/');
    out.push({
      source: 'local',
      id: `panos/${r.file}`,
      lat: located ? lat : NaN,
      lon: located ? lon : NaN,
      heading: toNum(r.heading),
      pano: r.pano === true,
      time: toNum(r.time),
      author: '',
      licence: '',
      thumb: url,
      url,
      full: url,
      page: '',
      title: r.file.replace(/^.*\//, ''),
      located,
    });
  }
  return out;
}
