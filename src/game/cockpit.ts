// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Looking into a mirror: which of the vehicle's mirrors is shown large over
 * the picture (ui/mirrorzoom.ts draws it, render/mirrorzoom.ts renders it).
 *
 * The mirror key and the mirror button go round the mirrors the vehicle has
 * – off → left → right → inside → off –, a tap on a mirror in the driver's
 * seat shows that one (and a second tap puts it away again).  A car has all
 * three, a truck, a bus or a tractor only the two outside ones, the tram's
 * cab none.  Nothing here draws or knows about three.js: it is the state,
 * kept apart so that it can be tested.
 */

/** the mirrors by their names (render/mirrors.ts MirrorSpec.name), in the order the key goes round them */
export const MIRROR_ORDER: readonly string[] = ['left', 'right', 'inside'];

export class MirrorLook {
  /** the mirror shown large (its name), or null: none */
  shown: string | null = null;

  /** The next one of the mirrors the vehicle has (`have`, by name) – after the last of them, none. */
  next(have: readonly string[]): string | null {
    const order = MIRROR_ORDER.filter((n) => have.includes(n));
    const i = this.shown === null ? -1 : order.indexOf(this.shown);
    this.shown = i + 1 < order.length ? order[i + 1] : null;
    return this.shown;
  }

  /** A mirror was tapped: that one large – or, if it is the one shown already, none. */
  pick(name: string, have: readonly string[]): string | null {
    this.shown = this.shown === name || !have.includes(name) ? null : name;
    return this.shown;
  }

  close(): void {
    this.shown = null;
  }

  /** The vehicle (or what it shows) changed: a mirror it does not have is shown no more. */
  keep(have: readonly string[]): string | null {
    if (this.shown !== null && !have.includes(this.shown)) this.shown = null;
    return this.shown;
  }
}

/** Where a mirror's glass is on the screen: its bounding box (px), and how far it is from the eye (m). */
export interface MirrorOnScreen {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  distance: number;
}

/**
 * The mirror a tap at (x, y) means: one whose glass is there, or – the glass
 * of a mirror is small on a phone – within `margin` pixels of it; of several,
 * the one the tap is deepest inside, then the nearest.  Null: none.
 */
export function mirrorAt(x: number, y: number, mirrors: readonly MirrorOnScreen[], margin = 24): string | null {
  let best: MirrorOnScreen | null = null;
  let bestOut = Infinity;
  for (const m of mirrors) {
    // how far outside the box the tap lies (0: inside)
    const out = Math.hypot(Math.max(0, m.x0 - x, x - m.x1), Math.max(0, m.y0 - y, y - m.y1));
    if (out > margin) continue;
    if (out < bestOut - 1e-9 || (Math.abs(out - bestOut) <= 1e-9 && best && m.distance < best.distance)) {
      best = m;
      bestOut = out;
    }
  }
  return best ? best.name : null;
}

/**
 * The shape of the panel the mirror is shown in: width : height of its glass,
 * kept within limits – so that a tall truck mirror or a long, narrow inside
 * mirror still gives a picture that fits the upper half of a screen.
 */
export function zoomAspect(glassWidth: number, glassHeight: number): number {
  const a = glassHeight > 0 ? glassWidth / glassHeight : 1.6;
  return Math.max(1.4, Math.min(2.6, a));
}

/**
 * The panel on a screen of `w` × `h` pixels: as large as the upper half of
 * the screen allows (and most of its width), centred, its top `top` pixels
 * down – with the shape `aspect` (width : height).
 */
export function zoomPanel(w: number, h: number, aspect: number, top: number): { x: number; y: number; w: number; h: number } {
  // (its foot at the middle of the screen – a little lower on a short one, where the top is taken by the controls)
  const maxH = Math.max(60, h * 0.5 + 8 - top, h * 0.42);
  const maxW = Math.max(80, w * 0.94);
  let ph = Math.min(maxH, maxW / aspect);
  let pw = ph * aspect;
  if (pw > maxW) {
    pw = maxW;
    ph = pw / aspect;
  }
  pw = Math.round(pw);
  ph = Math.round(ph);
  return { x: Math.round((w - pw) / 2), y: Math.round(top), w: pw, h: ph };
}
