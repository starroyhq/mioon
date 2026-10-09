/** Bounded mailbox client for the disposable graphical-namespace chat fixture. */
import {readFile, writeFile, mkdir, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function chatQaClient({iteration = 'chat'} = {}) {
  if (!['chat', 'responses', 'durable'].includes(iteration)) throw Error('Unknown synthetic QA iteration');
  const root = fileURLToPath(new URL(`../evidence/agent-${iteration}`, import.meta.url)), runtime = path.join(root, 'browser-runtime');
  const fixture = JSON.parse(await readFile(path.join(runtime, 'fixture.json'), 'utf8'));
  const waitFor = async (test, label, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await test(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 80)); } throw Error(`Timed out: ${label}`); };
  async function request(pathname, options = {}) {
    const box = path.join(root, 'api-mailbox'), id = randomUUID(); await mkdir(box, {recursive: true});
    await writeFile(path.join(box, id + '.request.json'), JSON.stringify({pathname, options}));
    const result = await waitFor(async () => { try { return JSON.parse(await readFile(path.join(box, id + '.result.json'), 'utf8')); } catch { return false; } }, 'graphical chat fixture response');
    if (result.probeError) throw Error(result.probeError); return result;
  }
  const route = projectId => `/api/agent/chat/${encodeURIComponent(projectId)}`;
  const snapshot = async (projectId = fixture.project.id) => { const result = await request(route(projectId)); if (result.status !== 200 || !result.ok) throw Error(`Chat snapshot failed: ${result.status}`); return result.data; };
  const audit = () => request('/audit'), restart = () => request('/restart');
  async function fault({pathname = route(fixture.project.id) + '/runs', kind = 'drop'} = {}) { for (const name of ['fault-observed.json', 'release']) try { await unlink(path.join(runtime, name)); } catch {} await writeFile(path.join(runtime, 'fault.json'), JSON.stringify({method: 'POST', pathname, kind})); }
  const waitFault = () => waitFor(async () => { try { return JSON.parse(await readFile(path.join(runtime, 'fault-observed.json'), 'utf8')); } catch { return false; } }, 'held or dropped chat acknowledgement');
  return {root, runtime, fixture, waitFor, request, route, snapshot, audit, restart, fault, waitFault, release: () => writeFile(path.join(runtime, 'release'), 'release')};
}
