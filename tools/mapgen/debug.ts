// SPDX-License-Identifier: AGPL-3.0-only
/** Small SVG writer for eyeballing pipeline output (not used by the game). */
import { writeFileSync } from 'node:fs';

export class DebugSvg {
  private readonly parts: string[] = [];
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly scale: number;

  /** World-space box to draw and pixels per metre. */
  constructor(minX: number, minZ: number, maxX: number, maxZ: number, scale: number) {
    this.minX = minX;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxZ = maxZ;
    this.scale = scale;
  }

  private px(x: number): string {
    return ((x - this.minX) * this.scale).toFixed(1);
  }

  private pz(z: number): string {
    return ((z - this.minZ) * this.scale).toFixed(1);
  }

  inView(x: number, z: number, pad = 0): boolean {
    return x >= this.minX - pad && x <= this.maxX + pad && z >= this.minZ - pad && z <= this.maxZ + pad;
  }

  /** Polyline from stride-`stride` coordinates (x first, z last of each vertex). */
  line(pts: ArrayLike<number>, stride: number, color: string, width: number, opacity = 1, dash = ''): void {
    let d = '';
    let any = false;
    for (let i = 0; i < pts.length; i += stride) {
      const x = pts[i];
      const z = pts[i + stride - 1];
      if (this.inView(x, z, 50)) any = true;
      d += `${i === 0 ? 'M' : 'L'}${this.px(x)} ${this.pz(z)}`;
    }
    if (!any) return;
    this.parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${(width * this.scale).toFixed(2)}" stroke-opacity="${opacity}" stroke-linejoin="round" stroke-linecap="butt"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
    );
  }

  polygon(ring: ArrayLike<number>, fill: string, opacity = 1, stroke = 'none', strokeWidth = 0): void {
    let d = '';
    let any = false;
    for (let i = 0; i < ring.length; i += 2) {
      if (this.inView(ring[i], ring[i + 1], 50)) any = true;
      d += `${i === 0 ? 'M' : 'L'}${this.px(ring[i])} ${this.pz(ring[i + 1])}`;
    }
    if (!any) return;
    this.parts.push(
      `<path d="${d}Z" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${(strokeWidth * this.scale).toFixed(2)}"/>`,
    );
  }

  circle(x: number, z: number, r: number, fill: string, opacity = 1): void {
    if (!this.inView(x, z, r)) return;
    this.parts.push(
      `<circle cx="${this.px(x)}" cy="${this.pz(z)}" r="${(r * this.scale).toFixed(2)}" fill="${fill}" fill-opacity="${opacity}"/>`,
    );
  }

  text(x: number, z: number, s: string, sizeM: number, fill = '#000'): void {
    if (!this.inView(x, z)) return;
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    this.parts.push(
      `<text x="${this.px(x)}" y="${this.pz(z)}" font-size="${(sizeM * this.scale).toFixed(1)}" font-family="sans-serif" fill="${fill}" text-anchor="middle">${esc}</text>`,
    );
  }

  save(path: string, background = '#e9efe0'): void {
    const w = ((this.maxX - this.minX) * this.scale).toFixed(0);
    const h = ((this.maxZ - this.minZ) * this.scale).toFixed(0);
    writeFileSync(
      path,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${background}"/>${this.parts.join('\n')}</svg>`,
    );
  }
}
