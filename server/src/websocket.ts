// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A minimal WebSocket server side (RFC 6455) on node:http's `upgrade`
 * event, so the server needs no dependency.
 *
 * What it does: the handshake (version 13, no extensions, no
 * subprotocols), text messages in one or several fragments, ping/pong,
 * close.  Client frames must be masked; binary messages, reserved bits and
 * messages above `maxMessage` bytes close the connection (1003 / 1002 /
 * 1009).  Messages the server sends are single unmasked text frames.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsHandlers {
  onText: (text: string) => void;
  onClose: (code: number) => void;
  onPong?: () => void;
}

export class WsConnection {
  readonly socket: Duplex;
  readonly maxMessage: number;
  handlers: WsHandlers | null = null;
  closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closeSent = false;

  constructor(socket: Duplex, maxMessage: number) {
    this.socket = socket;
    this.maxMessage = maxMessage;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
  }

  send(text: string): void {
    if (this.closed || this.closeSent) return;
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  ping(): void {
    if (!this.closed && !this.closeSent) this.frame(0x9, Buffer.alloc(0));
  }

  /** Sends a close frame and ends the socket shortly after. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeSent) {
      const r = Buffer.from(reason.slice(0, 100), 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this.frame(0x8, p);
      this.closeSent = true;
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish(code);
  }

  private frame(op: number, payload: Buffer): void {
    const n = payload.length;
    let head: Buffer;
    if (n < 126) {
      head = Buffer.from([0x80 | op, n]);
    } else if (n < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers?.onClose(code);
  }

  /** Bytes that came with the upgrade request (node's `head`). */
  feed(d: Buffer): void {
    if (d.length) this.onData(d);
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > this.maxMessage + 14 + 65536) return this.close(1009, 'too big');
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) return this.close(1009, 'too big');
        len = Number(big);
        off = 10;
      }
      if (rsv || !masked) return this.close(1002, 'protocol error');
      if (op >= 0x8 && (len > 125 || !fin)) return this.close(1002, 'protocol error');
      if (len > this.maxMessage) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code === 1005 || code === 1006 || code < 1000 ? 1000 : code);
        return;
      }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) { this.handlers?.onPong?.(); continue; }
      if (op === 0x2) return this.close(1003, 'text only');
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1 && this.fragments.length) return this.close(1002, 'protocol error');
        if (op === 0x0 && !this.fragments.length) return this.close(1002, 'protocol error');
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessage) return this.close(1009, 'too big');
        if (fin) {
          const all = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentBytes = 0;
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(all);
          } catch {
            return this.close(1007, 'bad utf-8');
          }
          this.handlers?.onText(text);
        }
        continue;
      }
      return this.close(1002, 'protocol error');
    }
  }
}

/** Answers the handshake; null (socket answered with 400 and destroyed) when the request is no valid upgrade. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, maxMessage: number): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (req.method !== 'GET' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || version !== '13'
    || !/websocket/i.test(String(req.headers.upgrade ?? ''))) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (socket instanceof Object && 'setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  return new WsConnection(socket, maxMessage);
}

export function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 1000).unref();
}
