import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../packages/business/src/db.mjs';
import { createServices } from '../packages/business/src/services.mjs';
import { startWorker } from '../packages/business/src/jobs.mjs';

// Deferred, in-process adapters make the exact await boundary deterministic.
// They do not contact a provider or read any real user's media or credentials.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, methods = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-race-'));
  const store = openStore(root);
  let submissions = 0, worker;
  const provider = {
    id: 'mock',
    capabilities: { models: ['race-fixture'], aspectRatios: ['9:16'], durations: [2], enabled: true, configured: true, mock: true },
    submit: async () => { submissions++; return { providerJobId: 'race-provider-task' }; },
    reconcile: async () => null,
    poll: async () => ({ status: 'running', progress: 0.2 }),
    ...methods,
  };
  const providers = new Map([['mock', provider]]);
  const services = createServices(store, providers);
  t.after(async () => { if (worker) await worker.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  const project = await services.call('project.create', { name: 'Isolated race fixture' });
  const asset = { id: randomUUID(), projectId: project.id, mimeType: 'image/png', relativePath: 'media/unused-fixture.png', sha256: 'a'.repeat(64) };
  await writeFile(path.join(root, asset.relativePath), 'Inert reference for the injected adapter; never decoded or transmitted.');
  store.put('assets', asset);
  const shot = await services.call('shot.create', { projectId: project.id, title: 'Race fixture', referenceAssetIds: [asset.id] });
  const job = await services.call('generation.submit', { shotId: shot.id, expectedRevision: shot.revision, providerId: 'mock', requestId: randomUUID() });
  return {
    store, services, job, provider, providers,
    read: () => store.get('jobs', job.id),
    transition: patch => services.saveJob(store.get('jobs', job.id), patch),
    submissions: () => submissions,
    start: () => (worker = startWorker(store, services, providers)),
  };
}

test('queued cancellation prevents any provider dispatch', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const cancelled = await f.services.call('job.cancel', { jobId: f.job.id });
  assert.equal(cancelled.status, 'cancelled');
  const worker = f.start();
  await worker.tick();
  await worker.stop();
  assert.equal(f.submissions(), 0);
  assert.equal(f.read().submissionCount, 0);
  assert.equal(f.read().providerJobId, null);
  assert.equal(f.read().status, 'cancelled');
});

test('worker reconciliation cannot resurrect a cancellation made while awaiting the provider', { timeout: 5000 }, async t => {
  const entered = deferred(), result = deferred();
  const f = await fixture(t, { reconcile: async () => { entered.resolve(); return result.promise; } });
  f.transition({ status: 'submission_unknown', phase: 'reconciliation_required' });
  const worker = f.start();
  await entered.promise;
  const cancelled = await f.services.call('job.cancel', { jobId: f.job.id });
  result.resolve({ providerJobId: 'reconciled-existing-task' });
  await worker.stop();
  assert.equal(f.read().status, 'cancelled');
  assert.equal(f.read().cancelScope, 'local_only');
  assert.equal(f.read().error.code, 'LOCAL_WAIT_STOPPED');
  assert.equal(f.read().revision, cancelled.revision);
  assert.equal(f.submissions(), 0);
});

test('service reconciliation preserves cancellation across the remote lookup await', { timeout: 5000 }, async t => {
  const entered = deferred(), result = deferred();
  const f = await fixture(t, { reconcile: async () => { entered.resolve(); return result.promise; } });
  f.transition({ status: 'submission_unknown', phase: 'reconciliation_required' });
  const pending = f.services.call('job.reconcile', { jobId: f.job.id });
  await entered.promise;
  const cancelled = await f.services.call('job.cancel', { jobId: f.job.id });
  result.resolve({ providerJobId: 'reconciled-existing-task' });
  const returned = await pending;
  assert.equal(returned.status, 'cancelled');
  assert.equal(f.read().status, 'cancelled');
  assert.equal(f.read().cancelScope, 'local_only');
  assert.equal(f.read().revision, cancelled.revision);
});

test('service reconciliation preserves a completed job and version pointer across a stale poll', { timeout: 5000 }, async t => {
  const entered = deferred(), result = deferred();
  const f = await fixture(t, { poll: async () => { entered.resolve(); return result.promise; } });
  f.transition({ status: 'running', providerJobId: 'known-existing-task' });
  const pending = f.services.call('job.reconcile', { jobId: f.job.id });
  await entered.promise;
  const versionId = randomUUID();
  const completed = f.transition({ status: 'succeeded', phase: 'complete', progress: 100, versionId });
  result.resolve({ status: 'running', progress: 0.5 });
  const returned = await pending;
  assert.equal(returned.status, 'succeeded');
  assert.equal(returned.versionId, versionId);
  assert.equal(f.read().status, 'succeeded');
  assert.equal(f.read().versionId, versionId);
  assert.equal(f.read().revision, completed.revision);
});

