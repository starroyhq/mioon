/** Own-cloud disposable acceptance runtime. No live endpoint is contacted.
 * Seed through the real worker with an injected Runway HTTP 409, then serve
 * its persisted state using the ordinary backend with all live providers off.
 */
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { startServer } from '../apps/server/src/index.ts';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { providerEnvironmentKeys } from '../packages/business/src/provider-registry.ts';
import { createRunwayUnknownFixture } from './helpers/runway-unknown-fixture.mjs';
const runtime = path.resolve('evidence/q1-runway-parity/runtime');
const dataDir = path.join(runtime, 'workspace'), fixtureFile = path.join(runtime, 'fixture.json');
await mkdir(runtime, { recursive: true });
for (const key of providerEnvironmentKeys) delete process.env[key];
process.env.MIOON_ENABLE_LIVE_PROVIDER = '0';
let fixture;
try { fixture = JSON.parse(await readFile(fixtureFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fixture = await createRunwayUnknownFixture(dataDir);
  await writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
}
const server = await startServer({ dataDir, port: 4891, token: 'q1-offline-local-synthetic-token', distDir: path.resolve('apps/web/dist') });
// Run HTTP checks in the same host network namespace as the backend. The CUA
// JavaScript kernel and command sandbox may have separate loopback namespaces.
const rpc = async (operation, input) => {
  const response = await fetch(`${server.url}/api/rpc`, { method: 'POST', headers: { Authorization: 'Bearer q1-offline-local-synthetic-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, input }) });
  return { status: response.status, ...await response.json() };
};
const retry = await rpc('job.retry', { jobId: fixture.jobId, requestId: randomUUID() });
assert.equal(retry.status, 409); assert.equal(retry.error.code, 'UNSAFE_RETRY');
const providers = await rpc('provider.list', {});
assert.ok(providers.data.filter(x => !x.mock).every(x => !x.enabled));
await writeFile(path.join(runtime, 'http-checks.json'), JSON.stringify({ at: new Date().toISOString(), jobId: fixture.jobId, retry: { status: retry.status, code: retry.error.code }, allLiveDisabled: true }, null, 2));
await writeFile(path.join(runtime, 'server.json'), JSON.stringify({ url: server.url, projectId: fixture.projectId, jobId: fixture.jobId, pid: process.pid, fixture: 'Injected HTTP 409; no live provider verification' }, null, 2));
console.log(`RUNWAY_PARITY_QA_READY ${server.url}`);
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
