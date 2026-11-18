// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTTP helpers: errors as `{"error", "message"}`, JSON answers, reading a
 * body with a size limit, the client's address behind trusted proxies, and
 * CORS by a list of allowed origins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error that becomes an HTTP answer. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (message: string, code = 'bad_request'): ApiError => new ApiError(400, code, message);
export const notFound = (what = 'not found'): ApiError => new ApiError(404, 'not_found', what);
export const forbidden = (message = 'not allowed', code = 'forbidden'): ApiError => new ApiError(403, code, message);

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendBytes(res: ServerResponse, type: string, data: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(data.length), ...headers });
  res.end(data);
}

export function sendError(res: ServerResponse, e: ApiError): void {
  const headers: Record<string, string> = {};
  if (e.status === 429) headers['Retry-After'] = '60';
  sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra }, headers);
}

/** Reads the whole body, at most `limit` bytes (413 beyond). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new ApiError(413, 'too_large', `the body may have at most ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      n += c.length;
      if (n > limit) {
        done = true;
        req.resume();
        reject(new ApiError(413, 'too_large', `the body may have at most ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** Reads a JSON object body; with `optional` an empty body counts as `{}`. */
export async function readJson(req: IncomingMessage, limit: number, optional = false): Promise<Record<string, unknown>> {
  const b = await readBody(req, limit);
  if (optional && !b.toString('utf8').trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(b.toString('utf8'));
  } catch {
    throw bad('the body is not valid JSON', 'bad_json');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('the body must be a JSON object', 'bad_json');
  return v as Record<string, unknown>;
}

/** The client's address: the socket's, or – behind `trustProxy` proxies – the one they saw in X-Forwarded-For. */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy <= 0) return direct;
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return direct;
  return list[Math.max(0, list.length - trustProxy)];
}

function originRegex(pattern: string): RegExp {
  const esc = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9.-]*');
  return new RegExp(`^${esc}$`);
}

/** True when `origin` matches one of the patterns (`*` stands for any host name part or port). */
export function originAllowed(origin: string, patterns: string[]): boolean {
  const o = origin.toLowerCase();
  return patterns.some((p) => (p === '*' ? true : originRegex(p).test(o)));
}

export function corsHeaders(origin: string | undefined, patterns: string[]): Record<string, string> {
  if (!origin || !originAllowed(origin, patterns)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------- validation

export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length < min || s.length > max) throw bad(`${field} must have ${min} to ${max} characters`);
  return s;
}

export function optStr(v: unknown, field: string, max: number): string | undefined {
  return v === undefined || v === null ? undefined : str(v, field, 0, max);
}

export function numIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${field} must be a number from ${min} to ${max}`);
  return v;
}

export function optNum(v: unknown, field: string, min: number, max: number): number | undefined {
  return v === undefined || v === null ? undefined : numIn(v, field, min, max);
}

export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${field} must be true or false`);
  return v;
}

/** An ISO-8601 date-time (or date), normalised to UTC; undefined when absent. */
export function optTime(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw bad(`${field} must be an ISO-8601 time`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw bad(`${field} must be an ISO-8601 time`);
  return new Date(t).toISOString();
}
