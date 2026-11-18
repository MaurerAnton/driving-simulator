// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Starts the server: `node src/main.ts` (configuration by environment
 * variables, see config.ts and the README).  Stops cleanly on SIGINT and
 * SIGTERM: players get `bye` "server_stopping", the database is closed.
 */

import { createApp, SERVER_VERSION } from './app.ts';
import { loadConfig } from './config.ts';
import { countAdmins } from './db.ts';

const config = loadConfig();
const app = createApp(config);
const port = await app.listen();
console.log(`Fahrsim Baunatal server ${SERVER_VERSION} listening on ${config.host}:${port}, data in ${config.dataDir}`);
if (countAdmins(app.db) === 0) {
  console.log('No admin account yet – make one with: node src/cli.ts account create <name> --admin');
}

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: stopping`);
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
