// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vehicle dynamics.
 *
 * A 6-DOF rigid body on four independently sprung wheels:
 *
 *  - Suspension: ray-style contact against the ground, spring + bump/rebound
 *    damper + anti-roll bar + bump stop.  The ground height seen by a wheel
 *    is the envelope of several samples along its rolling direction, so a
 *    kerb is climbed over a quarter of a wheel turn instead of in one step.
 *  - Tyres: bristle (relaxation-length) model.  The tyre force follows a
 *    deflection state that integrates slip; at speed this is ordinary slip
 *    ratio / slip angle through a Pacejka-type curve with a friction circle,
 *    at standstill it degenerates into a spring – real static friction, so
 *    the car stands still on a hill on its brakes or in gear.
 *  - Driveline: engine (torque curve, friction, idle control, limiter,
 *    starter, stalling) – dry clutch – gearbox – open differential.  Clutch
 *    and brakes are solved as friction constraints ("how much torque would
 *    lock this, clamp to capacity"), which is exact in both the locked and
 *    the slipping state and never oscillates.
 *
 * Everything is deterministic and allocation-free in step().
 */
import type { DriverInput, Ground, GroundSample, VehicleSpec, WheelState } from './types.ts';

const G = 9.81;
const AIR_DENSITY = 1.2;
const RPM = 30 / Math.PI;
/** suspension length at full droop (attachment to wheel centre) */
const L_MAX = 0.36;
/** Pacejka shape: peak at normalised slip 1, sliding level ≈ 0.71 of the peak */
const PAC_B = 1.9;
const PAC_C = 1.5;
const PAC_E = 0.2;

/**
 * Corners of the body shell relative to the point on the ground below the
 * middle of the wheelbase (x right, y up, z back): bumpers/sills and roof.
 */
const BODY_POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.8, 0.32, -2.02],
  [0.8, 0.32, -2.02],
  [-0.8, 0.32, 2.02],
  [0.8, 0.32, 2.02],
  [-0.84, 0.86, -0.9],
  [0.84, 0.86, -0.9],
  [-0.84, 0.92, 1.7],
  [0.84, 0.92, 1.7],
  [-0.58, 1.42, -0.42],
  [0.58, 1.42, -0.42],
  [-0.58, 1.42, 1.2],
  [0.58, 1.42, 1.2],
];
const BODY_STIFFNESS = 160000; // N/m per corner
const BODY_DAMPING = 9000; // N·s/m
const BODY_FRICTION = 0.55;

