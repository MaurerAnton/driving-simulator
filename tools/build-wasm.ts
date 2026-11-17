// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Builds the WebAssembly of the game (src/wasm/kernels.cpp) into
 * src/wasm/kernels.wasm.ts – the module as base64, with the SHA-256 of the
 * source it was built from – and checks that the two belong together:
 *
 *   node tools/build-wasm.ts           # build (needs clang with the wasm32 target)
 *   node tools/build-wasm.ts --check   # does the module still match its source?  (no compiler needed)
 *
 * No linker and no Emscripten: clang compiles the one source file to a
 * relocatable WebAssembly object, which is already a module a browser can
 * run when there is nothing to link – no C library, no static data (the
 * memory is laid out by src/wasm/kernels.ts) and only the imports
 * allowed below.  This build checks that, then drops the sections only a
 * linker reads (linking, reloc.*, producers, target_features).
 *
 * The module is part of the repository, so neither the game's build nor
 * the deployment needs clang; the workflow (.github/workflows/pages.yml)
 * and a test (tests/world/wasm.test.ts) check that it was rebuilt whenever
 * the source changed.  Other versions of clang give other bytes – the
 * JavaScript twins are the reference, and the test checks that both agree.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(root, 'src/wasm/kernels.cpp');
const OUT = join(root, 'src/wasm/kernels.wasm.ts');
const CLANG = process.env.CLANG ?? 'clang++';
const FLAGS = [
  '--target=wasm32',
  // (the first WebAssembly: every browser that has WebAssembly at all)
  '-mcpu=mvp',
  '-O2',
  '-ffreestanding',
  '-nostdlib',
  '-fno-exceptions',
  '-fno-rtti',
  // the same doubles as the JavaScript: no fused multiply-add, no fast math
  '-ffp-contract=off',
  '-std=c++17',
  '-Wall',
  '-Werror',
];
/** what the module may import (env.…) */
const ALLOWED_IMPORTS = new Set(['__linear_memory', '__indirect_function_table', '__stack_pointer', 'way_cost']);

export function sourceHash(): string {
  return createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
}

/** The hash and the module written in kernels.wasm.ts. */
export function builtModule(): { hash: string; bytes: Uint8Array } | null {
  let text: string;
  try {
    text = readFileSync(OUT, 'utf8');
  } catch {
    return null;
  }
  const hash = /SOURCE_SHA256 = '([0-9a-f]{64})'/.exec(text)?.[1];
  const b64 = /WASM_BASE64 =\s*'([A-Za-z0-9+/=]*)'/.exec(text)?.[1];
  if (!hash || b64 === undefined) return null;
  return { hash, bytes: new Uint8Array(Buffer.from(b64, 'base64')) };
}

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function readLeb(b: Uint8Array, at: { p: number }): number {
  let n = 0;
  let shift = 0;
  for (;;) {
    const x = b[at.p++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return n >>> 0;
    shift += 7;
  }
}

/** The object without the sections for a linker, with the hash of its source as a custom section. */
export function finish(obj: Uint8Array, hash: string): Uint8Array {
  if (obj[0] !== 0 || obj[1] !== 0x61 || obj[2] !== 0x73 || obj[3] !== 0x6d) throw new Error('not WebAssembly');
  const parts: number[] = Array.from(obj.subarray(0, 8));
  const at = { p: 8 };
  while (at.p < obj.length) {
    const start = at.p;
    const id = obj[at.p++];
    const size = readLeb(obj, at);
    const body = at.p;
    at.p = body + size;
    if (id === 11) throw new Error('static data in the module (DATA section) – kernels.cpp must keep everything in memory handed over by the JavaScript');
    if (id === 0) continue;
    parts.push(...obj.subarray(start, at.p));
  }
  const name = new TextEncoder().encode('fahrsim-source-sha256');
  const payload = [...leb(name.length), ...name, ...new TextEncoder().encode(hash)];
  parts.push(0, ...leb(payload.length), ...payload);
  return Uint8Array.from(parts);
}

function check(bytes: Uint8Array): void {
  const m = new WebAssembly.Module(bytes as BufferSource);
  for (const i of WebAssembly.Module.imports(m)) {
    if (i.module !== 'env' || !ALLOWED_IMPORTS.has(i.name)) throw new Error(`the module imports ${i.module}.${i.name} – it must not need a C library`);
  }
  const exports = WebAssembly.Module.exports(m).map((e) => e.name);
  for (const e of ['decode_section', 'unpack_faces', 'route_prepare', 'route_search']) if (!exports.includes(e)) throw new Error(`no export ${e}`);
}

function build(): void {
  const dir = mkdtempSync(join(tmpdir(), 'fahrsim-wasm-'));
  try {
    const obj = join(dir, 'kernels.o');
    execFileSync(CLANG, [...FLAGS, '-c', SOURCE, '-o', obj], { stdio: 'inherit' });
    const hash = sourceHash();
    const wasm = finish(new Uint8Array(readFileSync(obj)), hash);
    check(wasm);
    const clang = execFileSync(CLANG, ['--version'], { encoding: 'utf8' }).split('\n')[0];
    const b64 = Buffer.from(wasm).toString('base64');
    const lines = b64.match(/.{1,120}/g) ?? [''];
    writeFileSync(
      OUT,
      `// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GENERATED by tools/build-wasm.ts from src/wasm/kernels.cpp – do not edit;
 * rebuild with \`node tools/build-wasm.ts\` after changing the source.
 * (${wasm.length} bytes of WebAssembly; ${clang.replace(/\*\//g, '')})
 */
export const SOURCE_SHA256 = '${hash}';
export const WASM_BASE64 =
  '${lines.join('')}';
`,
    );
    console.log(`src/wasm/kernels.wasm.ts: ${wasm.length} bytes of WebAssembly (${b64.length} as base64), source ${hash.slice(0, 12)}…`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const built = builtModule();
    const hash = sourceHash();
    if (!built) {
      console.error('src/wasm/kernels.wasm.ts is missing or unreadable: run node tools/build-wasm.ts');
      process.exit(1);
    }
    if (built.hash !== hash) {
      console.error(`src/wasm/kernels.cpp changed since src/wasm/kernels.wasm.ts was built (${built.hash.slice(0, 12)}… ≠ ${hash.slice(0, 12)}…): run node tools/build-wasm.ts`);
      process.exit(1);
    }
    const inModule = WebAssembly.Module.customSections(new WebAssembly.Module(built.bytes as BufferSource), 'fahrsim-source-sha256')[0];
    if (!inModule || new TextDecoder().decode(inModule) !== hash) {
      console.error('the module in src/wasm/kernels.wasm.ts does not carry the hash of its source: run node tools/build-wasm.ts');
      process.exit(1);
    }
    check(built.bytes);
    console.log(`src/wasm/kernels.wasm.ts matches src/wasm/kernels.cpp (${built.bytes.length} bytes)`);
  } else build();
}
