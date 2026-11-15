// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Notices of the instructor (faults, hints).  They are shown one at a time in
 * the block that normally carries the street name: of all that are current,
 * the gravest – and among equally grave ones the newest.
 */

export type NoticeSeverity = 'fail' | 'major' | 'minor' | 'hint';

export interface Notice {
  title: string;
  why: string;
  /** severity and rule, e.g. "schwerer Fehler · § 37 StVO" */
  meta: string;
  severity: NoticeSeverity;
  /** milliseconds (any clock, as long as it is the same one) */
  at: number;
  until: number;
}

const RANK: Record<NoticeSeverity, number> = { fail: 3, major: 2, minor: 1, hint: 0 };

/** Serious faults are red, the rest yellow. */
export const noticeColour = (n: Notice): 'red' | 'yellow' => (RANK[n.severity] >= 2 ? 'red' : 'yellow');

export class NoticeBoard {
  private readonly list: Notice[] = [];

  /** `seconds`: how long it stays current. The same notice again replaces the old one. */
  add(title: string, why: string, meta: string, severity: NoticeSeverity, seconds: number, now: number): void {
    const old = this.list.findIndex((n) => n.title === title);
    if (old >= 0) this.list.splice(old, 1);
    this.list.push({ title, why, meta, severity, at: now, until: now + seconds * 1000 });
  }

  /** The one to show at `now`, or null. */
  current(now: number): Notice | null {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].until <= now) this.list.splice(i, 1);
    let best: Notice | null = null;
    for (const n of this.list) {
      if (!best || RANK[n.severity] > RANK[best.severity] || (RANK[n.severity] === RANK[best.severity] && n.at >= best.at)) best = n;
    }
    return best;
  }

  clear(): void {
    this.list.length = 0;
  }

  get count(): number {
    return this.list.length;
  }
}
