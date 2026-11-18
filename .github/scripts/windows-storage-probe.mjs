// Temporary W0 diagnostic: report the fixed reason/error code for Windows
// private-storage failures on the exact runner paths the desktop smoke uses.
import path from 'node:path';
import {tmpdir} from 'node:os';
const storage = await import('../../packages/contracts/src/private-storage.ts');
const {initializeNodePrivateStorage} = await import('../../packages/node-host/src/private-storage-bootstrap.ts');
await initializeNodePrivateStorage();
const report = [];
const describe = error => ({ok: false, code: typeof error?.code === 'string' ? error.code : null,
  reason: typeof error?.reason === 'string' ? error.reason : null});
function attempt(label, directory, options = {create: true}) {
  try {
    const info = storage.ensurePrivateDirectory(directory, options);
    report.push({label, ok: true, identity: storage.privateStorageIdentity(info ?? undefined) ?? null});
  } catch (error) {
    report.push({label, ...describe(error)});
  }
}
const unique = `${process.pid}-${Date.now()}`;
attempt('runner-temp-user-data', path.join(String(process.env.RUNNER_TEMP ?? tmpdir()), `mioon-probe-${unique}`, 'user-data'));
attempt('runner-temp-user-data-validate-only', path.join(String(process.env.RUNNER_TEMP ?? tmpdir()), `mioon-probe-${unique}`, 'probe-missing'), {create: false, allowMissing: true});
attempt('tmpdir-user-data', path.join(tmpdir(), `mioon-probe-${unique}`, 'user-data'));
attempt('localappdata-user-data', path.join(String(process.env.LOCALAPPDATA ?? tmpdir()), `mioon-probe-${unique}`, 'user-data'));
try {
  const directory = storage.createPrivateTemporaryDirectory(tmpdir(), 'mioon-probe-');
  report.push({label: 'native-temporary', ok: true, identity: storage.privateStorageIdentity(storage.validatePrivateDirectory(directory) ?? undefined) ?? null});
} catch (error) {report.push({label: 'native-temporary', ...describe(error)});}
console.log(JSON.stringify({platform: process.platform, node: process.versions.node, user: process.env.USERNAME ?? null,
  runnerTemp: Boolean(process.env.RUNNER_TEMP), report}, null, 2));
