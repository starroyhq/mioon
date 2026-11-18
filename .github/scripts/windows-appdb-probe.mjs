// Temporary W0 diagnostic: reproduce the backend app-library open path under
// plain Node on the Windows runner and report the fixed storage reason.
import path from 'node:path';
import os from 'node:os';
import {realpathSync} from 'node:fs';
const storage = await import('../../packages/contracts/src/private-storage.ts');
const {initializeNodePrivateStorage} = await import('../../packages/node-host/src/private-storage-bootstrap.ts');
const {openAppDatabase} = await import('../../packages/business/src/app-db/connection.ts');
await initializeNodePrivateStorage();
const report = [];
const describe = error => ({ok: false, code: typeof error?.code === 'string' ? error.code : null,
  reason: typeof error?.reason === 'string' ? error.reason : null,
  name: typeof error?.name === 'string' ? error.name : null,
  message: typeof error?.message === 'string' ? error.message.slice(0, 240) : null});
const run = async (label, work) => {
  try {report.push({label, ok: true, ...(await work() ?? {})});}
  catch (error) {report.push({label, ...describe(error)});}
};
const envBase = String(process.env.LOCALAPPDATA ?? os.tmpdir());
for (const [variant, base] of [['env', envBase], ['realpath', realpathSync(envBase)]]) {
  const userData = path.join(base, `mioon-appdb-probe-${process.pid}-${variant}`);
  await run(`${variant}-user-data`, () => storage.ensurePrivateDirectory(userData, {create: true}));
  const dataDir = path.join(userData, 'data');
  await run(`${variant}-data-dir`, () => storage.ensurePrivateDirectory(dataDir, {create: true}));
  await run(`${variant}-app-database`, () => {
    const db = openAppDatabase(dataDir);
    const result = {database: 'app-library.db', open: !db.closed};
    db.close();
    return result;
  });
}
await run('environment', () => ({localappdata: envBase, temp: process.env.TEMP ?? null, username: process.env.USERNAME ?? null}));
console.log(JSON.stringify({platform: process.platform, node: process.versions.node, report}, null, 2));
