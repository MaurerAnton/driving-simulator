// SPDX-License-Identifier: AGPL-3.0-only
/**
 * When a sign counts.
 *
 * Many signs hold only at certain times: "22–6 h" under a speed limit (the
 * quiet of the night), "Mo–Fr 7–17 h" in front of a school, "werktags" under
 * a no-stopping sign.  The time stands on an additional panel below the sign
 * (Zusatzzeichen 1040-30, 1042-33 …); OpenStreetMap writes the same as a
 * condition – maxspeed:conditional = "30 @ (Mo-Fr 07:00-17:00)" – and puts it
 * into the code of the panel: "DE:274[30],1042-33[Mo-Fr 07:00-17:00]".
 *
 * This file reads such times – the part of OpenStreetMap's opening_hours
 * syntax that conditions use: weekdays, public holidays, hours, "off" –,
 * says whether one holds at a moment of the game's clock, and writes it the
 * way the panels show it ("Mo–Fr 7–17 h").  What lies beyond that part
 * (months, dates, sunset, "wet", "weight>7.5") is not understood: such a
 * condition is left out rather than guessed at.
 */
import { berlinClock, isHoliday } from './timetable.ts';

/** A moment as the signs see it (in Hesse): weekday (0 Sunday … 6 Saturday), minutes after midnight, whether today and yesterday are public holidays. */
export interface SignTime {
  day: number;
  min: number;
  holiday: boolean;
  holidayBefore: boolean;
}

/** bit of a day set for the public holidays (bits 0–6 are Sunday … Saturday) */
export const PH = 1 << 7;
const ALL_DAYS = 0x7f;
/** minutes of a day */
const DAY = 24 * 60;

/**
 * One span of a time window: on which days (bits 0–6 Sunday … Saturday, PH:
 * public holidays) it begins, from when to when (minutes after midnight of
 * that day; `from` < `to`).  Beyond 24 h it runs into the next day:
 * "22:00-06:00" is 1320 … 1800.
 */
export interface TimeSpan {
  days: number;
  from: number;
  to: number;
}

/** When something holds: in one of its spans, and not on the days it is off ("PH off": not on public holidays). */
export interface TimeWindow {
  spans: TimeSpan[];
  off: number;
}

/** The moment `date` on the clocks in Kassel, as the signs see it. */
export function signTimeOf(date: Date): SignTime {
  const c = berlinClock(date);
  const before = new Date(Date.UTC(c.y, c.m - 1, c.d) - 86400000);
  return {
    day: c.weekday,
    min: c.s / 60,
    holiday: isHoliday(c.y, c.m, c.d),
    holidayBefore: isHoliday(before.getUTCFullYear(), before.getUTCMonth() + 1, before.getUTCDate()),
  };
}

const DAY_NAMES: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, so: 0, di: 2, mi: 3, do: 4 };

/** "Mo-Fr", "Sa,Su", "Tu,Fr", "PH", "Mo-Su,PH" → a day set; null if it is not one. */
function parseDays(text: string): number | null {
  let days = 0;
  for (const part of text.split(',')) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (p === 'ph') {
      days |= PH;
      continue;
    }
    const m = /^([a-z]{2})(?:\s*-\s*([a-z]{2}))?$/.exec(p);
    if (!m) return null;
    const a = DAY_NAMES[m[1]];
    const b = m[2] === undefined ? a : DAY_NAMES[m[2]];
    if (a === undefined || b === undefined) return null;
    // (Monday first: "Fr-Mo" runs over the weekend)
    const ma = (a + 6) % 7;
    const mb = (b + 6) % 7;
    for (let k = ma; ; k = (k + 1) % 7) {
      days |= 1 << ((k + 1) % 7);
      if (k === mb) break;
    }
  }
  return days === 0 ? null : days;
}

/** "07:00", "7:30", "7", "7.30", "24:00", "43:00" → minutes (null if it is not a time). */
function parseClock(text: string): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 48 || min > 59) return null;
  return h * 60 + min;
}

/** "07:00-17:00", "22-6", "16:00-43:00" → [from, to] in minutes after the midnight it begins after (`to` beyond 1440: into the next day); null if not a span. */
function parseHours(text: string): [number, number] | null {
  const m = /^([\d:.]+)\s*[-–]\s*([\d:.]+)$/.exec(text.trim());
  if (!m) return null;
  const a = parseClock(m[1]);
  const b = parseClock(m[2]);
  if (a === null || b === null || a >= DAY || b === a) return null;
  // (an end before the beginning is on the next day; 43:00 is 19:00 of the next day as well)
  return [a, b > a ? b : b + DAY];
}

/**
 * Read a time as conditions and panels write it: "22:00-06:00",
 * "Mo-Fr 07:00-17:00", "Mo-Fr 06:00-10:00, 19:00-21:00; Sa 06:00-10:00",
 * "Su,PH", "Mo-Sa 06:00-12:00; PH off", "werktags 18-19", "22-6" (in
 * brackets or not).  Null for anything else.
 */
