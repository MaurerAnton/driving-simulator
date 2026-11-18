// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A theory scene seen from above, frozen at one moment – the still of the
 * "spot the danger" items and of the exam questions with a scene
 * (ui/learn.ts).  Drawn on a 2D canvas from the scene's own data
 * (game/theory.ts, theorystage.ts): the road and the pavements, the kerbs,
 * the traffic lights in their colours, the signs, trees and barriers, and
 * every vehicle, cyclist and person where the script has them then – the
 * learner's car white with a yellow edge, as in a theory book.  North is up,
 * the learner comes from below.  Cheap: no 3D, drawn once (and again when a
 * sign's picture has come).
 */
import { THEORY, corners, lightAt, newPose, poseAt, prepare } from '../game/theory.ts';
import type { Scene } from '../game/theory.ts';
import type { SurfaceKind } from '../game/theorystage.ts';
import { artAspect, drawSignArt } from '../render/signart.ts';

const scenes = new Map<string, Scene>();

function sceneOf(id: string): Scene | null {
  let s = scenes.get(id);
  if (!s) {
    const l = THEORY.find((x) => x.id === id);
    if (!l) return null;
    s = prepare(l);
    scenes.set(id, s);
  }
  return s;
}

/** The moment of a scene: the time of its question `step`, moved by `off` seconds (null: no such scene). */
export function sceneTime(id: string, step: number, off = 0): number | null {
  const l = THEORY.find((x) => x.id === id);
  const st = l?.steps[step];
  return l && st ? Math.max(0, Math.min(l.end, st.at + off)) : null;
}

const GROUND: Record<SurfaceKind, string> = {
  asphalt: '#4f555c',
  walk: '#a7a399',
  island: '#8b9a74',
  apron: '#6f7377',
  paint: '#eeeeea',
  red: '#a8483f',
  steel: '#8a8f94',
};

const KIND_COLOUR: Record<string, string> = { van: '#e8e8e8', bus: '#d8a417', truck: '#5d6f80', tram: '#c8303a', bike: '#2f8a4a', person: '#3a6fb0', child: '#e08a2a', deer: '#8a5a32', boar: '#4a3a30' };
const LAMP: Record<string, string> = { R: '#e53935', Y: '#ffb300', G: '#43a047', A: '#ffb300', O: '#30363d' };

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const images = new Map<string, HTMLImageElement>();

/**
 * Draw scene `id` at time `t` into the canvas (its size as given by its
 * width and height attributes).  `you`: the label of the learner's car.
 * `signBase`: where the signs' SVG files are (public/signs/) – their
 * pictures are drawn once they have come.
 */
export function drawPlan(canvas: HTMLCanvasElement, id: string, t: number, you: string, signBase: string): boolean {
  const scene = sceneOf(id);
  const g = canvas.getContext('2d');
  if (!scene || !g) return false;
  const W = canvas.width;
  const H = canvas.height;
  const pose = newPose();
  // ---- what to show: the learner and whoever is near
  const me = scene.actors.find((a) => a.def.kind === 'me');
  const mp = me ? poseAt(me, t, newPose()) : null;
  const cx0 = mp?.x ?? (scene.stage.bounds[0] + scene.stage.bounds[2]) / 2;
  const cz0 = mp?.z ?? (scene.stage.bounds[1] + scene.stage.bounds[3]) / 2;
  let x0 = cx0 - 14;
  let x1 = cx0 + 14;
  let z0 = cz0 - 22;
  let z1 = cz0 + 10;
  for (const a of scene.actors) {
    const p = poseAt(a, t, pose);
    if (!p.visible || Math.hypot(p.x - cx0, p.z - cz0) > 75) continue;
    x0 = Math.min(x0, p.x - 8);
    x1 = Math.max(x1, p.x + 8);
    z0 = Math.min(z0, p.z - 8);
    z1 = Math.max(z1, p.z + 8);
  }
  const scale = Math.min(W / (x1 - x0), H / (z1 - z0));
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const sx = (x: number): number => (x - cx) * scale + W / 2;
  const sy = (z: number): number => (z - cz) * scale + H / 2;
  const ring = (pts: readonly number[]): void => {
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) g.moveTo(sx(pts[i]), sy(pts[i + 1]));
      else g.lineTo(sx(pts[i]), sy(pts[i + 1]));
    }
    g.closePath();
  };
  const line = (pts: readonly number[]): void => {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) g.moveTo(sx(pts[i]), sy(pts[i + 1]));
      else g.lineTo(sx(pts[i]), sy(pts[i + 1]));
    }
    g.stroke();
  };

  // ---- the ground
  g.fillStyle = '#5b7346';
  g.fillRect(0, 0, W, H);
  for (const s of scene.stage.surfaces) {
    g.beginPath();
    ring(s.ring);
    for (const h of s.holes ?? []) ring(h);
    g.fillStyle = GROUND[s.kind];
    g.fill('evenodd');
  }
  g.lineWidth = Math.max(1, scale * 0.12);
  g.strokeStyle = 'rgba(30, 30, 30, 0.55)';
  for (const k of scene.stage.kerbs) line(k.line);
  g.strokeStyle = '#c9ccd0';
  g.lineWidth = Math.max(1, scale * 0.2);
  for (const gd of scene.stage.guards) line(gd);
  for (const p of scene.stage.props ?? []) {
    if ((p.from !== undefined && t < p.from) || (p.to !== undefined && t > p.to)) continue;
    if (p.kind === 'tree') {
      g.fillStyle = '#2f5a2a';
      g.beginPath();
      g.arc(sx(p.x), sy(p.z), scale * 2.2 * (p.size ?? 1), 0, Math.PI * 2);
      g.fill();
    } else if (p.kind === 'tunnel' && p.x1 !== undefined && p.z1 !== undefined) {
      g.fillStyle = 'rgba(20, 20, 24, 0.55)';
      g.fillRect(Math.min(sx(p.x), sx(p.x1)), Math.min(sy(p.z), sy(p.z1)), Math.abs(sx(p.x1) - sx(p.x)), Math.abs(sy(p.z1) - sy(p.z)));
    } else {
      g.fillStyle = p.kind === 'triangle' || p.kind === 'cone' || p.kind === 'barrier' ? '#e2412f' : p.kind === 'heap' ? '#7a5a3a' : '#e8e8e8';
      const r = scale * (p.kind === 'barrier' ? 1.2 : p.kind === 'heap' ? 1.6 : 0.45);
      g.fillRect(sx(p.x) - r, sy(p.z) - r * 0.6, r * 2, r * 1.2);
    }
  }

  // ---- the vehicles and people
  for (const a of scene.actors) {
    const p = poseAt(a, t, pose);
    if (!p.visible) continue;
    const isMe = a.def.kind === 'me';
    const small = a.def.kind === 'person' || a.def.kind === 'child';
    g.fillStyle = isMe ? '#ffffff' : a.def.colour !== undefined ? hex(a.def.colour) : (KIND_COLOUR[a.def.kind] ?? '#c0c4c8');
    if (small) {
      g.beginPath();
      g.arc(sx(p.x), sy(p.z), Math.max(3, scale * 0.45), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 1;
      g.stroke();
      continue;
    }
    const c = corners(a, p);
    g.beginPath();
    ring(c);
    g.fill();
    g.lineWidth = isMe ? 3 : 1;
    g.strokeStyle = isMe ? '#ffcc00' : 'rgba(0, 0, 0, 0.7)';
    g.stroke();
    // its nose: a darker band at the front
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.lineWidth = Math.max(1.5, scale * 0.25);
    g.beginPath();
    g.moveTo(sx(c[0]), sy(c[1]));
    g.lineTo(sx(c[2]), sy(c[3]));
    g.stroke();
    // the indicators: amber dots at the corners of the side shown (both: hazard lights)
    if (p.blink !== 0) {
      g.fillStyle = '#ffa000';
      const dots = p.blink === 2 ? [0, 1, 2, 3] : p.blink < 0 ? [0, 3] : [1, 2];
      for (const i of dots) {
        g.beginPath();
        g.arc(sx(c[i * 2]), sy(c[i * 2 + 1]), Math.max(2.5, scale * 0.35), 0, Math.PI * 2);
        g.fill();
      }
    }
    if (isMe) {
      g.font = `bold ${Math.round(Math.max(12, Math.min(18, scale * 1.4)))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      const by = Math.max(sy(c[5]), sy(c[7])) + 4;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      g.strokeText(you, sx(p.x), Math.min(H - 18, by));
      g.fillStyle = '#ffcc00';
      g.fillText(you, sx(p.x), Math.min(H - 18, by));
    }
  }

  // ---- the traffic lights and the signs
  for (const l of scene.stage.lights) {
    const r = Math.max(3, scale * 0.6);
    g.fillStyle = '#111';
    g.fillRect(sx(l.x) - r - 1, sy(l.z) - r - 1, 2 * r + 2, 2 * r + 2);
    g.fillStyle = LAMP[lightAt(scene, l.id, t)] ?? LAMP.O;
    g.beginPath();
    g.arc(sx(l.x), sy(l.z), r, 0, Math.PI * 2);
    g.fill();
  }
  const size = Math.max(14, Math.min(30, scale * 2.6));
  for (const s of scene.stage.signs) {
    s.codes.forEach((code, i) => {
      const x = sx(s.x) + 4;
      const y = sy(s.z) - size - 2 + i * (size + 1);
      if (x < -size || x > W || y < -size || y > H) return;
      if (artAspect(code) !== null && !images.has(code)) {
        const a = artAspect(code) ?? 1;
        drawSignArt(g, code, x, y, a >= 1 ? size : size * a, a >= 1 ? size / a : size);
        return;
      }
      let img = images.get(code);
      if (!img) {
        img = new Image();
        img.src = `${signBase}svg/${encodeURIComponent(code)}.svg`;
        images.set(code, img);
      }
      if (img.complete && img.naturalWidth > 0) {
        const a = img.naturalWidth / img.naturalHeight;
        g.drawImage(img, x, y, a >= 1 ? size : size * a, a >= 1 ? size / a : size);
      } else if (!img.complete) {
        img.addEventListener('load', () => void drawPlan(canvas, id, t, you, signBase), { once: true });
      }
    });
  }
  return true;
}
