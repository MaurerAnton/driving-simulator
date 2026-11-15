// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The log of driving faults: every fault of every drive, kept in the browser
 * (localStorage) so that it is still there in the next session.  The player
 * can read it at any time and open the rule each fault refers to.
 */
import type { Severity } from '../sim/rules.ts';

export interface FaultEntry {
  /** when it happened (ms since 1970) */
  t: number;
  /** catalogue key of the fault, see src/i18n/violations.ts */
  id: string;
  severity: Severity;
  /** values for the title, e.g. { limit: 30, speed: 47 } */
  data: Record<string, number | string>;
  /** the street it happened in ('' if unknown) */
  street: string;
  /** 'free', 'exam' or the id of the lesson */
  mode: string;
  x: number;
  z: number;
}

/** What is needed of localStorage (tests bring their own). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'fahrsim-baunatal.faults.v1';
/** older entries make room for new ones */
export const FAULT_LOG_MAX = 400;

const SEVERITIES = new Set(['hint', 'minor', 'major', 'fail']);

function valid(e: unknown): e is FaultEntry {
  if (typeof e !== 'object' || e === null) return false;
  const f = e as Partial<FaultEntry>;
  return typeof f.t === 'number' && typeof f.id === 'string' && SEVERITIES.has(String(f.severity)) && typeof f.data === 'object' && f.data !== null;
}

export class FaultLog {
  /** oldest first */
  readonly entries: FaultEntry[] = [];
  private readonly store: KeyValueStore | null;

  constructor(store: KeyValueStore | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.store = store;
    try {
      const raw = store?.getItem(KEY);
      if (raw) {
        const list: unknown = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const e of list) {
            if (valid(e)) this.entries.push({ ...e, street: typeof e.street === 'string' ? e.street : '', mode: typeof e.mode === 'string' ? e.mode : 'free', x: Number(e.x) || 0, z: Number(e.z) || 0 });
          }
        }
      }
    } catch {
      /* no storage, or something else was stored there: start empty */
    }
  }

  add(e: FaultEntry): void {
    this.entries.push(e);
    if (this.entries.length > FAULT_LOG_MAX) this.entries.splice(0, this.entries.length - FAULT_LOG_MAX);
    this.save();
  }

  clear(): void {
    this.entries.length = 0;
    try {
      this.store?.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  private save(): void {
    try {
      this.store?.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      /* private window or storage full: the log lives as long as the page */
    }
  }
}
