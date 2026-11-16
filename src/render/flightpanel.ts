// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The instrument panel of the light aeroplane (render/plane.ts), drawn on
 * canvases.  In front of the pilot the classic six – airspeed, attitude and
 * altitude in the upper row, turn coordinator, heading and vertical speed
 * below –, to their right the rev counter and the fuel and flap gauges, to
 * their left the warning lamps and the ignition key, under them the light
 * switches; in the middle of the panel the radios.  Symbols and numbers
 * only: there is nothing to translate.
 *
 * The pilot's half changes all the time and is redrawn at most 15 times a
 * second; the radios never change and are drawn once.
 */
import * as THREE from 'three';
import { TRAINER } from '../sim/flightspec.ts';

/** What the instruments show (a part of the aeroplane's visual state, render/plane.ts). */
export interface PanelReadings {
  iasKt: number;
  altitudeFt: number;
  vsFpm: number;
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  /** the ball of the turn coordinator: −1 … 1 (to the end of its tube), + = to the right */
  slip: number;
  turnRateDegS: number;
  rpmGauge: number;
  /** 0 … 1 */
  fuel: number;
  /** degrees */
  flapsGauge: number;
  stallWarning: boolean;
  parkingBrake: boolean;
  engineOn: boolean;
  /** the light switches below the instruments show these */
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean };
}

/**
 * Where the pictures lie on the panel (metres): x across the aeroplane from
 * its middle (+ to the right), v up the panel from the lower edge of the
 * pictures.  The pilot's instruments fill `left` … `split`, the radios
 * `split` … `right`.
 */
export const PANEL_AREA = { left: -0.52, split: -0.02, right: 0.52, height: 0.3125 } as const;

const DEG = Math.PI / 180;
const KT = 1.943844;
const FONT = '"DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
/** the panel's paint – the 3D panel around the pictures has the same colour (render/plane.ts) */
export const PANEL_PAINT = 0x3a3f45;
const PAINT_CSS = '#3a3f45';
const WHITE = '#eceff1';
const FACE = '#0b0c0e';

// ---- the pilot's half: 2048 pixels to the metre
const W = 1024;
const H = 640;
const S = W / (PANEL_AREA.split - PANEL_AREA.left);

/** An instrument: its middle and the radius of its face, in pixels. */
interface Dial {
  x: number;
  y: number;
  r: number;
}

const at = (x: number, v: number, r: number, scale = S, left: number = PANEL_AREA.left): Dial => ({
  x: (x - left) * scale,
  y: (PANEL_AREA.height - v) * scale,
  r: r * scale,
});

const ASI = at(-0.4, 0.222, 0.042);
const AI = at(-0.3, 0.222, 0.042);
const ALT = at(-0.2, 0.222, 0.042);
const TC = at(-0.4, 0.122, 0.042);
const HI = at(-0.3, 0.122, 0.042);
const VSI = at(-0.2, 0.122, 0.042);
const TACH = at(-0.094, 0.222, 0.038);
const FUEL = at(-0.125, 0.12, 0.024);
const FLAPS = at(-0.063, 0.12, 0.024);
const LAMPS = [0.27, 0.225, 0.18, 0.135].map((v) => at(-0.485, v, 0.0115));
const KEY = at(-0.485, 0.062, 0.016);
const SWITCHES = [-0.45, -0.415, -0.38, -0.345, -0.31].map((x) => at(x, 0.034, 0.009));

/** A point at clock angle `a` (0 = 12 o'clock, clockwise) and `k` radii from the middle. */
function polar(d: Dial, a: number, k: number): [number, number] {
  return [d.x + Math.sin(a) * d.r * k, d.y - Math.cos(a) * d.r * k];
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** The square bezel with its four screws and the black face of a round instrument. */
function bezel(c: CanvasRenderingContext2D, d: Dial): void {
  const b = d.r * 1.13;
  roundRect(c, d.x - b, d.y - b, 2 * b, 2 * b, d.r * 0.22);
  c.fillStyle = '#1a1c1f';
  c.fill();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      c.beginPath();
      c.arc(d.x + sx * d.r * 0.93, d.y + sy * d.r * 0.93, d.r * 0.065, 0, Math.PI * 2);
      c.fillStyle = '#5b6066';
      c.fill();
    }
  }
  c.beginPath();
  c.arc(d.x, d.y, d.r * 1.02, 0, Math.PI * 2);
  c.fillStyle = '#2b2e32';
  c.fill();
  c.beginPath();
  c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  c.fillStyle = FACE;
  c.fill();
}

