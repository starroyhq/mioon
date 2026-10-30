// Another process for the project-file tests. MODE (env or argv[2]):
// - open-report: opens through the kernel, prints one JSON line
//   {ok:true, projectId, historyState, elapsedMs} or {ok:false, code, details, message, elapsedMs},
//   closes and exits 0;
// - open-hold: opens, prints `ready`, keeps the project open until SIGTERM;
// - raw-read: reads FILE with a plain read-only SQLite connection, prints
//   {ok:true} or {ok:false, message, errcode}.
// The project comes from ROOT (test layout) or PROJECT_FILE, LOCAL_DIR, CACHE_DIR, TEMP_DIR.
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {TEST_STORE_LAYOUT} from '../../packages/contracts/src/project-file.ts';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';
import type {OpenProjectConnectionOptions} from '../../packages/business/src/project-file/connection.ts';

const mode = process.env.MODE ?? process.argv[2];
const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

function openOptions(): OpenProjectConnectionOptions {
  const root = process.env.ROOT;
  if (root) {
    const location = {
      localDir: path.join(root, ...TEST_STORE_LAYOUT.localDir),
      cacheDir: path.join(root, ...TEST_STORE_LAYOUT.cacheDir),
      tempDir: path.join(root, ...TEST_STORE_LAYOUT.tempDir),
    };
    return {projectFile: path.join(root, ...TEST_STORE_LAYOUT.projectFile), locate: () => location};
  }
  const {PROJECT_FILE: projectFile, LOCAL_DIR: localDir, CACHE_DIR: cacheDir, TEMP_DIR: tempDir} = process.env;
  if (!projectFile || !localDir || !cacheDir || !tempDir) throw new Error('Set ROOT, or PROJECT_FILE, LOCAL_DIR, CACHE_DIR and TEMP_DIR');
  return {projectFile, locate: () => ({localDir, cacheDir, tempDir})};
}

if (mode === 'open-report') {
  const started = performance.now();
  try {
    const connection = openProjectConnection(openOptions());
    const elapsedMs = performance.now() - started;
    print({ok: true, projectId: connection.projectId, historyState: connection.historyState, elapsedMs});
    connection.close();
  } catch (error) {
    const {code, details, message} = error as {code?: unknown; details?: unknown; message?: unknown};
    print({ok: false, code, details, message, elapsedMs: performance.now() - started});
  }
} else if (mode === 'open-hold') {
  const connection = openProjectConnection(openOptions());
  process.once('SIGTERM', () => {
    connection.close();
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
  process.stdout.write('ready\n');
} else if (mode === 'raw-read') {
  const file = process.env.FILE;
  if (!file) throw new Error('Set FILE');
  try {
    const db = new DatabaseSync(file, {readOnly: true, timeout: 0});
    try {
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    } finally {
      db.close();
    }
    print({ok: true});
  } catch (error) {
    print({ok: false, message: (error as Error).message, errcode: (error as {errcode?: unknown}).errcode});
  }
} else {
  throw new Error(`Unknown MODE: ${String(mode)}`);
}
