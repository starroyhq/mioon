// Temporary W0 diagnostic: reproduce the backend app-library open path under
// plain Node on the Windows runner and report the fixed storage reason plus
// the owning SIDs/ACLs that the native validator checks.
import path from 'node:path';
import os from 'node:os';
import {openSync, closeSync, constants, lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
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
const powershell = (script) => {
  try {return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', timeout: 30000}).trim();}
  catch (error) {return `PS_ERROR:${String(error?.status ?? '')}`;}
};
const acl = target => powershell(`$item = Get-Item -LiteralPath '${target}'; $acl = Get-Acl -LiteralPath '${target}'; [pscustomobject]@{owner=$acl.Owner; sddl=$acl.Sddl; aces=@($acl.Access | ForEach-Object { "$($_.IdentityReference) $($_.AccessControlType) $($_.FileSystemRights) inherit=$($_.IsInherited)" })} | ConvertTo-Json -Compress -Depth 4`);
const sid = () => powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
const base = String(process.env.LOCALAPPDATA ?? os.tmpdir());
const userData = path.join(base, `mioon-appdb-probe-${process.pid}`);
await run('user-data', () => storage.ensurePrivateDirectory(userData, {create: true}));
const dataDir = path.join(userData, 'data');
await run('data-dir', () => storage.ensurePrivateDirectory(dataDir, {create: true}));
const dbFile = path.join(dataDir, 'app-library.db');
await run('validate-missing', () => storage.validateManagedFile(dbFile, {root: dataDir, allowMissing: true}));
await run('create-empty-by-node', () => {
  closeSync(openSync(dbFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600));
  return {size: lstatSync(dbFile).size};
});
await run('validate-created-node-file', () => storage.validateManagedFile(dbFile, {root: dataDir, allowMissing: true}));
await run('validate-dir-root', () => storage.validatePrivateDirectory(dataDir));
await run('open-app-database', () => {
  const db = openAppDatabase(dataDir);
  const result = {database: 'app-library.db', open: !db.closed};
  db.close();
  return result;
});
await run('facts', () => ({sid: sid(), dataDir: acl(dataDir), dbFile: acl(dbFile), userData: acl(userData)}));
console.log(JSON.stringify({platform: process.platform, node: process.versions.node, report}, null, 2));
