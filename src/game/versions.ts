// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The versions of the game one may play: the newest at the top of the site,
 * every earlier one under v/<version>/ beside it – each its own build of the
 * app (a few megabytes), all of them reading the one map at the top
 * (tools/old-versions.ts builds them and writes versions.json, the list the
 * game shows; .github/workflows/pages.yml puts it all on the site).
 *
 * This file: reading that list, and the addresses – where the top of the
 * site is from wherever a version runs, and where each version is.
 */

export interface HostedVersion {
  /** "1.2.0" */
  version: string;
  /** when it was released (ISO), if known */
  at?: string;
  /** it is on the site (there is room for so many versions only: the newest are) */
  hosted: boolean;
  /** it can read the map the site has (false: built for a map of another form – listed, not playable) */
  map: boolean;
}

export interface VersionList {
  /** the version at the top of the site */
  latest: string;
  /** the earlier versions, newest first */
  versions: HostedVersion[];
}

/** where an earlier version lies, below the top of the site */
export const VERSION_DIR = 'v/';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** -1, 0, 1: which of two versions ("1.10.0", "1.9.2") is the newer */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** versions.json as written by tools/old-versions.ts – null if it is not that */
export function parseVersions(json: unknown): VersionList | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as { latest?: unknown; versions?: unknown };
  if (typeof o.latest !== 'string' || !SEMVER.test(o.latest) || !Array.isArray(o.versions)) return null;
  const versions: HostedVersion[] = [];
  for (const v of o.versions as unknown[]) {
    if (typeof v !== 'object' || v === null) continue;
    const e = v as Partial<HostedVersion>;
    if (typeof e.version !== 'string' || !SEMVER.test(e.version) || e.version === o.latest) continue;
    versions.push({ version: e.version, hosted: e.hosted === true, map: e.map !== false, ...(typeof e.at === 'string' ? { at: e.at } : {}) });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return { latest: o.latest, versions };
}

/** The version an address is of, if it is one of the earlier ones (…/v/1.2.0/…) – else null. */
export function versionOfPath(href: string): string | null {
  const path = new URL(href).pathname;
  const m = /\/v\/(\d+\.\d+\.\d+)\/(?:[^/]*)$/.exec(path);
  return m ? m[1] : null;
}

/** The top of the site, from the address of the page (its base) – also from an earlier version under v/<version>/. */
export function siteRoot(baseHref: string): string {
  const here = new URL('./', baseHref);
  return versionOfPath(here.href) ? new URL('../../', here).href : here.href;
}

/** The address of a version: the top of the site for the latest one, v/<version>/ below it for the others. */
export function versionHref(root: string, version: string, latest: string): string {
  return version === latest ? root : new URL(`${VERSION_DIR}${version}/`, root).href;
}

/** Can this version be played from the list? */
export function playable(list: VersionList, version: string): boolean {
  if (version === list.latest) return true;
  const v = list.versions.find((e) => e.version === version);
  return !!v && v.hosted && v.map;
}

let loaded: Promise<VersionList | null> | null = null;

/** The list of the site (versions.json at its top) – null where there is none (a development server, a copy of the app alone). */
export function loadVersions(root: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<VersionList | null> {
  loaded ??= fetchFn(new URL('versions.json', root).href, { cache: 'no-cache' })
    .then(async (r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? parseVersions(await r.json()) : null))
    .catch(() => null);
  return loaded;
}

/**
 * What an earlier version would spoil: it keeps to its own settings and
 * resets what it does not know (a vehicle, a menu that came later) – and
 * marks its notes as seen.  So these are put aside when the newest version
 * is left for an earlier one, and put back when the newest runs again.
 */
const KEPT_KEYS = ['fahrsim-baunatal.settings.v2', 'fahrsim-baunatal.news'];
const KEPT = 'fahrsim-baunatal.beforeOldVersion';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Put the settings aside: about to go from the newest version to an earlier one (`fromHref`: the page's base). */
export function keepForReturn(fromHref: string, store: Store | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!store || versionOfPath(fromHref) !== null) return;
  try {
    const kept: Record<string, string> = {};
    for (const k of KEPT_KEYS) {
      const v = store.getItem(k);
      if (v !== null) kept[k] = v;
    }
    store.setItem(KEPT, JSON.stringify(kept));
  } catch {
    /* nothing kept: nothing to put back */
  }
}

/** Back in the newest version (at the top of the site): the settings as they were before the earlier one ran. */
export function restoreAfterOldVersion(hereHref: string, store: Store | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!store || versionOfPath(hereHref) !== null) return;
  try {
    const raw = store.getItem(KEPT);
    if (raw === null) return;
    store.removeItem(KEPT);
    const kept = JSON.parse(raw) as Record<string, unknown>;
    for (const k of KEPT_KEYS) if (typeof kept[k] === 'string') store.setItem(k, kept[k]);
  } catch {
    /* as it is, then */
  }
}
