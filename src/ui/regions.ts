// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The settings' part for the region: the site's own map, or one of the regions
 * of map-assets (world/regions.ts) – choosing one.  A region is a map of its own
 * (its own extent, roads and places to start at); its files come from
 * map-assets (world/regionfiles.ts), and one is loaded instead of the site's
 * map when the game is loaded again.
 *
 * The list is read once from `regions.json` beside the parts index.  A region
 * the index does not name is not offered; if the index cannot be read (an older
 * repository without regions, or offline) only the site's own map is offered.
 */
import type { Settings } from '../game/settings.ts';
import { saveSettings } from '../game/settings.ts';
import { parseRegions, type Region, type RegionIndex } from '../world/regions.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Where the index of regions is had: the repository over raw.githubusercontent (CORS ok), or the site. */
export async function loadRegionIndex(fetchRepo = true, siteBase = 'map-assets/', fetchFn: typeof fetch = fetch): Promise<RegionIndex | null> {
  const urls: string[] = [];
  if (fetchRepo) {
    urls.push('https://raw.githubusercontent.com/MaurerAnton/driving-simulator/main/map-assets/regions.json');
  }
  urls.push(`${siteBase}regions.json`);
  for (const url of urls) {
    try {
      const res = await fetchFn(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      const index = parseRegions(await res.json());
      if (index) return index;
    } catch {
      // (offline, or a repository without regions: try the next)
    }
  }
  return null;
}

/** The region with this id in the index, or null. */
export function findRegion(index: RegionIndex | null, id: string): Region | null {
  if (!index || !id) return null;
  return index.regions.find((r) => r.id === id) ?? null;
}

/**
 * The settings' part for the region: a choice among the regions of map-assets,
 * and the site's own map as the first entry.  Changing it is applied the next
 * time the game is loaded (a button does that).
 */
export function regionSettings(s: Settings, t: T): HTMLElement {
  const box = el('div');
  box.append(el('h2', '', t('region.title')));
  const row = el('div', 'row');
  const sel = el('select');
  sel.style.maxWidth = '100%';
  row.append(sel);
  const status = el('p', 'note');
  const reloadRow = el('div', 'row');
  const reload = el('button', 'btn chip', t('region.reload'));
  reload.onclick = () => location.reload();
  reloadRow.append(reload);
  reloadRow.hidden = true;
  const help = el('p', 'note');
  help.textContent = t('region.help');
  box.append(row, status, reloadRow, help);

  /** the region loaded now (the page was loaded with it) */
  const inUse = s.region;

  const draw = (index: RegionIndex | null): void => {
    sel.replaceChildren();
    const site = el('option', '', t('region.site'));
    site.value = '';
    sel.append(site);
    for (const r of index?.regions ?? []) {
      const o = el('option', '', r.name);
      o.value = r.id;
      sel.append(o);
    }
    // a region chosen that the index no longer names: back to the site's map
    if (s.region && !findRegion(index, s.region)) s.region = '';
    sel.value = s.region;
    if (!index) status.textContent = t('region.none');
    else if (!s.region) status.textContent = t('region.siteNote');
    else status.textContent = t('region.note', { name: findRegion(index, s.region)?.name ?? s.region });
    reloadRow.hidden = s.region === inUse;
  };

  sel.onchange = () => {
    s.region = sel.value;
    saveSettings(s);
    reloadRow.hidden = s.region === inUse;
    status.textContent = s.region ? t('region.note', { name: s.region }) : t('region.siteNote');
  };

  void loadRegionIndex().then(draw);
  return box;
}
