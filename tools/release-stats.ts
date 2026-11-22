// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How big the game was at a version: the lines of its code, its tests and
 * its translations, and the bytes of the files in the repository – shown
 * beside the date of every version in "What's new" (src/game/releases.ts,
 * the field `size`).
 *
 *   node tools/release-stats.ts <commit or tag> …        the numbers, as JSON
 *   node tools/release-stats.ts --worktree               the same for the files as they are now
 *   node tools/release-stats.ts --fill 1.7.0 --worktree  put them into the entry of 1.7.0
 *   node tools/release-stats.ts --fill all               every entry, from its commit or its tag vX.Y.Z
 *
 * A release: right before its commit, `--fill X.Y.Z --worktree` (the files
 * that will be committed: tracked ones and new ones git does not ignore).
 *
 * What is counted: the files git has at that version, without the map
 * (public/map – in the repository up to 0.7.0, a file of a release since).
 * Lines are those of text files only (a file with a zero byte is binary):
 * code – .ts .cpp .css .html .mjs .py under src/, tools/ and server/ (without
 * the tests and the translations); tests – the same kinds under tests/ and
 * server/tests/; translations – src/i18n/*.ts (up to 0.5.0: src/ui/i18n.ts);
 * and all lines of all text
 * files.  Bytes: all files, binary ones too (the map left out).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES } from '../src/game/releases.ts';
import type { ReleaseSize } from '../src/game/releases.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY = new Uint8Array(0);

const CODE_EXT = /\.(ts|cpp|css|html|mjs|py)$/;

/** Which count a file's lines go into, besides the total ('' : only the total). */
export function kindOf(path: string): 'code' | 'tests' | 'i18n' | '' {
  if (path.startsWith('public/map/')) return '';
  // (up to 0.5.0 the German and English texts were one file: src/ui/i18n.ts)
  if (/^src\/i18n\/[^/]+\.ts$/.test(path) || path === 'src/ui/i18n.ts') return 'i18n';
  if (!CODE_EXT.test(path)) return '';
  if (path.startsWith('tests/') || path.startsWith('server/tests/')) return 'tests';
  if (path.startsWith('src/') || path.startsWith('tools/') || path.startsWith('server/')) return 'code';
  return '';
}

/** lines of a text file – null for a binary one */
export function linesOf(buf: Uint8Array): number | null {
  if (buf.subarray(0, 8000).includes(0)) return null;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  if (buf.length > 0 && buf[buf.length - 1] !== 10) n++;
  return n;
}

/** Add up files: (path, bytes, contents). */
export function tally(files: Iterable<{ path: string; bytes: number; data: Uint8Array }>): ReleaseSize {
  const s: ReleaseSize = { lines: 0, code: 0, tests: 0, i18n: 0, bytes: 0, maps: 0 };
  for (const f of files) {
    if (f.path.startsWith('public/map/')) continue;
    // (the additional maps are data like the map itself: counted apart, not as the game)
    if (f.path.startsWith('map-assets/')) {
      s.maps = (s.maps ?? 0) + f.bytes;
      continue;
    }
    s.bytes += f.bytes;
    const n = linesOf(f.data);
    if (n === null) continue;
    s.lines += n;
    const k = kindOf(f.path);
    if (k) s[k] += n;
  }
  return s;
}

function git(args: string[], input?: Buffer): Buffer {
  const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** The numbers of a commit or tag. */
export function statsAt(ref: string): ReleaseSize {
  const entries: { path: string; sha: string; bytes: number }[] = [];
  for (const line of git(['ls-tree', '-r', '-l', '-z', ref]).toString('utf8').split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+) +(\d+)\t(.*)$/s.exec(line);
    if (m && !m[3].startsWith('public/map/')) entries.push({ sha: m[1], bytes: Number(m[2]), path: m[3] });
  }
  // (every blob in one go: git cat-file --batch answers "<sha> blob <size>\n<contents>\n" for each)
  const out = git(['cat-file', '--batch'], Buffer.from(entries.map((e) => e.sha).join('\n') + '\n'));
  let at = 0;
  const files = entries.map((e) => {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    const data = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    return { path: e.path, bytes: e.bytes, data };
  });
  return tally(files);
}

/** The numbers of the files as they are now: tracked ones and new ones git does not ignore (what a commit of all would hold). */
export function statsOfWorktree(): ReleaseSize {
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set(paths)].flatMap((path) => {
    // (the maps are data: only counted as bytes, so their contents are never read – a whole
    //  map-assets/ of parts would not fit in memory, and tally would skip them anyway)
    if (path.startsWith('map-assets/') || path.startsWith('public/map/')) {
      try {
        const st = statSync(resolve(root, path));
        if (st.isFile()) return [{ path, bytes: st.size, data: EMPTY }];
      } catch {
        // (gone)
      }
      return [];
    }
    const p = resolve(root, path);
    try {
      if (!statSync(p).isFile()) return [];
      const data = readFileSync(p);
      return [{ path, bytes: data.length, data }];
    } catch {
      return []; // (deleted, not yet committed)
    }
  });
  return tally(files);
}

/** The commit a release was made from: its own (a development version) or its tag. */
const refOf = (version: string): string => RELEASES.find((r) => r.version === version)?.commit ?? `v${version}`;

/** Put the numbers into the entry of `version` in src/game/releases.ts (its `size: …` line). */
export function fillInto(text: string, version: string, s: ReleaseSize): string {
  const start = text.indexOf(`version: '${version}',`);
  if (start < 0) throw new Error(`src/game/releases.ts: no entry ${version}`);
  const next = text.indexOf('version: ', start + 10);
  const end = next < 0 ? text.length : next;
  const m = /size: (null|\{[^}]*\}),/.exec(text.slice(start, end));
  if (!m) throw new Error(`src/game/releases.ts: the entry ${version} has no line "size: …,"`);
  const lit = `size: { lines: ${s.lines}, code: ${s.code}, tests: ${s.tests}, i18n: ${s.i18n}, bytes: ${s.bytes}, maps: ${s.maps} },`;
  const at = start + m.index;
  return text.slice(0, at) + lit + text.slice(at + m[0].length);
}

function main(): void {
  const args = process.argv.slice(2);
  const worktree = args.includes('--worktree');
  const fi = args.indexOf('--fill');
  if (fi >= 0) {
    const what = args[fi + 1];
    if (!what) throw new Error('--fill <version|all>');
    if (what === 'all' && worktree) throw new Error('--worktree is for one version: --fill X.Y.Z --worktree');
    const file = resolve(root, 'src/game/releases.ts');
    let text = readFileSync(file, 'utf8');
    const versions = what === 'all' ? RELEASES.map((r) => r.version) : [what];
    for (const v of versions) {
      let s: ReleaseSize;
      if (worktree) s = statsOfWorktree();
      else {
        try {
          s = statsAt(refOf(v));
        } catch {
          console.log(`[stats] ${v}: no ${refOf(v)} – left as it is (not released yet? --worktree right before its commit)`);
          continue;
        }
      }
      text = fillInto(text, v, s);
      console.log(`[stats] ${v}: ${JSON.stringify(s)}`);
    }
    writeFileSync(file, text);
    return;
  }
  const out: Record<string, ReleaseSize> = {};
  if (worktree) out.worktree = statsOfWorktree();
  for (const ref of args.filter((a) => !a.startsWith('--'))) out[ref] = statsAt(ref);
  console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
