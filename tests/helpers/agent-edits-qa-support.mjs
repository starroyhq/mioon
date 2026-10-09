/** Shared controls for disposable reviewed-edit graphical fixtures. These controls
 * are filesystem mailboxes owned by the fixture, never production HTTP routes. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, appendFile, rename, readdir, unlink, stat} from 'node:fs/promises';
import {prepareMutationQaFixture, mutationQaAudit} from '../mutation-qa-runtime.mjs';
import {startEditWireModel} from './agent-edit-wire-model.mjs';
import {createAgentSettings} from '../../packages/business/src/agent/settings.mjs';
import {createAgentSettingsFile} from '../../packages/business/src/agent/settings-file.mjs';

export const EDIT_QA_REPO = fileURLToPath(new URL('../../', import.meta.url));
export const EDIT_QA_ROOT = path.join(EDIT_QA_REPO, 'evidence/agent-edits');
export const EDIT_QA_TOKEN = 'agent-edits-synthetic-local-qa-token';
export function editQaPaths(mode = 'browser') {
  if (!['browser', 'native'].includes(mode)) throw Error('Unknown reviewed-edit QA fixture');
  const runtime = path.join(EDIT_QA_ROOT, `${mode}-runtime`);
  const userData = mode === 'native' ? path.join(runtime, 'user-data') : runtime;
  return {root: EDIT_QA_ROOT, runtime, userData, workspace: path.join(userData, 'workspace'),
    mailbox: path.join(runtime, 'mailbox'), mock: path.join(runtime, 'mock')};
}
export async function jsonFile(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await rename(temporary, file);
}
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
export function clearEditQaEnvironment(env) {
  env.MIOON_ENABLE_LIVE_PROVIDER = '0';
  for (const name of Object.keys(env)) if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_)/u.test(name) ||
    ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'MIOON_DESKTOP_SMOKE_OUTPUT', 'MIOON_TOKEN'].includes(name)) delete env[name];
  return env;
}
export async function prepareEditQaFixture(mode = 'browser') {
  const paths = editQaPaths(mode);
  await mkdir(paths.runtime, {recursive: true, mode: 0o700});
  const fixture = await prepareMutationQaFixture(paths.userData);
  if (fixture.synthetic !== true || path.resolve(fixture.workspace) !== paths.workspace) throw Error('Not the dedicated synthetic reviewed-edit workspace');
  const result = {...fixture, ...paths, mode, synthetic: true};
  await jsonFile(path.join(paths.runtime, 'fixture.json'), result);
  return result;
}
export async function seedEditQaSettings(directory, baseUrl, protocol = 'responses') {
  if (!['responses', 'chat_completions'].includes(protocol)) throw Error('Explicit supported protocol required');
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/v1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Only the synthetic loopback model is allowed');
  const settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(directory, 'agent-settings')})});
  try {
    const initial = await settings.get(), configuration = {protocol, presetId: 'ollama', platformId: 'local', baseUrl, model: 'qwen3:8b'};
    if (initial.secret.configured) throw Error('Refusing a QA workspace containing an Agent credential');
    if (JSON.stringify(initial.configuration) === JSON.stringify(configuration)) return initial;
    return await settings.put({expectedRevision: initial.revision, configuration, secret: {action: 'remove'}});
  } finally { await settings.close(); }
}
export function validateEditQaPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 32768 ||
      Object.keys(value).some(key => !['name', 'arguments', 'rawArguments', 'noCall', 'secondTool', 'hold', 'error', 'truncate'].includes(key))) throw Error('Invalid bounded model plan');
  for (const key of ['hold', 'error', 'truncate']) if (value[key] !== undefined && !['request', 'answer'].includes(value[key])) throw Error('Model boundary must be request or answer');
  for (const key of ['noCall', 'secondTool']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error('Invalid model plan flag');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 128)) throw Error('Invalid synthetic tool name');
  if (value.rawArguments !== undefined && typeof value.rawArguments !== 'string') throw Error('Invalid raw synthetic arguments');
  return structuredClone(value);
}
export async function startEditQaModel(paths, {label = 'runtime'} = {}) {
  await mkdir(paths.mock, {recursive: true, mode: 0o700});
  let port = 0;
  try {
    const descriptor = await readJson(path.join(paths.mock, 'model.json')), previous = new URL(descriptor.baseUrl);
    if (descriptor.synthetic !== true || previous.protocol !== 'http:' || previous.hostname !== '127.0.0.1' || previous.pathname !== '/v1' || previous.username || previous.password || previous.search || previous.hash || !Number.isInteger(Number(previous.port))) throw Error('Invalid saved synthetic model endpoint');
    port = Number(previous.port);
    if (port < 1024 || port > 65535) throw Error('Invalid saved synthetic model port');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = await startEditWireModel({port}), sessionId = randomUUID(), startedAt = new Date().toISOString();
  const sessionDirectory = path.join(paths.mock, 'sessions', sessionId);
  await mkdir(sessionDirectory, {recursive: true, mode: 0o700});
  await jsonFile(path.join(paths.mock, 'model.json'), {baseUrl: model.baseUrl, sessionId, startedAt, label, pid: process.pid, synthetic: true});
  let persisted = 0, queued = 0, closing, persistError, tail = Promise.resolve();
  const flush = () => tail = tail.then(async () => {
    const snapshot = model.snapshot();
    if (snapshot.captures.length > 512) throw Error('Synthetic model capture bound exceeded');
    for (const capture of snapshot.captures.slice(persisted)) {
      if (capture.headers.authorization) throw Error('Synthetic model unexpectedly received an authorization header');
      const line = JSON.stringify({sessionId, startedAt, label, ...capture}) + '\n';
      await appendFile(path.join(paths.mock, 'model-requests.jsonl'), line, {mode: 0o600});
      await appendFile(path.join(sessionDirectory, 'requests.jsonl'), line, {mode: 0o600});
      persisted++;
    }
    const evidence = {sessionId, startedAt, label, synthetic: true, ...snapshot};
    await jsonFile(path.join(sessionDirectory, 'snapshot.json'), evidence);
    await jsonFile(path.join(paths.mock, 'snapshot.json'), evidence);
    return evidence;
  });
  let flushing = false;
  const timer = setInterval(() => {
    if (closing || persistError || flushing) return; flushing = true;
    flush().catch(error => { persistError = error; }).finally(() => { flushing = false; });
  }, 100); timer.unref();
  await flush();
  return {
    baseUrl: model.baseUrl, sessionId, sessionDirectory,
    plan(value) { if (persistError) throw persistError; if (++queued > 256) throw Error('Synthetic plan bound exceeded'); model.plan(validateEditQaPlan(value)); return {queued, sessionId}; },
    release(boundary) { if (!['request', 'answer'].includes(boundary)) throw Error('Invalid model boundary'); model.release(boundary); return {released: boundary}; },
    snapshot: async () => { if (persistError) throw persistError; return flush(); },
    async close() { return closing ??= (async () => { clearInterval(timer); await model.close(); if (persistError) throw persistError; await flush(); })(); },
  };
}
export async function editQaAudit(fixture, model, name) {
  if (name !== undefined && !/^[a-z0-9-]{1,64}$/u.test(name)) throw Error('Invalid bounded audit name');
  const result = {...mutationQaAudit(fixture.workspace), mode: fixture.mode, synthetic: true, model: await model.snapshot()};
  if (name) { const directory = path.join(fixture.runtime, 'snapshots'); await mkdir(directory, {recursive: true}); await jsonFile(path.join(directory, `${name}.json`), result); }
  return result;
}
/** Only read-only audits, fixture model plans and owned lifecycle controls. There
 * is deliberately no arbitrary RPC, network fetch, SQL or app-state setter. */
