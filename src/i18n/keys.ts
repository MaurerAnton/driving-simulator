// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What is printed on the keys the simulator uses.
 *
 * The controls go by the position of a key (KeyboardEvent.code): the four
 * keys under the left hand steer and accelerate whatever is printed on them –
 * W A S D on a US keyboard, Z Q S D on a French one.  The texts therefore
 * name keys by their code ([[KeyW]]), and this module turns the code into
 * the letter of the player's own keyboard: from the browser where it tells
 * (Chromium: navigator.keyboard.getLayoutMap), otherwise from the layout that
 * is usual for the language.
 */

let layout: { get(code: string): string | undefined } | null = null;

/** Ask the browser for the keyboard layout (once, at start; harmless if it does not know). */
export async function initKeyLabels(): Promise<void> {
  try {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<{ get(code: string): string | undefined }> } }).keyboard;
    if (kb?.getLayoutMap) layout = await kb.getLayoutMap();
  } catch {
    /* not available: the usual layout of the language is assumed */
  }
}

/** Languages whose usual keyboard swaps Y and Z. */
const QWERTZ = new Set(['de', 'hr', 'hu', 'cs', 'sq']);
/** The French layout, as far as the keys used here differ from a US keyboard. */
const AZERTY: Record<string, string> = { KeyQ: 'A', KeyA: 'Q', KeyW: 'Z', KeyZ: 'W', KeyM: ',' };

const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/**
 * The label of a key.  `name` gives the translated names of the keys that
 * carry a word (space bar, Enter, Shift, Esc).
 */
export function keyLabel(code: string, lang: string, name: (key: string) => string): string {
  if (code === 'Space') return name('key.Space');
  if (code === 'Enter' || code === 'NumpadEnter') return name('key.Enter');
  if (code === 'ShiftLeft' || code === 'ShiftRight') return name('key.Shift');
  if (code === 'Escape') return name('key.Escape');
  if (code in ARROWS) return ARROWS[code];
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Key')) {
    const real = layout?.get(code);
    if (real && real.length === 1) return real.toUpperCase();
    const letter = code.slice(3);
    if (QWERTZ.has(lang)) return letter === 'Z' ? 'Y' : letter === 'Y' ? 'Z' : letter;
    if (lang === 'fr') return AZERTY[code] ?? letter;
    return letter;
  }
  // (the full stop: on foot, opening what one stands at – game/openplay.ts)
  if (code === 'Period') return layout?.get(code) ?? '.';
  return code; // F1 …
}

/**
 * The same on a touch screen: the control on the screen that does what the
 * key does.  Values starting with "@" are text keys (labels of the "⋯" sheet).
 */
const TOUCH: Record<string, string> = {
  KeyW: '@tbGas',
  KeyS: '@tbBrake',
  KeyE: '▲',
  Digit1: '▲',
  KeyQ: '▼',
  KeyR: '▼',
  Space: 'P',
  KeyZ: '◀',
  KeyC: '▶',
  Enter: '⋯ @tbStarter',
  KeyB: '⋯ @tbBelt',
  KeyI: '⋯ @tbIgnition',
  KeyX: '⋯ @tbHazard',
  KeyJ: '⋯ @tbLookLeft',
  KeyK: '⋯ @tbLookRight',
  KeyL: '⋯ @tbLights',
  KeyO: '⋯ @tbHighBeam',
  KeyH: '⋯ @tbHorn',
  KeyV: '⋯ @tbCamera',
  KeyT: '⋯ @tbReset',
  KeyM: '⋯ @tbMenu',
  Escape: '⋯ @tbMenu',
};

export function touchLabel(code: string, lang: string, name: (key: string) => string): string {
  const t = TOUCH[code];
  if (!t) return keyLabel(code, lang, name);
  // the name of the button, without what it says in brackets ("Starter (hold)" → "Starter")
  return t.replace(/@(\w+)/, (_, key: string) => name(key).replace(/\s*[(（][^)）]*[)）]\s*$/, ''));
}
