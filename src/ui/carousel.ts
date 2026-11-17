// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The main menu in rows over the 3D scene: the vehicle, the town, the place
 * in it, the options of that vehicle, and what to do – each row a strip of
 * cards to swipe along.  The middle of the screen stays free: the scene
 * behind shows the vehicle chosen, standing where the drive will begin
 * (game.ts places it).  The simple menu of before is still there – the
 * settings choose (render in hud.ts showMenu).
 */
import type { AddressHit } from '../game/address.ts';
import { LESSONS } from '../game/nav.ts';
import type { Settings } from '../game/settings.ts';
import { saveSettings } from '../game/settings.ts';
import { VEHICLES, VEHICLE_KINDS, powerOf } from '../game/vehicles.ts';
import type { VehicleKind } from '../game/vehicles.ts';
import { lessonIntro, lessonTitle } from '../i18n/index.ts';
import type { Lang } from '../i18n/index.ts';
import type { SpawnJson } from '../world/types.ts';
import type { RunwayChoice, StartRequest, TramStopChoice } from './hud.ts';

/** What the scene behind the menu is to show: this vehicle, standing here. */
export interface MenuPreview {
  kind: VehicleKind;
  x: number;
  z: number;
  yaw: number;
  /** the tram: the stop it will start at (it is put on the track there) */
  stop?: TramStopChoice;
}

export interface CarouselContext {
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  settings: Settings;
  spawns: readonly SpawnJson[];
  tramStops: readonly TramStopChoice[] | null;
  runways: readonly RunwayChoice[] | null;
  /** whether the map has a practice yard (the lessons on it) */
  hasYard: boolean;
  /** the language list */
  language: HTMLElement;
  /** a field for an address (calls `pick` with the one chosen) */
  address: (pick: (hit: AddressHit) => void) => HTMLElement;
  /** the other pages: settings, controls, log, what's new, about */
  tools: Array<[string, () => void]>;
  version: string;
  start: (req: StartRequest) => void;
  preview: (p: MenuPreview) => void;
  redraw: () => void;
}

const ICONS: Record<VehicleKind, string> = {
  car: '🚗',
  carTrailer: '🚙',
  moped: '🛵',
  motorcycle125: '🏍️',
  motorcycle35: '🏍️',
  motorcycle: '🏍️',
  lightTruck: '🚚',
  lightTruckTrailer: '🚚',
  truckSolo: '🚛',
  truck: '🚛',
  minibus: '🚐',
  minibusTrailer: '🚐',
  bus: '🚌',
  busTrailer: '🚌',
  tractorSlow: '🚜',
  tractor: '🚜',
  tram: '🚊',
  plane: '🛩️',
  mobileCrane: '🏗️',
  loaderCrane: '🏗️',
  towerCrane: '🏗️',
  pedestrian: '🚶',
};

