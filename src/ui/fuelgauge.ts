// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel gauge of the HUD's dashboard strip: a pump, and beside it a bar
 * that shows how full the tank is – amber and the pump lit, as the lamp of
 * an instrument cluster, once the reserve is reached.  A vehicle without a
 * tank (the tram, on foot) shows none.  The exact amount is shown as a
 * percentage beside the bar ("9.5%", and to three decimals in the tooltip
 * and the accessible name: "Fuel — 9.536%").
 */

/** The tank's share (0 … 1) as a percentage to three decimals: "9.536". */
export function fuelPercent(share: number): string {
  if (!Number.isFinite(share)) return '0.000';
  return (Math.max(0, Math.min(1, share)) * 100).toFixed(3);
}
export class FuelGauge {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly amount: HTMLElement;
  private shown = '';
  private readonly title: string;
  private readonly lowTitle: string;
  constructor(title: string, lowTitle: string) {
    this.el = document.createElement('span');
    this.el.className = 'fuel';
    this.title = title;
    this.lowTitle = lowTitle;
    this.el.title = title;
    this.el.dataset.low = lowTitle;
    this.el.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 3h9a1 1 0 0 1 1 1v7h1.2a2.3 2.3 0 0 1 2.3 2.3v4.2a.9.9 0 0 0 1.8 0V9.8l-2.6-2.6 1.3-1.3 3 3a2 2 0 0 1 .6 1.4v7.2a2.9 2.9 0 0 1-5.8 0v-4.2a.3.3 0 0 0-.3-.3H14V20h1v2H2v-2h1V4a1 1 0 0 1 1-1zm1.5 2v5h6V5h-6z"/></svg><span class="bar"><i></i></span><span class="amount"></span>';
    this.bar = this.el.querySelector('i') as HTMLElement;
    this.amount = this.el.querySelector('.amount') as HTMLElement;
    this.el.hidden = true;
  }

  /** How full the tank is (0 … 1; undefined: no tank), and whether the reserve is reached. */
  update(share: number | undefined, low: boolean): void {
    // (the key carries the exact percentage: the tooltip changes when it does)
    const pct = share === undefined ? '' : fuelPercent(share);
    const key = share === undefined ? '' : `${pct}|${low ? 1 : 0}`;
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = share === undefined;
    if (share === undefined) return;
    const n = Math.max(0, Math.min(100, share * 100));
    this.bar.style.width = `${n.toFixed(0)}%`;
    this.el.classList.toggle('low', low);
    // (the amount, visible: "9.5 %" beside the bar – the tooltip keeps three decimals)
    this.amount.textContent = `${n.toFixed(n >= 10 ? 0 : 1)}%`;
    // the exact amount: "Fuel — 9.536%" ("Fuel low …" when the reserve is reached)
    const exact = `${pct}%`;
    this.el.title = `${low ? this.lowTitle : this.title} — ${exact}`;
    this.el.setAttribute('aria-label', this.el.title);
  }
}
