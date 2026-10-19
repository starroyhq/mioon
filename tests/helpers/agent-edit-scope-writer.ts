/** Separate writer against an owned synthetic SQLite fixture only. */
import {DatabaseSync} from 'node:sqlite';
const [file, shotId, projectId, corrupt] = process.argv.slice(2);
if (!file || !shotId || !projectId) throw new Error('Usage: agent-edit-scope-writer <db> <shotId> <projectId> [corrupt]');
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
const existing = db.prepare('SELECT data FROM shots WHERE id=?').get(shotId);
if (!existing) throw new Error('Missing synthetic shot');
const shot = JSON.parse(String(existing.data));
const data = corrupt === 'yes' ? '{' : JSON.stringify({...shot, projectId, title: 'FOREIGN_SCOPE_SECRET'});
db.prepare('UPDATE shots SET projectId=?,data=? WHERE id=?').run(projectId, data, shotId);
process.send?.({type: 'locked'});
// The caller begins the scoped mutation while this transaction owns the lock.
setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 120);