test('accepted submission records its remote ID without undoing local cancellation', { timeout: 5000 }, async t => {
  const entered = deferred(), result = deferred();
  let attempts = 0;
  const f = await fixture(t, { submit: async () => { attempts++; entered.resolve(); return result.promise; } });
  const worker = f.start();
  await entered.promise;
  assert.equal(f.read().status, 'submitting');
  await f.services.call('job.cancel', { jobId: f.job.id });
  result.resolve({ providerJobId: 'accepted-despite-local-stop' });
  await worker.stop();
  assert.equal(f.read().status, 'cancelled');
  assert.equal(f.read().cancelScope, 'local_only');
  assert.equal(f.read().providerJobId, 'accepted-despite-local-stop');
  assert.equal(f.read().submissionCount, 1);
  assert.equal(attempts, 1);
  await assert.rejects(f.services.call('job.retry', { jobId: f.job.id, requestId: randomUUID() }), error => error.code === 'UNSAFE_RETRY');
});

test('stale worker polling does not overwrite local cancellation with failure', { timeout: 5000 }, async t => {
  const entered = deferred(), result = deferred();
  const f = await fixture(t, { poll: async () => { entered.resolve(); return result.promise; } });
  f.transition({ status: 'running', providerJobId: 'known-existing-task' });
  const worker = f.start();
  await entered.promise;
  await f.services.call('job.cancel', { jobId: f.job.id });
  result.resolve({ status: 'failed', error: { code: 'REMOTE_FAILURE', message: 'Delayed failure response' } });
  await worker.stop();
  assert.equal(f.read().status, 'cancelled');
  assert.equal(f.read().error.code, 'LOCAL_WAIT_STOPPED');
  assert.equal(f.submissions(), 0);
});

test('reconciliation never reclassifies queued, submitting, or definitively failed jobs as unknown', { timeout: 5000 }, async t => {
  let remoteLookups = 0;
  const f = await fixture(t, { reconcile: async () => { remoteLookups++; return null; } });
  for (const status of ['queued', 'submitting', 'failed']) {
    const before = f.transition({ status, providerJobId: null });
    const returned = await f.services.call('job.reconcile', { jobId: f.job.id });
    assert.deepEqual(returned, f.services.publicValue(before));
    assert.equal(f.read().status, status);
    assert.equal(f.read().revision, before.revision);
    await assert.rejects(f.services.call('job.reconcile', { jobId: f.job.id, providerJobId: 'unrelated-task' }), error => error.code === 'INVALID_RECONCILIATION_STATE');
  }
  assert.equal(remoteLookups, 0);
});

test('concurrent manual reconciliations cannot attach one remote task to different local snapshots', { timeout: 5000 }, async t => {
  const bothEntered = deferred(), result = deferred();
  let polls = 0;
  const f = await fixture(t);
  // This injected Runway stand-in only returns an in-memory deferred response.
  // It never constructs the live adapter or reads provider environment settings.
  f.providers.set('runway', {
    id: 'runway',
    poll: async () => { if (++polls === 2) bothEntered.resolve(); return result.promise; },
  });
  const first = { ...f.read(), providerId: 'runway', status: 'submission_unknown' };
  const second = {
    ...first, id: randomUUID(), requestId: randomUUID(),
    snapshot: { ...first.snapshot, prompt: 'A different generation snapshot' },
  };
  f.store.put('jobs', first);
  f.store.put('jobs', second);
  const providerJobId = 'shared-existing-remote-task';
  const outcomesPromise = Promise.allSettled([
    f.services.call('job.reconcile', { jobId: first.id, providerJobId }),
    f.services.call('job.reconcile', { jobId: second.id, providerJobId }),
  ]);
  await bothEntered.promise;
  result.resolve({ status: 'running', progress: 0.5 });
  const outcomes = await outcomesPromise;
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'TASK_ID_CONFLICT');
  assert.equal(f.store.list('jobs').filter(job => job.providerId === 'runway' && job.providerJobId === providerJobId).length, 1);
  const unclaimed = f.store.list('jobs').find(job => job.providerJobId === null);
  assert.equal(unclaimed.status, 'submission_unknown');
});

test('repeated retries with fresh IDs create only one active child, while the original retry remains replayable', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.transition({ status: 'failed', phase: 'provider_failed' });
  const requestIds = Array.from({ length: 8 }, () => randomUUID());
  const outcomes = await Promise.allSettled(requestIds.map(requestId => f.services.call('job.retry', { jobId: f.job.id, requestId })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of outcomes.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'RETRY_ALREADY_ACTIVE');
  const child = outcomes.find(result => result.status === 'fulfilled').value;
  assert.equal(child.retryOfJobId, f.job.id);
  assert.equal(f.store.list('jobs').length, 2);
  assert.equal((await f.services.call('job.retry', { jobId: f.job.id, requestId: child.requestId })).id, child.id);
  for (const status of ['queued', 'submitting', 'running', 'downloading', 'submission_unknown']) {
    f.services.saveJob(f.store.get('jobs', child.id), { status });
    await assert.rejects(f.services.call('job.retry', { jobId: f.job.id, requestId: randomUUID() }), error => error.code === 'RETRY_ALREADY_ACTIVE' && error.details.jobId === child.id);
  }
  f.services.saveJob(f.store.get('jobs', child.id), { status: 'failed' });
  const later = await f.services.call('job.retry', { jobId: f.job.id, requestId: randomUUID() });
  assert.notEqual(later.id, child.id);
  assert.equal(f.store.list('jobs').length, 3);
  assert.equal(f.submissions(), 0);
});
