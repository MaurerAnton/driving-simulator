// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Two small buttons in a corner of the screen: full screen (the browser's
 * Fullscreen API – where a phone's browser offers it) and hiding the whole
 * display for a clean view of the world.  While the display is hidden only
 * a faint button stays to bring it back (also F2, or the button's double
 * meaning: tap it again); menus still open over it.
 */

const HIDE_KEY = 'fahrsim.hudHidden';

export interface ViewButtons {
  node: HTMLElement;
  /** hide or show the display (F2) */
  toggleHud(): void;
  toggleFullscreen(): void;
}

export function viewButtons(root: HTMLElement, t: (k: string) => string): ViewButtons {
  const box = document.createElement('div');
  box.className = 'view-btns';
  const fs = document.createElement('button');
  fs.type = 'button';
  fs.className = 'view-btn';
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'view-btn';
  const canFull = !!document.documentElement.requestFullscreen;
  const fsIcon = (): void => {
    const on = !!document.fullscreenElement;
    fs.textContent = on ? '🗗' : '⛶';
    fs.title = t(on ? 'view.fullscreenOff' : 'view.fullscreen');
    fs.setAttribute('aria-label', fs.title);
  };
  const hidden = (): boolean => root.classList.contains('hud-off');
  const hideIcon = (): void => {
    hide.textContent = hidden() ? '👁' : '◌';
    hide.title = t(hidden() ? 'view.hudShow' : 'view.hudHide');
    hide.setAttribute('aria-label', hide.title);
  };
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  };
  const setHidden = (on: boolean): void => {
    root.classList.toggle('hud-off', on);
    try {
      sessionStorage.setItem(HIDE_KEY, on ? '1' : '');
    } catch {
      /* (a convenience) */
    }
    hideIcon();
  };
  const toggleHud = (): void => setHidden(!hidden());
  fs.onclick = (e) => {
    e.stopPropagation();
    toggleFullscreen();
  };
  hide.onclick = (e) => {
    e.stopPropagation();
    toggleHud();
  };
  document.addEventListener('fullscreenchange', fsIcon);
  fs.hidden = !canFull;
  box.append(fs, hide);
  fsIcon();
  let was = false;
  try {
    was = sessionStorage.getItem(HIDE_KEY) === '1';
  } catch {
    /* (none) */
  }
  setHidden(was);
  return { node: box, toggleHud, toggleFullscreen };
}
