// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The earlier versions of the game on the site, beside the newest one.
 *
 *   node tools/old-versions.ts --out dist [--cache .old-versions] [--budget 1000000000] [--pack data/work/old-versions]
 *
 * Run after the newest version was built into `--out` (npm run build, with
 * the map in it).  For every tag vX.Y.Z older than package.json's version –
 * and every development version of src/game/releases.ts (0.x, before 1.0.0:
 * a commit without a tag, `commit` there) – it puts that version's app under
 * <out>/v/X.Y.Z/ – the app only: each reads
 * the one map at the top of the site (GitHub Pages holds 1 GB, and the map
 * is most of it), and the traffic signs there too where its own are the same
 * as today's.  Then it writes <out>/versions.json, the list the game shows
 * (src/game/versions.ts).
 *
 * A version is built once: from the tag or commit (in a git worktree of its own, with
 * the packages its package-lock.json names), with two lines changed so that
 * it finds the map (and the signs) two folders up, without source maps, and
 * with a small link back to the newest version on its page.  The result is
 * kept in `--cache` (the workflow keeps that folder between runs – actions/
 * cache) and, if it is not there, looked for as a file of the version's
 * release (app-X.Y.Z-rN.tar.gz, written with --pack: upload it there and no
 * build ever has to make it again; a development version has no release –
 * its build is kept in the cache only, under a name with its commit).  RECIPE counts the way of building:
 * raise it when this file builds differently, and every version is built
 * anew.
 *
 * Versions are put on newest first while the site stays within --budget
 * bytes; those that do not fit are listed as not there.  Versions older
 * than MAP_READABLE_FROM cannot read today's map: they are listed, not built.
 *
 * Needs git, npm, curl and tar.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES } from '../src/game/releases.ts';
import { compareVersions } from '../src/game/versions.ts';
import type { HostedVersion, VersionList } from '../src/game/versions.ts';

/** the way of building (part of the name of every cached build) */
export const RECIPE = 1;
/**
 * The oldest version that reads the map of today.  The form of the map has
 * not changed since the development version 0.8.0 (map.json, the chunks w/…,
 * net.bin.gz and the tiles .fsb: src/world/loader.ts, netfile.ts and
 * tilefmt.ts are the same in 0.8.0, 0.9.0 and 1.0.0, and so is the code
 * that reads the tiles, render/tiles.ts): later maps only added files
 * (stops, lines, the far view, …), which older versions do not ask for, and
 * building styles (a facing-brick wall: a plain wall to them).  Before 0.8.0
 * the map was one world.json and tiles without the coding of their numbers –
 * neither of which a map has any more.
 * Raise it when a map comes that older versions cannot read.
 */
export const MAP_READABLE_FROM = '0.8.0';
/** GitHub Pages: a site of at most 1 GB */
const DEFAULT_BUDGET = 1_000_000_000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd: string, args: string[], cwd = root): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: exit ${r.status}`);
  return r.stdout;
}

/** bytes of a folder, all files in it */
export function folderSize(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += folderSize(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

/** Replace `from` by `to` in a file, where it must be once. */
function patch(file: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: "${from}" is there ${n} times, not once – the build of old versions needs a look (tools/old-versions.ts)`);
  writeFileSync(file, text.replace(from, to));
}

/**
 * The link back to the newest version, on the page of an earlier one: small,
 * in a corner, folded to an arrow after a few seconds (a tap target all the
 * same).  In plain HTML – the old app knows nothing of it.
 */
export function backLink(version: string): string {
  return `<a id="fs-latest" href="../../" title="Latest version" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;min-width:44px;min-height:44px;box-sizing:border-box;padding:0 14px;display:flex;align-items:center;justify-content:center;border-radius:22px;background:rgba(18,22,28,.72);color:#fff;font:600 14px/1 system-ui,sans-serif;text-decoration:none;opacity:.85">${version} ↩ <span id="fs-latest-text">&nbsp;latest</span></a>
<script>(function(){var l=(navigator.language||'en').slice(0,2),t={de:' neueste Version',fr:' dernière version',es:' última versión',it:' ultima versione',nl:' nieuwste versie',pl:' najnowsza wersja'}[l];var s=document.getElementById('fs-latest-text');if(t&&s)s.textContent='\\u00a0'+t;setTimeout(function(){if(s)s.remove();var a=document.getElementById('fs-latest');if(a){a.textContent='↩';a.title='${version} → latest';}},8000);})();</script>
`;
}

