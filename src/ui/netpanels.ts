// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The panels of the server (net/online.ts): "Account / server" in the
 * settings – the server's address, signing in with a token or making an
 * account, the name, the tokens, the progress kept in step, signing out –,
 * the admin's panel for an admin account (all the server's admin API
 * offers), "Play together" in the pause menu – hosting a session, joining
 * one by code, link or list, the players, the chat, leaving –, uploading a
 * photo or a 360° panorama, and the viewer of one.
 *
 * Each panel draws itself anew when something changes while it is open
 * (Online.redraw).  Plain DOM in the look of the other panels.
 */
import { closeX } from './closex.ts';
import { ServerError, normaliseServerUrl, tokenPrefix, validToken } from '../net/client.ts';
import type { AdminAccount, AdminSettings, TokenInfo } from '../net/client.ts';
import type { Online } from '../net/online.ts';
import { createSession, getSession, listSessions, sessionCode } from '../net/multiplayer.ts';
import type { SessionInfo } from '../net/multiplayer.ts';
import { IMAGE_TYPES, checkUpload, deleteImage, fileMeta, kindOf, makeThumb, uploadImage } from '../net/images.ts';
import type { ImageKind, ServerImage, UploadMeta } from '../net/images.ts';
import { latLonToWorld, worldToLatLon } from '../geo/utm.ts';
import { photoViewer } from './photoviewer.ts';
import { localeOf, tr } from '../i18n/index.ts';

type T = (key: string, p?: Record<string, string | number>) => string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, act: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = act;
  return b;
}

function input(value: string, placeholder: string, type = 'text'): HTMLInputElement {
  const i = el('input', 'net-input');
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
}

/** A line of a label and its field(s). */
function row(label: string, ...parts: HTMLElement[]): HTMLElement {
  const r = el('div', 'row');
  if (label) r.append(el('label', '', label));
  r.append(...parts);
  return r;
}

/** Copy a text to the clipboard (or share it on a phone); true: done. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The text of an error, in the player's language where it is one of the known ones. */
function errorText(t: T, e: unknown): string {
  if (e instanceof ServerError) {
    const known: Record<string, string> = {
      offline: 'net.errOffline',
      timeout: 'net.errOffline',
      unauthorized: 'net.errToken',
      bad_token: 'net.errBadToken',
      forbidden: 'net.errForbidden',
      registration_closed: 'net.errRegistration',
      not_found: 'net.errNotFound',
      conflict: 'net.errConflict',
      too_large: 'net.imgTooBig',
      not_a_server: 'net.errNotServer',
    };
    const key = known[e.code];
    return key ? t(key) : `${t('net.errServer')} (${e.code}${e.message ? `: ${e.message}` : ''})`;
  }
  // (a check of the panel's own: its text is already the player's)
  if (e instanceof Error) return e.message;
  return `${t('net.errServer')} (${String(e)})`;
}

