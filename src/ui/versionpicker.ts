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

/**
 * The warning on a button that plays an earlier version: only the game is of
 * that version, the map is today's.  As its tooltip and in its label – and,
 * on a touch screen (no tooltip there), as a note under it at the first tap;
 * the second tap goes.  `version()`: the version it plays now (a choice).
 */
function warnOnPlay(b: HTMLButtonElement, version: () => string, latest: string, t: T, go: () => void): HTMLButtonElement {
  const label = (b.textContent ?? '').replace(/^▶\s*/, '');
  let note: HTMLElement | null = null;
  let shownFor = '';
  /** The first version that could load a region of its own (before it, only the site's Nordhessen map). */
  const REGIONS_FROM = '1.7.4';
  const noRegions = (v: string): boolean => {
    // (a version older than 1.7.4 knows no regions: it plays the one map of this website)
    const [a, b2, c] = v.split('.').map(Number);
    const [x, y, z] = REGIONS_FROM.split('.').map(Number);
    return a * 1e6 + b2 * 1e3 + c < x * 1e6 + y * 1e3 + z;
  };
  const describe = (): void => {
    if (version() === latest) {
      // (the newest: its map is its own)
      b.removeAttribute('title');
      b.removeAttribute('aria-label');
    } else {
      b.title = `${t('version.playNote', { v: version() })}${noRegions(version()) ? ` ${t('version.noRegions')}` : ''}`;
      b.setAttribute('aria-label', `${label}. ${b.title}`);
    }
    if (note && shownFor !== version()) {
      note.remove();
      shownFor = '';
    }
  };
  describe();
  b.onclick = () => {
    const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    if (touch && version() !== latest && shownFor !== version()) {
      shownFor = version();
      note ??= el('p', 'note');
      note.textContent = `ⓘ ${t('version.playNote', { v: shownFor })}${noRegions(shownFor) ? ` ${t('version.noRegions')}` : ''}`;
      // (in the settings the button sits in a row with the choice: the note goes under the row)
      (b.parentElement?.classList.contains('row') ? b.parentElement : b).after(note);
      return;
    }
    go();
  };
  b.addEventListener('fs-describe', describe);
  return b;
}

/** Go to (play) a version. */
export function openVersion(version: string, latest: string, archive?: string): void {
  // (an earlier version would reset what it does not know: the settings are put back on return – game/versions.ts)
  if (version !== latest) keepForReturn(document.baseURI);
  location.assign(versionHref(root(), version, latest, archive));
}

/** The list of the site – null without one. */
export function siteVersions(): Promise<VersionList | null> {
  return loadVersions(root());
}

/**
 * A button to play `version` (for "What's new"): hidden until the site's
 * list says that version can be played; none for the version running.  For
 * a version the list has as unable to read today's map: a note saying so.
 */
export function playVersionButton(version: string, t: T): HTMLElement | null {
  if (version === VERSION) return null;
  const b = el('button', 'btn ghost chip', `▶ ${t('version.play', { v: version })}`);
  b.hidden = true;
  void siteVersions().then((list) => {
    // (one built for a map of another form – the development versions before 0.8.0 – is listed: said so in place of the button)
    if (list?.versions.some((e) => e.version === version && !e.map)) {
      b.replaceWith(el('p', 'note', t('version.oldMap')));
      return;
    }
    if (!list || !playable(list, version)) return;
    b.hidden = false;
    warnOnPlay(b, () => version, list.latest, t, () => openVersion(version, list.latest));
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
      // (an archived version is played from the archive: nothing to warn about but its map)
      const here = v.hosted || !!list.archive || !!v.ownMap;
      const why = !v.map && !v.ownMap ? ` – ${t('version.oldMap')}` : !here ? ` – ${t('version.notHosted')}` : '';
      add(v.version, `${v.version}${v.at ? ` (${formatTime(v.at)})` : ''}${why}`, here && (v.map || !!v.ownMap));
    }
    sel.value = VERSION;
    if (sel.value !== VERSION) sel.value = list.latest;
    const refresh = (): void => {
      go.disabled = sel.value === VERSION;
      // (the warning, for the version chosen)
      go.dispatchEvent(new Event('fs-describe'));
    };
    sel.onchange = refresh;
    warnOnPlay(go, () => sel.value, list.latest, t, () => openVersion(sel.value, list.latest, list.archive));
    refresh();
    row.hidden = false;
    note.textContent = `${t('version.running', { v: VERSION })} ${t('version.note')}`;
  });
  return box;
}
