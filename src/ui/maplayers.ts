// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The big map's layers the player may hide or show: the roadworks, the
 * demonstrations, the emergency vehicles, the fuel stations, the car
 * washes (the trams and buses have their own switch) – remembered in this
 * browser – and how the icons of the services and the emergency vehicles
 * are drawn and found under a finger.
 */

export type LayerId = 'works' | 'demos' | 'emergency' | 'fuel' | 'wash';
export const LAYERS: readonly LayerId[] = ['emergency', 'works', 'demos', 'fuel', 'wash'];
export const LAYER_KEYS: Record<LayerId, string> = { emergency: 'layerEmergency', works: 'layerWorks', demos: 'layerDemos', fuel: 'layerFuel', wash: 'layerWash' };

const KEY = 'fahrsim.mapLayers';

/** Which layers are shown (all, unless the player hid some). */
export function loadLayers(): Record<LayerId, boolean> {
  const out = { works: true, demos: true, emergency: true, fuel: true, wash: true };
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const j = raw ? (JSON.parse(raw) as Partial<Record<LayerId, unknown>>) : {};
    for (const k of LAYERS) if (typeof j[k] === 'boolean') out[k] = j[k] as boolean;
  } catch {
    /* (nothing stored, or no storage: all shown) */
  }
  return out;
}

export function saveLayers(l: Record<LayerId, boolean>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(l));
  } catch {
    /* (a convenience) */
  }
}

/** A fuel station or car wash on the map. */
export interface MapService {
  k: 'fuel' | 'wash';
  name: string;
  brand: string;
  x: number;
  z: number;
  osm: string;
  fuels?: readonly string[];
}

/** An emergency vehicle of the traffic on the map. */
export interface MapEmergency {
  id: number;
  /** 0 police, 1 ambulance, 2 fire engine, 3 emergency doctor */
  kind: number;
  call: boolean;
  x: number;
  z: number;
}

const EM_COLOURS = ['#2f6fdf', '#e8e8e8', '#d8261c', '#e8e8e8'];

/** Draw the services and the emergency vehicles in view (sx, sy: world → screen). */
export function drawLayerIcons(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  scale: number,
  sx: (x: number) => number,
  sy: (z: number) => number,
  services: readonly MapService[],
  emergencies: readonly MapEmergency[],
  shown: Record<LayerId, boolean>,
  blink: boolean,
): void {
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // the services only from a town's scale on: else the map would be covered with them
  if (scale >= 0.08) {
    for (const s of services) {
      if (!shown[s.k]) continue;
      const x = sx(s.x);
      const y = sy(s.z);
      if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
      g.fillStyle = s.k === 'fuel' ? '#1d7a3a' : '#1f6fb2';
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect(x - 9, y - 9, 18, 18, 4);
      g.fill();
      g.stroke();
      g.fillStyle = '#ffffff';
      g.font = '700 11px system-ui, sans-serif';
      g.fillText(s.k === 'fuel' ? '⛽' : '≋', x, y + 1);
    }
  }
  if (shown.emergency) {
    for (const e of emergencies) {
      const x = sx(e.x);
      const y = sy(e.z);
      if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
      g.fillStyle = EM_COLOURS[e.kind] ?? '#2f6fdf';
      g.strokeStyle = e.call && blink ? '#3b8cff' : '#0d1620';
      g.lineWidth = e.call ? 4 : 2;
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = e.kind === 0 ? '#ffffff' : '#c8141c';
      g.font = '800 10px system-ui, sans-serif';
      g.fillText(e.kind === 0 ? 'P' : e.kind === 2 ? '🔥' : '+', x, y + 1);
    }
  }
  g.restore();
}

/** What icon is under a point of the map (null: none) – the emergency vehicles first. */
export function layerIconAt(
  px: number,
  py: number,
  scale: number,
  sx: (x: number) => number,
  sy: (z: number) => number,
  services: readonly MapService[],
  emergencies: readonly MapEmergency[],
  shown: Record<LayerId, boolean>,
): { em: MapEmergency } | { service: MapService } | null {
  let best: { em: MapEmergency } | { service: MapService } | null = null;
  let bd = 16;
  if (shown.emergency) {
    for (const e of emergencies) {
      const d = Math.hypot(sx(e.x) - px, sy(e.z) - py);
      if (d < bd) {
        bd = d;
        best = { em: e };
      }
    }
  }
  if (best || scale < 0.08) return best;
  for (const s of services) {
    if (!shown[s.k]) continue;
    const d = Math.hypot(sx(s.x) - px, sy(s.z) - py);
    if (d < bd) {
      bd = d;
      best = { service: s };
    }
  }
  return best;
}
