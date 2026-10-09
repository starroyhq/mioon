/** Filesystem-only QA control client. UI actions remain ordinary CUA actions. */
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function editsQaClient({mode = 'browser'} = {}) {
  if (!['browser', 'native'].includes(mode)) throw Error('Unknown reviewed-edit fixture');
  const root = fileURLToPath(new URL('../evidence/agent-edits/', import.meta.url)), runtime = path.join(root, `${mode}-runtime`);
  const fixture = JSON.parse(await readFile(path.join(runtime, 'fixture.json'), 'utf8'));
  if (fixture.synthetic !== true || fixture.mode !== mode || fixture.runtime !== runtime) throw Error('Not the selected synthetic fixture');
  const waitFor = async (test, label, timeout = 20000) => {
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) throw Error('Invalid bounded QA timeout');
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await test(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 80)); }
    throw Error(`Timed out: ${label}`);
  };
  async function request(item, {timeout = 20000} = {}) {
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) throw Error('Invalid bounded QA timeout');
    if (!['audit', 'restart', 'fault', 'model.plan', 'model.snapshot', 'model.release'].includes(item?.action)) throw Error('Unknown bounded QA action');
    const box = path.join(runtime, 'mailbox'), id = randomUUID(), requestFile = path.join(box, `${id}.request.json`), resultFile = path.join(box, `${id}.result.json`);
    const encoded = JSON.stringify({...item, expiresAt: Date.now() + timeout});
    if (Buffer.byteLength(encoded) > 65536) throw Error('Synthetic control request too large');
    await mkdir(box, {recursive: true, mode: 0o700});
    await writeFile(`${requestFile}.tmp`, encoded, {mode: 0o600}); await rename(`${requestFile}.tmp`, requestFile);
    const result = await waitFor(async () => {
      try { return JSON.parse(await readFile(resultFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'reviewed-edit fixture control response', timeout);
    await unlink(resultFile);
    if (result.probeError) throw Error(result.probeError); return result;
  }
  return {root, runtime, fixture, waitFor, request,
    audit: name => request({action: 'audit', name}), restart: () => request({action: 'restart'}),
    plan: plan => request({action: 'model.plan', plan}), model: () => request({action: 'model.snapshot'}),
    release: boundary => request({action: 'model.release', boundary: boundary === 'first' ? 'request' : boundary}),
    fault: (boundary = 'beforeAcknowledgement') => request({action: 'fault', boundary}),
  };
}
