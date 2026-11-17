// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The buttons for what can be done where one stands beside the vehicle
 * (game/openplay.ts): "Open door" / "Close door" and "Get in" at a door of
 * the car, "Open bonnet", "Open tailgate", "Open rear doors" at the front or
 * the back.  A row of large buttons just above the tip line – for a finger
 * on a phone, and for the mouse; the keys do the same (G and the full stop).
 */

export interface OpenButton {
  id: string;
  label: string;
}

export class OpenButtons {
  private readonly el = document.createElement('div');
  private shown = '';

  constructor(parent: HTMLElement, onTap: (id: string) => void) {
    const el = this.el;
    el.className = 'openbuttons';
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'calc(5vh + 108px)',
      transform: 'translateX(-50%)',
      display: 'none',
      gap: '12px',
      pointerEvents: 'auto',
      maxWidth: '94vw',
      flexWrap: 'wrap',
      justifyContent: 'center',
    });
    el.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      // (not a look round with the finger, not the canvas's)
      e.stopPropagation();
      if (!b) return;
      e.preventDefault();
      onTap(b.dataset.id ?? '');
    });
    parent.append(el);
  }

  /** These buttons now (none: the row is hidden). */
  show(list: readonly OpenButton[]): void {
    const key = list.map((b) => `${b.id}:${b.label}`).join('|');
    if (key === this.shown) return;
    this.shown = key;
    this.el.replaceChildren(
      ...list.map((b) => {
        const e = document.createElement('button');
        e.type = 'button';
        e.dataset.id = b.id;
        e.textContent = b.label;
        Object.assign(e.style, {
          minHeight: '48px',
          minWidth: '104px',
          padding: '0 18px',
          borderRadius: '24px',
          border: 'none',
          background: 'rgba(255, 204, 0, 0.94)',
          color: '#111',
          font: '600 15px system-ui, sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,.35)',
          cursor: 'pointer',
          touchAction: 'none',
        });
        return e;
      }),
    );
    this.el.style.display = list.length ? 'flex' : 'none';
  }
}
