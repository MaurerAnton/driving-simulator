// SPDX-License-Identifier: AGPL-3.0-only
/** A text field that finds addresses of the map while one types (street, house number, town). */
import type { AddressHit } from '../game/address.ts';

export interface AddressPickerOptions<T extends AddressHit = AddressHit> {
  placeholder: string;
  loading: string;
  none: string;
  /** fetches the address list the first time it is needed */
  load(): Promise<{ search(query: string, limit?: number, near?: { x: number; z: number } | null): T[] } | null>;
  pick(hit: T): void;
  /** where the one who asks is (a place of the map): what lies near comes first */
  near?(): { x: number; z: number } | null;
}

export function addressPicker<T extends AddressHit = AddressHit>(o: AddressPickerOptions<T>): { node: HTMLElement; input: HTMLInputElement } {
  const node = document.createElement('div');
  node.className = 'addr';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = o.placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';
  const list = document.createElement('div');
  list.className = 'addr-list';
  node.append(input, list);

  // a combo box: the field keeps the focus, the arrow keys move a mark through the list below it
  const listId = `addr-list-${++pickers}`;
  list.id = listId;
  list.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let index: { search(query: string, limit?: number, near?: { x: number; z: number } | null): T[] } | null = null;
  let asked = false;
  let hits: T[] = [];
  let buttons: HTMLButtonElement[] = [];
  /** the entry the arrow keys have reached, -1: none yet */
  let active = -1;
  const mark = (i: number): void => {
    active = hits.length === 0 ? -1 : ((i % hits.length) + hits.length) % hits.length;
    buttons.forEach((b, k) => {
      b.classList.toggle('on', k === active);
      b.setAttribute('aria-selected', k === active ? 'true' : 'false');
    });
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', buttons[active].id);
      buttons[active].scrollIntoView?.({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const clear = (): void => {
    list.replaceChildren();
    hits = [];
    buttons = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const say = (text: string): void => {
    clear();
    if (!text) return;
    const p = document.createElement('small');
    p.textContent = text;
    list.append(p);
  };
  const choose = (h: T): void => {
    input.value = h.label;
    clear();
    o.pick(h);
  };
  const show = (): void => {
    const q = input.value.trim();
    // (one character is enough for a line number of public transport – "5", "N3" – where it is a
    //  whole token; for text a single letter would match half the map, so it waits for the second)
    if (q.length < (isLineToken(q) ? 1 : 2)) {
      say('');
      return;
    }
    if (!index) {
      say(o.loading);
      return;
    }
    const found = index.search(q, 8, o.near?.() ?? null);
    if (found.length === 0) {
      say(o.none);
      return;
    }
    clear();
    hits = found;
    input.setAttribute('aria-expanded', 'true');
    hits.forEach((h, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = `${listId}-${k}`;
      b.setAttribute('role', 'option');
      // the field keeps the focus (Tab goes on to the next control, the arrow keys walk the list)
      b.tabIndex = -1;
      b.textContent = h.label;
      b.onclick = () => choose(h);
      b.onpointerenter = () => mark(k);
      buttons.push(b);
      list.append(b);
    });
    mark(-1);
  };
  const ensure = (): void => {
    if (asked) return;
    asked = true;
    void o.load().then((ix) => {
      index = ix;
      if (!ix) say(o.none);
      else show();
    });
  };
  input.addEventListener('focus', ensure);
  input.addEventListener('input', () => {
    ensure();
    show();
  });
  input.addEventListener('keydown', (e) => {
    // by key *and* by code: some browsers and input methods report one of them only
    const k = e.key || e.code;
    const down = k === 'ArrowDown' || k === 'Down' || e.code === 'ArrowDown';
    const up = k === 'ArrowUp' || k === 'Up' || e.code === 'ArrowUp';
    if ((down || up) && !e.isComposing) {
      // (also keeps the browser from moving the caret or opening its own list of earlier entries)
      e.preventDefault();
      if (hits.length === 0) show();
      else mark(active < 0 ? (down ? 0 : hits.length - 1) : active + (down ? 1 : -1));
    } else if ((k === 'Enter' || e.code === 'NumpadEnter') && !e.isComposing && hits.length > 0) {
      e.preventDefault();
      choose(hits[Math.max(0, active)]);
    } else if ((k === 'Escape' || k === 'Esc') && hits.length > 0) {
      // close the list first; a second Escape reaches the menu
      e.preventDefault();
      clear();
    } else if (k === 'Tab' && active >= 0) choose(hits[active]);
    // typing must not drive the car or close the menu
    e.stopPropagation();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  return { node, input };
}

let pickers = 0;

/**
 * Is a query a line number of public transport, enough on its own to search
 * for ("5", "52", "N3"): digits, or a letter before digits.  Such a token is
 * whole at one character, where a single letter of a name is not.
 */
export function isLineToken(q: string): boolean {
  return /^(?:[a-zäöüß]{1,3}\d{1,3}|\d{1,3})$/i.test(q.trim());
}
