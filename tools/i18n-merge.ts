// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Brings a language file into the shape of the English reference:
 *
 *   node tools/i18n-merge.ts fr                      # same keys, order and comments as en.ts
 *   node tools/i18n-merge.ts fr new-texts.json       # … and take over the texts of a JSON file { "key": "text" }
 *   node tools/i18n-merge.ts --missing fr            # print what is missing or was changed, as JSON for a translator
 *
 * After texts were added to en.ts (and de.ts), a translator gets the output
 * of --missing, returns a JSON file with the translations, and the merge
 * writes src/i18n/<code>.ts: entries in the order of en.ts under its section
 * comments, texts from the JSON file where it has one, the existing text
 * otherwise.  Keys that en.ts no longer has are dropped.  Run
 * tools/i18n-check.ts afterwards.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = new URL('../src/i18n/', import.meta.url);
const load = async (code: string): Promise<Record<string, string>> => ((await import(pathToFileURL(fileURLToPath(new URL(`${code}.ts`, dir))).href)) as { default: Record<string, string> }).default;

const args = process.argv.slice(2);
const missingOnly = args[0] === '--missing';
if (missingOnly) args.shift();
const [code, jsonPath] = args;
if (!code || code === 'en') {
  console.error('usage: node tools/i18n-merge.ts [--missing] <language code> [translations.json]');
  process.exit(2);
}

const enText = readFileSync(new URL('en.ts', dir), 'utf8');
const en = await load('en');
const have = await load(code);
const fresh: Record<string, string> = jsonPath ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string>) : {};

if (missingOnly) {
  const out: Record<string, string> = {};
  for (const k of Object.keys(en)) if (!(k in have)) out[k] = en[k];
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const unknown = Object.keys(fresh).filter((k) => !(k in en));
if (unknown.length) console.warn(`${code}: not keys of en.ts, ignored: ${unknown.join(', ')}`);

// the head of the language's own file (licence line, its name) …
const own = readFileSync(new URL(`${code}.ts`, dir), 'utf8');
const head = own.slice(0, own.indexOf('const dict'));
// … and the body in the shape of en.ts
const body: string[] = [];
const missing: string[] = [];
let inside = false;
for (const line of enText.split('\n')) {
  if (line.startsWith('const dict')) {
    inside = true;
    body.push(line);
    continue;
  }
  if (!inside) continue;
  const m = /^  ("(?:[^"\\]|\\.)*"): /.exec(line);
  if (!m) {
    body.push(line);
    continue;
  }
  const key = JSON.parse(m[1]) as string;
  const text = fresh[key] ?? have[key];
  if (text === undefined) {
    missing.push(key);
    continue;
  }
  body.push(`  ${JSON.stringify(key)}: ${JSON.stringify(text)},`);
}
writeFileSync(new URL(`${code}.ts`, dir), head + body.join('\n'));
const taken = Object.keys(fresh).filter((k) => k in en).length;
console.log(`${code}: ${Object.keys(en).length - missing.length} of ${Object.keys(en).length} texts (${taken} taken over)${missing.length ? ` – missing: ${missing.join(', ')}` : ''}`);
process.exit(missing.length ? 1 : 0);
