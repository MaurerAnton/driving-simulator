// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's connection to a Fahrsim Baunatal server, all in one place: the
 * client (net/client.ts), the progress kept in step (net/sync.ts), the
 * photos (net/images.ts) and playing together (net/multiplayer.ts,
 * net/netrender.ts) – and the panels for them (ui/netpanels.ts).  The game
 * holds one Online and calls a few hooks: each frame, the boxes of the
 * others for its traffic, the panels from the settings and the pause menu.
 *
 * Without a server set nothing of this does anything (and costs nothing):
 * the game is a static site and stays complete on its own.
 */
import type * as THREE from 'three';
import { ServerClient, urlParams } from './client.ts';
import { ProgressSync, sharedSettings } from './sync.ts';
import { ImageCache, ImageUrls } from './images.ts';
import type { ServerImage } from './images.ts';
import { MultiplayerSession, socketUrl } from './multiplayer.ts';
import type { ChatLine, Snapshot } from './multiplayer.ts';
import { RemotePlayers } from './netrender.ts';
import type { PlayerBox, Shown } from './netrender.ts';
import type { Settings } from '../game/settings.ts';
import { loadSettings, saveSettings } from '../game/settings.ts';
import type { SceneryCollider } from '../sim/collision.ts';
import { latLonToWorld, worldToLatLon } from '../geo/utm.ts';
import { extraLayers } from '../ui/maplayers.ts';
import type { StreetImage } from '../reality/types.ts';
import { tr } from '../i18n/index.ts';
import { showAccount, showImage, showTogether } from '../ui/netpanels.ts';

// ------------------------------------------------------------------ before the game starts

let shared: { client: ServerClient; sync: ProgressSync } | null = null;

/** The one client and sync of the page (made on first use). */
export function netCore(): { client: ServerClient; sync: ProgressSync } {
  if (shared) return shared;
  const client = new ServerClient();
  const store = typeof localStorage === 'undefined' ? memoryStore() : localStorage;
  const sync = new ProgressSync({ client, store });
  shared = { client, sync };
  return shared;
}

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

/**
 * Before the game is built: the server and token of the address taken over
 * (the token out of the address bar), and – when signed in – the progress
 * pulled, so that the game starts with it.  Waits at most `wait` ms (a
 * server that does not answer delays nothing for longer); without a server
 * it returns at once.
 */
export async function netBeforeStart(wait = 2500): Promise<void> {
  const { client, sync } = netCore();
  const q = urlParams(location.href);
  const s = loadSettings();
  if (q.server !== null && q.server !== '' && q.server !== s.server) {
    s.server = q.server;
    saveSettings(s);
  }
  if (q.cleaned !== null) {
    try {
      history.replaceState(history.state, '', q.cleaned);
    } catch {
      /* (some embedded views refuse: the token stays, nothing breaks) */
    }
  }
  client.setServer(s.server);
  if (q.token) client.setToken(q.token);
  if (!client.url) return;
  const job = (async () => {
    if (await client.connect()) await sync.sync();
  })();
  await Promise.race([job, new Promise((r) => setTimeout(r, wait))]);
}

// ------------------------------------------------------------------ in the game

/** What Online needs of the game. */
export interface OnlineHost {
  settings: Settings;
  /** the game's layer of panels (the viewer of a picture goes there, over the map too) */
  ui: HTMLElement;
  scene: THREE.Scene;
  collider: SceneryCollider;
  /** show a panel over the game (null: none) */
  show(node: HTMLElement | null): void;
  /** a short line in the HUD (chat, joined, left) */
  message(text: string, sub?: string): void;
  /** where the player is (null: no drive) */
  where(): { x: number; z: number; yaw: number } | null;
  /** the map's build: players of a session should have the same */
  mapStamp(): string;
  /** the settings were changed from the server: apply them */
  settingsChanged(): void;
  /** the fault log was changed from the server: read it again */
  faultsChanged(): void;
  /** the big map open for a place to be tapped – then `done` (closing it without: nothing) */
  pickOnMap(done: (x: number, z: number) => void): void;
  /** put the player near (x, z) (from the pause menu: a free drive only) – false: not now */
  goNear(x: number, z: number): boolean;
}

