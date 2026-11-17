// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Playing an earlier version of the game: a choice in the settings, and a
 * button at every version in "What's new".  Each version is a page of its
 * own on the site (game/versions.ts): choosing one goes there – the newest is
 * the top of the site.  Where the site has no list of versions (a
 * development server, a copy of the app on its own) there is nothing to
 * choose, and the settings say so.
 */
import { VERSION } from '../game/releases.ts';
import { keepForReturn, loadVersions, playable, siteRoot, versionHref } from '../game/versions.ts';
import type { VersionList } from '../game/versions.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const root = (): string => siteRoot(document.baseURI);

/** Go to (play) a version. */
export function openVersion(version: string, latest: string): void {
  // (an earlier version would reset what it does not know: the settings are put back on return – game/versions.ts)
  if (version !== latest) keepForReturn(document.baseURI);
  location.assign(versionHref(root(), version, latest));
}

/** The list of the site – null without one. */
export function siteVersions(): Promise<VersionList | null> {
  return loadVersions(root());
}

/**
 * A button to play `version` (for "What's new"): hidden until the site's
 * list says that version can be played; none for the version running.
 */
export function playVersionButton(version: string, t: T): HTMLElement | null {
  if (version === VERSION) return null;
  const b = el('button', 'btn ghost chip', `▶ ${t('version.play', { v: version })}`);
  b.hidden = true;
  void siteVersions().then((list) => {
    if (!list || !playable(list, version)) return;
    b.hidden = false;
    b.onclick = () => openVersion(version, list.latest);
  });
  return b;
}

/** The settings' part: which version of the game to play. */
export function versionSettings(t: T, formatTime: (iso: string) => string): HTMLElement {
  const box = el('div');
  box.append(el('h2', '', t('version.title')));
  const row = el('div', 'row');
  const sel = el('select');
  const go = el('button', 'btn ghost chip', t('version.open'));
  go.disabled = true;
  row.append(sel, go);
  const note = el('p', 'note', t('version.running', { v: VERSION }));
  box.append(row, note);
  row.hidden = true;
  void siteVersions().then((list) => {
    if (!list) {
      note.textContent = `${t('version.running', { v: VERSION })} ${t('version.none')}`;
      return;
    }
    const add = (value: string, text: string, ok: boolean): void => {
      const op = el('option', '', text);
      op.value = value;
      op.disabled = !ok;
      sel.append(op);
    };
    add(list.latest, t('version.latest', { v: list.latest }), true);
    for (const v of list.versions) {
      const why = !v.map ? ` – ${t('version.oldMap')}` : !v.hosted ? ` – ${t('version.notHosted')}` : '';
      add(v.version, `${v.version}${v.at ? ` (${formatTime(v.at)})` : ''}${why}`, v.hosted && v.map);
    }
    sel.value = VERSION;
    if (sel.value !== VERSION) sel.value = list.latest;
    const refresh = (): void => {
      go.disabled = sel.value === VERSION;
    };
    sel.onchange = refresh;
    go.onclick = () => openVersion(sel.value, list.latest);
    refresh();
    row.hidden = false;
    note.textContent = `${t('version.running', { v: VERSION })} ${t('version.note')}`;
  });
  return box;
}
