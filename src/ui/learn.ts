// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The learning modes, opened from the "Learn" group of each main menu
 * (stage.ts, carousel.ts, the simple list of hud.ts): plain pages over the
 * picture, made for a phone held in the hand – big buttons, one thing at a
 * time, nothing that needs a keyboard.
 *
 *  - the theory exam (game/exam/exam.ts): 30 questions in 45 minutes, as in
 *    the test for class B; then the result, the mistakes explained, the
 *    exams taken before;
 *  - the sign trainer (game/exam/signs.ts): a sign, four meanings – or four
 *    numbers – to choose from; spaced repetition, a page of statistics;
 *  - "spot the danger" (game/exam/danger.ts): a theory scene frozen and seen
 *    from above (learnplan.ts) – why be ready to brake?
 *  - the lesson log (game/exam/learnlog.ts): where am I?
 *
 * What is learned is kept by game/exam/learnstore.ts (and synced with the
 * server: net/sync.ts, kind "learn").  The words of the questions come from
 * src/i18n/exam/, the rest from the interface's texts.  hud.ts loads this
 * file only when a learning mode is opened.
 */
import { LESSONS } from '../game/nav.ts';
import { DRILL_IDS } from '../game/drills.ts';
import { THEORY } from '../game/theory.ts';
import { loadTours } from '../game/tourlog.ts';
import { FaultLog } from '../game/faultlog.ts';
import { DANGER_ITEMS } from '../game/exam/danger.ts';
import type { DangerItem } from '../game/exam/danger.ts';
import { answered, clockText, pickExam, scoreExam, seeded, shuffle, timeLeft } from '../game/exam/exam.ts';
import type { ExamAnswer, ExamScore } from '../game/exam/exam.ts';
import type { ExamPicture, ExamQuestion } from '../game/exam/questions.ts';
import { QUESTIONS } from '../game/exam/questions.ts';
import { learnLog } from '../game/exam/learnlog.ts';
import type { LogRow, LogSection } from '../game/exam/learnlog.ts';
import { addExam, loadLearn, updateLearn } from '../game/exam/learnstore.ts';
import type { ExamRecord, LearnData } from '../game/exam/learnstore.ts';
import { ART_SIGNS, LEARNED_BOX, TOP_BOX, TRAINER_SIGNS, nextSign, review, signChoices, signNumber, signProgress } from '../game/exam/signs.ts';
import { loadExamTexts } from '../i18n/exam/index.ts';
import type { ExamText, ExamTexts } from '../i18n/exam/index.ts';
import { lessonTitle, localeOf } from '../i18n/index.ts';
import { citationParts } from '../i18n/violations.ts';
import { artAspect, drawSignArt } from '../render/signart.ts';
import { drawPlan, sceneTime } from './learnplan.ts';
import './learn.css';

export type LearnScreen = 'hub' | 'exam' | 'signs' | 'danger' | 'log';

export interface LearnContext {
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: string;
  /** the page to begin with */
  screen: LearnScreen;
  /** put a page on the screen (in place of the one before) */
  show: (page: HTMLElement) => void;
  /** back to the menu */
  back: () => void;
  /** where the signs' files are (public/signs/) */
  signBase: string;
}

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

/** The rule as text with links to the paragraphs. */
function refNode(ref: string): HTMLElement {
  const box = el('span', 'lr-ref');
  for (const p of citationParts(ref)) {
    if (p.url) {
      const a = el('a', '', p.text);
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      box.append(a);
    } else box.append(p.text);
  }
  return box;
}

/** A sign as the game draws it: its SVG file, or drawn by render/signart.ts. */
export function signPicture(code: string, base: string, size: number): HTMLElement {
  if (ART_SIGNS.has(code)) {
    const a = artAspect(code) ?? 1;
    const c = el('canvas', 'lr-sign');
    const w = a >= 1 ? size : size * a;
    const h = a >= 1 ? size / a : size;
    const k = Math.min(2, globalThis.devicePixelRatio || 1);
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.style.width = `${Math.round(w)}px`;
    c.style.height = `${Math.round(h)}px`;
    const g = c.getContext('2d');
    if (g) drawSignArt(g, code, 0, 0, c.width, c.height);
    return c;
  }
  const img = el('img', 'lr-sign');
  img.src = `${base}svg/${encodeURIComponent(code)}.svg`;
  img.alt = '';
  img.decoding = 'async';
  img.style.maxWidth = `${size}px`;
  img.style.maxHeight = `${size}px`;
  return img;
}