function ticks(c: CanvasRenderingContext2D, d: Dial, values: number[], angle: (v: number) => number, k0: number, k1: number, width: number, colour = WHITE): void {
  c.beginPath();
  for (const v of values) {
    const a = angle(v);
    const [x0, y0] = polar(d, a, k0);
    const [x1, y1] = polar(d, a, k1);
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }
  c.lineWidth = width;
  c.strokeStyle = colour;
  c.lineCap = 'butt';
  c.stroke();
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour = WHITE, weight = 600): void {
  c.font = `${weight} ${Math.round(size)}px ${FONT}`;
  c.fillStyle = colour;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

function numbers(c: CanvasRenderingContext2D, d: Dial, values: number[], angle: (v: number) => number, k: number, size: number, label: (v: number) => string = String): void {
  for (const v of values) {
    const [x, y] = polar(d, angle(v), k);
    text(c, label(v), x, y, size);
  }
}

/** A coloured band along the scale, from clock angle a0 to a1. */
function band(c: CanvasRenderingContext2D, d: Dial, a0: number, a1: number, k: number, width: number, colour: string): void {
  c.beginPath();
  c.arc(d.x, d.y, d.r * k, a0 - Math.PI / 2, a1 - Math.PI / 2);
  c.lineWidth = width;
  c.strokeStyle = colour;
  c.lineCap = 'butt';
  c.stroke();
}

/** A pointer from the middle of `d` (or `pivot`) at clock angle `a`. */
function needle(c: CanvasRenderingContext2D, d: Dial, a: number, length: number, width: number, colour = WHITE, tail = 0.16, pivot?: [number, number]): void {
  const [px, py] = pivot ?? [d.x, d.y];
  c.save();
  c.translate(px, py);
  c.rotate(a);
  const l = d.r * length;
  const w = d.r * width;
  c.beginPath();
  c.moveTo(-w, d.r * tail);
  c.lineTo(-w * 0.55, -l * 0.9);
  c.lineTo(0, -l);
  c.lineTo(w * 0.55, -l * 0.9);
  c.lineTo(w, d.r * tail);
  c.closePath();
  c.fillStyle = colour;
  c.fill();
  c.restore();
}

function hub(c: CanvasRenderingContext2D, d: Dial, k = 0.09): void {
  c.beginPath();
  c.arc(d.x, d.y, d.r * k, 0, Math.PI * 2);
  c.fillStyle = '#26292d';
  c.fill();
}

// ---- the scales
const VS0 = TRAINER.vs0 * KT;
const VS1 = TRAINER.vs1 * KT;
const VNE = TRAINER.vne * KT;
// (the measures give no flap or structural limit: the usual proportions of a trainer)
const VFE = Math.round(VS0 * 1.9);
const VNO = Math.round(VNE * 0.79);

/** Airspeed: 40 kt at 12 o'clock, 180 kt three quarters round; below 40 kt the scale is squeezed. */
const asiAngle = (kt: number): number => {
  const v = Math.max(0, Math.min(186, kt));
  return (v < 40 ? -35 + (v / 40) * 35 : ((v - 40) / 140) * 315) * DEG;
};
/** Vertical speed: 0 at 9 o'clock, climbing clockwise; 1000 ft/min at 100°, 2000 at 170°. */
const vsiAngle = (fpm: number): number => {
  const v = Math.max(-2000, Math.min(2000, Number.isFinite(fpm) ? fpm : 0));
  const m = Math.abs(v);
  return (-90 + Math.sign(v) * (m <= 1000 ? m / 10 : 100 + (m - 1000) * 0.07)) * DEG;
};
const tachAngle = (rpm: number): number => (-135 + (Math.max(0, Math.min(3550, rpm)) / 3500) * 270) * DEG;
const fuelAngle = (f: number): number => (-60 + Math.max(0, Math.min(1.02, f)) * 120) * DEG;
const flapAngle = (deg: number): number => (90 + Math.max(0, Math.min(TRAINER.flapsMax + 2, deg)) * 1.6) * DEG;

export class FlightPanel {
  /** the pilot's instruments (redrawn) */
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  /** the radios in the middle and the passenger's side (drawn once) */
  readonly radios: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly face = document.createElement('canvas');
  private readonly card = document.createElement('canvas');
  private last = -1;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.face.width = W;
    this.face.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.drawFace();
    this.drawCard();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // seen about as large as it is drawn: no mip-maps to rebuild at every redraw
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.radios = drawRadios();
    // never a blank panel: until the first update it shows the instruments at rest
    this.draw(REST);
  }

  /**
   * Redraw the instruments – at most 15 times a second.  True if it drew
   * (a caller that knows the panel is out of sight need not call at all).
   */
  update(r: PanelReadings, now: number): boolean {
    // (a clock that jumps back must not freeze the panel: only a short step forward counts as "just drawn")
    const since = now - this.last;
    if (this.last >= 0 && since >= 0 && since < 1 / 15 - 1e-3) return false;
    this.last = now;
    this.draw(r);
    return true;
  }

  dispose(): void {
    this.texture.dispose();
    this.radios.dispose();
  }

  // -------------------------------------------------------------------------- static faces
  private drawFace(): void {
    const c = this.face.getContext('2d')!;
    c.fillStyle = PAINT_CSS;
    c.fillRect(0, 0, W, H);
    for (const d of [ASI, AI, ALT, TC, HI, VSI, TACH, FUEL, FLAPS]) bezel(c, d);

    // airspeed (kt) with the white flap range, the green normal range, the yellow caution range and the red line
    band(c, ASI, asiAngle(VS0), asiAngle(VFE), 0.8, ASI.r * 0.07, '#f4f4f4');
    band(c, ASI, asiAngle(VS1), asiAngle(VNO), 0.9, ASI.r * 0.09, '#2fae4e');
    band(c, ASI, asiAngle(VNO), asiAngle(VNE), 0.9, ASI.r * 0.09, '#f0c419');
    ticks(c, ASI, [VNE], asiAngle, 0.78, 0.98, ASI.r * 0.06, '#e2231a');
    ticks(c, ASI, range(45, 180, 10), asiAngle, 0.86, 0.96, ASI.r * 0.022);
    ticks(c, ASI, range(40, 180, 10), asiAngle, 0.8, 0.96, ASI.r * 0.04);
    numbers(c, ASI, range(40, 180, 20), asiAngle, 0.6, ASI.r * 0.2);
    text(c, 'kt', ASI.x, ASI.y + ASI.r * 0.36, ASI.r * 0.15, '#aab2b9', 500);

    // altimeter: 0 … 9 hundred feet, a tick every 20 ft, the pressure window at 3 o'clock
    const altA = (v: number): number => (v / 10) * Math.PI * 2;
    ticks(c, ALT, range(0, 9.8, 0.2), altA, 0.87, 0.96, ALT.r * 0.022);
    ticks(c, ALT, range(0, 9, 1), altA, 0.78, 0.96, ALT.r * 0.045);
    numbers(c, ALT, range(0, 9, 1), altA, 0.62, ALT.r * 0.22);
    roundRect(c, ALT.x + ALT.r * 0.38, ALT.y - ALT.r * 0.1, ALT.r * 0.42, ALT.r * 0.2, ALT.r * 0.03);
    c.fillStyle = '#d9dcdf';
    c.fill();
    text(c, '1013', ALT.x + ALT.r * 0.59, ALT.y + ALT.r * 0.005, ALT.r * 0.15, '#15181b', 700);
    text(c, 'ft', ALT.x, ALT.y - ALT.r * 0.32, ALT.r * 0.14, '#aab2b9', 500);

    // turn coordinator: wings-level and standard-rate marks, the tube of the ball
    ticks(c, TC, [90, 270].map((a) => a * DEG), (a) => a, 0.74, 0.95, TC.r * 0.05);
    ticks(c, TC, [110, 250].map((a) => a * DEG), (a) => a, 0.74, 0.95, TC.r * 0.05);
    const tube = this.tubeShape();
    c.beginPath();
    c.arc(tube.cx, tube.cy, tube.R, (90 + 24) * DEG, (90 - 24) * DEG, true);
    c.lineWidth = TC.r * 0.24;
    c.strokeStyle = '#5c5a4c';
    c.lineCap = 'round';
    c.stroke();
    c.lineWidth = TC.r * 0.19;
    c.strokeStyle = '#c9c3a2';
    c.stroke();
    c.lineCap = 'butt';
    for (const s of [-1, 1]) {
      const a = (90 + s * 6.3) * DEG;
      c.beginPath();
      c.moveTo(tube.cx + Math.cos(a) * (tube.R - TC.r * 0.12), tube.cy + Math.sin(a) * (tube.R - TC.r * 0.12));
      c.lineTo(tube.cx + Math.cos(a) * (tube.R + TC.r * 0.12), tube.cy + Math.sin(a) * (tube.R + TC.r * 0.12));
      c.lineWidth = TC.r * 0.025;
      c.strokeStyle = '#1b1c1e';
      c.stroke();
    }

    // vertical speed (×100 ft/min): up above, down below
    const vs = (v: number): number => vsiAngle(v);
    ticks(c, VSI, [...range(-1000, 1000, 100), ...range(1250, 2000, 250), ...range(-2000, -1250, 250)], vs, 0.86, 0.96, VSI.r * 0.022);
    ticks(c, VSI, [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000], vs, 0.78, 0.96, VSI.r * 0.045);
    numbers(c, VSI, [0, 500, 1000, 1500, 2000, -500, -1000, -1500, -2000], vs, 0.6, VSI.r * 0.2, (v) => String(Math.abs(v / 100)));
    text(c, '▲', VSI.x + VSI.r * 0.08, VSI.y - VSI.r * 0.3, VSI.r * 0.15, '#aab2b9');
    text(c, '▼', VSI.x + VSI.r * 0.08, VSI.y + VSI.r * 0.3, VSI.r * 0.15, '#aab2b9');
    text(c, '×100 ft/min', VSI.x + VSI.r * 0.2, VSI.y + VSI.r * 0.005, VSI.r * 0.11, '#aab2b9', 500);

    // rev counter (×100 /min) with its green range and red line
    band(c, TACH, tachAngle(2100), tachAngle(2700), 0.9, TACH.r * 0.09, '#2fae4e');
    ticks(c, TACH, [2700], tachAngle, 0.76, 0.98, TACH.r * 0.06, '#e2231a');
    ticks(c, TACH, range(0, 3500, 100), tachAngle, 0.87, 0.96, TACH.r * 0.022);
    ticks(c, TACH, range(0, 3500, 500), tachAngle, 0.78, 0.96, TACH.r * 0.045);
    numbers(c, TACH, range(0, 3500, 500), tachAngle, 0.6, TACH.r * 0.21, (v) => String(v / 100));
    text(c, '×100 /min', TACH.x, TACH.y + TACH.r * 0.4, TACH.r * 0.13, '#aab2b9', 500);

    // fuel: empty … full with a red reserve, a pump drawn below
    band(c, FUEL, fuelAngle(0), fuelAngle(0.12), 0.88, FUEL.r * 0.14, '#e2231a');
    ticks(c, FUEL, [0, 0.25, 0.5, 0.75, 1], fuelAngle, 0.72, 0.96, FUEL.r * 0.06);
    text(c, '0', ...polar(FUEL, fuelAngle(0), 0.5), FUEL.r * 0.3);
    text(c, '1', ...polar(FUEL, fuelAngle(1), 0.5), FUEL.r * 0.3);
    pump(c, FUEL.x, FUEL.y + FUEL.r * 0.5, FUEL.r * 0.32);

    // flaps: the pointer droops like the flap, marks at the detents
    const detents = [0, 10, 20, 30];
    ticks(c, FLAPS, detents, flapAngle, 0.72, 0.96, FLAPS.r * 0.06);
    numbers(c, FLAPS, detents, flapAngle, 0.5, FLAPS.r * 0.26);
    // the wing in front of the flap, drawn small on the left half
    c.beginPath();
    c.ellipse(FLAPS.x - FLAPS.r * 0.5, FLAPS.y, FLAPS.r * 0.4, FLAPS.r * 0.11, 0, 0, Math.PI * 2);
    c.fillStyle = '#aab2b9';
    c.fill();

    // the ignition key: off – right – left – both – start
    c.beginPath();
    c.arc(KEY.x, KEY.y, KEY.r, 0, Math.PI * 2);
    c.fillStyle = '#1a1c1f';
    c.fill();
    c.beginPath();
    c.arc(KEY.x, KEY.y, KEY.r * 0.62, 0, Math.PI * 2);
    c.fillStyle = '#b9bec4';
    c.fill();
    ticks(c, KEY, [-60, -30, 0, 30, 60].map((a) => a * DEG), (a) => a, 1.08, 1.32, KEY.r * 0.09);
    // the light switches' plate
    const s0 = SWITCHES[0];
    const s1 = SWITCHES[SWITCHES.length - 1];
    roundRect(c, s0.x - s0.r * 2.4, s0.y - s0.r * 3.4, s1.x - s0.x + s0.r * 4.8, s0.r * 6.8, s0.r * 0.6);
    c.fillStyle = '#2a2e33';
    c.fill();
  }

  /** The inclinometer's tube: an arc of a circle whose middle lies above the instrument's middle. */
  private tubeShape(): { cx: number; cy: number; R: number } {
    return { cx: TC.x, cy: TC.y - TC.r * 0.62, R: TC.r * 1.3 };
  }

  /** The compass card of the heading indicator, drawn once and turned. */
  private drawCard(): void {
    const r = HI.r;
    const size = Math.ceil(r * 2);
    this.card.width = size;
    this.card.height = size;
    const c = this.card.getContext('2d')!;
    const d: Dial = { x: size / 2, y: size / 2, r };
    c.beginPath();
    c.arc(d.x, d.y, r * 0.99, 0, Math.PI * 2);
    c.fillStyle = FACE;
    c.fill();
    const deg = (v: number): number => v * DEG;
    ticks(c, d, range(0, 355, 5), deg, 0.86, 0.97, r * 0.022);
    ticks(c, d, range(0, 350, 10), deg, 0.78, 0.97, r * 0.04);
    const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (const v of range(0, 330, 30)) {
      c.save();
      c.translate(...polar(d, deg(v), 0.6));
      c.rotate(deg(v));
      text(c, names[v] ?? String(v / 10), 0, 0, r * (names[v] ? 0.24 : 0.2), names[v] ? '#ffffff' : WHITE, 700);
      c.restore();
    }
  }

  // -------------------------------------------------------------------------- the moving parts
  private draw(r: PanelReadings): void {
    const c = this.ctx;
    c.drawImage(this.face, 0, 0);
    const num = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

    needle(c, ASI, asiAngle(num(r.iasKt)), 0.9, 0.055);
    hub(c, ASI);

    this.attitude(c, num(r.pitchDeg), num(r.bankDeg));

    // altimeter: the long hand hundreds, the short one thousands, the thin one ten thousands
    const alt = num(r.altitudeFt);
    needle(c, ALT, (alt / 100000) * Math.PI * 2, 0.98, 0.025, '#d0d4d8', 0.05);
    needle(c, ALT, (alt / 10000) * Math.PI * 2, 0.55, 0.1, WHITE, 0.12);
    needle(c, ALT, (alt / 1000) * Math.PI * 2, 0.9, 0.055, WHITE, 0.2);
    hub(c, ALT);

    this.turn(c, num(r.turnRateDegS), num(r.slip));

    // heading: the card turns under the lubber line
    c.save();
    c.beginPath();
    c.arc(HI.x, HI.y, HI.r, 0, Math.PI * 2);
    c.clip();
    c.translate(HI.x, HI.y);
    c.rotate(-num(r.headingDeg) * DEG);
    c.drawImage(this.card, -this.card.width / 2, -this.card.height / 2);
    c.restore();
    ticks(c, HI, range(45, 315, 45), (v) => v * DEG, 1.0, 1.1, HI.r * 0.05, '#ffffff');
    c.beginPath();
    c.moveTo(HI.x, HI.y - HI.r * 0.76);
    c.lineTo(HI.x - HI.r * 0.07, HI.y - HI.r * 1.0);
    c.lineTo(HI.x + HI.r * 0.07, HI.y - HI.r * 1.0);
    c.closePath();
    c.fillStyle = '#ff8a1e';
    c.fill();
    plane(c, HI.x, HI.y, HI.r * 0.42, '#ff8a1e');

    needle(c, VSI, vsiAngle(num(r.vsFpm)), 0.9, 0.055);
    hub(c, VSI);

    needle(c, TACH, tachAngle(num(r.rpmGauge)), 0.9, 0.06);
    hub(c, TACH);

    needle(c, FUEL, fuelAngle(num(r.fuel)), 0.85, 0.09, WHITE, 0.2);
    hub(c, FUEL, 0.14);
    needle(c, FLAPS, flapAngle(num(r.flapsGauge)), 0.92, 0.1, '#f0f0f0', 0.25);
    hub(c, FLAPS, 0.14);

    // warning lamps: stall, parking brake, oil pressure and charging (both out while the engine stands)
    lamp(c, LAMPS[0], r.stallWarning, '#ff3b22', (x, y, s, ink) => warning(c, x, y, s, ink));
    lamp(c, LAMPS[1], r.parkingBrake, '#ff3b22', (x, y, s, ink) => text(c, '(P)', x, y + s * 0.04, s * 0.9, ink, 800));
    lamp(c, LAMPS[2], !r.engineOn, '#ff3b22', (x, y, s, ink) => oilCan(c, x, y, s, ink));
    lamp(c, LAMPS[3], !r.engineOn, '#ff3b22', (x, y, s, ink) => battery(c, x, y, s, ink));

    // the light switches: beacon, landing, taxi, navigation, strobe
    const L = r.lights;
    const states = [L.beacon, L.landing, L.taxi, L.nav, L.strobe];
    SWITCHES.forEach((d, i) => {
      rocker(c, d, states[i]);
      lightIcon(c, i, d.x, d.y - d.r * 2.5, d.r * 1.1);
    });
    this.texture.needsUpdate = true;
  }

  /** The attitude indicator: sky and ground turn with the bank and slide with the pitch behind the fixed aeroplane. */
  private attitude(c: CanvasRenderingContext2D, pitch: number, bank: number): void {
    const d = AI;
    const R = d.r;
    const sky = '#2f78c6';
    const ground = '#7b4f2b';
    c.save();
    c.beginPath();
    c.arc(d.x, d.y, R * 0.995, 0, Math.PI * 2);
    c.clip();
    c.translate(d.x, d.y);
    c.rotate(-bank * DEG);
    // the outer ring: sky and ground halves, turning with the bank only
    c.fillStyle = sky;
    c.fillRect(-R, -R, 2 * R, R);
    c.fillStyle = ground;
    c.fillRect(-R, 0, 2 * R, R);
    // the pointer of the bank scale, on the turning ring
    c.beginPath();
    c.moveTo(0, -R * 0.74);
    c.lineTo(-R * 0.07, -R * 0.6);
    c.lineTo(R * 0.07, -R * 0.6);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.fill();
    // the ball inside: also slides with the pitch
    c.beginPath();
    c.arc(0, 0, R * 0.72, 0, Math.PI * 2);
    c.clip();
    const k = R * 0.034;
    const off = Math.max(-40, Math.min(40, pitch)) * k;
    c.translate(0, off);
    c.fillStyle = '#3a8ad8';
    c.fillRect(-R, -R * 3, 2 * R, R * 3);
    c.fillStyle = '#8a5a31';
    c.fillRect(-R, 0, 2 * R, R * 3);
    c.fillStyle = '#ffffff';
    c.fillRect(-R, -R * 0.012, 2 * R, R * 0.024);
    c.strokeStyle = '#ffffff';
    c.lineWidth = R * 0.022;
    c.beginPath();
    for (const p of [-20, -15, -10, -5, 5, 10, 15, 20]) {
      const y = -p * k;
      const half = p % 10 === 0 ? R * 0.26 : R * 0.12;
      c.moveTo(-half, y);
      c.lineTo(half, y);
    }
    c.stroke();
    for (const p of [-20, -10, 10, 20]) {
      const y = -p * k;
      text(c, String(Math.abs(p)), -R * 0.38, y, R * 0.13, '#ffffff', 700);
      text(c, String(Math.abs(p)), R * 0.38, y, R * 0.13, '#ffffff', 700);
    }
    c.restore();
    // the fixed bank scale: 10°, 20°, 30°, 45°, 60° either side
    c.save();
    c.translate(d.x, d.y);
    c.strokeStyle = '#ffffff';
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const long = Math.abs(a) === 30 || Math.abs(a) === 60;
      c.lineWidth = R * (long ? 0.045 : 0.03);
      c.beginPath();
      c.moveTo(Math.sin(a * DEG) * R * 0.8, -Math.cos(a * DEG) * R * 0.8);
      c.lineTo(Math.sin(a * DEG) * R * (long ? 0.99 : 0.92), -Math.cos(a * DEG) * R * (long ? 0.99 : 0.92));
      c.stroke();
    }
    c.beginPath();
    c.moveTo(0, -R * 0.8);
    c.lineTo(-R * 0.08, -R * 0.98);
    c.lineTo(R * 0.08, -R * 0.98);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.fill();
    // the little aeroplane: wings, a dot, a tail post below
    c.fillStyle = '#ff9a1e';
    c.strokeStyle = '#1d1f22';
    c.lineWidth = R * 0.015;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * R * 0.62, -R * 0.03);
      c.lineTo(s * R * 0.22, -R * 0.03);
      c.lineTo(s * R * 0.14, R * 0.06);
      c.lineTo(s * R * 0.2, R * 0.06);
      c.lineTo(s * R * 0.25, R * 0.03);
      c.lineTo(s * R * 0.62, R * 0.03);
      c.closePath();
      c.fill();
      c.stroke();
    }
    c.beginPath();
    c.arc(0, 0, R * 0.04, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillRect(-R * 0.02, R * 0.36, R * 0.04, R * 0.32);
    c.restore();
  }

  /** The turn coordinator: the little aeroplane banks with the rate of turn, the ball rolls with the slip. */
  private turn(c: CanvasRenderingContext2D, rate: number, slip: number): void {
    const d = TC;
    const R = d.r;
    // a turn at the standard rate (3°/s) puts the wing on the lower mark
    const tilt = Math.max(-1.7, Math.min(1.7, rate / 3)) * 20 * DEG;
    c.save();
    c.translate(d.x, d.y - R * 0.06);
    c.rotate(tilt);
    c.fillStyle = '#eef0f2';
    c.fillRect(-R * 0.72, -R * 0.035, R * 1.44, R * 0.07);
    c.beginPath();
    c.arc(0, 0, R * 0.11, 0, Math.PI * 2);
    c.fill();
    c.fillRect(-R * 0.025, -R * 0.24, R * 0.05, R * 0.16);
    c.fillRect(-R * 0.2, -R * 0.13, R * 0.4, R * 0.04);
    c.restore();
    // the ball
    const t = this.tubeShape();
    const a = (90 - Math.max(-1, Math.min(1, slip)) * 21) * DEG;
    c.beginPath();
    c.arc(t.cx + Math.cos(a) * t.R, t.cy + Math.sin(a) * t.R, R * 0.085, 0, Math.PI * 2);
    c.fillStyle = '#111214';
    c.fill();
    hub(c, { x: d.x, y: d.y - R * 0.06, r: R }, 0.05);
  }
}