/** The versions that went before `latest`: the tags vX.Y.Z, newest first. */
export function olderTags(tags: string[], latest: string): string[] {
  return tags
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .filter((v) => compareVersions(v, latest) < 0)
    .sort((a, b) => compareVersions(b, a));
}

/** A development version (0.x before 1.0.0, no tag): its commit. */
export interface DevVersion {
  version: string;
  commit: string;
}

/** The development versions of src/game/releases.ts. */
export const DEV_VERSIONS: readonly DevVersion[] = RELEASES.flatMap((r) => (r.dev && r.commit ? [{ version: r.version, commit: r.commit }] : []));

/** All earlier versions: the older tags and the development versions, newest first (a tag wins over a development version of the same number). */
export function earlierVersions(tags: string[], dev: readonly DevVersion[], latest: string): string[] {
  const all = new Set(olderTags(tags, latest));
  for (const d of dev) if (compareVersions(d.version, latest) < 0) all.add(d.version);
  return [...all].sort((a, b) => compareVersions(b, a));
}

/**
 * Which versions go on the site: newest first, as long as they fit into what
 * is left of the budget.  `sizes`: the bytes of each built one (absent: not built).
 */
export function chooseHosted(versions: string[], sizes: Map<string, number>, room: number): Set<string> {
  const out = new Set<string>();
  for (const v of versions) {
    const n = sizes.get(v);
    if (n === undefined || n > room) continue;
    out.add(v);
    room -= n;
  }
  return out;
}

function repoUrl(): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { repository: { url: string } };
  return pkg.repository.url.replace(/\.git$/, '');
}

/** the name of a cached build, in the cache and as a file of the release */
const assetName = (v: string): string => `app-${v}-r${RECIPE}.tar.gz`;

/** Fetch the build of a version from its release, if it has one there. */
function fromRelease(v: string, into: string): boolean {
  const file = `${into}.tar.gz`;
  const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', file, `${repoUrl()}/releases/download/v${v}/${assetName(v)}`], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.status !== 0) {
    rmSync(file, { force: true });
    return false;
  }
  mkdirSync(into, { recursive: true });
  run('tar', ['-xzf', file, '-C', into]);
  rmSync(file, { force: true });
  return existsSync(join(into, 'index.html'));
}

/** Build version `v` from its tag or commit (`ref`) into `into`. */
function build(v: string, ref: string, into: string, work: string, base = '../../', ownMap = false): void {
  const tree = join(work, `tree-${v}`);
  rmSync(tree, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root });
  run('git', ['worktree', 'add', '--detach', '--force', tree, ref]);
  try {
    // the map – and the signs, where they are today's – two folders up: <site>/v/<version>/ → <site>/
    // (a version that cannot read today's map keeps the map it had, built in from its own public/map)
    if (!ownMap) patch(join(tree, 'src/game/app.ts'), "new URL('map/', document.baseURI)", `new URL('${base}map/', document.baseURI)`);
    const sameSigns = spawnSync('git', ['diff', '--quiet', '--diff-filter=DM', ref, 'HEAD', '--', 'public/signs'], { cwd: root }).status === 0;
    if (sameSigns && !ownMap) patch(join(tree, 'src/game/game.ts'), "new URL('signs/', document.baseURI)", `new URL('${base}signs/', document.baseURI)`);
    run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], tree);
    rmSync(into, { recursive: true, force: true });
    // (vite of the tag, its own config – the relative base './' that makes a build work in any folder)
    run(join(tree, 'node_modules/.bin/vite'), ['build', '--outDir', into, '--emptyOutDir', '--logLevel', 'warn'], tree);
    if (sameSigns && !ownMap) rmSync(join(into, 'signs'), { recursive: true, force: true });
    if (!ownMap) rmSync(join(into, 'map'), { recursive: true, force: true });
    for (const f of readdirSync(join(into, 'assets'))) if (f.endsWith('.map')) rmSync(join(into, 'assets', f));
    const html = join(into, 'index.html');
    const page = readFileSync(html, 'utf8');
    if (!page.includes('</body>')) throw new Error(`${html}: no </body>`);
    writeFileSync(html, page.replace('</body>', `${backLink(v)}</body>`));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root });
    rmSync(tree, { recursive: true, force: true });
  }
}

