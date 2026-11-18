// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The reality view: "what does this place really look like?"
 *
 * Shows real street-level pictures of where the car is – the player's own
 * files (360° panoramas saved with a street-view download tool, photos) and,
 * if switched on, pictures from Panoramax, KartaView and Mapillary – plus
 * links that open the same place on the web sites of the imagery services.
 */
import type { Settings } from '../game/settings.ts';
import { readImageMeta } from '../reality/imagemeta.ts';
import { IMAGE_FILE, LIST_FILE, describeLocal, imagesFromIndex, parseList } from '../reality/local.ts';
import type { ListEntry } from '../reality/local.ts';
import { placeLinks, searchImages } from '../reality/providers.ts';
import { SOURCE_NAME, rankImages } from '../reality/types.ts';
import type { ImageSource, StreetImage } from '../reality/types.ts';
import { PanoramaView } from '../render/panorama.ts';
import { formatMonth, formatUnit, tr } from '../i18n/index.ts';

export interface RealityPlace {
  lat: number;
  lon: number;
  /** compass direction the car faces, degrees */
  heading: number;
  /** street name, may be empty */
  name: string;
}

export interface RealityHost {
  settings: Settings;
  saveSettings(): void;
  close(): void;
  /** can this position be meant (is it on the map)? */
  plausible(lat: number, lon: number): boolean;
  /** widest texture the graphics chip takes */
  maxTexture: number;
  /** the map with aerial photographs, close up on where the car is */
  openAerial(): void;
  /** pictures of other sources near a place – the players' photos on a server (net/online.ts) */
  extraImages?(lat: number, lon: number): Promise<StreetImage[]>;
}

type Remote = Exclude<ImageSource, 'local'>;
const REMOTE: Remote[] = ['panoramax', 'kartaview', 'mapillary'];
/** search radius in metres: first close by, then further out */
const NEAR = 90;
const FAR = 300;

