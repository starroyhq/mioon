import {writeSync} from 'node:fs';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {open, facade} from './workspace-schema26-fixtures.mjs';
const [filename, stopAt] = process.argv.slice(2), db = open(filename);
db.exec('PRAGMA journal_mode=WAL; PRAGMA cache_size=5');
initializeWorkspaceSchema26(facade(db, item => {
  if (item.phase !== 'after' || item.index !== Number(stopAt)) return;
  writeSync(1, JSON.stringify({...item, transaction:db.isTransaction, journal:db.prepare('PRAGMA journal_mode').get().journal_mode}) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}));
throw new Error('requested kill boundary was not reached');
