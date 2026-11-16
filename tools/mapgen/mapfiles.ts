// SPDX-License-Identifier: AGPL-3.0-only
/** The files of a map folder on disk, for the map loader (src/world/loader.ts) in tools and tests. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { MapFiles } from '../../src/world/loader.ts';

export function diskFiles(dir: string): MapFiles {
  return {
    bytes(path: string): Promise<ArrayBuffer | null> {
      const file = resolve(dir, path);
      if (!existsSync(file)) return Promise.resolve(null);
      const raw = readFileSync(file);
      const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
      return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    },
  };
}