/** A Mapillary client token the operator of this copy built in (optional; players can enter their own). */
const BUILT_IN_TOKEN = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPILLARY_TOKEN ?? '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Mark a piece of text, ready for Ctrl+C. */
function selectText(node: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export class RealityPanel {
  readonly pano = new PanoramaView();
  private readonly root: HTMLElement;
  private readonly host: RealityHost;
  private node: HTMLElement | null = null;
  private view!: HTMLElement;
  private photo!: HTMLImageElement;
  private message!: HTMLElement;
  private caption!: HTMLElement;
  private thumbs!: HTMLElement;
  private noteNode!: HTMLElement;
  private readonly statusNodes = new Map<Remote, HTMLElement>();
  private place: RealityPlace = { lat: 0, lon: 0, heading: 0, name: '' };
  /** what each service answered for the current place */
  private readonly found = new Map<Remote, StreetImage[]>();
  private readonly status = new Map<Remote, string>();
  private readonly cache = new Map<string, StreetImage[]>();
  /** the player's own pictures; kept while the page is open */
  private readonly own: StreetImage[] = [];
  private readonly files = new Map<string, File>();
  private readonly thumbJobs = new Map<string, Promise<string>>();
  private hostedLoaded = false;
  private current: StreetImage | null = null;
  private abort: AbortController | null = null;
  private zoom = { k: 1, x: 0, y: 0 };
  private radius = NEAR;
  private note = '';
  /** the player chose a picture: no more switching to a better match on our own */
  private picked = false;
  private openedAt = 0;

  constructor(root: HTMLElement, host: RealityHost) {
    this.root = root;
    this.host = host;
  }

  get isOpen(): boolean {
    return this.node !== null;
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.host.settings.lang, p);
  }

  private get token(): string {
    return this.host.settings.reality.mapillaryToken.trim() || BUILT_IN_TOKEN;
  }

  // ------------------------------------------------------------------ opening
  open(place: RealityPlace): void {
    this.close();
    this.place = place;
    this.found.clear();
    this.status.clear();
    this.current = null;
    this.radius = NEAR;
    this.note = '';
    this.picked = false;
    this.openedAt = performance.now();
    this.build();
    void this.loadHosted();
    void this.loadExtra(place);
    for (const s of REMOTE) if (this.host.settings.reality[s]) void this.search(s);
    this.refresh();
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
    this.pano.close();
    this.node?.remove();
    this.node = null;
    this.statusNodes.clear();
  }

  /**
   * Draw the panorama, if one is showing.  (While the panel is open the world
   * is hidden behind it and need not be drawn at all.)
   */
  render(renderer: Parameters<PanoramaView['render']>[0], canvas: HTMLCanvasElement): void {
    if (!this.node || !this.pano.active || !this.view.classList.contains('pano')) return;
    const r = this.view.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    this.pano.render(renderer, { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height });
  }

  private build(): void {
    const o = el('div', 'overlay reality');
    const head = el('header', 'rv-head');
    const title = el('div', 'rv-title');
    title.append(el('b', '', this.t('reality')), el('span', '', this.t('realitySub')));
    const where = el('div', 'rv-where', `${this.place.name ? `${this.place.name} · ` : ''}${this.place.lat.toFixed(5)}, ${this.place.lon.toFixed(5)}`);
    const closeBtn = el('button', 'btn', `${this.t('realityClose')} (Esc)`);
    closeBtn.onclick = () => this.host.close();
    head.append(title, where, closeBtn);

    this.view = el('div', 'rv-view');
    this.photo = el('img', 'rv-photo');
    this.photo.alt = '';
    this.photo.referrerPolicy = 'no-referrer';
    this.photo.draggable = false;
    this.message = el('div', 'rv-msg');
    this.caption = el('div', 'rv-cap');
    this.photo.hidden = true;
    this.view.append(this.photo, this.message, this.caption);
    this.bindView();

    const side = el('aside', 'rv-side');
    // this place: its coordinates, the same spot at the imagery services and from above
    side.append(el('h2', '', this.t('realityPlace')));
    const coords = `${this.place.lat.toFixed(6)}, ${this.place.lon.toFixed(6)}`;
    const coordRow = el('div', 'rv-coords');
    const code = el('code', '', coords);
    const copy = el('button', 'btn ghost', this.t('realityCopy'));
    copy.onclick = () => {
      const done = (): void => {
        copy.textContent = this.t('realityCopied');
        setTimeout(() => (copy.textContent = this.t('realityCopy')), 1600);
      };
      // (the clipboard needs a secure page and the player's click; otherwise the text is selected for copying by hand)
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(coords).then(done, () => selectText(code));
      else selectText(code);
    };
    coordRow.append(code, copy);
    side.append(coordRow);
    const links = el('div', 'rv-links');
    for (const l of placeLinks(this.place.lat, this.place.lon, this.place.heading)) links.append(link(l.url, `${l.label} ↗`));
    side.append(links);
    const aerial = el('button', 'btn ghost', this.t('realityAerial'));
    aerial.onclick = () => this.host.openAerial();
    const aerialRow = el('div', 'buttons');
    aerialRow.append(aerial);
    side.append(aerialRow);

    side.append(el('h2', '', this.t('realitySources')));
    for (const s of REMOTE) side.append(this.sourceRow(s));
    side.append(el('p', 'rv-note', this.t('realityPrivacy')));

    side.append(el('h2', '', this.t('realityOwn')));
    side.append(el('p', 'rv-note', this.t('realityOwnText')));
    const pick = el('div', 'buttons');
    const files = el('input');
    files.type = 'file';
    files.multiple = true;
    files.accept = 'image/*,.json,.geojson,.csv,.tsv';
    files.hidden = true;
    files.onchange = () => void this.importFiles([...(files.files ?? [])]);
    const folder = el('input');
    folder.type = 'file';
    folder.multiple = true;
    folder.setAttribute('webkitdirectory', '');
    folder.hidden = true;
    folder.onchange = () => void this.importFiles([...(folder.files ?? [])]);
    const bf = el('button', 'btn ghost', this.t('realityPickFiles'));
    bf.onclick = () => files.click();
    const bd = el('button', 'btn ghost', this.t('realityPickFolder'));
    bd.onclick = () => folder.click();
    pick.append(bf, bd, files, folder);
    this.noteNode = el('p', 'rv-note');
    side.append(pick, this.noteNode);

    side.append(el('h2', '', this.t('realityNearby')));
    this.thumbs = el('div', 'rv-thumbs');
    side.append(this.thumbs);


    const main = el('div', 'rv-main');
    main.append(this.view, side);
    o.append(head, main);
    // pictures dropped anywhere on the panel
    o.addEventListener('dragover', (e) => e.preventDefault());
    o.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer) void this.importDrop(e.dataTransfer);
    });
    // Esc while typing the access token (the game's key handling leaves text fields alone)
    o.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target instanceof HTMLInputElement) this.host.close();
    });
    this.root.append(o);
    this.node = o;
    closeBtn.focus();
  }

  private sourceRow(s: Remote): HTMLElement {
    const cfg = this.host.settings.reality;
    const row = el('div', 'rv-source');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = cfg[s];
    const status = el('em');
    this.statusNodes.set(s, status);
    label.append(box, el('b', '', SOURCE_NAME[s]), el('small', '', s === 'mapillary' && !BUILT_IN_TOKEN ? this.t('realityToken') : this.t('realityFree')), status);
    row.append(label);
    let tokenRow: HTMLElement | null = null;
    if (s === 'mapillary') {
      tokenRow = el('div', 'rv-token');
      const input = el('input');
      input.type = 'text';
      input.placeholder = 'MLY|…';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = cfg.mapillaryToken;
      input.onchange = () => {
        cfg.mapillaryToken = input.value.trim();
        this.host.saveSettings();
        this.cacheDrop('mapillary');
        if (cfg.mapillary) void this.search('mapillary');
      };
      const help = el('small');
      help.append(link('https://www.mapillary.com/dashboard/developers', this.t('realityTokenHelp')), document.createTextNode(` · ${this.t('realityTokenStored')}`));
      tokenRow.append(input, help);
      tokenRow.hidden = !cfg.mapillary;
      row.append(tokenRow);
    }
    box.onchange = () => {
      cfg[s] = box.checked;
      this.host.saveSettings();
      if (tokenRow) tokenRow.hidden = !box.checked;
      if (box.checked) void this.search(s);
      else {
        this.found.delete(s);
        this.status.delete(s);
        if (this.current?.source === s) this.current = null;
        this.refresh();
      }
    };
    return row;
  }

  // ---------------------------------------------------------------- services
  private cacheKey(s: Remote, radius: number): string {
    return `${s}:${this.place.lat.toFixed(4)}:${this.place.lon.toFixed(4)}:${radius}`;
  }

  private cacheDrop(s: Remote): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${s}:`)) this.cache.delete(k);
  }

  private async search(s: Remote): Promise<void> {
    if (s === 'mapillary' && !this.token) {
      this.status.set(s, this.t('realityNeedToken'));
      this.found.delete(s);
      this.refresh();
      return;
    }
    this.abort ??= new AbortController();
    const signal = this.abort.signal;
    const node = this.node;
    this.status.set(s, this.t('realityLoading'));
    this.refresh();
    try {
      let list: StreetImage[] = [];
      for (const radius of [NEAR, FAR]) {
        const key = this.cacheKey(s, radius);
        let got = this.cache.get(key);
        if (!got) {
          got = await searchImages(s, { lat: this.place.lat, lon: this.place.lon, radius }, { token: this.token, signal });
          this.cache.set(key, got);
        }
        list = got;
        if (radius === FAR) this.radius = FAR;
        if (list.length > 0) break;
      }
      if (this.node !== node || !this.host.settings.reality[s]) return;
      this.found.set(s, list);
      this.status.set(s, this.t('realityCount', { n: list.length }));
    } catch (e) {
      if (signal.aborted || this.node !== node) return;
      this.found.delete(s);
      const msg = e instanceof Error ? e.message : String(e);
      this.status.set(s, this.t('realityError', { e: msg === 'token' ? this.t('realityNeedToken') : msg.slice(0, 90) }));
    }
    this.refresh();
  }

  // ------------------------------------------------------------ own pictures
  /** The pictures the host adds (a server's): among the own ones, each once. */
  private async loadExtra(place: RealityPlace): Promise<void> {
    if (!this.host.extraImages) return;
    try {
      const imgs = await this.host.extraImages(place.lat, place.lon);
      const have = new Set(this.own.map((i) => i.id));
      const add = imgs.filter((i) => !have.has(i.id));
      if (add.length === 0 || this.place !== place) return;
      this.own.push(...add);
      this.refresh();
    } catch {
      /* (no server, or it did not answer: nothing more to show) */
    }
  }

  /** Pictures offered by a self-hosted copy in its panos/ folder. */
  private async loadHosted(): Promise<void> {
    if (this.hostedLoaded) return;
    this.hostedLoaded = true;
    try {
      const base = new URL('panos/', document.baseURI).href;
      const res = await fetch(`${base}index.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const imgs = imagesFromIndex(await res.json(), base);
      if (imgs.length === 0) return;
      this.own.push(...imgs);
      this.refresh();
    } catch {
      /* no such folder: nothing to show */
    }
  }

  private async importDrop(data: DataTransfer): Promise<void> {
    const out: File[] = [];
    type Entry = { isFile: boolean; isDirectory: boolean; file(cb: (f: File) => void, err: () => void): void; createReader(): { readEntries(cb: (e: Entry[]) => void, err: () => void): void } };
    const walk = async (entry: Entry): Promise<void> => {
      if (entry.isFile) {
        const f = await new Promise<File | null>((res) => entry.file(res, () => res(null)));
        if (f) out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise<Entry[]>((res) => reader.readEntries(res, () => res([])));
          if (batch.length === 0) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    const entries: Entry[] = [];
    for (const item of [...data.items]) {
      const get = (item as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry;
      const entry = get ? get.call(item) : null;
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) for (const e of entries) await walk(e);
    else out.push(...data.files);
    await this.importFiles(out);
  }

  /** Take over pictures (and the lists lying next to them) from the player's machine. Nothing is uploaded. */
  async importFiles(files: File[]): Promise<void> {
    const lists: ListEntry[] = [];
    for (const f of files) {
      if (LIST_FILE.test(f.name) && f.size < 30e6) {
        try {
          lists.push(...parseList(await f.text()));
        } catch {
          /* unreadable list: the pictures may still place themselves */
        }
      }
    }
    let n = 0;
    let placed = 0;
    for (const f of files) {
      if (!IMAGE_FILE.test(f.name) && !f.type.startsWith('image/')) continue;
      const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (this.files.has(name)) continue;
      let meta = readImageMeta(new Uint8Array(0));
      try {
        meta = readImageMeta(new Uint8Array(await f.slice(0, 512 * 1024).arrayBuffer()));
      } catch {
        /* unreadable start: fall back to the file name */
      }
      const img = describeLocal({ name, meta, url: URL.createObjectURL(f), thumb: '' }, lists, this.host.plausible);
      this.files.set(name, f);
      this.own.push(img);
      n++;
      if (img.located) placed++;
    }
    if (n > 0) {
      this.note = this.t('realityImported', { n, p: placed });
      // show the best match again, which may now be one of these
      this.current = null;
      this.picked = false;
    }
    this.refresh();
  }

  /** A small preview of an own picture, made once and on demand (the originals can be huge). */
  private ownThumb(img: StreetImage): Promise<string> {
    let job = this.thumbJobs.get(img.id);
    if (!job) {
      job = (async () => {
        const file = this.files.get(img.id);
        if (!file) return img.url;
        try {
          const bmp = await createImageBitmap(file, { resizeWidth: 240, resizeQuality: 'medium' });
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')?.drawImage(bmp, 0, 0);
          bmp.close();
          img.thumb = c.toDataURL('image/jpeg', 0.7);
          return img.thumb;
        } catch {
          return img.url;
        }
      })();
      this.thumbJobs.set(img.id, job);
    }
    return job;
  }

  // ------------------------------------------------------------------ showing
  private all(): StreetImage[] {
    const out = [...this.own];
    for (const s of REMOTE) out.push(...(this.found.get(s) ?? []));
    return out;
  }

  private refresh(): void {
    if (!this.node) return;
    for (const [s, node] of this.statusNodes) node.textContent = this.status.get(s) ?? '';
    this.noteNode.textContent = this.note;
    const ranked = rankImages(this.all(), this.place.lat, this.place.lon, this.place.heading).filter((r) => r.dist <= FAR * 1.5);
    this.thumbs.replaceChildren();
    for (const { image, dist } of ranked.slice(0, 24)) this.thumbs.append(this.thumbButton(image, formatUnit(Math.round(dist), 'meter', this.host.settings.lang)));
    const loose = this.own.filter((i) => !i.located);
    if (loose.length > 0) {
      this.thumbs.append(el('div', 'rv-group', this.t('realityUnplaced', { n: loose.length })));
      for (const image of loose.slice(0, 12)) this.thumbs.append(this.thumbButton(image, ''));
    }
    // Show the best match – and, until the player has chosen one, a better one that a slower service brings
    const best = ranked.length > 0 ? ranked[0].image : null;
    if (best && (!this.current || (!this.picked && best !== this.current && performance.now() - this.openedAt < 6000))) this.select(best);
    else if (!this.current) this.showEmpty();
  }

  private thumbButton(image: StreetImage, distance: string): HTMLElement {
    const b = el('button', `rv-thumb${image === this.current ? ' on' : ''}`);
    const pic = el('img');
    pic.alt = '';
    pic.loading = 'lazy';
    pic.referrerPolicy = 'no-referrer';
    if (image.thumb) pic.src = image.thumb;
    else
      void this.ownThumb(image).then((u) => {
        pic.src = u;
      });
    const year = Number.isFinite(image.time) ? String(new Date(image.time).getUTCFullYear()) : '';
    const from = image.source === 'local' ? this.t('realityOwnPicture') : SOURCE_NAME[image.source];
    b.append(pic, el('span', '', [distance, year].filter(Boolean).join(' · ') || from), el('span', 'rv-from', from));
    if (image.pano) b.append(el('i', '', '360°'));
    b.title = [image.title, distance, year, from].filter(Boolean).join(' · ');
    b.onclick = () => {
      this.picked = true;
      this.select(image);
    };
    return b;
  }

  private showEmpty(): void {
    this.pano.close();
    this.view.classList.remove('pano');
    this.photo.hidden = true;
    this.caption.replaceChildren();
    const anyOn = REMOTE.some((s) => this.host.settings.reality[s]);
    const busy = REMOTE.some((s) => this.status.get(s) === this.t('realityLoading'));
    this.message.hidden = false;
    this.message.textContent = busy ? this.t('realityLoading') : anyOn || this.own.length > 0 ? this.t('realityNoneFound', { r: this.radius }) : this.t('realityNone');
  }

  private select(image: StreetImage): void {
    this.current = image;
    this.zoom = { k: 1, x: 0, y: 0 };
    this.applyZoom();
    for (const b of this.thumbs.querySelectorAll('.rv-thumb.on')) b.classList.remove('on');
    this.setCaption(image);
    this.message.hidden = true;
    if (image.pano) {
      this.photo.hidden = true;
      this.message.hidden = false;
      this.message.textContent = this.t('realityLoading');
      const mobile = window.matchMedia('(pointer: coarse)').matches;
      this.pano
        .show(image.full || image.url, Math.min(this.host.maxTexture, mobile ? 4096 : 8192))
        .then(() => {
          if (this.current !== image || !this.node) return;
          // look the way the car faces
          this.pano.yaw = Number.isFinite(image.heading) ? ((this.place.heading - image.heading) * Math.PI) / 180 : 0;
          this.view.classList.add('pano');
          this.message.hidden = true;
        })
        .catch(() => {
          // may not be used as a texture or failed to decode: show it flat instead
          if (this.current === image && this.node) this.showFlat(image);
        });
    } else this.showFlat(image);
    this.refreshMarks();
  }

  private refreshMarks(): void {
    // cheap: rebuild the list so the chosen picture is marked
    const cur = this.current;
    const ranked = rankImages(this.all(), this.place.lat, this.place.lon, this.place.heading).filter((r) => r.dist <= FAR * 1.5);
    const buttons = [...this.thumbs.querySelectorAll('.rv-thumb')];
    const order = [...ranked.slice(0, 24).map((r) => r.image), ...this.own.filter((i) => !i.located).slice(0, 12)];
    buttons.forEach((b, i) => b.classList.toggle('on', order[i] === cur));
  }

  private showFlat(image: StreetImage): void {
    this.pano.close();
    this.view.classList.remove('pano');
    this.message.hidden = true;
    this.photo.hidden = false;
    this.photo.onerror = () => {
      if (this.current !== image) return;
      this.photo.hidden = true;
      this.message.hidden = false;
      this.message.textContent = this.t('realityError', { e: 'image' });
    };
    this.photo.src = image.url;
  }

  private setCaption(image: StreetImage): void {
    const c = this.caption;
    c.replaceChildren();
    const date = Number.isFinite(image.time) ? formatMonth(image.time, this.host.settings.lang) : '';
    if (image.source === 'local') {
      c.append(el('span', '', [this.t('realityOwnPicture'), image.title, date].filter(Boolean).join(' · ')));
      if (!image.located) {
        const pin = el('button', 'btn ghost small', this.t('realityPinHere'));
        pin.onclick = () => {
          image.lat = this.place.lat;
          image.lon = this.place.lon;
          image.located = true;
          if (!image.pano && Number.isNaN(image.heading)) image.heading = this.place.heading;
          this.refresh();
          this.setCaption(image);
        };
        c.append(pin);
      }
    } else {
      const who = image.author ? `© ${image.author}` : this.t('realityContributors', { s: SOURCE_NAME[image.source] });
      c.append(el('span', '', [who, date, image.licence, SOURCE_NAME[image.source]].filter(Boolean).join(' · ')));
      if (image.page) c.append(link(image.page, `${this.t('realityOriginal')} ↗`));
    }
    if (image.pano) c.append(el('small', '', this.t('realityDragHint')));
  }

  // ------------------------------------------------------- looking and zooming
  private applyZoom(): void {
    const z = this.zoom;
    this.photo.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.k})`;
  }

  private bindView(): void {
    const v = this.view;
    let down = false;
    let lx = 0;
    let ly = 0;
    v.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.rv-cap')) return;
      down = true;
      lx = e.clientX;
      ly = e.clientY;
      v.setPointerCapture(e.pointerId);
    });
    v.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (v.classList.contains('pano')) this.pano.drag(dx, dy, v.clientHeight);
      else if (this.zoom.k > 1) {
        this.zoom.x += dx;
        this.zoom.y += dy;
        this.applyZoom();
      }
    });
    const up = (): void => {
      down = false;
    };
    v.addEventListener('pointerup', up);
    v.addEventListener('pointercancel', up);
    v.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (v.classList.contains('pano')) this.pano.zoom(e.deltaY);
        else {
          const k = Math.max(1, Math.min(8, this.zoom.k * Math.exp(-e.deltaY * 0.0015)));
          // keep the point under the pointer where it is
          const r = v.getBoundingClientRect();
          const px = e.clientX - r.left - r.width / 2;
          const py = e.clientY - r.top - r.height / 2;
          const f = k / this.zoom.k;
          this.zoom.x = px - (px - this.zoom.x) * f;
          this.zoom.y = py - (py - this.zoom.y) * f;
          this.zoom.k = k;
          if (k === 1) this.zoom.x = this.zoom.y = 0;
          this.applyZoom();
        }
      },
      { passive: false },
    );
    v.addEventListener('dblclick', () => {
      this.zoom = { k: 1, x: 0, y: 0 };
      this.applyZoom();
      this.pano.fov = 75;
    });
  }

  /** For the automated check of the page: what is showing right now. */
  debugInfo(): Record<string, unknown> {
    return {
      open: this.isOpen,
      own: this.own.length,
      found: Object.fromEntries([...this.found].map(([k, v]) => [k, v.length])),
      status: Object.fromEntries(this.status),
      current: this.current ? { source: this.current.source, pano: this.current.pano, title: this.current.title } : null,
      panoActive: this.pano.active,
      note: this.note,
    };
  }
}