/** The instruments at rest: on the ground, engine off. */
const REST: PanelReadings = {
  iasKt: 0,
  altitudeFt: 0,
  vsFpm: 0,
  headingDeg: 0,
  pitchDeg: 0,
  bankDeg: 0,
  slip: 0,
  turnRateDegS: 0,
  rpmGauge: 0,
  fuel: 0.5,
  flapsGauge: 0,
  stallWarning: false,
  parkingBrake: true,
  engineOn: false,
  lights: { nav: false, beacon: false, strobe: false, landing: false, taxi: false },
};

/** A small aeroplane seen from above (the heading indicator's index). */
function plane(c: CanvasRenderingContext2D, x: number, y: number, s: number, colour: string): void {
  c.save();
  c.translate(x, y);
  c.fillStyle = colour;
  c.fillRect(-s * 0.06, -s * 0.6, s * 0.12, s * 1.25);
  c.fillRect(-s * 0.62, -s * 0.18, s * 1.24, s * 0.16);
  c.fillRect(-s * 0.26, s * 0.48, s * 0.52, s * 0.1);
  c.restore();
}

/** A warning lamp: dark glass, lit in its colour, with its symbol. */
function lamp(c: CanvasRenderingContext2D, d: Dial, on: boolean, colour: string, icon: (x: number, y: number, s: number, ink: string) => void): void {
  c.beginPath();
  c.arc(d.x, d.y, d.r * 1.25, 0, Math.PI * 2);
  c.fillStyle = '#1a1c1f';
  c.fill();
  c.beginPath();
  c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  if (on) {
    const g = c.createRadialGradient(d.x, d.y - d.r * 0.3, d.r * 0.1, d.x, d.y, d.r);
    g.addColorStop(0, '#ffd2c4');
    g.addColorStop(0.45, colour);
    g.addColorStop(1, '#8a1a10');
    c.fillStyle = g;
  } else {
    c.fillStyle = '#3b1d1a';
  }
  c.fill();
  icon(d.x, d.y, d.r, on ? '#2a0804' : '#5e3b37');
}