function pacejka(rho: number): number {
  const u = PAC_B * rho;
  return Math.sin(PAC_C * Math.atan(u - PAC_E * (u - Math.atan(u))));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function newWheel(): WheelState {
  return { steer: 0, spin: 0, omega: 0, compression: 0, contact: false, load: 0, slipRatio: 0, slipAngle: 0, skid: 0, hx: 0, hy: 0, hz: 0, grip: 1 };
}

export class Vehicle {
  readonly spec: VehicleSpec;
  private readonly ground: Ground;
  /** centre of mass (world) */
  readonly pos = new Float64Array(3);
  readonly quat = new Float64Array([0, 0, 0, 1]);
  readonly vel = new Float64Array(3);
  readonly angVel = new Float64Array(3);
  readonly wheels: WheelState[] = [newWheel(), newWheel(), newWheel(), newWheel()];
  /**
   * Position of the model origin (ground point below the middle of the
   * wheelbase at rest) in body coordinates.  Place the 3D model at
   * pos + R·modelOrigin with the body orientation.
   */
  readonly modelOrigin: Float64Array;

  // --- derived, refreshed every step ---
  speed = 0;
  yaw = 0;
  /** vertical component of the body's up axis: 1 = on its wheels, 0 = on its side, -1 = on the roof */
  upright = 1;
  rpm = 0;
  engineRunning = false;
  stalledEvent = false;
  engineLoad = 0;
  gear = 0;
  clutchLock = 0;
  accLong = 0;
  accLat = 0;
  absActive = false;
  gearGrind = false;
  steerWheelAngle = 0;
  steerTorque = 0;
  /** clutch pedal position actually applied (differs from the input with autoClutch) */
  clutchPedal = 0;
  /** distance driven (m) */
  odometer = 0;

  // --- internal state ---
  private engineOmega = 0;
  private idleI = 0;
  private limiterCut = false;
  private fireTimer = 0;
  private shiftTimer = 0;
  private autoGear = 1;
  private readonly rot = new Float64Array(9);
  private readonly attach: number[][];
  private readonly comp = new Float64Array(4);
  private readonly compPrev = new Float64Array(4);
  private readonly susLen = new Float64Array(4).fill(L_MAX);
  private readonly zx = new Float64Array(4);
  private readonly zy = new Float64Array(4);
  private readonly fxTyre = new Float64Array(4);
  /** the body shell (not just the tyres) touches the ground: rolled over or stuck nose-down */
  bodyContact = false;
  /** 1 + (tyre damping seen by the wheel) · h / inertia: the wheel is integrated implicitly against it */
  private readonly wheelImp = new Float64Array(4).fill(1);
  private readonly absMul = new Float64Array(4).fill(1);
  private readonly sample: GroundSample = { y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 };
  private readonly staticComp: [number, number];
  private readonly idleOmega: number;
  private readonly prevVel = new Float64Array(3);
  private frontLat = 0;
  private lastTc = 0;
  private startGrace = 0;
  /** number of internal integration steps per step() call */
  substeps = 2;

  constructor(spec: VehicleSpec, ground: Ground) {
    this.spec = spec;
    this.ground = ground;
    const b = spec.wheelbase - spec.cgToFront;
    const loadF = (spec.mass * G * b) / spec.wheelbase / 2;
    const loadR = (spec.mass * G * spec.cgToFront) / spec.wheelbase / 2;
    this.staticComp = [loadF / spec.springRate[0], loadR / spec.springRate[1]];
    const yF = -(spec.cgHeight - spec.wheelRadius) + L_MAX - this.staticComp[0];
    const yR = -(spec.cgHeight - spec.wheelRadius) + L_MAX - this.staticComp[1];
    const t = spec.track / 2;
    this.attach = [
      [-t, yF, -spec.cgToFront],
      [t, yF, -spec.cgToFront],
      [-t, yR, b],
      [t, yR, b],
    ];
    this.modelOrigin = new Float64Array([0, -spec.cgHeight, spec.cgToFront - spec.wheelbase / 2]);
    this.idleOmega = spec.idleRpm / RPM;
    this.teleport(0, 0, 0, 0);
  }

  /** Place the car at rest with its model origin on (x, y, z), facing `yaw`. */
  teleport(x: number, y: number, z: number, yaw: number): void {
    const s = Math.sin(yaw / 2);
    const c = Math.cos(yaw / 2);
    this.quat[0] = 0;
    this.quat[1] = s;
    this.quat[2] = 0;
    this.quat[3] = c;
    this.updateRot();
    const r = this.rot;
    const mo = this.modelOrigin;
    this.pos[0] = x - (r[0] * mo[0] + r[1] * mo[1] + r[2] * mo[2]);
    this.pos[1] = y - (r[3] * mo[0] + r[4] * mo[1] + r[5] * mo[2]);
    this.pos[2] = z - (r[6] * mo[0] + r[7] * mo[1] + r[8] * mo[2]);
    this.vel.fill(0);
    this.angVel.fill(0);
    this.prevVel.fill(0);
    for (let i = 0; i < 4; i++) {
      const axle = i < 2 ? 0 : 1;
      this.comp[i] = this.compPrev[i] = this.staticComp[axle];
      this.susLen[i] = L_MAX - this.comp[i];
      this.zx[i] = 0;
      this.zy[i] = 0;
      this.absMul[i] = 1;
      this.wheels[i].omega = 0;
      this.wheels[i].compression = this.comp[i];
    }
    this.speed = 0;
    this.accLong = 0;
    this.accLat = 0;
    this.derive(0);
  }

  resetDrivetrain(engineRunning: boolean): void {
    this.engineRunning = engineRunning;
    this.engineOmega = engineRunning ? this.idleOmega : 0;
    this.idleI = engineRunning ? 0.12 : 0;
    this.fireTimer = 0;
    this.shiftTimer = 0;
    this.limiterCut = false;
    this.startGrace = 0;
    this.rpm = this.engineOmega * RPM;
  }

  applyImpulse(px: number, py: number, pz: number, jx: number, jy: number, jz: number): void {
    const m = this.spec.mass;
    this.vel[0] += jx / m;
    this.vel[1] += jy / m;
    this.vel[2] += jz / m;
    const rx = px - this.pos[0];
    const ry = py - this.pos[1];
    const rz = pz - this.pos[2];
    this.addAngular(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, 1);
  }

  translate(dx: number, dy: number, dz: number): void {
    this.pos[0] += dx;
    this.pos[1] += dy;
    this.pos[2] += dz;
  }

  /** Height of each wheel centre above the model's ground plane, in body coordinates (for drawing the wheels). */
  getWheelHeights(out: number[]): void {
    for (let i = 0; i < 4; i++) out[i] = this.attach[i][1] - this.susLen[i] - this.modelOrigin[1];
  }

  /** World position of the model origin (see `modelOrigin`). */
  getModelPosition(out: Float64Array | number[]): void {
    const r = this.rot;
    const mo = this.modelOrigin;
    out[0] = this.pos[0] + r[0] * mo[0] + r[1] * mo[1] + r[2] * mo[2];
    out[1] = this.pos[1] + r[3] * mo[0] + r[4] * mo[1] + r[5] * mo[2];
    out[2] = this.pos[2] + r[6] * mo[0] + r[7] * mo[1] + r[8] * mo[2];
  }

  /** Body point (body coordinates) → world. */
  toWorld(bx: number, by: number, bz: number, out: Float64Array | number[]): void {
    const r = this.rot;
    out[0] = this.pos[0] + r[0] * bx + r[1] * by + r[2] * bz;
    out[1] = this.pos[1] + r[3] * bx + r[4] * by + r[5] * bz;
    out[2] = this.pos[2] + r[6] * bx + r[7] * by + r[8] * bz;
  }

  step(dt: number, input: DriverInput): void {
    this.stalledEvent = false;
    this.gearGrind = false;
    const n = this.substeps;
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h, input);
    this.derive(dt);
  }

  // ---------------------------------------------------------------------------
  private updateRot(): void {
    const q = this.quat;
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const r = this.rot;
    r[0] = 1 - 2 * (y * y + z * z);
    r[1] = 2 * (x * y - z * w);
    r[2] = 2 * (x * z + y * w);
    r[3] = 2 * (x * y + z * w);
    r[4] = 1 - 2 * (x * x + z * z);
    r[5] = 2 * (y * z - x * w);
    r[6] = 2 * (x * z - y * w);
    r[7] = 2 * (y * z + x * w);
    r[8] = 1 - 2 * (x * x + y * y);
  }

  /** angVel += I⁻¹ · (world torque) · h */
  private addAngular(tx: number, ty: number, tz: number, h: number): void {
    const r = this.rot;
    const I = this.spec.inertia;
    const bx = (r[0] * tx + r[3] * ty + r[6] * tz) / I[0];
    const by = (r[1] * tx + r[4] * ty + r[7] * tz) / I[1];
    const bz = (r[2] * tx + r[5] * ty + r[8] * tz) / I[2];
    this.angVel[0] += (r[0] * bx + r[1] * by + r[2] * bz) * h;
    this.angVel[1] += (r[3] * bx + r[4] * by + r[5] * bz) * h;
    this.angVel[2] += (r[6] * bx + r[7] * by + r[8] * bz) * h;
  }

  private torqueAt(rpm: number): number {
    const c = this.spec.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
      }
    }
    return 0;
  }

  private ratio(gear: number): number {
    const s = this.spec;
    if (gear === 0 || gear === -2) return 0;
    if (gear < 0) return -s.reverseRatio * s.finalDrive;
    return s.gearRatios[Math.min(gear, s.gearRatios.length) - 1] * s.finalDrive;
  }

  private substep(h: number, inp: DriverInput): void {
    const s = this.spec;
    const w = this.wheels;
    this.updateRot();
    const r = this.rot;
    const px = this.pos[0];
    const py = this.pos[1];
    const pz = this.pos[2];
    const vx = this.vel[0];
    const vy = this.vel[1];
    const vz = this.vel[2];
    const wx = this.angVel[0];
    const wy = this.angVel[1];
    const wz = this.angVel[2];
    // forward = -Z body axis
    const fwdX = -r[2];
    const fwdY = -r[5];
    const fwdZ = -r[8];
    const upX = r[1];
    const upY = r[4];
    const upZ = r[7];
    const rightX = r[0];
    const rightY = r[3];
    const rightZ = r[6];
    const vForward = vx * fwdX + vy * fwdY + vz * fwdZ;

    // ---- steering (Ackermann) ------------------------------------------------
    const delta = clamp(inp.steer, -1, 1) * s.maxWheelAngle;
    this.steerWheelAngle = delta * s.steeringRatio;
    if (Math.abs(delta) > 1e-4) {
      const R = s.wheelbase / Math.tan(Math.abs(delta));
      const inner = Math.atan(s.wheelbase / (R - s.track / 2));
      const outer = Math.atan(s.wheelbase / (R + s.track / 2));
      if (delta > 0) {
        w[0].steer = outer;
        w[1].steer = inner;
      } else {
        w[0].steer = -inner;
        w[1].steer = -outer;
      }
    } else {
      w[0].steer = delta;
      w[1].steer = delta;
    }

    // ---- gearbox / clutch engagement ----------------------------------------
    const driveOmega = (w[0].omega + w[1].omega) / 2;
    let engagement: number;
    let gear = this.gear;
    let parkLock = false;
    let converter = false;
    if (s.transmission === 'automatic') {
      converter = true;
      const sel = inp.gear;
      if (sel === -2) {
        gear = 0;
        parkLock = Math.abs(vForward) < 1.2;
      } else if (sel === -1) gear = vForward < 1.5 ? -1 : 0;
      else if (sel === 0) gear = 0;
      else {
        if (vForward < -1.5) gear = 0;
        else {
          // shift schedule on engine speed, later with more throttle
          let g = this.autoGear;
          if (this.shiftTimer <= 0) {
            const up = 1900 + 4300 * inp.throttle;
            const down = 1050 + 1700 * inp.throttle;
            const rpmNow = this.engineOmega * RPM;
            const syncRpm = driveOmega * this.ratio(g) * RPM;
            if (g < s.gearRatios.length && syncRpm > up && rpmNow > up * 0.9) {
              g++;
              this.shiftTimer = 0.38;
            } else if (g > 1 && (syncRpm < down || (inp.throttle > 0.92 && driveOmega * this.ratio(g - 1) * RPM < 5900))) {
              g--;
              this.shiftTimer = 0.38;
            }
          }
          this.autoGear = g;
          gear = g;
        }
      }
      if (gear <= 0) this.autoGear = 1;
      engagement = 1;
    } else {
      if (inp.gear !== gear) {
        const target = clamp(Math.round(inp.gear), -1, s.gearRatios.length);
        if (target === 0) gear = 0;
        else {
          const mismatch = Math.abs(this.engineOmega - this.ratio(target) * driveOmega);
          const wrongWay = (target === -1 && vForward > 1.5) || (target > 0 && vForward < -1.5);
          if (wrongWay) this.gearGrind = true;
          else if (s.autoClutch) {
            gear = target;
            this.shiftTimer = 0.26;
          } else if (inp.clutch > 0.6 || mismatch < 12) gear = target;
          else this.gearGrind = true;
        }
      }
      let pedal = inp.clutch;
      if (s.autoClutch) {
        // launch like a centrifugal clutch, open when the engine would otherwise stall
        const syncRpm = Math.abs(driveOmega * this.ratio(gear)) * RPM;
        const rpmNow = this.engineOmega * RPM;
        let e = 1;
        if (syncRpm < 1150) e = inp.throttle > 0.02 ? clamp((rpmNow - 950) / 1100, 0, 1) : clamp((syncRpm - 850) / 250, 0, 1);
        if (this.shiftTimer > 0 || !this.engineRunning) e = this.engineRunning ? 0 : e;
        if (inp.brake > 0.3 && syncRpm < 1000) e = 0;
        pedal = 0.75 - 0.45 * e ** (1 / 1.6);
      }
      this.clutchPedal = pedal;
      const t = clamp((0.75 - pedal) / 0.45, 0, 1);
      engagement = t ** 1.6;
    }
    if (this.shiftTimer > 0) this.shiftTimer -= h;
    this.gear = gear;
    const ratio = this.ratio(gear);

    // ---- wheels: suspension and tyres ---------------------------------------
    let Fx = 0;
    let Fy = -s.mass * G;
    let Fz = 0;
    let Tx = 0;
    let Ty = 0;
    let Tz = 0;
    const smp = this.sample;
    let frontLat = 0;
    for (let i = 0; i < 4; i++) {
      const wh = w[i];
      const axle = i < 2 ? 0 : 1;
      const a = this.attach[i];
      // attachment point (world) and its lever arm
      const ax = r[0] * a[0] + r[1] * a[1] + r[2] * a[2];
      const ay = r[3] * a[0] + r[4] * a[1] + r[5] * a[2];
      const az = r[6] * a[0] + r[7] * a[1] + r[8] * a[2];
      const Ax = px + ax;
      const Ay = py + ay;
      const Az = pz + az;
      // rolling direction of this wheel
      const sd = Math.sin(wh.steer);
      const cd = Math.cos(wh.steer);
      let fx = rightX * sd + fwdX * cd;
      let fy = rightY * sd + fwdY * cd;
      let fz = rightZ * sd + fwdZ * cd;
      // wheel centre at the previous suspension length
      const l0 = this.susLen[i];
      const cx0 = Ax - upX * l0;
      const cy0 = Ay - upY * l0;
      const cz0 = Az - upZ * l0;
      // ground envelope under the tyre
      const rad = s.wheelRadius;
      this.ground.sample(cx0, cz0, cy0, smp);
      let gy = smp.y;
      const nx = smp.nx;
      const ny = smp.ny;
      const nz = smp.nz;
      const grip = smp.grip;
      const rolling = smp.rolling;
      const fl = Math.hypot(fx, fz) || 1;
      const hx = fx / fl;
      const hz = fz / fl;
      for (let k = 0; k < 4; k++) {
        const off = (k < 2 ? 0.45 : 0.75) * (k % 2 === 0 ? 1 : -1) * rad;
        const lift = (k < 2 ? 0.893 : 0.6614) * rad - rad;
        this.ground.sample(cx0 + hx * off, cz0 + hz * off, cy0, smp);
        if (smp.y + lift > gy) gy = smp.y + lift;
      }
      // suspension length that puts the tyre on the plane through (cx0, gy, cz0)
      const dn = -(upX * nx + upY * ny + upZ * nz); // down axis · normal (negative)
      let contact = false;
      let l = L_MAX;
      if (dn < -0.25) {
        const dist = (Ax - cx0) * nx + (Ay - gy) * ny + (Az - cz0) * nz;
        l = (dist - rad) / -dn;
        if (l < L_MAX) contact = true;
        else l = L_MAX;
      }
      let comp = L_MAX - l;
      let N = 0;
      if (contact) {
        if (comp > s.travel + 0.06) comp = s.travel + 0.06; // the bump stop is not infinitely soft
        l = L_MAX - comp;
        let vc = (comp - this.compPrev[i]) / h;
        vc = clamp(vc, -3, 3);
        const other = this.compPrev[i ^ 1];
        N = s.springRate[axle] * comp + (vc > 0 ? s.damperBump[axle] : s.damperRebound[axle]) * vc + s.antiRoll[axle] * (comp - other);
        if (comp > s.travel - 0.035) N += 260000 * (comp - (s.travel - 0.035));
        if (N < 0) N = 0;
      }
      this.comp[i] = comp;
      this.susLen[i] = l;
      wh.compression = comp;
      wh.contact = contact && N > 0;
      wh.load = N;
      wh.grip = grip;
      const Cx = Ax - upX * l;
      const Cy = Ay - upY * l;
      const Cz = Az - upZ * l;
      wh.hx = Cx;
      wh.hy = Cy;
      wh.hz = Cz;
      if (!wh.contact) {
        this.zx[i] *= 0.9;
        this.zy[i] *= 0.9;
        this.fxTyre[i] = 0;
        this.wheelImp[i] = 1;
        wh.slipRatio = 0;
        wh.slipAngle = 0;
        wh.skid = 0;
        continue;
      }
      // contact point and its velocity
      const Px = Cx - nx * rad;
      const Py = Cy - ny * rad;
      const Pz = Cz - nz * rad;
      const rx = Px - px;
      const ry = Py - py;
      const rz = Pz - pz;
      const vpx = vx + wy * rz - wz * ry;
      const vpy = vy + wz * rx - wx * rz;
      const vpz = vz + wx * ry - wy * rx;
      // tyre axes in the ground plane
      const fn = fx * nx + fy * ny + fz * nz;
      fx -= nx * fn;
      fy -= ny * fn;
      fz -= nz * fn;
      const fl2 = Math.hypot(fx, fy, fz) || 1;
      fx /= fl2;
      fy /= fl2;
      fz /= fl2;
      // side = forward × normal (points to the wheel's right)
      const sx = fy * nz - fz * ny;
      const sy = fz * nx - fx * nz;
      const sz = fx * ny - fy * nx;
      const vLong = vpx * fx + vpy * fy + vpz * fz;
      const vLat = vpx * sx + vpy * sy + vpz * sz;
      // bristle deflection: dz/dt = slip velocity − |v|/L · z  (exact exponential update)
      const av = Math.abs(vLong);
      const vsx = wh.omega * rad - vLong;
      const vsy = -vLat;
      // softer peaks on loose surfaces
      const soft = 1 / Math.sqrt(Math.max(grip, 0.3));
      const kPeak = s.slipRatioPeak * soft;
      const aPeak = Math.tan(s.slipAnglePeak) * soft;
      let zx = this.zx[i];
      let zy = this.zy[i];
      if (av > 1e-3) {
        const ex = Math.exp((-av * h) / s.relaxLong);
        const ey = Math.exp((-av * h) / s.relaxLat);
        zx = zx * ex + ((vsx * s.relaxLong) / av) * (1 - ex);
        zy = zy * ey + ((vsy * s.relaxLat) / av) * (1 - ey);
      } else {
        zx += vsx * h;
        zy += vsy * h;
      }
      // damping of the tyre spring, only needed (and only acting) near standstill
      const low = 1 / (1 + (av * av) / 2.25);
      const tau = 0.035 * low;
      let sgx = (zx + tau * vsx) / s.relaxLong / kPeak;
      let sgy = (zy + tau * vsy) / s.relaxLat / aPeak;
      let rho = Math.hypot(sgx, sgy);
      const RHO_MAX = 3.5;
      if (rho > RHO_MAX) {
        // anti wind-up: a sliding tyre does not store more deflection
        const k = RHO_MAX / rho;
        zx *= k;
        zy *= k;
        sgx *= k;
        sgy *= k;
        rho = RHO_MAX;
      }
      this.zx[i] = zx;
      this.zy[i] = zy;
      const staticLoad = (s.mass * G) / 4;
      const mu = s.muPeak * grip * clamp(1 - s.loadSensitivity * (N / staticLoad - 1), 0.75, 1.12);
      let fxT = 0;
      let fyT = 0;
      // secant stiffness of the tyre curve (force per unit of normalised slip)
      const F = rho > 1e-6 ? (mu * N * pacejka(rho)) / rho : mu * N * PAC_B * PAC_C;
      if (rho > 1e-6) {
        fxT = F * sgx;
        fyT = F * sgy;
      }
      this.fxTyre[i] = fxT;
      // The standstill damping is far too stiff for the light wheel to be
      // integrated explicitly (it would flip-flop around the road speed and
      // shake itself loose from a gently applied brake): remember how strongly
      // the force reacts to the wheel speed, the wheel update divides by it.
      this.wheelImp[i] = 1 + (((F * tau) / (s.relaxLong * kPeak)) * rad * rad * h) / s.wheelInertia;
      wh.slipRatio = (zx / s.relaxLong);
      wh.slipAngle = Math.atan(zy / s.relaxLat);
      wh.skid = clamp((rho - 1) / 1.5, 0, 1) * clamp(Math.hypot(vsx, vsy) / 2, 0, 1);
      if (i < 2) frontLat += fyT / (mu * N + 1);
      // rolling resistance acts on the body as a force opposing the motion
      const frr = -s.rollingResistance * rolling * N * Math.tanh(vLong / 0.4);
      const tfx = fx * (fxT + frr) + sx * fyT + nx * N;
      const tfy = fy * (fxT + frr) + sy * fyT + ny * N;
      const tfz = fz * (fxT + frr) + sz * fyT + nz * N;
      Fx += tfx;
      Fy += tfy;
      Fz += tfz;
      Tx += ry * tfz - rz * tfy;
      Ty += rz * tfx - rx * tfz;
      Tz += rx * tfy - ry * tfx;
      // ABS: release when the wheel decelerates into deep slip
      if (s.abs) {
        const kappa = (wh.omega * rad - vLong) / Math.max(av, 0.6);
        if (inp.brake > 0.05 && vLong > 1.6 && kappa < -0.15) this.absMul[i] -= h * 16;
        else this.absMul[i] += h * 8;
        this.absMul[i] = clamp(this.absMul[i], 0.04, 1);
      }
    }
    this.frontLat = frontLat / 2;
    this.compPrev.set(this.comp);

    // ---- body on the ground -----------------------------------------------------
    // Only the wheels carry the car in normal driving.  Once it leans far over
    // (rolled, or nose-down in a ditch) the corners of the body shell take over,
    // so that it comes to rest on its side or roof instead of sinking away.
    this.bodyContact = false;
    if (upY < 0.9) {
      const mo = this.modelOrigin;
      for (const b of BODY_POINTS) {
        const bx = b[0] + mo[0];
        const by = b[1] + mo[1];
        const bz = b[2] + mo[2];
        const rx = r[0] * bx + r[1] * by + r[2] * bz;
        const ry = r[3] * bx + r[4] * by + r[5] * bz;
        const rz = r[6] * bx + r[7] * by + r[8] * bz;
        this.ground.sample(px + rx, pz + rz, py + ry + 0.8, smp);
        const depth = smp.y - (py + ry);
        if (!(depth > 0)) continue;
        const vpx = vx + wy * rz - wz * ry;
        const vpy = vy + wz * rx - wx * rz;
        const vpz = vz + wx * ry - wy * rx;
        const vn = vpx * smp.nx + vpy * smp.ny + vpz * smp.nz;
        const N = clamp(BODY_STIFFNESS * Math.min(depth, 0.4) - BODY_DAMPING * vn, 0, 90000);
        if (N <= 0) continue;
        // sheet metal sliding on the ground
        const tx = vpx - vn * smp.nx;
        const ty = vpy - vn * smp.ny;
        const tz = vpz - vn * smp.nz;
        const f = (-BODY_FRICTION * N) / Math.max(Math.hypot(tx, ty, tz), 0.4);
        const bfx = N * smp.nx + f * tx;
        const bfy = N * smp.ny + f * ty;
        const bfz = N * smp.nz + f * tz;
        Fx += bfx;
        Fy += bfy;
        Fz += bfz;
        Tx += ry * bfz - rz * bfy;
        Ty += rz * bfx - rx * bfz;
        Tz += rx * bfy - ry * bfx;
        this.bodyContact = true;
      }
    }

    // ---- engine ---------------------------------------------------------------
    const Ie = s.engineInertia;
    const Iw = s.wheelInertia;
    let we = this.engineOmega;
    if (!inp.ignition && this.engineRunning) this.engineRunning = false;
    const rpm = we * RPM;
    let Te = 0;
    let offFriction = 0;
    if (this.engineRunning) {
      const err = this.idleOmega - we;
      // Modern engine management defends the idle speed with a lot of torque
      // (anti-stall), but not with all of it: a careless clutch still kills it.
      this.idleI = clamp(this.idleI + err * h * 0.05, 0, 0.35);
      const idleThr = clamp(err * 0.035 + this.idleI, 0, 0.85);
      let thr = Math.max(clamp(inp.throttle, 0, 1), idleThr);
      if (rpm > s.limiterRpm) this.limiterCut = true;
      else if (rpm < s.limiterRpm - 140) this.limiterCut = false;
      if (this.limiterCut) thr = 0;
      const fr = s.engineFriction[0] + s.engineFriction[1] * Math.max(rpm, 0);
      Te = thr * (this.torqueAt(rpm) + fr) - fr;
      this.engineLoad = thr;
    } else {
      this.engineLoad = 0;
      this.idleI = 0;
      // Compression and friction of a dead engine act as a Coulomb brake:
      // high breakaway torque (holds the parked car in gear), less once it turns.
      const aw = Math.abs(we);
      offFriction = 25 + 35 / (1 + (aw / 3) * (aw / 3)) + 0.05 * aw;
      if (inp.ignition && inp.starter) {
        Te = 115 * Math.max(0, 1 - we / 34);
        if (we > 19) this.fireTimer += h;
        else this.fireTimer = Math.max(0, this.fireTimer - h);
        if (this.fireTimer > 0.5) {
          // it fires at cranking speed, well below the stall threshold: give it
          // a moment to run up to idle before stalling is judged again
          this.engineRunning = true;
          this.idleI = 0.14;
          this.fireTimer = 0;
          this.startGrace = 0.9;
        }
      } else this.fireTimer = 0;
    }

    // ---- clutch as a friction constraint ---------------------------------------
    // inverse inertia of the two driven wheels (implicit against the tyre damping, see above)
    const inv0 = 1 / (s.wheelInertia * this.wheelImp[0]);
    const inv1 = 1 / (s.wheelInertia * this.wheelImp[1]);
    const S = rollTorque(this.fxTyre[0], s.wheelRadius) * inv0 + rollTorque(this.fxTyre[1], s.wheelRadius) * inv1;
    // Gearbox and differential losses: less torque arrives when the engine
    // drives, more is taken when the wheels drive the engine.
    const driving = this.lastTc * ratio * driveOmega >= 0;
    const wheelRatio = ratio * (driving ? s.drivelineEfficiency : 1 / s.drivelineEfficiency);
    let Tc = 0;
    let capacity = 0;
    if (ratio !== 0) {
      if (converter) {
        // fluid coupling: capacity grows with engine speed squared, locked up when cruising
        const sync = Math.abs(driveOmega * ratio);
        capacity = 0.00356 * we * we;
        if (gear >= 2 && sync > 135 && this.shiftTimer <= 0) capacity = Math.max(capacity, s.clutchTorque);
        if (this.shiftTimer > 0) capacity *= 0.35;
        capacity = Math.min(capacity, s.clutchTorque * 1.1);
      } else capacity = engagement * s.clutchTorque;
      if (capacity > 0) {
        const win = ratio * driveOmega;
        const est = offFriction > 0 && Math.abs(we) > 0.5 ? -Math.sign(we) * offFriction : 0;
        const lock = ((we - win) / h + (Te + est) / Ie + (ratio * S) / 2) / (1 / Ie + (ratio * wheelRatio * (inv0 + inv1)) / 4);
        Tc = clamp(lock, -capacity, capacity);
      }
    }
    this.lastTc = Tc;
    this.clutchLock = capacity > 0 && Math.abs(Tc) < capacity * 0.999 ? 1 : capacity > 0 ? 0.5 : 0;

    we += ((Te - Tc) / Ie) * h;
    if (offFriction > 0) {
      const need = (Math.abs(we) * Ie) / h;
      if (offFriction >= need) we = 0;
      else we -= (Math.sign(we) * offFriction * h) / Ie;
    }
    if (we < 0 && this.engineRunning) we = 0;
    if (this.startGrace > 0) this.startGrace -= h;
    if (this.engineRunning && this.startGrace <= 0 && we * RPM < s.stallRpm) {
      this.engineRunning = false;
      this.stalledEvent = true;
    }
    this.engineOmega = we;

    // ---- wheel rotation and brakes ----------------------------------------------
    let absActive = false;
    for (let i = 0; i < 4; i++) {
      const wh = w[i];
      const front = i < 2;
      const Ii = Iw * this.wheelImp[i];
      let T = -this.fxTyre[i] * s.wheelRadius;
      if (front) T += (Tc * wheelRatio) / 2;
      wh.omega += (T / Ii) * h;
      let brake = inp.brake * s.brakeTorque * (front ? s.brakeBiasFront / 2 : (1 - s.brakeBiasFront) / 2) * this.absMul[i];
      if (!front) brake += inp.handbrake * (s.handbrakeTorque / 2);
      if (front && parkLock) brake += 6000;
      if (brake > 0) {
        const need = (Math.abs(wh.omega) * Ii) / h;
        if (brake >= need) wh.omega = 0;
        else wh.omega -= (Math.sign(wh.omega) * brake * h) / Ii;
      }
      if (this.absMul[i] < 0.9) absActive = true;
      wh.spin += wh.omega * h;
    }
    this.absActive = absActive;

    // ---- aerodynamics, integration -------------------------------------------------
    const v2 = Math.hypot(vx, vy, vz);
    const drag = 0.5 * AIR_DENSITY * s.dragArea * v2;
    Fx -= drag * vx;
    Fy -= drag * vy;
    Fz -= drag * vz;
    this.vel[0] += (Fx / s.mass) * h;
    this.vel[1] += (Fy / s.mass) * h;
    this.vel[2] += (Fz / s.mass) * h;
    this.addAngular(Tx, Ty, Tz, h);
    // a little angular damping keeps a parked car from accumulating numerical spin
    const ad = 1 - 0.05 * h;
    this.angVel[0] *= ad;
    this.angVel[1] *= ad;
    this.angVel[2] *= ad;
    const al = Math.hypot(this.angVel[0], this.angVel[1], this.angVel[2]);
    if (al > 25) {
      const k = 25 / al;
      this.angVel[0] *= k;
      this.angVel[1] *= k;
      this.angVel[2] *= k;
    }
    this.pos[0] += this.vel[0] * h;
    this.pos[1] += this.vel[1] * h;
    this.pos[2] += this.vel[2] * h;
    const q = this.quat;
    const ox = this.angVel[0];
    const oy = this.angVel[1];
    const oz = this.angVel[2];
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    q[0] += 0.5 * h * (ox * qw + oy * qz - oz * qy);
    q[1] += 0.5 * h * (oy * qw + oz * qx - ox * qz);
    q[2] += 0.5 * h * (oz * qw + ox * qy - oy * qx);
    q[3] += 0.5 * h * (-ox * qx - oy * qy - oz * qz);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q[0] /= ql;
    q[1] /= ql;
    q[2] /= ql;
    q[3] /= ql;
    this.odometer += Math.abs(vForward) * h;
  }

  private derive(dt: number): void {
    this.updateRot();
    const r = this.rot;
    const fx = -r[2];
    const fy = -r[5];
    const fz = -r[8];
    this.speed = this.vel[0] * fx + this.vel[1] * fy + this.vel[2] * fz;
    this.yaw = Math.atan2(-fx, -fz);
    this.upright = r[4];
    this.rpm = this.engineOmega * RPM;
    if (dt > 0) {
      const ax = (this.vel[0] - this.prevVel[0]) / dt;
      const ay = (this.vel[1] - this.prevVel[1]) / dt;
      const az = (this.vel[2] - this.prevVel[2]) / dt;
      const k = Math.min(1, dt * 12);
      this.accLong += (ax * fx + ay * fy + az * fz - this.accLong) * k;
      this.accLat += (ax * r[0] + ay * r[3] + az * r[6] - this.accLat) * k;
    }
    this.prevVel.set(this.vel);
    // self-aligning feel: lateral utilisation of the front axle, fading as the tyres saturate
    this.steerTorque = clamp(-this.frontLat * 1.4, -1, 1);
  }
}

/** Torque a longitudinal tyre force exerts against the wheel's rotation. */
function rollTorque(fx: number, radius: number): number {
  return fx * radius;
}
