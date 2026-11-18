// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The admin's command line: everything the admin endpoints do, working on
 * the database directly (also while the server runs).  Uses the same
 * configuration (FAHRSIM_DATA, FAHRSIM_PEPPER) as the server – with another
 * pepper the tokens it makes would not work.
 *
 *   node src/cli.ts help
 *
 * Tokens are printed once, when they are made; they cannot be shown again.
 */

import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import {
  type Db, countAdmins, deleteAccount, deleteImageRow, endSession, findAccount, getImage, getSettings, listAccounts,
  listTokens, liveSessions, openDb, putSettings, queryImages, revokeTokens, updateAccount,
} from './db.ts';
import { ApiError } from './http.ts';
import {
  addToken, createAccount, parseImageMeta, removeImageFiles, removeImageFilesById, storeImage, validName,
  type ImageMetaIn,
} from './services.ts';

const HELP = `Fahrsim Baunatal server – admin commands

  account create <name> [--admin] [--token <custom>]   make an account, print its token
  account list                                         all accounts
  account show <id|name>                               an account and its tokens (prefixes)
  account token <id|name> [--token <custom>]           add a token (random or custom)
  account revoke <id|name> <prefix>                    revoke the token(s) starting with <prefix>
  account admin <id|name> on|off                       make / unmake an admin
  account disable <id|name> on|off                     disable / enable an account
  account rename <id|name> <new name>
  account delete <id|name>                             delete with its images and progress
  settings                                             show the settings
  settings registration on|off                         self-registration
  settings guests on|off                               guests in multiplayer sessions
  settings motd <text>                                 message of the day ("" for none)
  settings origins <origin,origin,…>                   allowed browser origins
  image import <file> --owner <id|name> --lat <lat> --lon <lon> [--kind photo|pano360]
               [--heading <deg>] [--pitch <deg>] [--title <text>] [--taken <iso>]
               [--visibility public|private] [--thumb <file>]
  image list [--owner <id|name>] [--limit <n>]
  image delete <id>
  sessions                                             running multiplayer sessions
  sessions end <code>                                  end one (players get "bye")

Configuration as for the server: FAHRSIM_DATA (data directory), FAHRSIM_PEPPER.`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Splits arguments into positional ones and --options (with a value, or flags). */
function parseArgs(argv: string[], flags: string[]): { pos: string[]; opt: Record<string, string> } {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (flags.includes(k)) opt[k] = 'true';
      else {
        if (i + 1 >= argv.length) fail(`--${k} needs a value`);
        opt[k] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

const onOff = (v: string | undefined): boolean => {
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  return fail('say on or off');
};

function account(db: Db, idOrName: string | undefined) {
  if (!idOrName) fail('which account? (id or exact name)');
  return findAccount(db, idOrName) ?? fail(`no account "${idOrName}" (or the name is not unique – use the id)`);
}

function run(argv: string[]): void {
  const config = loadConfig();
  const db = openDb(config.dataDir);
  const defaults = { registration: config.registration, motd: config.motd, origins: config.origins };
  const [group, cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest, ['admin']);
  switch (group) {
    case 'account': {
      switch (cmd) {
        case 'create': {
          const r = createAccount(db, config.pepper, pos[0], { admin: opt.admin === 'true', token: opt.token });
          console.log(`account ${r.account.id} "${r.account.name}"${r.account.admin ? ' (admin)' : ''}`);
          console.log(`token: ${r.token}`);
          return;
        }
        case 'list':
          for (const a of listAccounts(db)) {
            console.log(`${a.id}  ${a.name}${a.admin ? '  [admin]' : ''}${a.disabled ? '  [disabled]' : ''}  tokens: ${a.tokens}  created ${a.created}`);
          }
          return;
        case 'show': {
          const a = account(db, pos[0]);
          console.log(JSON.stringify({ ...a, tokens: listTokens(db, a.id) }, null, 2));
          return;
        }
        case 'token': {
          const a = account(db, pos[0]);
          console.log(`token: ${addToken(db, config.pepper, a.id, opt.token)}`);
          return;
        }
        case 'revoke': {
          const a = account(db, pos[0]);
          if (!pos[1]) fail('which token? give its first 6 characters');
          console.log(`revoked: ${revokeTokens(db, a.id, pos[1])}`);
          return;
        }
        case 'admin': {
          const a = account(db, pos[0]);
          const on = onOff(pos[1]);
          if (!on && a.admin && countAdmins(db) <= 1) console.warn('note: this was the last admin');
          updateAccount(db, a.id, { admin: on });
          console.log(`${a.name}: admin ${on ? 'on' : 'off'}`);
          return;
        }
        case 'disable': {
          const a = account(db, pos[0]);
          const on = onOff(pos[1]);
          updateAccount(db, a.id, { disabled: on });
          console.log(`${a.name}: ${on ? 'disabled' : 'enabled'}`);
          return;
        }
        case 'rename': {
          const a = account(db, pos[0]);
          const u = updateAccount(db, a.id, { name: validName(pos.slice(1).join(' ')) });
          console.log(`renamed to "${u?.name}"`);
          return;
        }
        case 'delete': {
          const a = account(db, pos[0]);
          removeImageFilesById(config.dataDir, deleteAccount(db, a.id) ?? []);
          console.log(`deleted ${a.id} "${a.name}"`);
          return;
        }
      }
      break;
    }
    case 'settings': {
      if (!cmd) {
        const s = getSettings(db, defaults);
        const g = db.prepare("SELECT value FROM settings WHERE key = 'guests'").get() as { value: string } | undefined;
        console.log(JSON.stringify({ ...s, guests: g ? JSON.parse(g.value) === true : true }, null, 2));
        return;
      }
      if (cmd === 'registration') { putSettings(db, { registration: onOff(pos[0]) }); return; }
      if (cmd === 'guests') {
        db.prepare("INSERT INTO settings (key, value) VALUES ('guests', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify(onOff(pos[0])));
        return;
      }
      if (cmd === 'motd') { putSettings(db, { motd: pos.join(' ').slice(0, 1000) }); return; }
      if (cmd === 'origins') {
        const list = pos.join(',').split(',').map((s) => s.trim()).filter(Boolean);
        for (const o of list) if (o !== '*' && !/^https?:\/\/[A-Za-z0-9.*-]+(:(\d{1,5}|\*))?$/.test(o)) fail(`not an origin: ${o}`);
        putSettings(db, { origins: list });
        return;
      }
      break;
    }
    case 'image': {
      if (cmd === 'import') {
        if (!pos[0]) fail('which file?');
        const owner = account(db, opt.owner);
        const meta = parseImageMeta({
          lat: Number(opt.lat), lon: Number(opt.lon), kind: opt.kind ?? 'photo',
          heading: opt.heading !== undefined ? Number(opt.heading) : undefined,
          pitch: opt.pitch !== undefined ? Number(opt.pitch) : undefined,
          title: opt.title, taken: opt.taken, visibility: opt.visibility ?? 'public',
        }, false) as ImageMetaIn;
        const file = readFileSync(pos[0]);
        if (file.length > config.imageBytes) fail(`the file is larger than ${config.imageBytes} bytes`);
        const thumb = opt.thumb ? readFileSync(opt.thumb) : null;
        const r = storeImage(db, config.dataDir, owner.id, meta, file, thumb);
        console.log(`image ${r.id} (${r.mime}, ${r.width}×${r.height}, ${r.bytes} bytes${r.thumb_mime ? ', with thumbnail' : ''})`);
        return;
      }
      if (cmd === 'list') {
        const owner = opt.owner ? account(db, opt.owner).id : undefined;
        for (const r of queryImages(db, { viewer: null, all: true, owner, limit: Number(opt.limit ?? 1000) })) {
          console.log(`${r.id}  ${r.kind}  ${r.visibility}  ${r.lat.toFixed(6)},${r.lon.toFixed(6)}  ${r.width}×${r.height}  owner ${r.owner}  ${r.title}`);
        }
        return;
      }
      if (cmd === 'delete') {
        const r = pos[0] ? getImage(db, pos[0]) : null;
        if (!r) fail('no such image');
        deleteImageRow(db, r.id);
        removeImageFiles(config.dataDir, r);
        console.log(`deleted image ${r.id}`);
        return;
      }
      break;
    }
    case 'sessions': {
      if (!cmd) {
        for (const s of liveSessions(db)) {
          console.log(`${s.code}  ${s.title || '(no title)'}  players ${s.players}/${s.max_players}  ${s.public ? 'public' : 'private'}  owner ${s.owner}  created ${s.created}`);
        }
        return;
      }
      if (cmd === 'end') {
        if (!pos[0] || !endSession(db, pos[0].toUpperCase())) fail('no such running session');
        console.log('ended (the server tells the players within a few seconds)');
        return;
      }
      break;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
  }
  fail(`unknown command\n\n${HELP}`);
}

try {
  run(process.argv.slice(2));
} catch (e) {
  if (e instanceof ApiError) fail(`${e.code}: ${e.message}`);
  throw e;
}