function warning(c: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string): void {
  c.beginPath();
  c.moveTo(x, y - s * 0.62);
  c.lineTo(x + s * 0.62, y + s * 0.48);
  c.lineTo(x - s * 0.62, y + s * 0.48);
  c.closePath();
  c.lineWidth = s * 0.14;
  c.strokeStyle = ink;
  c.lineJoin = 'round';
  c.stroke();
  c.fillStyle = ink;
  c.fillRect(x - s * 0.055, y - s * 0.24, s * 0.11, s * 0.4);
  c.fillRect(x - s * 0.055, y + s * 0.24, s * 0.11, s * 0.11);
}

function oilCan(c: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string): void {
  c.fillStyle = ink;
  c.fillRect(x - s * 0.5, y - s * 0.05, s * 0.62, s * 0.38);
  c.beginPath();
  c.moveTo(x + s * 0.12, y - s * 0.02);
  c.lineTo(x + s * 0.66, y - s * 0.22);
  c.lineTo(x + s * 0.66, y - s * 0.1);
  c.lineTo(x + s * 0.12, y + s * 0.16);
  c.closePath();
  c.fill();
  c.fillRect(x - s * 0.26, y - s * 0.26, s * 0.14, s * 0.22);
  c.beginPath();
  c.arc(x + s * 0.66, y + s * 0.22, s * 0.08, 0, Math.PI * 2);
  c.fill();
}

