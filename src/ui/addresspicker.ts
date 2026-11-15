// SPDX-License-Identifier: AGPL-3.0-only
/** A text field that finds addresses of the map while one types (street, house number, town). */
import type { AddressHit, AddressIndex } from '../game/address.ts';

export interface AddressPickerOptions {
  placeholder: string;
  loading: string;
  none: string;
  /** fetches the address list the first time it is needed */
  load(): Promise<AddressIndex | null>;
  pick(hit: AddressHit): void;
}

export function addressPicker(o: AddressPickerOptions): { node: HTMLElement; input: HTMLInputElement } {
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

  let index: AddressIndex | null = null;
  let asked = false;
  let hits: AddressHit[] = [];
  const say = (text: string): void => {
    list.replaceChildren();
    if (!text) return;
    const p = document.createElement('small');
    p.textContent = text;
    list.append(p);
  };
  const choose = (h: AddressHit): void => {
    input.value = h.label;
    list.replaceChildren();
    hits = [];
    o.pick(h);
  };
  const show = (): void => {
    const q = input.value.trim();
    if (q.length < 2) {
      hits = [];
      say('');
      return;
    }
    if (!index) {
      say(o.loading);
      return;
    }
    hits = index.search(q, 8);
    if (hits.length === 0) {
      say(o.none);
      return;
    }
    list.replaceChildren();
    for (const h of hits) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = h.label;
      b.onclick = () => choose(h);
      list.append(b);
    }
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
    if (e.key === 'Enter' && hits.length > 0) {
      e.preventDefault();
      choose(hits[0]);
    }
    // typing must not drive the car or close the menu
    e.stopPropagation();
  });
  return { node, input };
}
