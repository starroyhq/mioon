/** Read-only audit of the isolated native chat fixture. Never prints keys/tokens. */
import {DatabaseSync} from 'node:sqlite';
import {readFile, writeFile, readdir, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root = path.resolve(process.argv.includes('--responses') ? 'evidence/agent-responses/native-runtime' : 'evidence/agent-chat/native-runtime'), userData = path.join(root, 'user-data');
const db = new DatabaseSync(path.join(userData, 'workspace/workbench.sqlite'), {readOnly: true}); let domainHash;
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='workspace_preferences' ORDER BY name").all().map(row => row.name);
  const records = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  domainHash = createHash('sha256').update(JSON.stringify(records)).digest('hex');
} finally { db.close(); }
let connection = null;
try { const value = JSON.parse(await readFile(path.join(userData, 'mcp-connection.json'), 'utf8')); connection = {utilityPid: value.pid, origin: value.url}; } catch {}
const settingsFiles = [], directory = path.join(userData, 'agent-settings');
let entries = []; try { entries = await readdir(directory, {withFileTypes: true}); } catch {}
for (const entry of entries) if (entry.isFile()) {
  const file = path.join(directory, entry.name), bytes = await readFile(file), info = await stat(file);
  settingsFiles.push({name: entry.name, bytes: bytes.length, mode: (info.mode & 0o777).toString(8), plaintextDummyKeyPresent: bytes.includes(Buffer.from('mioon-qa-dummy-chat-key-')), chatTextPresent: bytes.includes(Buffer.from('mock:slow'))});
}
let mock = []; try { mock = (await readFile(path.join(root, 'mock/mock-requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
const report = {at: new Date().toISOString(), domainHash, connection, settingsFiles, mock};
const name = process.argv.slice(2).find(value => value !== '--responses') || 'snapshot'; if (!/^[a-z0-9-]+$/.test(name)) throw Error('Unsafe audit name');
await writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