function battery(c: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string): void {
  c.lineWidth = s * 0.12;
  c.strokeStyle = ink;
  c.strokeRect(x - s * 0.56, y - s * 0.3, s * 1.12, s * 0.66);
  c.fillStyle = ink;
  c.fillRect(x - s * 0.42, y - s * 0.46, s * 0.2, s * 0.14);
  c.fillRect(x + s * 0.22, y - s * 0.46, s * 0.2, s * 0.14);
  c.fillRect(x - s * 0.42, y - s * 0.02, s * 0.22, s * 0.09);
  c.fillRect(x + s * 0.2, y - s * 0.02, s * 0.22, s * 0.09);
  c.fillRect(x + s * 0.265, y - s * 0.085, s * 0.09, s * 0.22);
}

function pump(c: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  c.fillStyle = '#aab2b9';
  c.fillRect(x - s * 0.45, y - s * 0.55, s * 0.6, s * 1.1);
  c.fillStyle = FACE;
  c.fillRect(x - s * 0.33, y - s * 0.42, s * 0.36, s * 0.3);
  c.strokeStyle = '#aab2b9';
  c.lineWidth = s * 0.12;
  c.beginPath();
  c.moveTo(x + s * 0.15, y - s * 0.2);
  c.lineTo(x + s * 0.42, y - s * 0.05);
  c.lineTo(x + s * 0.42, y + s * 0.4);
  c.stroke();
}