/** Open the learning modes on a page. */
export async function openLearn(c: LearnContext): Promise<void> {
  const texts = await loadExamTexts(c.lang);
  const ui = new LearnUi(c, texts);
  ui.open(c.screen);
}

class LearnUi {
  private readonly c: LearnContext;
  private readonly tx: ExamTexts;
  private readonly t: LearnContext['t'];
  /** the clock of the exam running (stopped when its page goes) */
  private tick = 0;

  constructor(c: LearnContext, texts: ExamTexts) {
    this.c = c;
    this.tx = texts;
    this.t = c.t;
  }

  open(s: LearnScreen): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = 0;
    if (s === 'exam') this.examIntro();
    else if (s === 'signs') this.signs('meaning');
    else if (s === 'danger') this.danger();
    else if (s === 'log') this.log();
    else this.hub();
  }

  private date(ms: number): string {
    return ms > 0 ? new Date(ms).toLocaleDateString(localeOf(this.c.lang)) : '';
  }

  /** A page: its title, a back button (to the hub, or from the hub to the menu), what is in it. */
  private page(title: string, toHub = true): { panel: HTMLElement; root: HTMLElement } {
    const root = el('div', 'overlay solid lr');
    const panel = el('div', 'panel lr-panel');
    const head = el('div', 'lr-head');
    const back = button('lr-back', '‹', () => (toHub ? this.open('hub') : this.c.back()));
    back.title = this.t('back');
    back.setAttribute('aria-label', this.t('back'));
    head.append(back, el('h1', '', title));
    panel.append(head);
    root.append(panel);
    return { panel, root };
  }

  // ------------------------------------------------------------------ the hub

  private hub(): void {
    const { panel, root } = this.page(this.t('learn.title'), false);
    panel.append(el('p', '', this.t('learn.hint')));
    const d = loadLearn();
    const sp = signProgress(d.signs, Date.now());
    const right = DANGER_ITEMS.filter((x) => d.danger[x.id]?.ok).length;
    const tiles: Array<[LearnScreen, string, string, string]> = [
      ['exam', this.t('learn.exam'), this.t('learn.examDesc'), this.t('learn.examProgress', { passed: d.exams.filter((e) => e.passed).length, taken: d.exams.length })],
      ['signs', this.t('learn.signs'), this.t('learn.signsDesc'), this.t('learn.signsProgress', { learned: sp.learned, total: sp.total, due: sp.due })],
      ['danger', this.t('learn.danger'), this.t('learn.dangerDesc'), this.t('learn.dangerProgress', { right, total: DANGER_ITEMS.length })],
      ['log', this.t('learn.log'), this.t('learn.logDesc'), ''],
    ];
    const grid = el('div', 'lr-tiles');
    for (const [id, title, desc, state] of tiles) {
      const b = el('button', 'card lr-tile');
      b.type = 'button';
      b.dataset.k = `learn-${id}`;
      b.append(el('b', '', title), el('small', '', desc));
      if (state) b.append(el('span', 'lr-state', state));
      b.onclick = () => this.open(id);
      grid.append(b);
    }
    panel.append(grid);
    this.c.show(root);
  }

  // ------------------------------------------------------------------ the theory exam

  private examIntro(): void {
    const { panel, root } = this.page(this.t('learn.exam'));
    panel.append(el('p', '', this.t('learn.examRules')), el('p', 'note', this.t('learn.examOwn')));
    const go = button('btn lr-big', this.t('learn.examStart'), () => this.examRun());
    go.dataset.k = 'exam-start';
    panel.append(go);
    const d = loadLearn();
    panel.append(el('h2', '', this.t('learn.examHistory')));
    if (d.exams.length === 0) panel.append(el('p', '', this.t('learn.examNone')));
    const list = el('div', 'lr-list');
    for (const e of d.exams.slice(0, 20)) list.append(this.examRow(e));
    panel.append(list);
    this.c.show(root);
  }

  private examRow(e: ExamRecord): HTMLElement {
    const r = el('div', `lr-row ${e.passed ? 'ok' : 'bad'}`);
    r.append(el('b', '', e.passed ? this.t('learn.passed') : this.t('learn.failed')), el('span', '', this.t('learn.examRow', { points: e.points, max: e.max, errors: e.errors })), el('small', '', this.date(e.t)));
    return r;
  }

  private examRun(): void {
    const qs = pickExam(QUESTIONS, seeded((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
    const answers: Record<string, ExamAnswer | undefined> = {};
    const order = new Map<string, number[]>();
    const rand = seeded(Date.now() >>> 0);
    for (const q of qs) order.set(q.id, shuffle([...Array(q.answers).keys()], rand));
    const start = Date.now();
    let at = 0;
    let over = false;
    const { panel, root } = this.page(this.t('learn.exam'));
    root.classList.add('lr-exam');
    // (leaving in the middle: asked first – the exam is not counted)
    (panel.querySelector('.lr-back') as HTMLButtonElement).onclick = () => {
      if (!over && !confirm(this.t('learn.leaveExam'))) return;
      over = true;
      this.open('hub');
    };
    const bar = el('div', 'lr-bar');
    const count = el('span', 'lr-count');
    const pts = el('span', 'lr-pts');
    const clock = el('span', 'lr-clock');
    clock.setAttribute('role', 'timer');
    clock.title = this.t('learn.clock');
    bar.append(count, pts, clock);
    const body = el('div', 'lr-q');
    const nav = el('div', 'lr-nav');
    const grid = el('div', 'lr-grid');
    grid.hidden = true;
    panel.append(bar, body, nav, grid);

    const finish = (timeUp: boolean): void => {
      if (over) return;
      over = true;
      if (this.tick) clearInterval(this.tick);
      this.tick = 0;
      const s = scoreExam(qs, answers);
      const rec: ExamRecord = { t: Date.now(), points: s.points, max: s.max, errors: s.errors, passed: s.passed, wrong: s.wrong, secs: Math.round((Date.now() - start) / 1000) };
      updateLearn((d) => addExam(d, rec));
      this.examResult(qs, answers, order, s, timeUp);
    };
    const showClock = (): void => {
      const left = timeLeft(start, Date.now());
      clock.textContent = `⏱ ${clockText(left)}`;
      clock.classList.toggle('low', left < 5 * 60_000);
      if (left <= 0) finish(true);
    };
    const draw = (): void => {
      const q = qs[at];
      count.textContent = this.t('learn.qOf', { n: at + 1, count: qs.length });
      pts.textContent = this.t('learn.points', { n: q.points });
      body.replaceChildren(...this.questionNodes(q, order.get(q.id) ?? [], answers, () => drawGrid()));
      nav.replaceChildren(
        button('btn ghost', `‹ ${this.t('learn.prev')}`, () => go(at - 1)),
        button('btn ghost', this.t('learn.overview'), () => {
          grid.hidden = !grid.hidden;
        }),
        at < qs.length - 1 ? button('btn', `${this.t('learn.next')} ›`, () => go(at + 1)) : button('btn', this.t('learn.handIn'), () => handIn()),
      );
      (nav.firstElementChild as HTMLButtonElement).disabled = at === 0;
      drawGrid();
      panel.scrollTop = 0;
    };
    const drawGrid = (): void => {
      grid.replaceChildren(
        ...qs.map((q, i) => {
          const b = button(`lr-cell${answered(answers[q.id]) ? ' done' : ''}${i === at ? ' on' : ''}`, String(i + 1), () => {
            grid.hidden = true;
            go(i);
          });
          b.setAttribute('aria-label', this.t('learn.qOf', { n: i + 1, count: qs.length }));
          return b;
        }),
        button('btn lr-handin', this.t('learn.handIn'), () => handIn()),
      );
    };
    const go = (i: number): void => {
      at = Math.max(0, Math.min(qs.length - 1, i));
      draw();
    };
    const handIn = (): void => {
      const open = qs.filter((q) => !answered(answers[q.id])).length;
      if (open > 0 && !confirm(this.t('learn.handInOpen', { n: open }))) return;
      finish(false);
    };
    draw();
    showClock();
    this.tick = window.setInterval(() => {
      // (the page left another way – the menu, the language: the clock stops)
      if (!root.isConnected) {
        clearInterval(this.tick);
        this.tick = 0;
        return;
      }
      showClock();
    }, 1000);
    this.c.show(root);
  }

  /** A question: its picture, its text, its answers to tick (in `order`) or a field for the number. */
  private questionNodes(q: ExamQuestion, order: readonly number[], answers: Record<string, ExamAnswer | undefined>, changed: () => void, review?: { right: boolean }): HTMLElement[] {
    const w = this.tx.questions[q.id] as ExamText;
    const out: HTMLElement[] = [];
    if (q.picture) out.push(this.picture(q.picture));
    out.push(el('p', 'lr-text', w.q));
    if (q.number) {
      const row = el('label', 'lr-number');
      row.append(el('span', '', this.t('learn.typeNumber')));
      const input = el('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.value = typeof answers[q.id] === 'string' ? (answers[q.id] as string) : '';
      input.disabled = !!review;
      input.oninput = () => {
        answers[q.id] = input.value;
        changed();
      };
      row.append(input);
      if (q.number.unit) row.append(el('span', 'lr-unit', q.number.unit));
      out.push(row);
      return out;
    }
    if (q.correct.length > 1 || !review) out.push(el('small', 'lr-multi', this.t('learn.multi')));
    const list = el('div', 'lr-answers');
    for (const i of order) {
      const ticked = (): boolean => Array.isArray(answers[q.id]) && (answers[q.id] as number[]).includes(i);
      const b = el('button', 'lr-answer');
      b.type = 'button';
      const box = el('span', 'lr-box');
      b.append(box, el('span', '', w.a[i] ?? ''));
      const paint = (): void => {
        b.setAttribute('aria-pressed', String(ticked()));
        b.classList.toggle('on', ticked());
        box.textContent = ticked() ? '✓' : '';
      };
      if (review) {
        b.disabled = true;
        if (q.correct.includes(i)) b.classList.add('right');
        else if (ticked()) b.classList.add('wrong');
      } else
        b.onclick = () => {
          const now = Array.isArray(answers[q.id]) ? [...(answers[q.id] as number[])] : [];
          answers[q.id] = now.includes(i) ? now.filter((x) => x !== i) : [...now, i];
          paint();
          changed();
        };
      paint();
      list.append(b);
    }
    out.push(list);
    return out;
  }

  private picture(p: ExamPicture): HTMLElement {
    const box = el('div', 'lr-pic');
    if ('sign' in p) box.append(signPicture(p.sign, this.c.signBase, 120));
    else {
      const canvas = el('canvas', 'lr-plan');
      canvas.width = 640;
      canvas.height = 400;
      const t = sceneTime(p.scene, p.step, p.off ?? 0);
      if (t !== null) drawPlan(canvas, p.scene, t, this.t('learn.you'), this.c.signBase);
      box.append(canvas);
    }
    return box;
  }

  private answerText(q: ExamQuestion, a: ExamAnswer | undefined): string {
    if (!answered(a)) return this.t('learn.noAnswer');
    if (q.number) return `${String(a)} ${q.number.unit}`.trim();
    const w = this.tx.questions[q.id];
    return (a as number[])
      .slice()
      .sort((x, y) => x - y)
      .map((i) => w?.a[i] ?? '')
      .join(' · ');
  }

  private examResult(qs: readonly ExamQuestion[], answers: Record<string, ExamAnswer | undefined>, order: ReadonlyMap<string, number[]>, s: ExamScore, timeUp: boolean): void {
    const { panel, root } = this.page(this.t('learn.exam'));
    const head = el('div', `lr-verdict ${s.passed ? 'ok' : 'bad'}`);
    head.append(el('b', '', s.passed ? this.t('learn.passed') : this.t('learn.failed')), el('span', '', this.t('learn.score', { points: s.points, max: s.max, errors: s.errors })));
    if (timeUp) panel.append(el('p', 'note warn', this.t('learn.timeUp')));
    panel.append(head);
    if (s.wrongFive >= 2) panel.append(el('p', 'note warn', this.t('learn.wrongFive')));
    if (s.wrong.length === 0) panel.append(el('p', '', this.t('learn.allRight')));
    else {
      panel.append(el('h2', '', this.t('learn.wrongList')));
      for (const id of s.wrong) {
        const q = qs.find((x) => x.id === id) as ExamQuestion;
        const w = this.tx.questions[id];
        const box = el('div', 'lr-review');
        box.append(el('small', 'lr-topic', `${this.t(`learn.topic.${q.topic}`)} · ${this.t('learn.points', { n: q.points })}`));
        box.append(...this.questionNodes(q, order.get(id) ?? [], answers, () => {}, { right: false }));
        if (q.number) box.append(el('p', 'lr-yours', this.t('learn.yourAnswer', { a: this.answerText(q, answers[id]) })), el('p', 'lr-rightans', this.t('learn.rightAnswer', { a: `${q.number.value} ${q.number.unit}`.trim() })));
        else if (!answered(answers[id])) box.append(el('p', 'lr-yours', this.t('learn.yourAnswer', { a: this.t('learn.noAnswer') })));
        const why = el('p', 'lr-why', w?.why ?? '');
        why.append(refNode(q.ref));
        box.append(why);
        panel.append(box);
      }
    }
    const b = el('div', 'buttons');
    b.append(button('btn', this.t('learn.again'), () => this.examRun()), button('btn ghost', this.t('learn.examHistory'), () => this.examIntro()));
    panel.append(b);
    this.c.show(root);
  }

  // ------------------------------------------------------------------ the sign trainer

  private signs(mode: 'meaning' | 'number', after = ''): void {
    const { panel, root } = this.page(this.t('learn.signs'));
    const d = loadLearn();
    const now = Date.now();
    const sp = signProgress(d.signs, now);
    const top = el('div', 'lr-chips');
    for (const m of ['meaning', 'number'] as const) {
      const b = button(`lr-chip${m === mode ? ' on' : ''}`, this.t(m === 'meaning' ? 'learn.signMeaning' : 'learn.signNumber'), () => this.signs(m));
      b.setAttribute('aria-pressed', String(m === mode));
      top.append(b);
    }
    top.append(button('lr-chip', this.t('learn.stats'), () => this.signStats()));
    panel.append(top, el('p', 'lr-state', this.t('learn.signsProgress', { learned: sp.learned, total: sp.total, due: sp.due })));
    const code = nextSign(d.signs, now, after);
    const meaning = (c: string): string => this.tx.signs[c] ?? c;
    const label = mode === 'meaning' ? meaning : (c: string): string => signNumber(c);
    const choices = signChoices(code, Math.random, label);
    const card = el('div', 'lr-signcard');
    card.append(signPicture(code, this.c.signBase, 150));
    panel.append(card, el('p', 'lr-text', this.t(mode === 'meaning' ? 'learn.askMeaning' : 'learn.askNumber')));
    const list = el('div', 'lr-answers');
    const after2 = el('div', 'lr-after');
    for (const ch of choices) {
      const b = el('button', 'lr-answer');
      b.type = 'button';
      b.append(el('span', '', label(ch)));
      b.onclick = () => {
        const right = ch === code;
        updateLearn((x) => {
          x.signs[code] = review(x.signs[code], right, Date.now());
        });
        for (const o of list.querySelectorAll('button')) (o as HTMLButtonElement).disabled = true;
        b.classList.add(right ? 'right' : 'wrong');
        list.children[choices.indexOf(code)]?.classList.add('right');
        after2.replaceChildren(el('b', right ? 'ok' : 'bad', this.t(right ? 'learn.right' : 'learn.wrong')), el('p', '', this.t('learn.signIs', { code: signNumber(code), meaning: meaning(code) })), button('btn lr-big', `${this.t('learn.next')} ›`, () => this.signs(mode, code)));
        (after2.querySelector('.btn') as HTMLButtonElement | null)?.focus();
      };
      list.append(b);
    }
    panel.append(list, after2);
    this.c.show(root);
  }

  private signStats(): void {
    const { panel, root } = this.page(this.t('learn.stats'));
    const back = panel.querySelector('.lr-back') as HTMLButtonElement;
    back.onclick = () => this.signs('meaning');
    const d = loadLearn();
    const list = el('div', 'lr-list');
    for (const code of TRAINER_SIGNS) {
      const s = d.signs[code];
      const r = el('div', `lr-row lr-signrow${s && s.box >= LEARNED_BOX ? ' ok' : ''}`);
      r.append(signPicture(code, this.c.signBase, 40));
      const txt = el('div', 'lr-signtxt');
      txt.append(el('b', '', this.tx.signs[code] ?? code), el('small', '', `${signNumber(code)} · ${s ? `${this.t('learn.box', { n: s.box, max: TOP_BOX })} · ${this.t('learn.statsRow', { right: s.right, wrong: s.wrong })}` : this.t('learn.statsNew')}`));
      r.append(txt);
      list.append(r);
    }
    panel.append(list);
    this.c.show(root);
  }

  // ------------------------------------------------------------------ spot the danger

  /** The next item: one not answered yet, else one answered wrong last, else the one answered longest ago. */
  private nextDanger(d: LearnData, avoid: string): DangerItem {
    const items = DANGER_ITEMS.filter((x) => x.id !== avoid && this.tx.danger[x.id]);
    return items.find((x) => !d.danger[x.id]) ?? items.find((x) => !d.danger[x.id]?.ok) ?? items.slice().sort((a, b) => (d.danger[a.id]?.last ?? 0) - (d.danger[b.id]?.last ?? 0))[0] ?? DANGER_ITEMS[0];
  }

  private danger(after = ''): void {
    const { panel, root } = this.page(this.t('learn.danger'));
    const d = loadLearn();
    const item = this.nextDanger(d, after);
    const w = this.tx.danger[item.id] as ExamText;
    const right = DANGER_ITEMS.filter((x) => d.danger[x.id]?.ok).length;
    const scene = THEORY.find((l) => l.id === item.scene);
    panel.append(el('p', 'lr-state', `${scene ? this.t(`theory.${scene.id}.title`) : ''} · ${this.t('learn.dangerProgress', { right, total: DANGER_ITEMS.length })}`));
    panel.append(this.picture({ scene: item.scene, step: item.step, off: item.off }));
    panel.append(el('p', 'lr-text', w.q), el('p', 'lr-ask', this.t('learn.dangerAsk')), el('small', 'lr-multi', this.t('learn.multi')));
    const order = shuffle([...Array(item.answers).keys()], Math.random);
    const ticked = new Set<number>();
    const list = el('div', 'lr-answers');
    const buttons: HTMLButtonElement[] = [];
    for (const i of order) {
      const b = el('button', 'lr-answer');
      b.type = 'button';
      const box = el('span', 'lr-box');
      b.append(box, el('span', '', w.a[i] ?? ''));
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        if (ticked.has(i)) ticked.delete(i);
        else ticked.add(i);
        b.classList.toggle('on', ticked.has(i));
        box.textContent = ticked.has(i) ? '✓' : '';
        b.setAttribute('aria-pressed', String(ticked.has(i)));
        check.disabled = ticked.size === 0;
      };
      b.dataset.i = String(i);
      buttons.push(b);
      list.append(b);
    }
    const after2 = el('div', 'lr-after');
    const check = button('btn lr-big', this.t('learn.check'), () => {
      const ok = ticked.size === item.correct.length && item.correct.every((i) => ticked.has(i));
      updateLearn((x) => {
        const s = x.danger[item.id] ?? { right: 0, wrong: 0, ok: false, last: 0 };
        x.danger[item.id] = { right: s.right + (ok ? 1 : 0), wrong: s.wrong + (ok ? 0 : 1), ok, last: Date.now() };
      });
      for (const b of buttons) {
        const i = Number(b.dataset.i);
        b.disabled = true;
        if (item.correct.includes(i)) b.classList.add('right');
        else if (ticked.has(i)) b.classList.add('wrong');
      }
      check.remove();
      const why = el('p', 'lr-why', w.why);
      why.append(refNode(item.ref));
      after2.replaceChildren(el('b', ok ? 'ok' : 'bad', this.t(ok ? 'learn.right' : 'learn.wrong')), why, button('btn lr-big', `${this.t('learn.next')} ›`, () => this.danger(item.id)));
    });
    check.disabled = true;
    panel.append(list, check, after2);
    this.c.show(root);
  }

  // ------------------------------------------------------------------ the lesson log

  private log(): void {
    const { panel, root } = this.page(this.t('learn.log'));
    const d = loadLearn();
    let theoryDone: string[] = [];
    try {
      const v = JSON.parse(localStorage.getItem('fahrsim-baunatal.theory.v1') ?? 'null') as { done?: unknown } | null;
      theoryDone = Array.isArray(v?.done) ? v.done.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      /* (nothing kept) */
    }
    const log = learnLog({
      learn: d,
      lessons: LESSONS.map((l) => l.id),
      drills: DRILL_IDS,
      theory: THEORY.map((l) => l.id),
      theoryDone,
      danger: DANGER_ITEMS.map((x) => x.id),
      faults: new FaultLog().entries,
      tours: loadTours(),
      now: Date.now(),
    });
    // ---- at the top: the exams, the signs, the tours
    const sum = el('div', 'lr-sum');
    const fact = (title: string, value: string, go?: LearnScreen): void => {
      const b = el(go ? 'button' : 'div', 'lr-fact');
      if (b instanceof HTMLButtonElement) {
        b.type = 'button';
        b.onclick = () => this.open(go as LearnScreen);
      }
      b.append(el('small', '', title), el('b', '', value));
      sum.append(b);
    };
    fact(this.t('learn.logExams'), log.exams.taken > 0 ? `${this.t('learn.examProgress', { passed: log.exams.passed, taken: log.exams.taken })} · ${log.exams.best}/${log.exams.max}` : this.t('learn.examNone'), 'exam');
    fact(this.t('learn.logSigns'), this.t('learn.signsProgress', { learned: log.signs.learned, total: log.signs.total, due: log.signs.due }), 'signs');
    fact(this.t('learn.logTourTitle'), this.t('learn.logTours', { driven: log.tours.driven, done: log.tours.done }));
    panel.append(sum);
    const names: Record<LogSection['id'], [string, (id: string) => string]> = {
      lessons: [this.t('learn.logLessons'), (id) => lessonTitle(id, this.c.lang)],
      drills: [this.t('learn.logDrills'), (id) => this.t(`drill.${id}.name`)],
      theory: [this.t('learn.logTheory'), (id) => this.t(`theory.${id}.title`)],
      danger: [this.t('learn.logDanger'), (id) => this.t(`theory.${id}.title`)],
      exams: [this.t('learn.logExams'), () => ''],
    };
    for (const s of log.sections) {
      if (s.id === 'exams') continue;
      const [title, name] = names[s.id];
      const box = el('details', 'lr-sec');
      box.open = s.id === 'lessons' || s.id === 'drills';
      const head = el('summary');
      head.append(el('b', '', title), el('span', 'lr-of', this.t('learn.passedOf', { passed: s.passed, total: s.total })));
      box.append(head);
      for (const r of s.rows) box.append(this.logRow(name(r.id), r));
      panel.append(box);
    }
    const ex = el('details', 'lr-sec');
    const exHead = el('summary');
    exHead.append(el('b', '', this.t('learn.logExams')), el('span', 'lr-of', this.t('learn.examProgress', { passed: log.exams.passed, taken: log.exams.taken })));
    ex.append(exHead);
    for (const e of d.exams.slice(0, 20)) ex.append(this.examRow(e));
    panel.append(ex);
    this.c.show(root);
  }

  private logRow(name: string, r: LogRow): HTMLElement {
    const row = el('div', `lr-row ${r.state === 'passed' ? 'ok' : r.state === 'tried' ? 'tried' : ''}`);
    row.append(el('span', 'lr-name', name));
    const state = r.state === 'passed' ? (r.stars !== undefined ? `${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}` : '✓') : r.state === 'tried' ? this.t('learn.stateTried') : this.t('learn.stateNone');
    const st = el('span', 'lr-st', state);
    st.title = this.t(r.state === 'passed' ? 'learn.statePassed' : r.state === 'tried' ? 'learn.stateTried' : 'learn.stateNone');
    row.append(st, el('small', '', [r.tries > 1 ? this.t('learn.tries', { n: r.tries }) : '', this.date(r.date)].filter(Boolean).join(' · ')));
    return row;
  }
}
