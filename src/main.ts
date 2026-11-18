// SPDX-License-Identifier: AGPL-3.0-only
import { Game } from './game/game.ts';
import { startNetStats } from './game/netstats.ts';
import { restoreAfterOldVersion } from './game/versions.ts';

// (how much is downloaded: shown on the loading screens)
startNetStats();
// (back from an earlier version of the game: the settings as they were before it – game/versions.ts)
restoreAfterOldVersion(document.baseURI);
import { loadSettings } from './game/settings.ts';
import { setWasmMode } from './wasm/kernels.ts';
import { loadLang, tr } from './i18n/index.ts';
import { netBeforeStart } from './net/online.ts';

// (WebAssembly for the tiles and the quickest way, or JavaScript only: src/wasm/kernels.ts)
setWasmMode(loadSettings().wasm);

declare global {
  interface Window {
    /** test/debug hook used by tools/dev/shot.mjs */
    __fs?: { ready: boolean; game: Game; info: () => unknown };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

/** Nothing works: say why, in the reader's language if its texts can be fetched (English otherwise). */
function giveUp(key: string, params?: Record<string, string>): void {
  const lang = new URLSearchParams(location.search).get('lang') ?? loadSettings().lang;
  const say = (): void => {
    ui.textContent = tr(key, lang, params);
  };
  say();
  void loadLang(lang).then(say);
}

/** Can this browser draw the 3D picture at all? (tried on a canvas of its own, which is given back at once) */
function hasWebGl2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

if (!hasWebGl2()) giveUp('webglMissing');
// (a server set by the player – or ?server= –: the ?tk= token taken out of the address, and the progress kept there
// pulled before the game reads it – at most 2.5 s; without a server at once: net/online.ts)
else
  void netBeforeStart()
    .catch((err: unknown) => console.warn(err))
    .then(() => {
      try {
        const game = new Game(canvas, ui);
        window.__fs = { ready: false, game, info: () => game.debugInfo() };
        game.boot(new URLSearchParams(location.search)).catch((err: unknown) => {
          console.error(err);
          giveUp('loadError', { e: String(err) });
        });
      } catch (err) {
        console.error(err);
        giveUp('loadError', { e: String(err) });
      }
    });
