// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A stand-in for the Web Audio API in Node, for the tests of the sound: it
 * plays nothing, but keeps count of the nodes made (by kind) and of every
 * change scheduled on a setting, and lets the test move the audio clock.
 */

export class MockParam {
  value: number;
  /** the scheduled changes: [what, value, when] (the newest last) */
  readonly events: Array<[string, number, number]> = [];
  private readonly ctx: MockContext;

  constructor(ctx: MockContext, v: number) {
    this.ctx = ctx;
    this.value = v;
  }

  private ev(kind: string, v: number, t: number): this {
    this.ctx.paramCalls++;
    this.events.push([kind, v, t]);
    if (this.events.length > 200) this.events.shift();
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    this.value = v;
    return this.ev('set', v, t);
  }
  setTargetAtTime(v: number, t: number, _tc: number): this {
    this.value = v;
    return this.ev('target', v, t);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.value = v;
    return this.ev('linear', v, t);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.value = v;
    return this.ev('exp', v, t);
  }
  cancelScheduledValues(t: number): this {
    return this.ev('cancel', 0, t);
  }
}

export class MockNode {
  readonly kind: string;
  readonly outputs: unknown[] = [];
  readonly gain: MockParam;
  readonly frequency: MockParam;
  readonly detune: MockParam;
  readonly Q: MockParam;
  readonly pan: MockParam;
  readonly delayTime: MockParam;
  readonly threshold: MockParam;
  readonly knee: MockParam;
  readonly ratio: MockParam;
  readonly attack: MockParam;
  readonly release: MockParam;
  type = '';
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  started = -1;
  stopped = -1;
  wave: unknown = null;

  constructor(ctx: MockContext, kind: string) {
    this.kind = kind;
    const p = (v: number): MockParam => new MockParam(ctx, v);
    this.gain = p(1);
    this.frequency = p(440);
    this.detune = p(0);
    this.Q = p(1);
    this.pan = p(0);
    this.delayTime = p(0);
    this.threshold = p(-24);
    this.knee = p(30);
    this.ratio = p(12);
    this.attack = p(0.003);
    this.release = p(0.25);
  }
  connect<T>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(_dest?: unknown): void {
    this.outputs.length = 0;
  }
  start(t = 0, _offset?: number, _dur?: number): void {
    this.started = t;
  }
  stop(t = 0): void {
    this.stopped = t;
  }
  setPeriodicWave(w: unknown): void {
    this.wave = w;
  }
}

export class MockContext {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  /** nodes made, by kind; changes scheduled on settings; waves made */
  readonly made: Record<string, number> = {};
  paramCalls = 0;
  waves = 0;
  readonly nodes: MockNode[] = [];
  readonly destination: MockNode;

  constructor() {
    this.destination = new MockNode(this, 'destination');
  }
  get created(): number {
    let n = 0;
    for (const k in this.made) n += this.made[k];
    return n;
  }
  private make(kind: string): MockNode {
    this.made[kind] = (this.made[kind] ?? 0) + 1;
    const n = new MockNode(this, kind);
    this.nodes.push(n);
    return n;
  }
  createGain(): MockNode {
    return this.make('gain');
  }
  createBiquadFilter(): MockNode {
    return this.make('biquad');
  }
  createOscillator(): MockNode {
    return this.make('osc');
  }
  createBufferSource(): MockNode {
    return this.make('source');
  }
  createDynamicsCompressor(): MockNode {
    return this.make('compressor');
  }
  createDelay(_max?: number): MockNode {
    return this.make('delay');
  }
  createStereoPanner(): MockNode {
    return this.make('panner');
  }
  createBuffer(_channels: number, length: number, _rate: number): { length: number; getChannelData(c: number): Float32Array } {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array, _opts?: unknown): { real: Float32Array; imag: Float32Array } {
    this.waves++;
    return { real, imag };
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
}

/** Puts the stand-in where the game looks for the Web Audio API (window.AudioContext); returns the contexts it makes. */
export function installMockAudio(): MockContext[] {
  const made: MockContext[] = [];
  class Ctx extends MockContext {
    constructor() {
      super();
      made.push(this);
    }
  }
  (globalThis as unknown as { window: unknown }).window = { AudioContext: Ctx };
  return made;
}
