// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The windows on the big map (the panel for planning a drive, the small
 * windows of a stop or a vehicle): as large as what is in them, without
 * scrollbars to be seen (they still scroll when taller than the screen), and
 * the player can make them smaller – fold one up to its title with the
 * button beside it, or drag the grip at its lower corner (a finger or the
 * mouse; a double tap on the grip gives it its own size back).
 *
 * Their looks are in maps.css, which this module brings along.
 */
import './maps.css';

/** A button in the window's title row that folds it up to that row, and unfolds it again. */
export function foldButton(panel: HTMLElement, head: HTMLElement, label: (folded: boolean) => string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bm-x bm-fold';
  const show = (): void => {
    const folded = panel.classList.contains('bm-folded');
    b.textContent = folded ? '▸' : '▾';
    b.title = label(folded);
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-expanded', String(!folded));
  };
  b.onclick = () => {
    panel.classList.toggle('bm-folded');
    show();
  };
  show();
  // (before the close button, if the row has one)
  const close = head.querySelector('.bm-x:not(.bm-fold)');
  if (close) close.before(b);
  else head.append(b);
  return b;
}

/**
 * A grip at the lower corner of a window (one that lies in a box of its own,
 * at the top and the start of it): dragging it makes the window narrower or
 * lower than what is in it needs.  Returns what takes it away again.
 */
export function addGrip(panel: HTMLElement, label: string, min = { w: 220, h: 96 }): () => void {
  const box = panel.parentElement;
  if (!box) return () => {};
  box.classList.add('bm-griphost');
  const grip = document.createElement('div');
  grip.className = 'bm-grip';
  grip.title = label;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-label', label);
  box.append(grip);
  const rtl = (): boolean => getComputedStyle(panel).direction === 'rtl';
  const place = (): void => {
    const hidden = panel.hidden || panel.offsetWidth === 0 || panel.classList.contains('bm-folded');
    grip.hidden = hidden;
    if (hidden) return;
    // (at the corner away from the side the window stands at: the lower right one, the lower left one in a language written from the right)
    const r = rtl();
    grip.classList.toggle('rtl', r);
    grip.style.top = `${panel.offsetTop + panel.offsetHeight - 30}px`;
    grip.style.left = `${r ? panel.offsetLeft : panel.offsetLeft + panel.offsetWidth - 30}px`;
  };
  const ro = new ResizeObserver(place);
  ro.observe(panel);
  ro.observe(box);
  const mo = new MutationObserver(place);
  mo.observe(panel, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  let drag: { id: number; x: number; y: number; w: number; h: number } | null = null;
  let lastTap = 0;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - lastTap < 350) {
      // a double tap: as large as what is in it again
      panel.style.width = '';
      panel.style.maxHeight = '';
      lastTap = 0;
      return;
    }
    lastTap = now;
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    e.stopPropagation();
    const dx = (e.clientX - drag.x) * (rtl() ? -1 : 1);
    const w = Math.max(min.w, Math.min(box.clientWidth, drag.w + dx));
    const h = Math.max(min.h, Math.min(box.clientHeight, drag.h + e.clientY - drag.y));
    panel.style.width = `${Math.round(w)}px`;
    panel.style.maxHeight = `${Math.round(h)}px`;
    place();
  });
  const end = (e: PointerEvent): void => {
    if (drag?.id === e.pointerId) drag = null;
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  place();
  return () => {
    ro.disconnect();
    mo.disconnect();
    grip.remove();
  };
}
