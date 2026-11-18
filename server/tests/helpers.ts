// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test helpers: a server on a random port with a fresh data directory, a
 * small fetch wrapper, a WebSocket client that collects messages, and
 * hand-made image files carrying metadata that must be stripped.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createAccount } from '../src/services.ts';

export interface TestServer {
  app: App;
  base: string;
  dataDir: string;
  admin: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}, over: Partial<Config> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'fahrsim-server-test-'));
  const config = loadConfig({ FAHRSIM_LOG: 'quiet', ...env }, { dataDir, port: 0, host: '127.0.0.1', pepper: 'test-pepper-0123456789', ...over });
  const app = createApp(config);
  const port = await app.listen();
  const { token } = createAccount(app.db, config.pepper, 'Admin', { admin: true });
  return {
    app, base: `http://127.0.0.1:${port}`, dataDir, admin: token,
    async stop() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

export async function api(base: string, method: string, path: string, opts: { token?: string; json?: unknown; body?: RequestInit["body"]; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const r = await fetch(base + path, { method, headers, body });
  const type = r.headers.get('content-type') ?? '';
  const parsed = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: parsed, headers: r.headers };
}

export function form(meta: unknown, file: Buffer, thumb?: Buffer): FormData {
  const f = new FormData();
  f.append('meta', JSON.stringify(meta));
  f.append('file', new Blob([new Uint8Array(file)]), 'x.jpg');
  if (thumb) f.append('thumb', new Blob([new Uint8Array(thumb)]), 't.jpg');
  return f;
}

// ---------------------------------------------------------------- WebSocket

export class WsClient {
  ws: WebSocket;
  messages: any[] = [];
  closed: { code: number } | null = null;
  private waiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => {
      this.messages.push(JSON.parse(String(e.data)));
      this.wake();
    });
    this.ws.addEventListener('close', (e) => {
      this.closed = { code: e.code };
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Waits for (and removes from the queue) the first message matching `pred`. */
  async next(pred: (m: any) => boolean = () => true, ms = 3000): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.messages.findIndex(pred);
      if (i >= 0) return this.messages.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching message; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }

  async waitClosed(ms = 3000): Promise<{ code: number }> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('not closed');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    return this.closed;
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  close() {
    this.ws.close();
  }
}

export function wsUrl(base: string, q: Record<string, string>): string {
  return base.replace('http', 'ws') + '/api/v1/ws?' + new URLSearchParams(q).toString();
}

// ---------------------------------------------------------------- images

const SECRET = 'GPS-SECRET-51.2600N-9.4100E';

function seg(marker: number, body: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(0xff00 | marker, 0);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
}

/** An EXIF block (big-endian TIFF) with an orientation tag and a GPS-looking string. */
function exif(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 * 2 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(0, 30);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from(SECRET, 'latin1')]);
}

/** A structurally valid JPEG (not decodable pixels – the server never decodes) with EXIF, XMP, a comment and trailing data. */
export function jpeg(width: number, height: number, orientation = 1): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = 3;
  for (let i = 0; i < 3; i++) { sof[6 + i * 3] = i + 1; sof[7 + i * 3] = 0x11; sof[8 + i * 3] = 0; }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, exif(orientation)),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>' + SECRET + '</x:xmpmeta>', 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\0' + SECRET, 'latin1')),
    seg(0xfe, Buffer.from('comment ' + SECRET, 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, sof),
    seg(0xc4, Buffer.alloc(30, 0)),
    seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('TRAILING-MOTION-PHOTO ' + SECRET, 'latin1'),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(data.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc(4)]);
}

export function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0' + SECRET, 'latin1')),
    chunk('eXIf', Buffer.from('MM\0*' + SECRET, 'latin1')),
    chunk('pHYs', Buffer.alloc(9)),
    chunk('IDAT', Buffer.alloc(20, 7)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(type, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function webp(width: number, height: number): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const vp8l = Buffer.alloc(9);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8l),
    riffChunk('EXIF', Buffer.from('MM\0*' + SECRET, 'latin1')), riffChunk('XMP ', Buffer.from(SECRET, 'latin1')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

export const hasSecret = (b: Buffer): boolean => b.includes(Buffer.from('GPS-SECRET', 'latin1'));