/** The address of the game with the server (and a token or a session to join) in it – for a link to share. */
function gameLink(server: string, extra: Record<string, string>): string {
  const u = new URL(document.baseURI);
  u.search = '';
  u.hash = '';
  u.searchParams.set('server', server);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

/** The panels' shared frame: an overlay with a panel, its × and title. */
function frame(title: string, t: T, back: () => void): { o: HTMLElement; p: HTMLElement } {
  const o = el('div', 'overlay');
  const p = el('div', 'panel narrow net-panel');
  p.append(closeX(t('back'), back), el('h1', '', title));
  o.append(p);
  return { o, p };
}

function statusText(on: Online, t: T): string {
  const c = on.client;
  if (!c.url) return t('net.statusNone');
  if (c.status === 'connecting') return t('net.statusConnecting');
  if (c.status === 'offline') return c.lastError === 'not_a_server' ? t('net.errNotServer') : t('net.statusOffline');
  return t('net.statusOnline', { name: c.info?.name || c.url, version: c.info?.server ?? '' });
}

// ------------------------------------------------------------------ account / server

export function showAccount(on: Online, back: () => void): void {
  const t: T = (k, p) => tr(k, on.host.settings.lang, p);
  const done = (): void => {
    on.redraw = null;
    back();
  };
  // (what was shown last: a token just made, an error – kept over redraws)
  let note = '';
  let fresh = '';
  let busy = false;
  /** the account's tokens as the server lists them (null: not asked yet, or not listed) */
  let tokens: TokenInfo[] | null = null;
  let tokensOf = '';
  const loadTokens = (): void => {
    const c = on.client;
    const who = `${c.url}#${c.me?.id ?? ''}#${fresh}`;
    if (!c.me || tokensOf === who) return;
    tokensOf = who;
    c.myTokens().then(
      (list) => {
        tokens = list;
        if (!busy) draw();
      },
      () => {},
    );
  };
  const draw = (): void => {
    const c = on.client;
    loadTokens();
    const { o, p } = frame(t('net.account'), t, done);
    p.append(el('p', 'note', t('net.accountNote')));
    // the server
    const addr = input(c.url, 'https://…', 'url');
    addr.inputMode = 'url';
    const connect = button(t('net.connect'), () => {
      const u = normaliseServerUrl(addr.value);
      if (u === null) {
        note = t('net.errAddress');
        draw();
        return;
      }
      note = '';
      on.setServer(u);
      draw();
    });
    p.append(row(t('net.serverAddress'), addr, connect));
    const st = el('p', `note${c.status === 'offline' ? ' warn' : ''}`, statusText(on, t));
    p.append(st);
    if (c.status === 'offline' && c.url) p.append(button(t('net.retry'), () => c.wake(), 'btn ghost small'));
    if (c.info?.motd) p.append(el('p', 'net-motd', c.info.motd));
    if (c.status === 'online' && c.info) {
      const caps = c.info.capabilities;
      const known = ['accounts', 'progress', 'images', 'images360', 'multiplayer'];
      p.append(el('p', 'note', `${t('net.offers')}: ${caps.map((k) => (known.includes(k) ? t(`net.cap.${k}`) : k)).join(', ')}`));
      if (caps.includes('accounts')) {
        if (!c.me) signedOut(p);
        else signedIn(p);
      }
    }
    if (note) p.append(el('p', 'note warn', note));
    const b = el('div', 'buttons');
    b.append(button(t('back'), done, 'btn'));
    p.append(b);
    on.host.show(o);
  };
  const act = (job: () => Promise<void>): void => {
    if (busy) return;
    busy = true;
    note = '';
    job()
      .catch((e: unknown) => {
        note = errorText(t, e);
      })
      .finally(() => {
        busy = false;
        draw();
      });
  };
  const signedOut = (p: HTMLElement): void => {
    const c = on.client;
    if (c.lastError === 'bad_token' || (c.token && c.lastError)) p.append(el('p', 'note warn', t('net.errToken')));
    p.append(el('h2', '', t('net.signIn')));
    const tk = input('', t('net.tokenPlaceholder'), 'password');
    p.append(row(t('net.token'), tk, button(t('net.signIn'), () => act(async () => void (await c.signIn(tk.value))))));
    // (a server that says registration is closed: only the admin makes accounts)
    if (c.info?.registration === false) {
      p.append(el('p', 'note', t('net.errRegistration')));
      return;
    }
    p.append(el('h2', '', t('net.register')));
    const nm = input('', t('net.namePlaceholder'));
    nm.maxLength = 40;
    p.append(
      row(
        t('net.name'),
        nm,
        button(t('net.register'), () =>
          act(async () => {
            if (!nm.value.trim()) throw new Error(t('net.errName'));
            await c.register(nm.value);
            fresh = c.token;
          }),
        ),
      ),
    );
    p.append(el('p', 'note', t('net.registerNote')));
  };
  const signedIn = (p: HTMLElement): void => {
    const c = on.client;
    const me = c.me!;
    p.append(el('p', 'net-me', t(me.admin ? 'net.signedInAdmin' : 'net.signedIn', { name: me.name || me.id })));
    const nm = input(me.name, t('net.namePlaceholder'));
    nm.maxLength = 40;
    p.append(row(t('net.name'), nm, button(t('net.save'), () => act(() => c.rename(nm.value)), 'btn ghost')));
    // tokens: this one, a new one (to sign in on another device: a link with it), one taken back
    p.append(el('h2', '', t('net.tokens')));
    p.append(el('p', 'note', t('net.tokenThis', { prefix: tokenPrefix(c.token) })));
    if (fresh) {
      const link = gameLink(c.url, { tk: fresh });
      const box = el('div', 'net-secret');
      box.append(el('code', '', fresh));
      box.append(button(t('net.copyToken'), () => void copy(fresh), 'btn ghost small'), button(t('net.copyLink'), () => void copy(link), 'btn ghost small'));
      p.append(box, el('p', 'note warn', t('net.tokenSecret')));
    }
    p.append(
      button(t('net.newToken'), () =>
        act(async () => {
          fresh = await c.newToken();
          tokensOf = '';
        }), 'btn ghost'),
    );
    const known = tokens ?? me.tokens ?? null;
    if (known && known.length > 0) {
      const list = el('div', 'net-list');
      for (const k of known) {
        const r = el('div', 'net-item');
        const own = k.prefix === tokenPrefix(c.token);
        r.append(el('span', '', `${k.prefix}…${k.created ? ` · ${k.created.slice(0, 10)}` : ''}${k.lastUsed ? ` · ${t('net.lastUsed', { date: k.lastUsed.slice(0, 10) })}` : ''}${own ? ` (${t('net.thisDevice')})` : ''}`));
        if (!own)
          r.append(
            button(t('net.revoke'), () =>
              act(async () => {
                await c.revokeToken(k.prefix);
                tokensOf = '';
              }), 'btn ghost small'),
          );
        list.append(r);
      }
      p.append(list);
    }
    const pre = input('', t('net.prefixPlaceholder'));
    pre.maxLength = 6;
    p.append(
      row(
        t('net.revokeToken'),
        pre,
        button(t('net.revoke'), () =>
          act(async () => {
            if (pre.value.trim().length < 6) throw new Error(t('net.errPrefix'));
            if (pre.value.trim() === tokenPrefix(c.token) && !confirm(t('net.revokeOwnAsk'))) return;
            await c.revokeToken(pre.value.trim());
          }), 'btn ghost'),
      ),
    );
    // the progress
    if (c.has('progress')) {
      p.append(el('h2', '', t('net.progress')));
      const s = on.sync;
      const when = s.lastSync ? new Intl.DateTimeFormat(localeOf(on.host.settings.lang), { timeStyle: 'short' }).format(new Date(s.lastSync)) : '–';
      p.append(el('p', `note${s.lastError ? ' warn' : ''}`, s.lastError ? t('net.syncFailed') : t('net.synced', { time: when })));
      p.append(el('p', 'note', t('net.syncNote')));
      p.append(button(t('net.syncNow'), () => act(() => s.sync()), 'btn ghost'));
    }
    // photos
    if (c.has('images')) {
      p.append(el('h2', '', t('net.photos')));
      p.append(button(t('net.upload'), () => {
        on.redraw = null;
        showUpload(on, () => showAccount(on, back));
      }, 'btn ghost'));
    }
    if (me.admin) p.append(el('h2', '', t('net.admin')), button(t('net.adminOpen'), () => {
      on.redraw = null;
      showAdmin(on, () => showAccount(on, back));
    }, 'btn ghost'));
    const bye = el('div', 'buttons');
    bye.append(
      button(t('net.signOut'), () => {
        if (!confirm(t('net.signOutAsk'))) return;
        fresh = '';
        c.signOut();
        draw();
      }, 'btn ghost'),
      button(t('net.deleteMe'), () => {
        if (!confirm(t('net.deleteMeAsk'))) return;
        fresh = '';
        act(() => c.deleteMe());
      }, 'btn ghost warn'),
    );
    p.append(bye);
  };
  on.redraw = () => {
    if (!busy) draw();
  };
  draw();
}

// ------------------------------------------------------------------ admin

export function showAdmin(on: Online, back: () => void): void {
  const t: T = (k, p) => tr(k, on.host.settings.lang, p);
  const c = on.client;
  let accounts: AdminAccount[] = [];
  let settings: AdminSettings | null = null;
  let sessions: Awaited<ReturnType<typeof c.adminSessions>> = [];
  let note = '';
  let made = '';
  /** the account whose tokens are shown, and they */
  let open = '';
  let openTokens: TokenInfo[] = [];
  const load = async (): Promise<void> => {
    try {
      [accounts, settings] = await Promise.all([c.adminAccounts(), c.adminSettings()]);
      // (the running sessions: server 1.0.0 – an older one has none to list)
      sessions = await c.adminSessions().catch(() => []);
      openTokens = open ? await c.adminTokens(open).catch(() => []) : [];
      note = '';
    } catch (e) {
      note = errorText(t, e);
    }
    draw();
  };
  const act = (job: () => Promise<void>): void => {
    job()
      .then(load)
      .catch((e: unknown) => {
        note = errorText(t, e);
        draw();
      });
  };
  const draw = (): void => {
    const { o, p } = frame(t('net.admin'), t, back);
    if (note) p.append(el('p', 'note warn', note));
    if (made) {
      const box = el('div', 'net-secret');
      const link = gameLink(c.url, { tk: made });
      box.append(el('code', '', made), button(t('net.copyToken'), () => void copy(made), 'btn ghost small'), button(t('net.copyLink'), () => void copy(link), 'btn ghost small'));
      p.append(box, el('p', 'note warn', t('net.tokenSecret')));
    }
    // the server's settings
    if (settings) {
      const s = settings;
      p.append(el('h2', '', t('net.adminSettings')));
      const reg = el('input');
      reg.type = 'checkbox';
      reg.checked = s.registration;
      const l = el('label', '', t('net.adminRegistration'));
      l.style.flex = '1';
      p.append(row('', reg, l));
      const gst = el('input');
      gst.type = 'checkbox';
      gst.checked = s.guests;
      const gl = el('label', '', t('net.adminGuests'));
      gl.style.flex = '1';
      p.append(row('', gst, gl));
      const motd = el('textarea', 'net-input');
      motd.rows = 2;
      motd.maxLength = 500;
      motd.value = s.motd;
      p.append(row(t('net.adminMotd'), motd));
      const origins = el('textarea', 'net-input');
      origins.rows = 3;
      origins.value = s.origins.join('\n');
      p.append(row(t('net.adminOrigins'), origins), el('p', 'note', t('net.adminOriginsNote')));
      p.append(
        button(t('net.save'), () => {
          const list = origins.value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
          if (list.some((x) => !/^https?:\/\/[^\s/]+$/.test(x))) {
            note = t('net.errOrigins');
            draw();
            return;
          }
          act(() => c.adminSetSettings({ registration: reg.checked, guests: gst.checked, motd: motd.value.trim(), origins: list }));
        }),
      );
    }
    // a new account
    p.append(el('h2', '', t('net.adminNew')));
    const nm = input('', t('net.namePlaceholder'));
    nm.maxLength = 40;
    const tk = input('', t('net.adminCustomToken'));
    const adm = el('input');
    adm.type = 'checkbox';
    const al = el('label', '', t('net.adminIsAdmin'));
    al.style.flex = '1';
    p.append(row(t('net.name'), nm), row(t('net.token'), tk), row('', adm, al));
    p.append(
      button(t('net.adminCreate'), () => {
        if (!nm.value.trim()) {
          note = t('net.errName');
          draw();
          return;
        }
        if (tk.value.trim() && !validToken(tk.value.trim())) {
          note = t('net.errBadToken');
          draw();
          return;
        }
        act(async () => {
          const r = await c.adminCreate(nm.value, tk.value.trim() || undefined, adm.checked);
          made = r.token || tk.value.trim();
        });
      }),
    );
    // the accounts
    p.append(el('h2', '', t('net.adminAccounts', { n: accounts.length })));
    const list = el('div', 'net-list');
    for (const a of accounts) {
      const r = el('div', 'net-item');
      const who = el('div', 'net-who');
      who.append(el('b', '', a.name || a.id), el('small', '', `${a.admin ? `${t('net.adminBadge')} · ` : ''}${a.disabled ? `${t('net.adminDisabled')} · ` : ''}${a.created.slice(0, 10)}${a.tokens !== undefined ? ` · ${t('net.adminTokens', { n: a.tokens })}` : ''}`));
      const acts = el('div', 'net-acts');
      const self = a.id === c.me?.id;
      acts.append(
        button(t('net.adminRename'), () => {
          const n = prompt(t('net.name'), a.name);
          if (n && n.trim()) act(() => c.adminPatch(a.id, { name: n.trim() }));
        }, 'btn ghost small'),
        button(t('net.adminToken'), () => {
          const custom = prompt(t('net.adminTokenAsk'), '');
          if (custom === null) return;
          if (custom.trim() && !validToken(custom.trim())) {
            note = t('net.errBadToken');
            draw();
            return;
          }
          act(async () => {
            made = (await c.adminToken(a.id, custom.trim() || undefined)) || custom.trim();
          });
        }, 'btn ghost small'),
      );
      acts.append(
        button(t(open === a.id ? 'net.adminHideTokens' : 'net.adminShowTokens'), () => {
          open = open === a.id ? '' : a.id;
          void load();
        }, 'btn ghost small'),
      );
      if (!self) {
        acts.append(
          button(t(a.admin ? 'net.adminUnmake' : 'net.adminMake'), () => act(() => c.adminPatch(a.id, { admin: !a.admin })), 'btn ghost small'),
          button(t(a.disabled ? 'net.adminEnable' : 'net.adminDisable'), () => act(() => c.adminPatch(a.id, { disabled: !a.disabled })), 'btn ghost small'),
          button(t('net.adminDelete'), () => {
            if (confirm(t('net.adminDeleteAsk', { name: a.name || a.id }))) act(() => c.adminDelete(a.id));
          }, 'btn ghost small warn'),
        );
      }
      r.append(who, acts);
      list.append(r);
      if (open === a.id) {
        const tl = el('div', 'net-list net-sub');
        for (const k of openTokens) {
          const line = el('div', 'net-item');
          line.append(el('span', '', `${k.prefix}…${k.created ? ` · ${k.created.slice(0, 10)}` : ''}${k.lastUsed ? ` · ${t('net.lastUsed', { date: k.lastUsed.slice(0, 10) })}` : ''}`));
          line.append(button(t('net.revoke'), () => act(() => c.adminRevoke(a.id, k.prefix)), 'btn ghost small'));
          tl.append(line);
        }
        if (openTokens.length === 0) tl.append(el('p', 'note', '–'));
        list.append(tl);
      }
    }
    p.append(list);
    // the sessions running
    if (sessions.length > 0) {
      p.append(el('h2', '', t('net.adminSessions')));
      const sl = el('div', 'net-list');
      for (const s of sessions) {
        const r = el('div', 'net-item');
        r.append(el('span', '', `${s.code}${s.title ? ` · ${s.title}` : ''} · ${s.host || '–'} · ${s.playerList.length > 0 ? s.playerList.join(', ') : s.players}`));
        r.append(button(t('net.adminEnd'), () => {
          if (confirm(t('net.adminEndAsk', { code: s.code }))) act(() => c.adminEndSession(s.code));
        }, 'btn ghost small warn'));
        sl.append(r);
      }
      p.append(sl);
    }
    const b = el('div', 'buttons');
    b.append(button(t('net.refresh'), () => void load(), 'btn ghost'), button(t('back'), back));
    p.append(b);
    on.host.show(o);
  };
  draw();
  void load();
}

// ------------------------------------------------------------------ play together

export function showTogether(on: Online, back: () => void, openAccount: () => void): void {
  const t: T = (k, p) => tr(k, on.host.settings.lang, p);
  const c = on.client;
  const done = (): void => {
    on.redraw = null;
    on.onChat = null;
    back();
  };
  let note = '';
  let sessions: SessionInfo[] | null = null;
  let typed = on.joinCode ?? '';
  let chatDraft = '';
  let guest = '';
  const join = async (code: string): Promise<void> => {
    note = '';
    try {
      const s = await getSession(c, code);
      if (!s) throw new ServerError(404, 'not_found', '');
      if (!c.signedIn && !guest.trim()) {
        note = t('net.guestName');
        draw();
        return;
      }
      on.join(s.code, guest.trim());
    } catch (e) {
      note = errorText(t, e);
    }
    draw();
  };
  const draw = (): void => {
    const { o, p } = frame(t('net.together'), t, done);
    const ses = on.session;
    if (!c.url || c.status !== 'online' || !c.has('multiplayer')) {
      p.append(el('p', 'note', t(!c.url ? 'net.togetherNoServer' : c.status !== 'online' ? 'net.statusOffline' : 'net.togetherNotOffered')));
      p.append(button(t('net.account'), () => {
        on.redraw = null;
        openAccount();
      }, 'btn ghost'));
    } else if (ses) {
      // in a session: its code and link, the players, the chat
      const link = gameLink(c.url, { join: ses.code });
      const code = el('div', 'net-code', ses.code);
      p.append(el('p', 'note', t(ses.open ? 'net.sessionCode' : 'net.connecting')), code);
      const share = el('div', 'buttons');
      share.append(button(t('net.copyLink'), () => void copy(link), 'btn ghost small'));
      if (typeof navigator.share === 'function') share.append(button(t('net.share'), () => void navigator.share({ title: 'Fahrsim Baunatal', text: t('net.shareText', { code: ses.code }), url: link }).catch(() => {}), 'btn ghost small'));
      p.append(share);
      p.append(el('h2', '', t('net.players', { n: ses.players.size + 1 })));
      const list = el('div', 'net-list');
      const me = el('div', 'net-item');
      me.append(el('span', '', `${c.me?.name || guest || t('net.you')} (${t('net.you')})${ses.amHost ? ' ★' : ''}`));
      list.append(me);
      for (const pl of on.others()) {
        const r = el('div', 'net-item');
        r.append(el('span', '', `${pl.name}${pl.host ? ' ★' : ''}`));
        const acts = el('div', 'net-acts');
        if (pl.at) {
          const at = pl.at;
          acts.append(button(t('net.goTo'), () => {
            if (!on.host.goNear(at.x, at.z)) {
              note = t('net.goToNot');
              draw();
            }
          }, 'btn ghost small'));
        }
        if (ses.amHost) acts.append(button(t('net.kick'), () => {
          if (confirm(t('net.kickAsk', { name: pl.name }))) ses.kick(pl.id);
        }, 'btn ghost small warn'));
        r.append(acts);
        list.append(r);
      }
      p.append(list);
      // the chat
      p.append(el('h2', '', t('net.chat')));
      const log = el('div', 'net-chat');
      for (const l of ses.chat.slice(-30)) {
        const line = el('div', l.system ? 'sys' : '');
        if (l.system) line.textContent = t(l.text === 'join' ? 'net.joined' : l.text === 'leave' ? 'net.left' : 'net.newHost', { name: l.name || ses.players.get(l.id)?.name || '' });
        else {
          line.append(el('b', '', `${l.id === ses.you ? t('net.you') : l.name}: `), document.createTextNode(l.text));
        }
        log.append(line);
      }
      p.append(log);
      const msg = input(chatDraft, t('net.chatPlaceholder'));
      msg.maxLength = 300;
      msg.oninput = () => (chatDraft = msg.value);
      const send = (): void => {
        if (ses.chatSend(msg.value)) chatDraft = '';
        draw();
      };
      msg.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') send();
      };
      p.append(row('', msg, button(t('net.send'), send)));
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
      p.append(el('p', 'note', t('net.togetherNote')));
      p.append(button(t('net.leave'), () => {
        on.leave();
        draw();
      }, 'btn ghost warn'));
    } else {
      p.append(el('p', 'note', t('net.togetherNote')));
      if (!c.signedIn && c.info?.guests === false) p.append(el('p', 'note', t('net.noGuests')));
      else if (!c.signedIn) {
        p.append(el('p', 'note', t('net.togetherGuest')));
        const g = input(guest, t('net.namePlaceholder'));
        g.maxLength = 40;
        g.oninput = () => (guest = g.value);
        p.append(row(t('net.name'), g));
      }
      // host
      if (c.signedIn) {
        p.append(el('h2', '', t('net.host')));
        const title = input('', t('net.sessionTitle'));
        title.maxLength = 60;
        const pub = el('input');
        pub.type = 'checkbox';
        const pl = el('label', '', t('net.sessionPublic'));
        pl.style.flex = '1';
        const gst = el('input');
        gst.type = 'checkbox';
        const gl = el('label', '', t('net.sessionGuests'));
        gl.style.flex = '1';
        p.append(row(t('net.sessionTitleLabel'), title), row('', pub, pl));
        if (c.info?.guests !== false) p.append(row('', gst, gl));
        p.append(
          button(t('net.hostGo'), async () => {
            const at = on.host.where() ?? { x: 0, z: 0 };
            try {
              const s = await createSession(c, { title: title.value.trim() || undefined, map: on.host.mapStamp(), x: at.x, z: at.z, public: pub.checked, guests: gst.checked });
              on.join(s.code);
            } catch (e) {
              note = errorText(t, e);
            }
            draw();
          }),
        );
      }
      // join by code or link
      p.append(el('h2', '', t('net.join')));
      const code = input(typed, t('net.codePlaceholder'));
      code.oninput = () => (typed = code.value);
      code.autocapitalize = 'characters';
      p.append(
        row(
          '',
          code,
          button(t('net.joinGo'), () => {
            const k = sessionCode(code.value);
            if (!k) {
              note = t('net.errCode');
              draw();
              return;
            }
            void join(k);
          }),
        ),
      );
      // the public sessions
      p.append(el('h2', '', t('net.sessions')));
      if (sessions === null) p.append(el('p', 'note', t('net.loading')));
      else if (sessions.length === 0) p.append(el('p', 'note', t('net.noSessions')));
      else {
        const list = el('div', 'net-list');
        for (const s of sessions) {
          const r = el('div', 'net-item');
          r.append(el('span', '', `${s.title || s.code}${s.players !== undefined ? ` · ${s.players}${s.maxPlayers ? `/${s.maxPlayers}` : ''}` : ''}`));
          r.append(button(t('net.joinGo'), () => void join(s.code), 'btn ghost small'));
          list.append(r);
        }
        p.append(list);
      }
      p.append(button(t('net.refresh'), () => {
        sessions = null;
        draw();
        void refresh();
      }, 'btn ghost small'));
    }
    if (note) p.append(el('p', 'note warn', note));
    const b = el('div', 'buttons');
    b.append(button(t('back'), done));
    p.append(b);
    on.host.show(o);
  };
  const refresh = async (): Promise<void> => {
    try {
      sessions = await listSessions(c);
    } catch (e) {
      sessions = [];
      note = errorText(t, e);
    }
    if (on.redraw === redraw) draw();
  };
  // (redrawn on changes – but not under the player's fingers while typing)
  const redraw = (): void => {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return;
    draw();
  };
  on.redraw = redraw;
  draw();
  if (c.has('multiplayer') && !on.session) void refresh();
}