/** A rocker switch, its upper half pressed (and its lamp lit) when on. */
function rocker(c: CanvasRenderingContext2D, d: Dial, on: boolean): void {
  const w = d.r * 1.5;
  const h = d.r * 2.6;
  roundRect(c, d.x - w / 2, d.y - h / 2, w, h, d.r * 0.25);
  c.fillStyle = '#0f1012';
  c.fill();
  roundRect(c, d.x - w / 2 + 2, on ? d.y - h / 2 + 2 : d.y + 1, w - 4, h / 2 - 3, d.r * 0.2);
  c.fillStyle = on ? '#cfd3d6' : '#5a5f65';
  c.fill();
  c.beginPath();
  c.arc(d.x, d.y + h / 2 + d.r * 0.55, d.r * 0.22, 0, Math.PI * 2);
  c.fillStyle = on ? '#4cff6a' : '#1f3323';
  c.fill();
}

/** The symbols of the light switches: beacon, landing light, taxi light, navigation lights, strobes. */
function lightIcon(c: CanvasRenderingContext2D, i: number, x: number, y: number, s: number): void {
  c.save();
  c.strokeStyle = '#d9dde0';
  c.fillStyle = '#d9dde0';
  c.lineWidth = s * 0.14;
  if (i === 0) {
    // a red dome with rays
    c.beginPath();
    c.arc(x, y + s * 0.15, s * 0.32, Math.PI, 0);
    c.fillStyle = '#ff4a3a';
    c.fill();
    for (const a of [-60, -30, 0, 30, 60]) {
      c.beginPath();
      c.moveTo(x + Math.sin(a * DEG) * s * 0.45, y + s * 0.1 - Math.cos(a * DEG) * s * 0.45);
      c.lineTo(x + Math.sin(a * DEG) * s * 0.72, y + s * 0.1 - Math.cos(a * DEG) * s * 0.72);
      c.stroke();
    }
  } else if (i === 1 || i === 2) {
    // a lamp throwing its beam forward (long for landing, dipped for taxiing)
    c.beginPath();
    c.arc(x - s * 0.25, y, s * 0.3, Math.PI / 2, -Math.PI / 2, true);
    c.closePath();
    c.fill();
    for (const k of [-1, 0, 1]) {
      c.beginPath();
      c.moveTo(x, y + k * s * 0.22);
      c.lineTo(x + s * 0.62, y + k * s * 0.22 + (i === 2 ? s * 0.18 : 0));
      c.stroke();
    }
  } else if (i === 3) {
    // red and green
    c.beginPath();
    c.arc(x - s * 0.3, y, s * 0.24, 0, Math.PI * 2);
    c.fillStyle = '#ff4a3a';
    c.fill();
    c.beginPath();
    c.arc(x + s * 0.3, y, s * 0.24, 0, Math.PI * 2);
    c.fillStyle = '#3fdc6a';
    c.fill();
  } else {
    // a flash
    c.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      c.moveTo(x + Math.cos(a) * s * 0.18, y + Math.sin(a) * s * 0.18);
      c.lineTo(x + Math.cos(a) * s * 0.6, y + Math.sin(a) * s * 0.6);
    }
    c.stroke();
  }
  c.restore();
}