export class Online {
  readonly client: ServerClient;
  readonly sync: ProgressSync;
  readonly images: ImageCache;
  readonly urls: ImageUrls;
  readonly host: OnlineHost;
  session: MultiplayerSession | null = null;
  /** the code to join once the game is ready (?join=) */
  joinCode: string | null = null;
  private readonly remote = new RemotePlayers();
  private readonly shown: Shown[] = [];
  private readonly snaps = new Map<string, Snapshot>();
  private lookT = 0;
  private syncT = 0;
  private colliderOn = false;
  private guestTold = false;
  /** the panels redraw on changes while open */
  redraw: (() => void) | null = null;
  /** the player's session panel wants the chat as it comes */
  onChat: ((l: ChatLine) => void) | null = null;

  constructor(host: OnlineHost) {
    this.host = host;
    const core = netCore();
    this.client = core.client;
    this.sync = core.sync;
    this.images = new ImageCache(this.client);
    this.urls = new ImageUrls(this.client);
    this.joinCode = typeof location === 'undefined' ? null : urlParams(location.href).join;
    host.scene.add(this.remote.group);
    // (the progress from the server: what the game holds in memory is taken over)
    this.sync.pulled = (kind) => this.pulled(kind);
    this.client.onChange(() => {
      this.redraw?.();
      // (signed in just now, or the server is back: the progress at once)
      if (this.sync.possible) void this.sync.sync();
      this.tryJoin();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.client.wake());
      // (going away: what changed goes out now, as far as it gets)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && this.sync.possible) {
          this.sync.look();
          void this.sync.sync(true);
        }
      });
    }
    // the photos as a layer of the big map
    extraLayers.photos = {
      draw: (g, W, H, scale, sx, sy) => this.drawPhotos(g, W, H, scale, sx, sy),
      at: (px, py, scale, sx, sy) => this.photoAt(px, py, scale, sx, sy),
    };
    if (this.client.url && this.client.status === 'none') void this.client.connect();
    this.openImage = (img) => showImage(this, img, () => {}, host.ui);
    // (the server may have answered before the game was built: net/online.ts netBeforeStart)
    this.tryJoin();
  }

  /** Opened with ?join=CODE: into that session as soon as the server is there – as a guest, the panel asks for a name. */
  private tryJoin(): void {
    const code = this.joinCode;
    if (!code || !this.client.has('multiplayer') || this.session) return;
    if (this.client.signedIn) {
      this.joinCode = null;
      this.join(code);
    } else if (this.client.info && !this.client.token && !this.guestTold) {
      this.guestTold = true;
      this.host.message(this.t('net.joinAsGuest', { code }));
    }
  }

  /** "Account / server" (from the settings). */
  account(back: () => void): void {
    showAccount(this, back);
  }

  /** "Play together" (from the pause menu). */
  together(back: () => void): void {
    showTogether(this, back, () => showAccount(this, () => this.together(back)));
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.host.settings.lang, p);
  }

  /** A kind came from the server: what the game keeps in memory follows it. */
  private pulled(kind: string): void {
    if (kind === 'settings') {
      const fresh = loadSettings();
      const s = this.host.settings as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(sharedSettings(fresh as unknown as Record<string, unknown>))) s[k] = v;
      this.host.settingsChanged();
    } else if (kind === 'results') this.host.faultsChanged();
  }

  /** The server address changed (the account panel): stored in the settings, connected anew. */
  setServer(url: string): void {
    this.leave();
    this.images.clear();
    this.client.setServer(url);
    this.host.settings.server = this.client.url;
    saveSettings(this.host.settings);
    void this.client.connect();
  }

  // ---------------------------------------------------------------- each frame

  /** Each frame: the progress looked at, the own state sent, the others drawn. `me`: the own vehicle (null: none). */
  frame(dt: number, me: Snapshot | null): void {
    if (this.client.url) {
      this.lookT += dt;
      if (this.lookT >= 3) {
        this.lookT = 0;
        if (this.sync.possible) {
          this.sync.look();
          if (this.sync.due()) void this.sync.sync(true);
        }
      }
      // (now and then all of it: another device may have changed something)
      this.syncT += dt;
      if (this.syncT >= 300) {
        this.syncT = 0;
        if (this.sync.possible) void this.sync.sync();
      }
    }
    const ses = this.session;
    if (!ses) {
      if (this.colliderOn) this.clearOthers();
      return;
    }
    ses.tick(me);
    const now = performance.now();
    const list = this.shown;
    list.length = 0;
    for (const p of ses.players.values()) {
      if (ses.stale(p, now)) continue;
      let s = this.snaps.get(p.id);
      if (!s) this.snaps.set(p.id, (s = {} as Snapshot));
      if (p.track.sample(now, s)) list.push({ id: p.id, name: p.name, s });
    }
    this.remote.update(list, now / 1000, dt);
    // the others' boxes: the player's vehicle stops at them (nothing more – no physics between players)
    this.host.collider.remove('netplayers');
    this.host.collider.add({ key: 'netplayers', rings: null, ringCounts: null, segments: this.remote.segments(), discs: [] });
    this.colliderOn = true;
  }

  private clearOthers(): void {
    this.remote.clear();
    this.host.collider.remove('netplayers');
    this.colliderOn = false;
  }

  /** The others' vehicles for the traffic: it brakes for them as for any other obstacle. */
  obstacles(into: Array<{ x: number; y: number; z: number; yaw: number; speed: number; length: number; width: number }>): void {
    if (!this.session) return;
    for (const b of this.remote.boxes as readonly PlayerBox[]) into.push({ x: b.x, y: b.y, z: b.z, yaw: b.yaw, speed: b.speed, length: b.length, width: b.width });
  }

  /** the players in the session, for the panel (with where they are now) */
  others(): Array<{ id: string; name: string; host: boolean; at: Snapshot | null }> {
    const ses = this.session;
    if (!ses) return [];
    return [...ses.players.values()].map((p) => ({ id: p.id, name: p.name, host: p.host, at: p.track.latest }));
  }

  // ---------------------------------------------------------------- playing together

  /** Join a session by its code (signed in, or as a guest by `guestName`). */
  join(code: string, guestName = ''): void {
    this.leave();
    const url = socketUrl(this.client.url, code, this.client.token, guestName);
    const ses = new MultiplayerSession({
      url,
      code,
      socket: (u) => new WebSocket(u) as unknown as ReturnType<ConstructorParameters<typeof MultiplayerSession>[0]['socket']>,
      events: {
        line: (l) => this.chatLine(l),
        players: () => this.redraw?.(),
        hello: (map) => {
          if (map && map !== this.host.mapStamp()) this.host.message(this.t('net.mapDiffers'));
          this.redraw?.();
        },
        ended: (reason) => {
          if (this.session === ses) this.session = null;
          this.clearOthers();
          const why: Record<string, string> = { kicked: 'net.kicked', refused: 'net.refused', lost: 'net.lost', full: 'net.full', not_found: 'net.errNotFound', guests_not_allowed: 'net.noGuests', bad_token: 'net.errToken', unauthorized: 'net.errToken', host_left: 'net.hostLeft', replaced: 'net.replaced' };
          if (reason !== 'left') this.host.message(this.t(why[reason] ?? 'net.sessionEnded'));
          this.redraw?.();
        },
        error: (code) => {
          if (code === 'rate_limited') this.host.message(this.t('net.slowDown'));
        },
      },
    });
    this.session = ses;
    this.redraw?.();
  }

  leave(): void {
    const s = this.session;
    this.session = null;
    s?.leave();
    this.snaps.clear();
    this.clearOthers();
  }

  private chatLine(l: ChatLine): void {
    const ses = this.session;
    if (l.system) {
      const name = l.name || ses?.players.get(l.id)?.name || '';
      const key = l.text === 'join' ? 'net.joined' : l.text === 'leave' ? 'net.left' : 'net.newHost';
      this.host.message(this.t(key, { name }));
    } else if (l.id !== ses?.you) this.host.message(l.name, l.text);
    this.onChat?.(l);
    this.redraw?.();
  }

  // ---------------------------------------------------------------- photos

  private visible(sx: (x: number) => number, sy: (z: number) => number, W: number, H: number): [number, number, number, number] {
    // (back from screen to world: the scale and the offset of the two functions)
    const k = sx(1) - sx(0) || 1;
    const x0 = (0 - sx(0)) / k;
    const x1 = (W - sx(0)) / k;
    const z0 = (0 - sy(0)) / k;
    const z1 = (H - sy(0)) / k;
    const [n, w] = worldToLatLon(x0, z0);
    const [s, e] = worldToLatLon(x1, z1);
    return [Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)];
  }

  private drawPhotos(g: CanvasRenderingContext2D, W: number, H: number, scale: number, sx: (x: number) => number, sy: (z: number) => number): void {
    if (!this.client.has('images') || scale < 0.03) return;
    const [w, s, e, n] = this.visible(sx, sy, W, H);
    this.images.want(w, s, e, n);
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const img of this.images.all) {
      const [x, z] = latLonToWorld(img.lat, img.lon);
      const px = sx(x);
      const py = sy(z);
      if (px < -12 || py < -12 || px > W + 12 || py > H + 12) continue;
      const pano = img.kind === 'pano360';
      g.fillStyle = pano ? '#7a3fd1' : '#d9822b';
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(px, py, 9, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // (which way it looks: a small wedge)
      if (Number.isFinite(img.heading) && !pano) {
        const a = (img.heading * Math.PI) / 180;
        g.beginPath();
        g.moveTo(px + Math.sin(a) * 15, py - Math.cos(a) * 15);
        g.lineTo(px + Math.sin(a + 0.5) * 9, py - Math.cos(a + 0.5) * 9);
        g.lineTo(px + Math.sin(a - 0.5) * 9, py - Math.cos(a - 0.5) * 9);
        g.closePath();
        g.fill();
      }
      g.fillStyle = '#ffffff';
      g.font = '700 10px system-ui, sans-serif';
      g.fillText(pano ? '360' : '📷', px, py + 1);
    }
    g.restore();
  }

  private photoAt(px: number, py: number, scale: number, sx: (x: number) => number, sy: (z: number) => number): (() => void) | null {
    if (!this.client.has('images') || scale < 0.03) return null;
    let best: ServerImage | null = null;
    let bd = 16;
    for (const img of this.images.all) {
      const [x, z] = latLonToWorld(img.lat, img.lon);
      const d = Math.hypot(sx(x) - px, sy(z) - py);
      if (d < bd) {
        bd = d;
        best = img;
      }
    }
    const pick = best;
    return pick ? () => this.openImage?.(pick) : null;
  }

  /** set by the panels: open a picture in its viewer */
  openImage: ((img: ServerImage) => void) | null = null;

  /** The server's pictures near a place, for the reality view (public ones and the player's own). */
  async realityImages(lat: number, lon: number): Promise<StreetImage[]> {
    if (!this.client.has('images')) return [];
    const d = 0.004;
    this.images.want(lon - d, lat - d, lon + d, lat + d);
    // (what is known already, and a moment for the rest to come)
    await new Promise((r) => setTimeout(r, 900));
    const out: StreetImage[] = [];
    // (a private picture is fetched with the token, whole – only the nearest few of those)
    let privates = 0;
    const k = Math.cos((lat * Math.PI) / 180);
    const near = this.images.near(lat, lon, 400).sort((a, b) => Math.hypot(a.lat - lat, (a.lon - lon) * k) - Math.hypot(b.lat - lat, (b.lon - lon) * k));
    for (const img of near.slice(0, 40)) {
      if (img.visibility === 'private' && ++privates > 6) continue;
      try {
        const [thumb, url] = await Promise.all([this.urls.url(img, 'thumb'), this.urls.url(img, 'file')]);
        out.push({ source: 'local', id: `server:${img.id}`, lat: img.lat, lon: img.lon, heading: img.heading, pano: img.kind === 'pano360', time: img.taken ? Date.parse(img.taken) : NaN, author: img.ownerName, licence: '', thumb, url, full: url, page: '', title: img.title || this.t('net.photoBy', { name: img.ownerName || '?' }), located: true });
      } catch {
        /* (that one could not be fetched) */
      }
    }
    return out;
  }
}