export async function startEditQaMailbox(fixture, model, extras = {}) {
  const directory = fixture.mailbox; await mkdir(directory, {recursive: true, mode: 0o700});
  let closing = false, active = Promise.resolve();
  async function drain() {
    const requests = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.request\.json$/u.test(name)).sort();
    if (requests.length > 32) throw Error('Synthetic mailbox queue bound exceeded');
    for (const name of requests) {
      if (closing) break;
      const file = path.join(directory, name); let result;
      try {
        if ((await stat(file)).size > 65536) throw Error('Synthetic mailbox request too large');
        const item = await readJson(file); await unlink(file);
        if (!Number.isFinite(item.expiresAt) || item.expiresAt < Date.now() || item.expiresAt > Date.now() + 60000) throw Error('Expired synthetic mailbox request');
        if (item.action === 'audit') result = await editQaAudit(fixture, model, item.name);
        else if (item.action === 'model.snapshot') result = await model.snapshot();
        else if (item.action === 'model.plan') result = model.plan(item.plan);
        else if (item.action === 'model.release') result = model.release(item.boundary);
        else if (Object.hasOwn(extras, item.action)) result = await extras[item.action](item);
        else throw Error('Unknown bounded QA action');
      } catch (error) { await unlink(file).catch(() => {}); result = {probeError: error.message}; }
      await jsonFile(path.join(directory, name.replace('.request.json', '.result.json')), result);
    }
  }
  let busy = false;
  const timer = setInterval(() => {
    if (busy || closing) return; busy = true;
    active = drain().catch(async error => { await jsonFile(path.join(fixture.runtime, 'mailbox-error.json'), {at: new Date().toISOString(), error: error.message}); }).finally(() => { busy = false; });
  }, 40); timer.unref();
  return {async close() { closing = true; clearInterval(timer); await active; }};
}
export async function assertNativeFixtureClosed(paths = editQaPaths('native')) {
  for (const filename of ['launch.json', 'user-data/mcp-connection.json']) {
    let value; try { value = await readJson(path.join(paths.runtime, filename)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!Number.isSafeInteger(value.pid) || value.pid <= 1) throw Error('Invalid fixture process descriptor');
    try { process.kill(value.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    throw Error('The native fixture must be fully closed before preparation or relaunch');
  }
}
