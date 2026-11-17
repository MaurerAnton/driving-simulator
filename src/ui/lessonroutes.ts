// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the player sees of two things of 1.6.0, kept out of the big files:
 *
 *  - the set routes (game/routepresets.ts): a page of them, opened from the
 *    main menu, and a section of the big map's way planner – each route a
 *    big button with its name and what it leads through;
 *  - where the lessons take place (game/lessonplaces.ts): the question asked
 *    the first time a lesson starts, and the two rows of the settings page.
 *
 * Built from the classes the other pages use (overlay, panel, btn, row),
 * with tap targets as big as theirs.
 */
import { ROUTE_PRESETS } from '../game/routepresets.ts';
import { areaChoices } from '../game/lessonplaces.ts';
import type { LessonArea, LessonPlaceMode } from '../game/lessonplaces.ts';
import type { Settings } from '../game/settings.ts';
import type { SpawnJson } from '../world/types.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, text: string, act: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = act;
  return b;
}

/** One button for a set route: its name, and what it leads through below it. */
function routeButton(t: T, id: string, start: (id: string) => void): HTMLButtonElement {
  const b = button('btn ghost', '', () => start(id));
  b.style.cssText = 'display:block;width:100%;text-align:start;min-height:48px;margin:6px 0';
  const name = el('b', '', t(`routes.${id}.name`));
  const desc = el('small', '', t(`routes.${id}.desc`));
  desc.style.cssText = 'display:block;opacity:0.75;font-weight:400;margin-top:2px';
  b.append(name, desc);
  return b;
}

/** The page of set routes (from the main menu): a tap starts one – the drive begins at its first place. */
export function routePresetPage(t: T, start: (id: string) => void, back: () => void): HTMLElement {
  const o = el('div', 'overlay');
  const p = el('div', 'panel narrow');
  p.append(el('h1', '', t('routes.title')), el('p', '', t('routes.hint')));
  for (const r of ROUTE_PRESETS) p.append(routeButton(t, r.id, start));
  const b = el('div', 'buttons');
  b.append(button('btn', t('back'), back));
  p.append(b);
  o.append(p);
  return o;
}

/** The section of the big map's planner: the set routes, each driven from where the vehicle stands. */
export function routePresetSection(t: T, start: (id: string) => void): HTMLElement {
  const box = el('details', 'bm-tour');
  box.append(el('summary', '', t('routes.title')), el('small', 'bm-result', t('routes.mapHint')));
  for (const r of ROUTE_PRESETS) box.append(routeButton(t, r.id, start));
  return box;
}

/** The districts to choose from as a <select>, the chosen one (or the home town) selected. */
function areaSelect(s: Settings, spawns: readonly SpawnJson[], changed: () => void): HTMLSelectElement {
  const choices: LessonArea[] = areaChoices(spawns);
  const sel = el('select');
  choices.forEach((a, i) => {
    const op = el('option', '', a.name);
    op.value = String(i);
    sel.append(op);
  });
  const now = s.lessonArea;
  const at = now ? choices.findIndex((a) => a.name === now.name) : 0;
  sel.value = String(Math.max(0, at));
  sel.onchange = () => {
    const a = choices[Number(sel.value)];
    s.lessonArea = a ? { ...a } : null;
    changed();
  };
  return sel;
}

const MODES: ReadonlyArray<[LessonPlaceMode, string]> = [
  ['start', 'lessonPlace.start'],
  ['town', 'lessonPlace.town'],
  ['area', 'lessonPlace.area'],
];

/** The rows of the settings page: where the lessons take place, and the district for "in an area". */
export function lessonPlaceRows(t: T, s: Settings, spawns: readonly SpawnJson[], changed: () => void): HTMLElement[] {
  const row = el('div', 'row');
  const sel = el('select');
  for (const [v, k] of MODES) {
    const op = el('option', '', t(k));
    op.value = v;
    sel.append(op);
  }
  sel.value = s.lessonPlace;
  const areaRow = el('div', 'row');
  const area = areaSelect(s, spawns, changed);
  area.disabled = s.lessonPlace !== 'area';
  sel.onchange = () => {
    s.lessonPlace = sel.value as LessonPlaceMode;
    s.lessonPlaceAsked = true;
    area.disabled = s.lessonPlace !== 'area';
    if (s.lessonPlace === 'area' && !s.lessonArea) area.onchange?.(new Event('change'));
    changed();
  };
  row.append(el('label', '', t('lessonPlace.title')), sel);
  areaRow.append(el('label', '', t('lessonPlace.areaLabel')), area);
  return [row, areaRow, el('p', 'note', t('lessonPlace.note'))];
}

/**
 * The question asked the first time a lesson starts: where shall the lessons
 * take place?  `done` once answered (the settings are set; the caller saves
 * them and starts the lesson).
 */
export function askLessonPlace(t: T, s: Settings, spawns: readonly SpawnJson[], done: () => void): HTMLElement {
  const o = el('div', 'overlay');
  const p = el('div', 'panel narrow');
  p.append(el('h1', '', t('lessonPlace.title')), el('p', '', t('lessonPlace.ask')));
  const pick = (m: LessonPlaceMode): void => {
    s.lessonPlace = m;
    s.lessonPlaceAsked = true;
    done();
  };
  const big = (b: HTMLButtonElement): HTMLButtonElement => {
    b.style.cssText = 'display:block;width:100%;min-height:48px;margin:8px 0';
    return b;
  };
  p.append(big(button('btn', t('lessonPlace.start'), () => pick('start'))), big(button('btn ghost', t('lessonPlace.town'), () => pick('town'))));
  // "in an area": the district first, then go
  const areaRow = el('div', 'row');
  const area = areaSelect(s, spawns, () => {});
  if (!s.lessonArea) area.onchange?.(new Event('change'));
  const go = button('btn ghost', t('lessonPlace.area'), () => pick('area'));
  go.style.minHeight = '48px';
  areaRow.append(area, go);
  p.append(areaRow, el('p', 'note', t('lessonPlace.note')));
  o.append(p);
  return o;
}
