import { resolve } from 'node:path';
import { createApi } from './api.ts';
import { createAuth } from './auth.ts';
import { connectDatabase, openDatabase } from './database.ts';
import { createProbe } from './probe.ts';
import { createScheduler } from './scheduler.ts';
import { authSettings, databasePath, numberSetting } from './settings.ts';
import { openStore } from './store.ts';

const port = numberSetting('PORT', 3001, 1, 65535);
const intervalMs = numberSetting('CHECK_INTERVAL_MS', 300000, 5000, 86400000);
const timeoutMs = numberSetting('CHECK_TIMEOUT_MS', 8000, 100, 30000);
const monitorLimit = numberSetting('MONITORS_PER_ACCOUNT', 10, 1, 100);
const built = process.argv.includes('--built');
const databaseFile = databasePath();
const settings = authSettings(databaseFile, `http://127.0.0.1:${built ? port : 5173}`);
if (settings.secureCookies && !built) throw new Error('A origem pública requer npm run build e npm start.');

const database = openDatabase(databaseFile);
// Better Auth owns its SQLite connection so its transactions stay separate from scheduler writes.
const authDb = databaseFile === ':memory:' ? database : connectDatabase(databaseFile);
const auth = createAuth(authDb, settings);
const store = openStore(database);
const scheduler = createScheduler(store, createProbe({ timeoutMs }), intervalMs);
const server = createApi({
  store, scheduler, intervalMs, auth, monitorLimit, ...settings,
  webRoot: built ? resolve('dist', 'web') : undefined,
});

server.listen(port, '127.0.0.1', () => {
  scheduler.start();
  console.log(`PulseWatch ${built ? '' : 'API '}em http://127.0.0.1:${port}`);
});

function close() {
  server.close(() => {
    void scheduler.stop().finally(() => {
      if (authDb !== database) authDb.close();
      database.close();
    });
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
