/** Separate writer against an owned synthetic SQLite fixture only. */
import {DatabaseSync} from 'node:sqlite';
const [file, shotId, projectId, corrupt] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
const shot = JSON.parse(db.prepare('SELECT data FROM shots WHERE id=?').get(shotId).data);
const data = corrupt === 'yes' ? '{' : JSON.stringify({...shot, projectId, title: 'FOREIGN_SCOPE_SECRET'});
db.prepare('UPDATE shots SET projectId=?,data=? WHERE id=?').run(projectId, data, shotId);
process.send({type: 'locked'});
// The caller begins the scoped mutation while this transaction owns the lock.
setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 120);