// ------------------------------------------------------------------ uploading a picture

export function showUpload(on: Online, back: () => void): void {
  const t: T = (k, p) => tr(k, on.host.settings.lang, p);
  const c = on.client;
  const state: {
    file: File | null;
    thumb: Blob | null;
    thumbUrl: string;
    size: { width: number; height: number };
    kind: ImageKind;
    lat: number;
    lon: number;
    from: 'exif' | 'game' | 'map' | '';
    heading: string;
    taken: string;
    title: string;
    visibility: 'private' | 'public';
    note: string;
    busy: boolean;
  } = { file: null, thumb: null, thumbUrl: '', size: { width: 0, height: 0 }, kind: 'photo', lat: NaN, lon: NaN, from: '', heading: '', taken: '', title: '', visibility: 'private', note: '', busy: false };
  const fromGame = (): void => {
    const w = on.host.where();
    if (!w) return;
    const [lat, lon] = worldToLatLon(w.x, w.z);
    state.lat = lat;
    state.lon = lon;
    state.from = 'game';
    // (yaw 0 = north, positive to the left; a compass counts clockwise)
    state.heading = String(Math.round(((((-w.yaw * 180) / Math.PI) % 360) + 360) % 360));
  };
  const leave = (): void => {
    if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
    back();
  };
  const pickFile = async (f: File): Promise<void> => {
    state.note = '';
    state.file = f;
    if (!IMAGE_TYPES.includes(f.type)) {
      state.note = t('net.imgBadType');
      draw();
      return;
    }
    state.busy = true;
    draw();
    const [meta, th] = await Promise.all([fileMeta(f), makeThumb(f, 384)]);
    if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
    state.thumb = th.thumb;
    state.thumbUrl = th.thumb ? URL.createObjectURL(th.thumb) : '';
    state.size = { width: th.width || meta.width, height: th.height || meta.height };
    state.kind = kindOf({ pano: meta.pano, width: state.size.width, height: state.size.height });
    if (Number.isFinite(meta.lat) && Number.isFinite(meta.lon)) {
      state.lat = meta.lat;
      state.lon = meta.lon;
      state.from = 'exif';
    } else if (!state.from) fromGame();
    if (Number.isFinite(meta.heading)) state.heading = String(Math.round(meta.heading));
    state.taken = Number.isFinite(meta.time) ? new Date(meta.time).toISOString() : '';
    if (!state.title) state.title = f.name.replace(/\.[^.]+$/, '').slice(0, 120);
    state.busy = false;
    draw();
  };
  const draw = (): void => {
    const { o, p } = frame(t('net.upload'), t, leave);
    p.append(el('p', 'note', t('net.uploadNote')));
    const file = el('input');
    file.type = 'file';
    file.accept = IMAGE_TYPES.join(',');
    file.className = 'net-file';
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) void pickFile(f);
    };
    p.append(row(t('net.file'), file));
    if (state.file) {
      if (state.thumbUrl) {
        const img = el('img', 'net-thumb');
        img.src = state.thumbUrl;
        img.alt = '';
        p.append(img);
      }
      p.append(el('p', 'note', `${state.file.name} · ${(state.file.size / 1048576).toFixed(1)} MB${state.size.width ? ` · ${state.size.width}×${state.size.height}` : ''}`));
      // photo or panorama
      const kind = el('select');
      for (const k of ['photo', 'pano360'] as const) {
        const op = el('option', '', t(k === 'photo' ? 'net.kindPhoto' : 'net.kindPano'));
        op.value = k;
        kind.append(op);
      }
      kind.value = state.kind;
      kind.onchange = () => {
        state.kind = kind.value as ImageKind;
        draw();
      };
      p.append(row(t('net.kind'), kind));
      // where
      const where = Number.isFinite(state.lat) ? `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)} (${t(`net.from.${state.from || 'game'}`)})` : t('net.noPlace');
      p.append(row(t('net.place'), el('span', '', where)));
      const places = el('div', 'buttons');
      if (on.host.where()) places.append(button(t('net.placeGame'), () => {
        fromGame();
        draw();
      }, 'btn ghost small'));
      places.append(button(t('net.placeMap'), () => {
        on.host.pickOnMap((x, z) => {
          const [lat, lon] = worldToLatLon(x, z);
          state.lat = lat;
          state.lon = lon;
          state.from = 'map';
          draw();
        });
      }, 'btn ghost small'));
      p.append(places);
      const hd = input(state.heading, '0 … 359', 'number');
      hd.min = '0';
      hd.max = '359';
      hd.oninput = () => (state.heading = hd.value);
      if (state.kind === 'photo') p.append(row(t('net.heading'), hd));
      const title = input(state.title, t('net.titlePlaceholder'));
      title.maxLength = 120;
      title.oninput = () => (state.title = title.value);
      p.append(row(t('net.title'), title));
      const vis = el('select');
      for (const v of ['private', 'public'] as const) {
        const op = el('option', '', t(v === 'private' ? 'net.private' : 'net.public'));
        op.value = v;
        vis.append(op);
      }
      vis.value = state.visibility;
      vis.onchange = () => (state.visibility = vis.value as 'private' | 'public');
      p.append(row(t('net.visibility'), vis), el('p', 'note', t('net.visibilityNote')));
      p.append(
        button(t(state.busy ? 'net.uploading' : 'net.uploadGo'), () => {
          if (state.busy || !state.file) return;
          const h = state.heading.trim() === '' ? NaN : Number(state.heading);
          if (state.heading.trim() !== '' && !(h >= 0 && h < 360)) {
            state.note = t('net.errHeading');
            draw();
            return;
          }
          const meta: UploadMeta = { lat: state.lat, lon: state.lon, kind: state.kind, visibility: state.visibility, title: state.title.trim() || undefined, taken: state.taken || undefined, heading: state.kind === 'photo' && Number.isFinite(h) ? h : undefined };
          const bad = checkUpload(state.file, meta, c.info?.limits.imageBytes ?? 0, state.size);
          if (bad) {
            state.note = t(bad, { mb: Math.round((c.info?.limits.imageBytes ?? 0) / 1048576) });
            draw();
            return;
          }
          if (state.kind === 'pano360' && !c.has('images360')) {
            state.note = t('net.noPanos');
            draw();
            return;
          }
          state.busy = true;
          state.note = '';
          draw();
          uploadImage(c, state.file, meta, state.thumb)
            .then((img) => {
              if (img) on.images.add(img);
              state.file = null;
              state.title = '';
              state.note = t('net.uploaded');
            })
            .catch((e: unknown) => (state.note = errorText(t, e)))
            .finally(() => {
              state.busy = false;
              draw();
            });
        }),
      );
    }
    if (state.note) p.append(el('p', `note${state.note === t('net.uploaded') ? '' : ' warn'}`, state.note));
    const b = el('div', 'buttons');
    b.append(button(t('back'), leave));
    p.append(b);
    on.host.show(o);
  };
  draw();
}

