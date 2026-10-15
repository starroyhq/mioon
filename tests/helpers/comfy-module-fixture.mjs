// Synthetic local-only fixture for optional-module lifecycle acceptance.
// Never connects to ComfyUI, a model runtime, or a GPU.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../../packages/business/src/db.mjs';
import {createServices} from '../../packages/business/src/services.mjs';
import {createComfySettings} from '../../packages/business/src/comfy/settings.mjs';
import {COMFY_IMAGE_OPTIONS, DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../../packages/contracts/src/comfy-images.mjs';
import {createComfyFixturePng} from './comfy-http-fixture.mjs';

export const configuration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true,
  baseUrl: 'http://127.0.0.1:8188', model: 'synthetic/example.safetensors'};
export const availability = state => ({schemaVersion: 1, connectorId: 'mioon.comfy-local', implementationVersion: '1', state,
  reason: {available: 'ready', not_provided: 'distribution_not_provided', not_loaded: 'startup_not_loaded'}[state], fixedForSession: true});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function until(read, predicate) {
  const end = Date.now() + 5000;
  let value;
  while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await pause(5); }
  assert.fail(`Synthetic optional Comfy lifecycle did not settle: ${JSON.stringify(value)}`);
}
export function imageRows(store, tables = ['image_groups', 'image_tasks', 'image_reviews', 'image_requests', 'image_remote_runs', 'image_remote_observations', 'image_versions', 'assets']) {
  // Serialize raw SQL columns, including canonical strings and original receipts.
  // This catches rewrites that DTO equality alone would conceal.
  return Object.fromEntries(tables.map(table => [table, JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
}
export async function createModuleFixture(t, {fault = () => {}, submit, observe, moduleState, autoRun = true} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-comfy-module-'));
  let saved = null, store = openStore(root), settings, services;
  const calls = {post: 0, get: 0}, png = createComfyFixturePng();
  const persistence = {load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); }};
  const completed = args => ({state: 'completed', contentVerified: true, candidate: {bytes: png, mimeType: 'image/png',
    width: 512, height: 512, byteLength: png.length, sha256: sha256(png),
    descriptor: {filename: `${args.execution.filenamePrefix}_00001_.png`, subfolder: '', type: 'output'}}});
  const connector = {
    submit: async args => { calls.post++; if (submit) return submit(args); args.beforeSubmit(); return {state: 'submitted', promptId: args.execution.promptId}; },
    observe: async args => { calls.get++; return observe ? observe(args) : completed(args); },
  };
  async function create(state) {
    settings = await createComfySettings({persistence, reservedPorts: () => [4318]});
    services = createServices(store, new Map(), {env: {}, imageOptions: {autoRun, fault, comfySettings: settings,
      ...(state === undefined || state === 'available' ? {comfyConnector: connector} : {}),
      ...(state === undefined ? {} : {comfyModuleAvailability: availability(state)})}});
  }
  t.after(async () => { await services?.drain(); await settings?.close(); store.close(); rmSync(root, {recursive: true, force: true}); });
  await create(moduleState);
  const project = await services.call('project.create', {name: 'Optional Comfy synthetic'});
  const other = await services.call('project.create', {name: 'Other project'});
  const f = {root, project, other, calls, png, completed,
    get store() { return store; }, get settings() { return settings; }, get services() { return services; },
    call: (operation, input) => services.call(operation, input),
    input: (patch = {}) => ({projectId: project.id, requestId: randomUUID(), name: 'Synthetic retained image',
      providerId: 'comfy-local', model: configuration.model, prompt: 'Exact local fixture prompt.', options: COMFY_IMAGE_OPTIONS, ...patch}),
    prepare: input => services.call('image.review.prepare', {input, settingsRevision: 1}),
    approve: review => services.imageApproval({projectId: project.id, reviewId: review.id, expectedRevision: 1}),
    task: taskId => services.call('image.task.get', {projectId: project.id, taskId}),
    remote: taskId => services.call('image.task.remote.get', {projectId: project.id, taskId}),
    async observationInput(taskId) { return {projectId: project.id, taskId, requestId: randomUUID(), expectedRevision: (await f.remote(taskId)).remote.revision}; },
    check() { const checked = {ok: true, baseUrl: configuration.baseUrl, comfyVersion: '0.39.0', checkpoints: [configuration.model],
      nodeClasses: ['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage'], selectedCheckpointAvailable: true};
      settings.recordCheck(checked, settings.clearCheck(checked.baseUrl)); },
    async accepted() { const input = f.input(), review = await f.prepare(input), ack = await f.approve(review);
      await until(() => f.task(ack.id), task => !['queued', 'dispatching'].includes(task.state)); return {input, review, ack}; },
    async reopen(state) { await services.drain(); await settings.close(); store.close(); store = openStore(root); await create(state); },
  };
  await settings.put({expectedRevision: 0, configuration});
  f.check();
  return f;
}
