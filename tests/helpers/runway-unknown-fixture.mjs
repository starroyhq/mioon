/** A real Runway adapter + SQLite worker driven by one injected HTTP 409.
 * No request leaves this process and the only credential is an inert sentinel.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openStore } from '../../packages/business/src/db.mjs';
import { createServices } from '../../packages/business/src/services.mjs';
import { startWorker } from '../../packages/business/src/jobs.mjs';
import { createRunwayProvider } from '../../packages/business/src/providers/runway.mjs';

export const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/m1cAAAAASUVORK5CYII=', 'base64');
export async function createRunwayUnknownFixture(root) {
  const store = openStore(root), calls = [];
  let worker;
  const env = { RUNWAYML_API_SECRET: 'OFFLINE-Q1-SENTINEL', MIOON_ENABLE_LIVE_PROVIDER: '1', RUNWAY_APPROVED_ASSET_SHA256: createHash('sha256').update(syntheticPng).digest('hex') };
  const provider = createRunwayProvider({ root, env, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(url, 'https://api.dev.runwayml.com/v1/image_to_video');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ error: 'OFFLINE-Q1-SENTINEL' }), { status: 409 });
  } });
  const providers = new Map([['runway', provider]]), services = createServices(store, providers, { env });
  try {
    const project = await services.call('project.create', { name: 'Q1 · 合成 HTTP 409 · 零真实调用', description: 'Offline acceptance: an injected Runway HTTP 409, not a real provider verification.' });
    const asset = await services.call('asset.import', { projectId: project.id, name: 'Synthetic reference.png', mimeType: 'image/png', dataBase64: syntheticPng.toString('base64') });
    const shot = await services.call('shot.create', { projectId: project.id, title: '合成 HTTP 409：提交结果未知', prompt: 'A synthetic geometric shape moves slowly.', referenceAssetIds: [asset.id], aspectRatio: '9:16', duration: 2 });
    const job = await services.call('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, providerId: 'runway', requestId: randomUUID() });
    worker = startWorker(store, services, providers);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && ['queued', 'submitting'].includes(store.get('jobs', job.id).status)) await new Promise(resolve => setTimeout(resolve, 10));
    await worker.stop();
    const unknown = store.get('jobs', job.id);
    assert.equal(unknown.status, 'submission_unknown');
    assert.equal(unknown.error.code, 'SUBMISSION_UNKNOWN');
    assert.equal(unknown.submissionCount, 1);
    assert.equal(unknown.providerJobId, null);
    assert.equal(JSON.stringify(unknown).includes('OFFLINE-Q1-SENTINEL'), false);
    await assert.rejects(services.call('job.retry', { jobId: job.id, requestId: randomUUID() }), { code: 'UNSAFE_RETRY', status: 409 });
    const reconciled = await services.call('job.reconcile', { jobId: job.id });
    assert.equal(reconciled.status, 'submission_unknown');
    assert.equal(store.list('jobs').length, 1);
    assert.equal(store.list('versions').length, 0);
    assert.equal(calls.length, 1);
    return { root, projectId: project.id, shotId: shot.id, jobId: job.id, calls, job: reconciled, source: 'Real adapter and worker, injected offline HTTP 409; no live requests' };
  } finally {
    await worker?.stop();
    store.close();
  }
}