export function parseTimeWindow(raw: string): TimeWindow | null {
  let text = raw.trim();
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  if (!text) return null;
  // "werktags": Monday to Saturday, not on public holidays
  text = text.replace(/\bwerktags\b/gi, 'Mo-Sa WD');
  const w: TimeWindow = { spans: [], off: 0 };
  // Rules are parted by ";" – or by a "," after which a weekday follows hours ("Mo-Fr 07:00-17:00, Sa 08:00-12:00");
  // a "," between weekdays ("Tu,Fr 16:00-18:00") or between hours ("06:00-10:00, 19:00-21:00") stays in its rule.
  const rules: Array<{ days: string[]; rest: string[] }> = [];
  for (const part of text.split(';')) {
    let cur: { days: string[]; rest: string[] } | null = null;
    for (const item of part.split(',')) {
      const t = item.trim();
      if (!t) continue;
      const m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su|PH|So|Di|Mi|Do)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su|So|Di|Mi|Do))?)\b\s*(.*)$/i.exec(t);
      if (m) {
        if (!cur || cur.rest.length > 0) rules.push((cur = { days: [], rest: [] }));
        cur.days.push(m[1]);
        // ("Mo-Fr: 07:00-17:00")
        const rest = m[2].replace(/^:\s*/, '').trim();
        if (rest) cur.rest.push(rest);
      } else {
        if (!cur) rules.push((cur = { days: [], rest: [] }));
        cur.rest.push(t);
      }
    }
  }
  for (const r of rules) {
    let days = ALL_DAYS;
    if (r.days.length > 0) {
      const d = parseDays(r.days.join(','));
      if (d === null) return null;
      days = d;
    }
    let workdays = false;
    let off = false;
    const hours: string[] = [];
    for (let h of r.rest) {
      if (/\bWD\b/.test(h)) {
        workdays = true;
        h = h.replace(/\bWD\b/, '').trim();
      }
      if (/^off$/i.test(h)) {
        off = true;
        continue;
      }
      if (h) hours.push(h);
    }
    if (off) {
      if (hours.length > 0) return null;
      w.off |= days;
      continue;
    }
    if (workdays) w.off |= PH;
    if (hours.length === 0) {
      w.spans.push({ days, from: 0, to: DAY });
      continue;
    }
    for (const h of hours) {
      const span = parseHours(h);
      if (!span) return null;
      w.spans.push({ days, from: span[0], to: span[1] });
    }
  }
  return w.spans.length > 0 ? w : null;
}

/** Is day `day` (a holiday or not) one of `days`?  A public holiday counts as itself when PH is named, as its weekday otherwise. */
function onDay(days: number, day: number, holiday: boolean): boolean {
  if (holiday && (days & PH) !== 0) return true;
  return (days & (1 << day)) !== 0;
}

/** Does the window hold at moment `t`? */
export function holds(w: TimeWindow, t: SignTime): boolean {
  const yesterday = (t.day + 6) % 7;
  for (const s of w.spans) {
    // begun today – or begun yesterday and running over midnight into this morning
    if (t.min >= s.from && t.min < s.to && onDay(s.days, t.day, t.holiday) && !onDay(w.off, t.day, t.holiday)) return true;
    if (s.to > DAY && t.min < s.to - DAY && onDay(s.days, yesterday, t.holidayBefore) && !onDay(w.off, yesterday, t.holidayBefore)) return true;
  }
  return false;
}

const DE_DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** A day set as the panels write it: "Mo–Fr", "Di, Do, Fr", "Sa, So", "werktags" … ('' for every day). */
function daysText(days: number, off: number): string {
  const week = days & ALL_DAYS;
  if (week === 0x7e && (off & PH) !== 0) return 'werktags';
  if (week === ALL_DAYS && (days & PH) === 0) return '';
  const parts: string[] = [];
  // runs of days, Monday first
  const order = [1, 2, 3, 4, 5, 6, 0];
  let i = 0;
  while (i < 7) {
    if ((week & (1 << order[i])) === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && (week & (1 << order[j + 1])) !== 0) j++;
    if (j - i >= 2) parts.push(`${DE_DAYS[order[i]]}–${DE_DAYS[order[j]]}`);
    else for (let k = i; k <= j; k++) parts.push(DE_DAYS[order[k]]);
    i = j + 1;
  }
  if (days & PH) parts.push('feiertags');
  return parts.join(', ');
}

/** 450 → "7.30", 1320 → "22" */
function clockText(min: number): string {
  const h = Math.floor(min / 60) % 24 || (min >= 24 * 60 ? 24 : 0);
  const m = Math.round(min % 60);
  return m === 0 ? String(h) : `${h}.${String(m).padStart(2, '0')}`;
}

