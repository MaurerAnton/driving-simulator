// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wheel tracks in the snow: where the traffic drives, two strips of dark,
 * wet asphalt along every lane round the camera (and along the paths through
 * the junctions), with soft edges, laid over the snowy road.
 *
 * The roads' own material does not know where the lanes run, so the tracks
 * are a mesh of their own, built from the lane network on the processor –
 * only when snow lies on the road, only round the camera, and anew only when
 * the camera has moved a good way (or the network changed).  Nothing per
 * frame but a distance check; one draw call.
 */
import * as THREE from 'three';
import { newPolySample, samplePolyline } from '../core/geom.ts';
import type { PolySample } from '../core/geom.ts';
import { lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { EF } from '../world/types.ts';

/** the wheels run this far either side of the middle of a lane (m): half a car's track */
export const HALF_TRACK = 0.78;
/** half the width of a track in the snow (m) */
const HALF_WIDTH = 0.26;
/** a point every so many metres along a lane */
const STEP = 4;
/** the tracks lie this much above the road (m) – with the polygon offset, clear of its surface */
const LIFT = 0.03;
/** the colour of wet asphalt between the snow */
const WET_ASPHALT = 0x2e3135;

export class SnowTracks {
  /** add this to the scene */
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  /** how far round the camera the tracks are laid (m) – less on a slow device */
  radius = 160;
  /** how much they show: SeasonState.roadSnow (0 … 1; nothing is built while it is 0) */
  amount = 0;
  private cx = NaN;
  private cz = NaN;
  private readonly s: PolySample = newPolySample();

  constructor() {
    const material = new THREE.MeshLambertMaterial({
      color: WET_ASPHALT,
      // (the vertex colours carry the soft edges: alpha 1 in the middle of a track, 0 at its sides)
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'snow tracks';
    // after the road (0) and its markings (1)
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /**
   * Once a frame (cheap): the camera's place, the lanes (LaneGraph.lanes)
   * and, if given, the paths through the junctions (LaneGraph.connectors).
   */
  update(x: number, z: number, lanes: readonly (Lane | undefined)[], connectors?: readonly (Connector | undefined)[]): void {
    const a = Math.min(1, Math.max(0, this.amount));
    this.mesh.material.opacity = 0.9 * a;
    if (a < 0.02) {
      this.mesh.visible = false;
      return;
    }
    if (!(Math.hypot(x - this.cx, z - this.cz) < this.radius * 0.35)) this.build(x, z, lanes, connectors);
    this.mesh.visible = this.mesh.geometry.index !== null && this.mesh.geometry.index.count > 0;
  }

  /** Lay them anew at the next update – a piece of the network came or went. */
  invalidate(): void {
    this.cx = NaN;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private build(x: number, z: number, lanes: readonly (Lane | undefined)[], connectors?: readonly (Connector | undefined)[]): void {
    this.cx = x;
    this.cz = z;
    const R = this.radius;
    const pos: number[] = [];
    const idx: number[] = [];
    for (const lane of lanes) {
      if (!lane) continue;
      const e = lane.edge;
      // no snow in a tunnel; only what is near
      if (e.flags & EF.TUNNEL || e.maxX < x - R || e.minX > x + R || e.maxZ < z - R || e.minZ > z + R) continue;
      this.strip(lane.len, (d, out) => lanePoint(lane, d, out), x, z, pos, idx);
    }
    if (connectors) {
      for (const c of connectors) {
        if (!c || c.from.edge.flags & EF.TUNNEL) continue;
        samplePolyline(c.pl, c.len * 0.5, this.s);
        if (Math.hypot(this.s.x - x, this.s.z - z) > R + c.len) continue;
        this.strip(c.len, (d, out) => samplePolyline(c.pl, d, out), x, z, pos, idx);
      }
    }
    const n = pos.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    // white, its alpha the strip's shape: 0 at the sides, 1 in the middle (three vertices across)
    const colour = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      colour[i * 4] = colour[i * 4 + 1] = colour[i * 4 + 2] = 1;
      colour[i * 4 + 3] = i % 3 === 1 ? 1 : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colour, 4));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Two tracks along a path of `len` metres (`at`: the point and direction at a distance), where it runs near the camera. */
  private strip(len: number, at: (d: number, out: PolySample) => PolySample, x: number, z: number, pos: number[], idx: number[]): void {
    const s = this.s;
    const reach = this.radius * 1.15;
    const n = Math.max(1, Math.ceil(len / STEP));
    let joined = false;
    for (let i = 0; i <= n; i++) {
      at((len * i) / n, s);
      if (Math.hypot(s.x - x, s.z - z) > reach) {
        joined = false;
        continue;
      }
      const base = pos.length / 3;
      // across the lane (either way: the tracks lie to both sides)
      const nx = s.tz;
      const nz = -s.tx;
      for (let side = -1; side <= 1; side += 2) {
        for (let k = -1; k <= 1; k++) {
          const w = side * HALF_TRACK + k * HALF_WIDTH;
          pos.push(s.x + nx * w, s.y + LIFT, s.z + nz * w);
        }
      }
      if (joined) {
        const prev = base - 6;
        for (let t = 0; t < 2; t++) {
          for (let k = 0; k < 2; k++) {
            const a = prev + t * 3 + k;
            const c = base + t * 3 + k;
            idx.push(a, c, a + 1, a + 1, c, c + 1);
          }
        }
      }
      joined = true;
    }
  }
}