// ------------------------------------------------------------------ the radios, drawn once
/** The middle and the right of the panel: radio stack, clock, hour meter, glove box, circuit breakers. */
function drawRadios(): THREE.CanvasTexture {
  const scale = 1024 / (PANEL_AREA.right - PANEL_AREA.split);
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round(PANEL_AREA.height * scale);
  const c = canvas.getContext('2d')!;
  const X = (x: number): number => (x - PANEL_AREA.split) * scale;
  const Y = (v: number): number => (PANEL_AREA.height - v) * scale;
  c.fillStyle = PAINT_CSS;
  c.fillRect(0, 0, canvas.width, canvas.height);
  /** a box of the stack from x0 … x1, v0 … v1 */
  const unit = (x0: number, x1: number, v0: number, v1: number): void => {
    roundRect(c, X(x0), Y(v1), X(x1) - X(x0), Y(v0) - Y(v1), 6);
    c.fillStyle = '#16181b';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = '#4b5056';
    c.stroke();
  };
  const display = (x0: number, x1: number, v0: number, v1: number, value: string, colour: string): void => {
    c.fillStyle = '#05070a';
    c.fillRect(X(x0), Y(v1), X(x1) - X(x0), Y(v0) - Y(v1));
    c.font = `700 ${Math.round((Y(v0) - Y(v1)) * 0.78)}px "DejaVu Sans Mono", "Roboto Mono", Consolas, monospace`;
    c.fillStyle = colour;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(value, (X(x0) + X(x1)) / 2, (Y(v0) + Y(v1)) / 2 + 1);
  };
  const knob = (x: number, v: number, r: number): void => {
    c.beginPath();
    c.arc(X(x), Y(v), r * scale, 0, Math.PI * 2);
    c.fillStyle = '#2c2f33';
    c.fill();
    c.beginPath();
    c.arc(X(x), Y(v), r * scale * 0.6, 0, Math.PI * 2);
    c.fillStyle = '#44484e';
    c.fill();
  };
  const button = (x: number, v: number, w: number, h: number, lit = false): void => {
    roundRect(c, X(x - w / 2), Y(v + h / 2), w * scale, h * scale, 4);
    c.fillStyle = lit ? '#cfd3d6' : '#3b3f45';
    c.fill();
  };
  // the audio panel
  unit(0.0, 0.19, 0.27, 0.297);
  for (let i = 0; i < 8; i++) button(0.016 + i * 0.022, 0.2835, 0.016, 0.012, i === 1 || i === 4);
  // radio and navigation receiver: active and standby frequencies
  unit(0.0, 0.19, 0.205, 0.262);
  display(0.008, 0.092, 0.236, 0.255, '122.800', '#3dff7a');
  display(0.008, 0.092, 0.213, 0.232, '118.300', '#2fbf5c');
  display(0.098, 0.182, 0.236, 0.255, '113.40', '#3dff7a');
  display(0.098, 0.182, 0.213, 0.232, '110.50', '#2fbf5c');
  // transponder
  unit(0.0, 0.19, 0.155, 0.197);
  display(0.06, 0.13, 0.166, 0.188, '7000', '#ffb02a');
  knob(0.025, 0.176, 0.011);
  knob(0.165, 0.176, 0.011);
  // the moving map: rivers, roads, a field
  unit(0.0, 0.19, 0.03, 0.147);
  c.fillStyle = '#0d1a14';
  c.fillRect(X(0.008), Y(0.14), X(0.182) - X(0.008), Y(0.037) - Y(0.14));
  c.save();
  c.beginPath();
  c.rect(X(0.008), Y(0.14), X(0.182) - X(0.008), Y(0.037) - Y(0.14));
  c.clip();
  c.lineCap = 'round';
  const path = (pts: number[][], colour: string, width: number): void => {
    c.beginPath();
    pts.forEach(([x, v], i) => (i ? c.lineTo(X(x), Y(v)) : c.moveTo(X(x), Y(v))));
    c.strokeStyle = colour;
    c.lineWidth = width;
    c.stroke();
  };
  path([[0.0, 0.06], [0.05, 0.075], [0.09, 0.07], [0.13, 0.1], [0.19, 0.12]], '#2b6fa8', 6);
  path([[0.03, 0.03], [0.07, 0.1], [0.1, 0.15]], '#7a6a3a', 4);
  path([[0.12, 0.03], [0.14, 0.09], [0.19, 0.1]], '#7a6a3a', 4);
  path([[0.095, 0.045], [0.095, 0.135]], '#ff4af0', 4);
  c.fillStyle = '#c8ccd0';
  c.fillRect(X(0.142) - 4, Y(0.072), 8, Y(0.052) - Y(0.072));
  c.restore();
  c.beginPath();
  c.moveTo(X(0.095), Y(0.094));
  c.lineTo(X(0.089), Y(0.08));
  c.lineTo(X(0.101), Y(0.08));
  c.closePath();
  c.fillStyle = '#ffffff';
  c.fill();
  // clock and hour meter
  const clock: Dial = { x: X(0.255), y: Y(0.235), r: 0.026 * scale };
  bezel(c, clock);
  ticks(c, clock, range(0, 330, 30).map((a) => a * DEG), (a) => a, 0.78, 0.95, clock.r * 0.07);
  needle(c, clock, 300 * DEG, 0.55, 0.08);
  needle(c, clock, 60 * DEG, 0.85, 0.05);
  hub(c, clock);
  roundRect(c, X(0.31), Y(0.276), 0.07 * scale, 0.02 * scale, 4);
  c.fillStyle = '#16181b';
  c.fill();
  display(0.315, 0.375, 0.259, 0.273, '1234.5', '#e8e8e8');
  // circuit breakers
  for (let i = 0; i < 9; i++) {
    c.beginPath();
    c.arc(X(0.225 + i * 0.024), Y(0.035), 0.0065 * scale, 0, Math.PI * 2);
    c.fillStyle = '#1a1c1f';
    c.fill();
    c.beginPath();
    c.arc(X(0.225 + i * 0.024), Y(0.035), 0.0035 * scale, 0, Math.PI * 2);
    c.fillStyle = '#c4c8cc';
    c.fill();
  }
  // the glove box with its latch
  roundRect(c, X(0.3), Y(0.2), 0.2 * scale, 0.125 * scale, 10);
  c.lineWidth = 4;
  c.strokeStyle = '#2a2e33';
  c.stroke();
  roundRect(c, X(0.385), Y(0.19), 0.03 * scale, 0.012 * scale, 4);
  c.fillStyle = '#1d2024';
  c.fill();
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