function main(): void {
  const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const out = resolve(root, arg('out', 'dist'));
  const cache = resolve(root, arg('cache', '.old-versions'));
  // (an archive of its own: the earlier versions are played from another site, which takes the map
  //  and the signs from this one by their absolute address – every version fits, no budget)
  const archiveBase = arg('archive', '');
  // (an archive holds the earlier versions: this site only names it, and keeps no room of its own for them)
  const archiveUrl = arg('archive-url', '');
  // (where the map and the signs lie, seen from a version's page: this site's own, or – an archive –
  //  the absolute address of the site that keeps the map)
  const mapSite = arg('map-site', '');
  const mapBase = arg('map-base', mapSite ? `${mapSite.replace(/\/+$/, '')}/` : '../../');
  const budget = archiveBase ? Number.POSITIVE_INFINITY : archiveUrl ? 0 : Number(arg('budget', String(DEFAULT_BUDGET)));
  const packDir = process.argv.includes('--pack') ? resolve(root, arg('pack', 'data/work/old-versions')) : null;
  // (an archive has no newest build of its own: the newest stays on the main site, and the archive
  //  holds only the earlier ones – so its dist/ may begin empty)
  if (!archiveBase && !existsSync(join(out, 'index.html'))) throw new Error(`${out}: build the newest version first (npm run build)`);
  const latest = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
  const tagList = run('git', ['tag', '-l', 'v*']).split('\n');
  const tagged = new Set(olderTags(tagList, latest));
  const tags = earlierVersions(tagList, DEV_VERSIONS, latest);
  // (a development version: its commit – by its sha, kept apart in the cache, no release to fetch from)
  const devCommit = (v: string): string | undefined => (tagged.has(v) ? undefined : DEV_VERSIONS.find((d) => d.version === v)?.commit);
  const refOf = (v: string): string => devCommit(v) ?? `v${v}`;
  const dirOf = (v: string): string => {
    const c = devCommit(v);
    return join(cache, c ? `${v}-${c.slice(0, 12)}-r${RECIPE}` : `${v}-r${RECIPE}`);
  };
  const when = (v: string): string | undefined => {
    try {
      return run('git', ['log', '-1', '--format=%cI', refOf(v)]).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  mkdirSync(cache, { recursive: true });
  const work = join(cache, '.work');
  const sizes = new Map<string, number>();
  for (const v of tags) {
    // (a version that cannot read today's map is built only for an archive, with the map it had)
    const ownMap = compareVersions(v, MAP_READABLE_FROM) < 0;
    if (ownMap && !archiveBase) continue;
    const dir = dirOf(v);
    if (!existsSync(join(dir, 'index.html'))) {
      rmSync(dir, { recursive: true, force: true });
      if (!devCommit(v) && fromRelease(v, dir)) console.log(`[old] ${v}: from the release`);
      else {
        console.log(`[old] ${v}: building from ${refOf(v)}`);
        build(v, refOf(v), dir, work, mapBase, ownMap);
      }
    } else console.log(`[old] ${v}: cached`);
    sizes.set(v, folderSize(dir));
    if (packDir && !devCommit(v)) {
      mkdirSync(packDir, { recursive: true });
      run('tar', ['-czf', join(packDir, assetName(v)), '-C', dir, '.']);
      console.log(`[old] ${join(packDir, assetName(v))}: for the release v${v}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  // (builds of an earlier recipe: no longer of use)
  for (const e of readdirSync(cache)) if (!e.endsWith(`-r${RECIPE}`)) rmSync(join(cache, e), { recursive: true, force: true });
  rmSync(join(out, 'v'), { recursive: true, force: true });
  // (an archive begins with an empty dist/ – no newest build there: make it)
  mkdirSync(out, { recursive: true });
  const room = budget - folderSize(out) - 64 * 1024;
  const hosted = chooseHosted(tags, sizes, room);
  for (const v of hosted) cpSync(dirOf(v), join(out, 'v', v), { recursive: true });
  const list: VersionList = {
    latest,
    ...(archiveBase || archiveUrl ? { archive: archiveBase || archiveUrl } : {}),
    versions: tags.map((v): HostedVersion => {
      const at = when(v);
      const oldMap = compareVersions(v, MAP_READABLE_FROM) < 0;
      return { version: v, hosted: hosted.has(v), map: !oldMap, ...(oldMap && archiveBase ? { ownMap: true } : {}), ...(at ? { at } : {}) };
    }),
  };
  writeFileSync(join(out, 'versions.json'), JSON.stringify(list, null, 1));
  const left = tags.filter((v) => !hosted.has(v));
  console.log(`[old] on the site: ${[...hosted].join(', ') || 'none'}${left.length ? `; not: ${left.join(', ')}` : ''} – ${(folderSize(out) / 1e6).toFixed(0)} MB of ${(budget / 1e6).toFixed(0)} MB`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
