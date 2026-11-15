// SPDX-License-Identifier: AGPL-3.0-only
import { Game } from './game/game.ts';

declare global {
  interface Window {
    /** test/debug hook used by tools/dev/shot.mjs */
    __fs?: { ready: boolean; game: Game; info: () => unknown };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const game = new Game(canvas, ui);
window.__fs = { ready: false, game, info: () => game.debugInfo() };

game.boot(new URLSearchParams(location.search)).catch((err: unknown) => {
  console.error(err);
  ui.textContent = `Fehler beim Laden: ${String(err)}`;
});