/** How far each row was swiped (kept when the menu is drawn again after a choice), and whether the middle rows are folded away (at first: on a low screen). */
const swiped = new Map<string, number>();
let folded: boolean | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A row: its title, and its cards in a strip to swipe – the chosen one brought into view the first time. */
function row(key: string, title: string, items: HTMLElement[], extra?: HTMLElement): HTMLElement {
  const r = el('div', `cm-row cm-${key}`);
  const head = el('div', 'cm-head');
  head.append(el('span', '', title));
  if (extra) head.append(extra);
  const strip = el('div', 'cm-strip');
  strip.append(...items);
  strip.onscroll = () => swiped.set(key, strip.scrollLeft);
  r.append(head, strip);
  // (after it is in the page: where it was, else the chosen card in view)
  requestAnimationFrame(() => {
    const was = swiped.get(key);
    if (was !== undefined) strip.scrollLeft = was;
    else strip.querySelector<HTMLElement>('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  });
  return r;
}

function card(cls: string, on: boolean, parts: Array<string | HTMLElement>, act: () => void, title = ''): HTMLButtonElement {
  const b = el('button', `${cls}${on ? ' on' : ''}`);
  b.append(...parts);
  if (title) b.title = title;
  b.setAttribute('aria-pressed', String(on));
  b.onclick = act;
  return b;
}

/** The menu of rows. */
export function carouselMenu(c: CarouselContext): HTMLElement {
  const s = c.settings;
  folded ??= typeof window !== 'undefined' && window.innerHeight < 760;
  const def = VEHICLES[s.vehicle] ?? VEHICLES.car;
  const kind = def.kind;
  const last = s.lastStart;
  const save = (): void => {
    saveSettings(s);
  };
  const root = el('div', 'cm');

  // ---- at the top: the name, the language, the other pages
  const top = el('div', 'cm-top');
  const title = el('div', 'cm-title');
  title.innerHTML = 'Fahrsim <span>Baunatal</span>';
  title.append(el('small', '', c.version), el('small', 'cm-loading'));
  const tools = el('div', 'cm-tools');
  tools.append(c.language);
  for (const [label, run] of c.tools) {
    const b = el('button', 'btn ghost', label);
    b.onclick = run;
    tools.append(b);
  }
  top.append(title, tools);

  const rows = el('div', 'cm-rows');
  // ---- the vehicles
  const vehicles = VEHICLE_KINDS.map((k) => {
    const d = VEHICLES[k];
    const on = k === s.vehicle;
    return card('cm-card', on, [el('span', 'cm-icon', ICONS[k]), el('span', 'cm-name', c.t(d.name))], () => {
      if (k === s.vehicle) return;
      s.vehicle = k;
      save();
      c.redraw();
    });
  });
  // (the place and the options folded away: what they are set to, in one line beside the button that unfolds them)
  const fold = el('button', 'cm-fold');
  const summary = el('span', 'cm-summary');
  fold.append(summary, el('span', '', folded ? ' ▴' : ' ▾'));
  fold.setAttribute('aria-label', c.t(folded ? 'menuMore' : 'menuLess'));
  fold.title = fold.getAttribute('aria-label') ?? '';
  fold.onclick = () => {
    folded = !folded;
    c.redraw();
  };
  rows.append(row('vehicle', c.t('vehicle'), vehicles, fold));

  // ---- where: the towns, then the places of the town chosen (stops for the tram, runway ends for the aeroplane)
  let preview: MenuPreview | null = null;
  let request: Omit<StartRequest, 'mode'> = { spawn: Math.min(last.spawn, Math.max(0, c.spawns.length - 1)) };
  const middle: HTMLElement[] = [];
  const loading = (): HTMLElement => el('span', 'cm-chip off', c.t('realityLoading'));
  if (kind === 'plane') {
    const list = c.runways;
    const key = (r: RunwayChoice): string => `${r.field}|${r.end}`;
    if (!list || list.length === 0) middle.push(row('town', c.t('startPoint'), [list ? el('span', 'cm-chip off', '–') : loading()]));
    else {
      let at = list.findIndex((r) => key(r) === last.runway);
      if (at < 0) at = 0;
      const chosen = list[at];
      const fields = [...new Set(list.map((r) => r.field))];
      middle.push(
        row(
          'town',
          c.t('startPoint'),
          fields.map((f) =>
            card('cm-chip', f === chosen.field, [f], () => {
              last.runway = key(list.find((r) => r.field === f) as RunwayChoice);
              save();
              c.redraw();
            }),
          ),
        ),
        row(
          'place',
          chosen.field,
          list
            .filter((r) => r.field === chosen.field)
            .map((r) =>
              card('cm-chip', key(r) === key(chosen), [c.t('runwayEnd', { end: r.end })], () => {
                last.runway = key(r);
                save();
                c.redraw();
              }),
            ),
        ),
      );
      request = { ...request, runway: chosen };
      preview = { kind, x: chosen.x, z: chosen.z, yaw: chosen.yaw };
    }
  } else if (kind === 'tram') {
    const list = c.tramStops;
    const key = (t: TramStopChoice): string => `${t.name}|${t.town}`;
    if (!list || list.length === 0) middle.push(row('town', c.t('startPoint'), [list ? el('span', 'cm-chip off', '–') : loading()]));
    else {
      let at = list.findIndex((t) => key(t) === last.tramStop);
      if (at < 0) at = Math.max(0, list.findIndex((t) => t.name === 'Königsplatz'));
      const chosen = list[at];
      const towns = [...new Set(list.map((t) => t.town))];
      middle.push(
        row(
          'town',
          c.t('startPoint'),
          towns.map((town) =>
            card('cm-chip', town === chosen.town, [town], () => {
              last.tramStop = key(list.find((t) => t.town === town) as TramStopChoice);
              save();
              c.redraw();
            }),
          ),
        ),
        row(
          'place',
          chosen.town,
          list
            .filter((t) => t.town === chosen.town)
            .map((t) =>
              card('cm-chip', key(t) === key(chosen), [t.name], () => {
                last.tramStop = key(t);
                save();
                c.redraw();
              }),
            ),
        ),
      );
      request = { ...request, stop: chosen };
      preview = { kind, x: chosen.x, z: chosen.z, yaw: 0, stop: chosen };
    }
  } else if (c.spawns.length > 0) {
    // (the start points of the map by town, in the order the map lists them; or an address)
    const spawn = request.spawn;
    const address = last.address ?? undefined;
    const town = (i: number): string => c.spawns[i]?.g ?? '';
    const chosenTown = town(spawn);
    const towns: string[] = [];
    c.spawns.forEach((sp) => {
      const g = sp.g ?? '';
      if (!towns.includes(g)) towns.push(g);
    });
    const pickAddress = el('button', `cm-chip${address ? ' on' : ''}`, `📍 ${address ? address.label : c.t('startAddress')}`);
    let field: HTMLElement | null = null;
    pickAddress.onclick = () => {
      if (field) {
        field.remove();
        field = null;
        return;
      }
      field = c.address((hit) => {
        last.address = hit;
        save();
        c.redraw();
      });
      field.classList.add('cm-address');
      pickAddress.closest('.cm-row')?.after(field);
      field.querySelector('input')?.focus();
    };
    const townChips = towns.map((g) =>
      card('cm-chip', !address && g === chosenTown, [g || '–'], () => {
        last.spawn = c.spawns.findIndex((sp) => (sp.g ?? '') === g);
        last.address = null;
        save();
        c.redraw();
      }),
    );
    const places: HTMLElement[] = [];
    c.spawns.forEach((sp, i) => {
      if (town(i) !== chosenTown) return;
      places.push(
        card('cm-chip', !address && i === spawn, [sp.name], () => {
          last.spawn = i;
          last.address = null;
          save();
          c.redraw();
        }),
      );
    });
    middle.push(row('town', c.t('startPoint'), [pickAddress, ...townChips]), row('place', chosenTown || c.t('startPoint'), places));
    request = { ...request, address };
    const sp = c.spawns[spawn];
    preview = address ? { kind, x: address.x, z: address.z, yaw: sp?.yaw ?? 0 } : sp ? { kind, x: sp.x, z: sp.z, yaw: sp.yaw } : null;
  }

  // ---- the options of this vehicle: its gearbox, its engine, the make-up of the tram
  const options: HTMLElement[] = [];
  if (def.model === 'car' || def.model === 'motorcycle') {
    for (const [v, k] of [['assist', 'trAssist'], ['manual', 'trManual'], ['automatic', 'trAutomatic']] as const) {
      options.push(
        card('cm-chip', s.transmission === v, [c.t(k)], () => {
          s.transmission = v;
          save();
          c.redraw();
        }),
      );
    }
  }
  if (def.powers.length > 1) {
    const now = powerOf(def, s.powers);
    for (const ps of def.powers) {
      options.push(
        card('cm-chip', ps === now, [`${ps} PS`], () => {
          s.powers[def.kind] = ps;
          save();
          c.redraw();
        }, `${ps} PS (${Math.round(ps * 0.7355)} kW)`),
      );
    }
  }
  if (kind === 'tram') {
    for (const [v, k] of [['single', 'tramSetSingle'], ['double', 'tramSetDouble'], ['trailer', 'tramSetTrailer']] as const) {
      options.push(
        card('cm-chip', s.tramSet === v, [c.t(k)], () => {
          s.tramSet = v;
          save();
          c.redraw();
        }),
      );
    }
  }
  if (options.length > 0) middle.push(row('options', c.t('menuOptions'), options));
  if (!folded) rows.append(...middle);
  else {
    // the choices of the folded rows, as their chosen cards say them
    const said = middle.flatMap((r) => [...r.querySelectorAll<HTMLElement>('.cm-strip .on')].map((e) => e.textContent ?? ''));
    summary.textContent = said.filter((t) => t).join(' · ');
  }

  // ---- what to do: tap a card and the drive begins
  const modes: HTMLElement[] = [];
  const go = (mode: string): void => c.start({ ...request, mode });
  const mode = (title: string, desc: string, m: string, main = false): void => {
    modes.push(card(`cm-mode${main ? ' main' : ''}`, false, [el('b', '', title), el('small', '', desc)], () => go(m)));
  };
  mode(c.t(kind === 'plane' ? 'freeFly' : 'free'), c.t(kind === 'tram' ? 'freeTramDesc' : kind === 'pedestrian' ? 'freeWalkDesc' : kind === 'plane' ? 'freeFlyDesc' : 'freeDesc'), 'free', true);
  if (kind === 'tram') mode(c.t('demo'), c.t('demoTramDesc'), 'demo');
  if (kind !== 'tram' && kind !== 'pedestrian' && kind !== 'plane') {
    mode(c.t('demo'), c.t('demoDesc'), 'demo');
    mode(c.t('tourTitle'), c.t('tourDesc'), 'tour');
  }
  // the theory lessons: difficult situations shown on the practice yard (game/theorymode.ts)
  if (kind !== 'plane' && c.hasYard) mode(c.t('theory.title'), c.t('theory.desc'), 'theory');
  // the test place: every model of the game on the practice yard
  if (kind !== 'tram' && kind !== 'plane' && c.hasYard) mode(c.t('showTitle'), c.t('showDesc'), 'show');
  const rank = (k: string): number => (k === 'yard' ? 0 : k === 'exam' ? 2 : 1);
  const lessons = LESSONS.filter((l) => (l.vehicles ? l.vehicles.includes(kind) : l.vehicle ? l.vehicle === kind : kind !== 'tram' && kind !== 'pedestrian' && kind !== 'plane' && !(l.notFor ?? []).includes(kind)) && (l.kind !== 'yard' || c.hasYard)).sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const l of lessons) mode(lessonTitle(l.id, c.lang), l.id === 'exam' ? c.t('examDesc') : lessonIntro(l.id, c.lang), l.id);
  rows.append(row(`modes-${kind}`, c.t('start'), modes));

  root.append(top, rows);
  if (preview) c.preview(preview);
  return root;
}