// ------------------------------------------------------------------ the viewer

/** A picture of the server in its viewer (over the game); `back`: what was there before. */
export function showImage(on: Online, img: ServerImage, back: () => void, layer: HTMLElement): void {
  const t: T = (k, p) => tr(k, on.host.settings.lang, p);
  const c = on.client;
  const mine = !!c.me && (c.me.id === img.owner || c.me.admin);
  void on.urls.url(img, 'file').then(
    (url) => {
      const when = img.taken ? new Intl.DateTimeFormat(localeOf(on.host.settings.lang), { dateStyle: 'medium' }).format(new Date(img.taken)) : '';
      const v = photoViewer({
        url,
        pano: img.kind === 'pano360',
        heading: img.heading,
        caption: [img.title, img.ownerName ? t('net.photoBy', { name: img.ownerName }) : '', when, img.visibility === 'private' ? t('net.private') : ''].filter(Boolean).join(' · '),
        closeLabel: t('back'),
        gyroLabel: t('net.gyro'),
        deleteLabel: t('net.deleteImage'),
        onDelete: mine
          ? () => {
              if (!confirm(t('net.deleteImageAsk'))) return;
              deleteImage(c, img.id)
                .then(() => {
                  on.images.remove(img.id);
                  on.urls.forget(img.id);
                  v.close();
                  back();
                })
                .catch((e: unknown) => alert(errorText(t, e)));
            }
          : null,
        onClose: back,
      });
      layer.append(v.node);
    },
    (e: unknown) => alert(errorText(t, e)),
  );
}

/** for the tests and the map: the world place of a picture */
export function imagePlace(img: ServerImage): [number, number] {
  return latLonToWorld(img.lat, img.lon);
}