/**
 * The lines of a panel for a window, as German panels write them:
 * ["22–6 h"], ["Mo–Fr", "7–17 h"], ["werktags", "18–19 h"],
 * ["Mo–Fr 6–10 h, 19–21 h", "Sa 6–10 h"].  One line per group of days that
 * has its own hours – the first one parted into days and hours when there is
 * only one.
 */
export function windowLines(w: TimeWindow): string[] {
  const groups: Array<{ days: number; hours: string[] }> = [];
  for (const s of w.spans) {
    const hours = s.from === 0 && s.to === DAY ? '' : `${clockText(s.from)}–${clockText(s.to > DAY ? s.to - DAY : s.to)} h`;
    let g = groups.find((k) => k.days === s.days);
    if (!g) groups.push((g = { days: s.days, hours: [] }));
    if (hours && !g.hours.includes(hours)) g.hours.push(hours);
  }
  if (groups.length === 1) {
    const d = daysText(groups[0].days, w.off);
    const h = groups[0].hours.join(', ');
    return [d, h].filter(Boolean);
  }
  return groups.map((g) => [daysText(g.days, w.off), g.hours.join(', ')].filter(Boolean).join(' '));
}

/** The same in one line ("Mo–Fr 7–17 h") – for the speed-limit display. */
export function windowText(w: TimeWindow): string {
  return windowLines(w).join(' ');
}

/** Does a window name days at all (a panel 1042, "with weekdays") – or only hours (1040)? */
export function hasDays(w: TimeWindow): boolean {
  return w.spans.some((s) => (s.days & ALL_DAYS) !== ALL_DAYS || (s.days & PH) !== 0) || w.off !== 0;
}

/** The panel for a time: 1042-33 where it names weekdays ("Mo–Fr 7–17 h"), 1040-30 where it gives hours alone ("22–6 h"). */
export function panelCodeFor(w: TimeWindow): string {
  return hasDays(w) ? '1042-33' : '1040-30';
}

/**
 * A window written back in OpenStreetMap's way ("Mo-Fr 07:00-17:00; PH off")
 * – how the sign codes carry it (`1042-33:Mo-Fr 07:00-17:00`), and the same
 * text for the same time however it was written.
 */
export function windowSpec(w: TimeWindow): string {
  const en = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const hm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const dayList = (days: number): string => {
    const week = days & ALL_DAYS;
    const parts: string[] = [];
    if (week !== ALL_DAYS || (days & PH) !== 0) {
      const order = [1, 2, 3, 4, 5, 6, 0];
      let i = 0;
      while (i < 7) {
        if ((week & (1 << order[i])) === 0) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < 7 && (week & (1 << order[j + 1])) !== 0) j++;
        parts.push(j > i ? `${en[order[i]]}-${en[order[j]]}` : en[order[i]]);
        i = j + 1;
      }
      if (days & PH) parts.push('PH');
    }
    return parts.join(',');
  };
  const groups: Array<{ days: number; hours: string[] }> = [];
  for (const s of w.spans) {
    let g = groups.find((k) => k.days === s.days);
    if (!g) groups.push((g = { days: s.days, hours: [] }));
    // (an end on the next day as a time of that day where that is clear – "22:00-06:00" –, else beyond 24:00)
    const end = s.to > DAY && s.to - DAY <= s.from ? s.to - DAY : s.to;
    if (!(s.from === 0 && s.to === DAY)) g.hours.push(`${hm(s.from)}-${hm(end)}`);
  }
  const rules = groups.map((g) => [dayList(g.days), g.hours.join(',')].filter(Boolean).join(' '));
  if (w.off) rules.push(`${dayList(w.off)} off`);
  return rules.join('; ');
}

/** One alternative of a conditional tag: the value, and when it holds – a time window, or a word the game knows of ('wet'). */
export interface Conditional {
  value: string;
  when: TimeWindow | 'wet';
}

/**
 * The alternatives of a conditional tag of OpenStreetMap
 * ("30 @ (22:00-06:00); 50 @ (06:00-22:00)", "80 @ wet").  Those whose
 * condition is not a plain time (or "wet") are left out: "none @
 * destination", "30 @ (weight>7.5)", "no @ (2026 Mar 21-2026 Jun 14)".
 */
export function parseConditional(tag: string): Conditional[] {
  const out: Conditional[] = [];
  // the alternatives are parted by ";" outside brackets
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of tag) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const at = p.indexOf('@');
    if (at < 0) continue;
    const value = p.slice(0, at).trim();
    const cond = p.slice(at + 1).trim().replace(/^\((.*)\)$/s, '$1').trim();
    if (!value || !cond) continue;
    if (/^wet$/i.test(cond)) {
      out.push({ value, when: 'wet' });
      continue;
    }
    const w = parseTimeWindow(cond);
    if (w) out.push({ value, when: w });
  }
  return out;
}
