// SPDX-License-Identifier: AGPL-3.0-only
/** Instrument cluster drawn into a canvas texture: rev counter, speedometer, telltales. */
import * as THREE from 'three';

export interface DashState {
  speedKmh: number;
  rpm: number;
  gear: number;
  /** -1 left, 0 off, 1 right (current lamp phase is in `blinkOn`) */
  indicator: number;
  hazard: boolean;
  blinkOn: boolean;
  lowBeam: boolean;
  highBeam: boolean;
  handbrake: boolean;
  ignition: boolean;
  engineRunning: boolean;
  abs: boolean;
  seatbelt: boolean;
  fuel: number;
  automatic: boolean;
  /** show the engaged gear (driver aid; a real manual car has no such display) */
  showGear: boolean;
  odometerKm: number;
}

const W = 768;
const H = 256;
const FONT = '"DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

export class InstrumentPanel {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly face = document.createElement('canvas');
  private last = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.face.width = W;
    this.face.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.drawFace();
    // never a blank cluster: until the first update it shows the dials, unlit
    this.ctx.drawImage(this.face, 0, 0);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  /** Static dial faces, drawn once. */
  private drawFace(): void {
    const c = this.face.getContext('2d')!;
    c.fillStyle = '#07090b';
    c.fillRect(0, 0, W, H);
    const dial = (cx: number, cy: number, r: number, max: number, major: number, minor: number, label: (v: number) => string, unit: string, redFrom = Infinity): void => {
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fillStyle = '#101418';
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = '#3a4047';
      c.stroke();
      const a0 = Math.PI * 0.75;
      const span = Math.PI * 1.5;
      for (let v = 0; v <= max + 1e-6; v += minor) {
        const a = a0 + (v / max) * span;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const r0 = r * (isMajor ? 0.8 : 0.87);
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        c.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94);
        c.lineWidth = isMajor ? 3.2 : 1.6;
        c.strokeStyle = v >= redFrom ? '#e03a2a' : '#e8ecef';
        c.stroke();
        if (isMajor) {
          c.fillStyle = v >= redFrom ? '#e03a2a' : '#e8ecef';
          c.font = `600 ${Math.round(r * 0.17)}px ${FONT}`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(label(v), cx + Math.cos(a) * r * 0.65, cy + Math.sin(a) * r * 0.65);
        }
      }
      c.fillStyle = '#9aa3ab';
      c.font = `500 ${Math.round(r * 0.13)}px ${FONT}`;
      c.textAlign = 'center';
      c.fillText(unit, cx, cy + r * 0.38);
    };
    dial(150, 128, 116, 7000, 1000, 250, (v) => String(v / 1000), '×1000/min', 6500);
    dial(W - 150, 128, 116, 240, 20, 10, (v) => String(v), 'km/h');
  }

  /** Redraw at most ~20 times a second. */
  update(s: DashState, now: number): void {
    // (a clock that starts below zero or jumps back must not stop the instruments:
    // only a short step forward counts as "drawn a moment ago")
    const since = now - this.last;
    if (since >= 0 && since < 0.045) return;
    this.last = now;
    const c = this.ctx;
    c.drawImage(this.face, 0, 0);
    const lit = s.ignition;
    const needle = (cx: number, cy: number, r: number, frac: number): void => {
      const a = Math.PI * 0.75 + Math.max(0, Math.min(1.02, frac)) * Math.PI * 1.5;
      c.save();
      c.translate(cx, cy);
      c.rotate(a);
      c.beginPath();
      c.moveTo(-r * 0.16, -3.5);
      c.lineTo(r * 0.9, -1.2);
      c.lineTo(r * 0.9, 1.2);
      c.lineTo(-r * 0.16, 3.5);
      c.closePath();
      c.fillStyle = '#ff5a2a';
      c.fill();
      c.restore();
      c.beginPath();
      c.arc(cx, cy, r * 0.1, 0, Math.PI * 2);
      c.fillStyle = '#22272c';
      c.fill();
    };
    needle(150, 128, 116, s.rpm / 7000);
    needle(W - 150, 128, 116, s.speedKmh / 240);

    // centre display
    const cx = W / 2;
    c.fillStyle = '#0b1014';
    c.fillRect(cx - 100, 28, 200, 200);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (lit) {
      c.fillStyle = '#e8ecef';
      c.font = `600 62px ${FONT}`;
      c.fillText(String(Math.round(Math.max(0, s.speedKmh))), cx, 92);
      c.font = `500 18px ${FONT}`;
      c.fillStyle = '#9aa3ab';
      c.fillText('km/h', cx, 132);
      if (s.showGear || s.automatic) {
        const g = s.automatic ? (s.gear === -2 ? 'P' : s.gear === -1 ? 'R' : s.gear === 0 ? 'N' : `D${s.gear}`) : s.gear === -1 ? 'R' : s.gear === 0 ? 'N' : String(s.gear);
        c.font = `600 30px ${FONT}`;
        c.fillStyle = '#ffd24a';
        c.fillText(g, cx, 166);
      }
      c.font = `500 15px ${FONT}`;
      c.fillStyle = '#7d868e';
      c.fillText(`${s.odometerKm.toFixed(1)} km`, cx, 196);
      // fuel bar
      c.strokeStyle = '#5b646c';
      c.lineWidth = 1.5;
      c.strokeRect(cx - 60, 210, 120, 9);
      c.fillStyle = s.fuel < 0.15 ? '#ffb020' : '#cfd6dc';
      c.fillRect(cx - 59, 211, 118 * Math.max(0, Math.min(1, s.fuel)), 7);
    }

    // telltales
    const lamp = (x: number, y: number, on: boolean, color: string, draw: () => void): void => {
      c.save();
      c.translate(x, y);
      c.globalAlpha = on ? 1 : 0.07;
      c.fillStyle = color;
      c.strokeStyle = color;
      c.lineWidth = 3;
      draw();
      c.restore();
    };
    const arrow = (dir: number) => (): void => {
      c.beginPath();
      c.moveTo(dir * 16, 0);
      c.lineTo(0, -13);
      c.lineTo(0, -6);
      c.lineTo(-dir * 14, -6);
      c.lineTo(-dir * 14, 6);
      c.lineTo(0, 6);
      c.lineTo(0, 13);
      c.closePath();
      c.fill();
    };
    const blink = s.blinkOn && lit;
    lamp(cx - 78, 18, blink && (s.hazard || s.indicator < 0), '#35d04a', arrow(-1));
    lamp(cx + 78, 18, blink && (s.hazard || s.indicator > 0), '#35d04a', arrow(1));
    const text = (t: string, size = 15) => (): void => {
      c.font = `700 ${size}px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(t, 0, 0);
    };
    lamp(cx - 30, 14, lit && s.lowBeam, '#35d04a', text('◐', 20));
    lamp(cx + 30, 14, lit && s.highBeam, '#3d8bff', text('◑', 20));
    lamp(300, 232, lit && s.handbrake, '#ff3b30', text('(P)', 17));
    lamp(W - 300, 232, lit && s.abs, '#ffb020', text('ABS', 14));
    lamp(262, 208, lit && !s.engineRunning, '#ff3b30', text('⚠', 20));
    lamp(W - 262, 208, lit && !s.seatbelt, '#ff3b30', text('🔔', 16));
    // the fuel lamp, right of the fuel bar: the reserve is reached
    lamp(cx + 78, 214, lit && s.fuel < 0.12, '#ffb020', () => {
      c.fillRect(-8, -8, 9, 16);
      c.fillRect(-10, 8, 13, 2.5);
      c.beginPath();
      c.moveTo(1, -5);
      c.lineTo(6, -1);
      c.lineTo(6, 5);
      c.lineWidth = 2;
      c.stroke();
    });
    this.texture.needsUpdate = true;
  }
}
