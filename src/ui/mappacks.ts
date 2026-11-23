// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The settings' part for the map: the site's map, or one loaded by hand from
 * files and stored in this browser (world/mappack.ts) – choosing one, loading
 * one (the files of a release: map.tar or all its parts map.tar.00, .01, …),
 * removing one, and how much room they take.  Another map takes effect when
 * the game is loaded again: a button does that.
 */
import type { Settings } from '../game/settings.ts';
import { saveSettings } from '../game/settings.ts';
import { formatBytes } from '../game/netstats.ts';
import { MapPackError, activeMapPack, importMapPack, listMapPacks, removeMapPack, storageEstimate } from '../world/mappack.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** where the maps are to be had */
export const MAP_RELEASES_URL = 'https://github.com/MaurerAnton/driving-simulator/releases';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function mapPackSettings(s: Settings, t: T, locale: string): HTMLElement {
  const box = el('div');
  box.append(el('h2', '', t('mapPack.title')));
  const size = (n: number): string => formatBytes(n, locale);
  const row = el('div', 'row');
  const sel = el('select');
  sel.style.maxWidth = '100%';
  const remove = el('button', 'btn ghost chip', t('mapPack.remove'));
  row.append(sel, remove);
  const status = el('p', 'note');
  const reloadRow = el('div', 'row');
  const reload = el('button', 'btn chip', t('mapPack.reload'));
  reload.onclick = () => location.reload();
  reloadRow.append(reload);
  reloadRow.hidden = true;
  // loading a map from files
  const loadRow = el('div', 'row');
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const load = el('button', 'btn ghost chip', t('mapPack.load'));
  load.onclick = () => input.click();
  const cancel = el('button', 'btn ghost chip', t('mapPack.cancel'));
  cancel.hidden = true;
  loadRow.append(load, cancel, input);
  const progress = el('p', 'note');
  progress.hidden = true;
  const help = el('p', 'note');
  const a = el('a', '', MAP_RELEASES_URL.replace(/^https:\/\//, ''));
  a.href = MAP_RELEASES_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  help.append(t('mapPack.help'), ' ', a);
  box.append(row, status, reloadRow, loadRow, progress, help);

  /** the map read now (the page was loaded with it) */
  const inUse = activeMapPack()?.info.id ?? '';

  const draw = async (): Promise<void> => {
    const packs = await listMapPacks();
    // (no map stored here: the picker would only repeat the region's – hide the choice itself,
    //  keep the way to load one from files; it comes back the moment there is a map)
    row.hidden = packs.length === 0 && !s.mapPack;
    status.hidden = packs.length === 0 && !s.mapPack;
    sel.replaceChildren();
    const op = el('option', '', t('mapPack.site'));
    op.value = '';
    sel.append(op);
    for (const p of packs) {
      const o = el('option', '', `${p.map ?? p.name} · ${size(p.size)}`);
      o.value = p.id;
      sel.append(o);
    }
    if (!packs.some((p) => p.id === s.mapPack)) s.mapPack = '';
    sel.value = s.mapPack;
    const chosen = packs.find((p) => p.id === s.mapPack);
    remove.hidden = !chosen;
    const room = await storageEstimate();
    const parts: string[] = [];
    if (chosen) parts.push(t('mapPack.info', { name: chosen.name, files: chosen.files, size: size(chosen.size) }));
    if (room) parts.push(t('mapPack.room', { used: size(room.usage), quota: size(room.quota) }));
    status.textContent = parts.join(' · ');
    reloadRow.hidden = s.mapPack === inUse;
  };

  sel.onchange = () => {
    s.mapPack = sel.value;
    saveSettings(s);
    void draw();
  };
  remove.onclick = async () => {
    const id = sel.value;
    if (!id || !confirm(t('mapPack.removeAsk'))) return;
    remove.disabled = true;
    try {
      await removeMapPack(id);
    } catch (e) {
      status.textContent = String(e);
    }
    remove.disabled = false;
    if (s.mapPack === id) {
      s.mapPack = '';
      saveSettings(s);
    }
    await draw();
  };
  let abort: AbortController | null = null;
  cancel.onclick = () => abort?.abort();
  input.onchange = async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    abort = new AbortController();
    load.disabled = true;
    cancel.hidden = false;
    progress.hidden = false;
    progress.textContent = t('mapPack.storing', { pct: 0 });
    let shown = 0;
    try {
      const info = await importMapPack(
        files,
        (read, total) => {
          const pct = Math.floor((100 * read) / Math.max(1, total));
          if (pct !== shown) {
            shown = pct;
            progress.textContent = t('mapPack.storing', { pct });
          }
        },
        abort.signal,
      );
      s.mapPack = info.id;
      saveSettings(s);
      progress.textContent = t('mapPack.stored', { files: info.files, size: size(info.size) });
    } catch (e) {
      const key = e instanceof MapPackError ? e.key : 'mapPack.err.other';
      const detail = e instanceof MapPackError && e.message !== e.key ? e.message : e instanceof MapPackError ? '' : String(e);
      progress.textContent = t(key, { detail });
    }
    abort = null;
    load.disabled = false;
    cancel.hidden = true;
    await draw();
  };
  void draw();
  return box;
}
