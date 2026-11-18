// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The red × that closes a panel, in its upper right corner.
 *
 * Every close button of the game looks the same: a round red button with a
 * white × (style.css `.x-close` – the big map's, the mirror's, the main
 * menu's sheets and the map's pop-ups carry the same look by their own
 * classes).  On a panel it stays in the corner while the panel scrolls.
 */

/** A red × for the corner of a panel: `label` says what it does (for screen readers and as its tooltip). */
export function closeX(label: string, act: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'x-close panel-x';
  b.textContent = '✕';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = (e) => {
    e.stopPropagation();
    act();
  };
  return b;
}
