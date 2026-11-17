// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory lessons on the screen (game/theorymode.ts runs them): the list
 * of the situations to choose from, and during a lesson a bar at the foot of
 * the screen – what is going on, the question with its answers, whether the
 * answer was right and why (with the paragraph of the StVO, linked to its
 * text), and the buttons to go on, to see it again, to the next one.  The
 * middle of the screen stays free: the vehicles there are tapped to answer.
 * Plain DOM, like the rest of the interface.
 */
import { citationParts } from '../i18n/violations.ts';
import './theory.css';

/** One situation of the list. */
export interface TheoryItem {
  id: string;
  title: string;
  intro: string;
  /** answered all right once */
  done: boolean;
}

/** What the bar shows. */
export interface TheoryBar {
  /** the lesson's number and how many there are */
  n: number;
  count: number;
  title: string;
  /** being laid out; playing (the introduction); a question; the answer explained; the end */
  phase: 'loading' | 'play' | 'ask' | 'told' | 'end';
  text: string;
  ask: string;
  answers: Array<{ id: string; label: string }>;
  picked: string | null;
  right: string;
  why: string;
  ref: string;
  /** the end: how many were right */
  score: string;
  hasNext: boolean;
}

export interface TheoryBarActions {
  answer(id: string): void;
  goOn(): void;
  again(): void;
  next(): void;
  list(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class TheoryPanel {
  private readonly root: HTMLElement;
  private readonly t: (key: string, vars?: Record<string, string | number>) => string;
  private bar: HTMLElement | null = null;
  private list: HTMLElement | null = null;

  constructor(root: HTMLElement, t: (key: string, vars?: Record<string, string | number>) => string) {
    this.root = root;
    this.t = t;
  }

  /** The situations to choose from (over the whole screen). */
  showList(items: readonly TheoryItem[], pick: (id: string) => void, close: () => void): void {
    this.hide();
    const o = el('div', 'overlay th-list');
    const p = el('div', 'panel');
    p.append(el('h1', '', this.t('theory.title')), el('p', '', this.t('theory.listText')));
    const cards = el('div', 'cards');
    items.forEach((it, i) => {
      const c = el('button', 'card');
      c.append(el('b', '', `${i + 1} · ${it.title}`), el('small', '', it.intro));
      if (it.done) {
        const d = el('span', 'th-done', '✓');
        d.title = this.t('theory.done');
        d.setAttribute('aria-label', d.title);
        c.append(d);
      }
      c.onclick = () => pick(it.id);
      cards.append(c);
    });
    p.append(cards);
    const b = el('div', 'buttons');
    const back = el('button', 'btn ghost', this.t('menu'));
    back.onclick = close;
    b.append(back);
    p.append(b);
    o.append(p);
    this.root.append(o);
    this.list = o;
    (cards.firstElementChild as HTMLElement | null)?.focus();
  }

  /** The bar of a lesson, as it stands now (drawn anew: the controller calls this only when something changed). */
  show(v: TheoryBar, act: TheoryBarActions): void {
    this.list?.remove();
    this.list = null;
    const bar = this.bar ?? el('div', 'th-bar');
    bar.replaceChildren();
    const head = el('div', 'th-head');
    const icon = (text: string, label: string, run: () => void): HTMLButtonElement => {
      const b = el('button', 'th-icon', text);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.onclick = run;
      return b;
    };
    head.append(el('span', 'th-n', `${v.n}/${v.count}`), el('b', '', v.title));
    // (on a low screen the bar scrolls: going on is always at hand up here)
    if (v.phase === 'told') head.append(icon('▶', this.t('theory.goOn'), () => act.goOn()));
    head.append(icon('↺', this.t('theory.again'), () => act.again()), icon('☰', this.t('theory.list'), () => act.list()));
    bar.append(head);
    if (v.phase === 'loading') bar.append(el('p', 'th-text', this.t('theory.loading')));
    else if (v.phase === 'play') bar.append(el('p', 'th-text', v.text));
    else if (v.phase === 'ask' || v.phase === 'told') {
      // (what is going on: with the question – once answered, the reason takes its place)
      if (v.text && v.phase === 'ask') bar.append(el('p', 'th-text', v.text));
      bar.append(el('p', 'th-ask', v.ask));
      const answers = el('div', 'th-answers');
      for (const a of v.answers) {
        const b = el('button', '', a.label);
        if (v.phase === 'told') {
          b.disabled = true;
          if (a.id === v.right) b.classList.add('right');
          else if (a.id === v.picked) b.classList.add('wrong');
        } else b.onclick = () => act.answer(a.id);
        answers.append(b);
      }
      bar.append(answers);
      if (v.phase === 'told') {
        const ok = v.picked === v.right;
        bar.append(el('div', `th-verdict ${ok ? 'ok' : 'bad'}`, this.t(ok ? 'theory.right' : 'theory.wrong')));
        const why = el('p', 'th-why', v.why);
        why.append(this.rule(v.ref));
        bar.append(why);
        const row = el('div', 'th-actions');
        const go = el('button', 'btn', `${this.t('theory.goOn')} ▶`);
        go.onclick = () => act.goOn();
        row.append(go);
        bar.append(row);
        requestAnimationFrame(() => go.focus());
      } else bar.append(el('small', 'th-help', this.t('theory.help')));
    } else {
      bar.append(el('p', 'th-ask', v.score));
      const row = el('div', 'th-actions');
      const again = el('button', 'btn ghost', this.t('theory.again'));
      again.onclick = () => act.again();
      const list = el('button', 'btn ghost', this.t('theory.list'));
      list.onclick = () => act.list();
      row.append(again, list);
      if (v.hasNext) {
        const next = el('button', 'btn', `${this.t('theory.next')} ▶`);
        next.onclick = () => act.next();
        row.append(next);
        requestAnimationFrame(() => next.focus());
      }
      bar.append(row);
    }
    if (!this.bar) {
      this.root.append(bar);
      this.bar = bar;
    }
  }

  /** The rule, as German law writes it (left to right in every language), each paragraph a link to its official text. */
  private rule(ref: string): HTMLElement {
    const node = el('span', 'rule');
    node.dir = 'ltr';
    for (const part of citationParts(ref)) {
      if (!part.url) {
        node.append(part.text);
        continue;
      }
      const a = el('a', '', part.text);
      a.href = part.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = this.t('logRule');
      node.append(a);
    }
    return node;
  }

  hide(): void {
    this.bar?.remove();
    this.bar = null;
    this.list?.remove();
    this.list = null;
  }
}
