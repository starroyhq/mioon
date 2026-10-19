import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentChatSession, agentChatCanSend } from '../apps/web/src/agent-chat.js';
import { createImageGenerationSession, imageDraftDirty } from '../apps/web/src/image-generation.js';
import { createEditorSettingsScope } from '../apps/web/src/editor-settings-scope.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createAgentChatCloseReporter, createImageGenerationCloseReporter } from '../apps/web/src/native-close-sources.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createAgentAuthorizationUiMock } from './helpers/agent-authorization-ui.mjs';

// These tests join the actual sessions and close reporters to the actual scope
// and admission. A fake boolean source cannot reproduce focus starting a load.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), runId = id(4), requestId = id(5);
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://api.example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const settings = () => ({
  revision: 0, configuration: { ...configuration }, secret: { configured: true, storage: 'session' },
  storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' },
  presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }],
  scope: 'settings_only', verification: 'not_tested',
});
const running = () => ({
  id: runId, requestId, threadId, projectId, status: 'running', userText: 'Already accepted question', assistantText: 'Saved partial reply',
  configuration: { ...configuration }, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastEventId: 1,
});
const snapshot = (runs = []) => ({ instanceId, threadId, projectId, revision: 0, historyCursor: null, scope: 'chat_only', persistence: 'local_database', mode: 'simulated', settings: settings(), runs });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const commitOptions = (patch = {}) => ({ discardDirty: true, allowDrainFailure: false, expiresAt: 1500, ...patch });
function unload(admission) {
  let prevented = false;
  const event = { type: 'beforeunload', preventDefault() { prevented = true; }, returnValue: undefined };
  admission.prepareBeforeUnload(event);
  const allowed = admission.beforeUnload(event);
  return { allowed, prevented };
}
function closeFixture(registry, scope, additional = { dirty: false, busy: false, unknown: false, identity: [] }) {
  let sequence = 0;
  return createNativeCloseAdmission({
    registry, settings: createSettingsNavigationRegistry(), readScope: () => `workspace:${projectId}:1`,
    readDocumentURL: () => `http://127.0.0.1:8123/?project=${projectId}`,
    readAdditionalSnapshot: () => additional, onObservationPause: paused => scope.pauseObservation(paused),
    now: () => 1000, newToken: () => `modal-close-${++sequence}`,
  });
}
async function agentFixture(t, { accepted = false, additional } = {}) {
  const registry = createNativeCloseRegistry(), reporter = createAgentChatCloseReporter(registry);
  const calls = [], changes = [], streams = [], receipts = new Map(), initial = snapshot(accepted ? [running()] : []);
  let nextRead = null;
  const forbidden = operation => async () => { calls.push(operation); throw new Error(`Unexpected business operation: ${operation}`); };
  const authorization = createAgentAuthorizationUiMock(async () => { calls.push('read'); return nextRead ? nextRead.promise : structuredClone(initial); });
  const authorizationCalls = [];
  const client = {
    ...authorization,
    authorize: (...args) => { authorizationCalls.push(args); return authorization.authorize(...args); },
    lookup: forbidden('lookup'), history: forbidden('history'), start: forbidden('start'), stop: forbidden('stop'), run: forbidden('run'),
    stream: (_project, _run, _instance, _last, options) => {
      calls.push('stream'); streams.push(options);
      return new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const session = createAgentChatSession({ projectId, client, requestId: () => requestId,
    receipts: { get: key => receipts.get(key), set: (key, value) => receipts.set(key, value) },
    onChange: state => { changes.push(state.phase); reporter.publish(state); },
  });
  reporter.publish(session.getState());
  const scope = createEditorSettingsScope(async () => true);
  const unsubscribe = scope.subscribe(active => session.setVisible(active));
  const admission = closeFixture(registry, scope, additional);
  t.after(() => {
    scope.dispose(); admission.dispose(); unsubscribe(); session.dispose(); reporter.release();
    assert.equal(authorizationCalls.length, accepted ? 0 : 1, 'modal observation never grants authorization again');
  });
  await session.load();
  assert.equal(session.getState().phase, accepted ? 'streaming' : 'ready');
  if (!accepted) {
    assert.equal(session.edit('Keep this exact unsent draft'), true);
    assert.equal(await session.approve(true), true);
    assert.equal(agentChatCanSend(session.getState()), true);
  }
  return { registry, reporter, session, scope, admission, calls, changes, streams, receipts, authorizationKey: session.getState().consent,
    holdNextRead() { nextRead = deferred(); return { resolve: () => nextRead.resolve(structuredClone(initial)) }; },
  };
}

test('dirty Agent native inspection pauses before capture; modal blur/focus cannot start a load or stale the commit', async t => {
  const f = await agentFixture(t), draft = f.session.getState().draft;
  const inspection = f.admission.inspect();
  assert.equal(inspection.disposition, 'dirty');
  assert.equal(f.scope.active, false);
  assert.equal(f.session.getState().consent, null);
  const captured = f.registry.capture(), version = f.reporter.getState().version;
  const changes = f.changes.length;
  f.scope.blur(); f.scope.focus(); f.scope.blur(); f.scope.focus();
  await settle();
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.reporter.getState().busy, false);
  assert.equal(f.reporter.getState().version, version);
  assert.equal(f.registry.isCurrent(captured), true);
  assert.deepEqual(f.changes.slice(changes), []);
  assert.equal(f.admission.commit(inspection.token, commitOptions()), true);
  assert.deepEqual(unload(f.admission), { allowed: true, prevented: false });
  assert.equal(f.scope.active, false);
  assert.equal(f.session.getState().draft, draft);
  assert.deepEqual(f.calls, ['read']);
  assert.deepEqual(unload(f.admission), { allowed: false, prevented: true });
});

test('unknown-result risk close with dirty Agent keeps the exact unknown owner and requires separate discard', async t => {
  const owner = {}, additional = { dirty: false, busy: false, unknown: true, identity: [owner, 7, 'asset.import'] };
  const f = await agentFixture(t, { additional }), draft = f.session.getState().draft;
  const inspection = f.admission.inspect();
  assert.equal(inspection.disposition, 'unknown-dirty');
  f.scope.blur(); f.scope.focus();
  assert.equal(f.admission.commit(inspection.token, commitOptions({ allowUnknown: true, discardDirty: false })), false);
  assert.equal(f.admission.commit(inspection.token, commitOptions({ allowUnknown: true, allowDrainFailure: true })), false);
  assert.equal(f.admission.commit(inspection.token, commitOptions({ allowUnknown: true })), true);
  assert.deepEqual(unload(f.admission), { allowed: true, prevented: false });
  assert.deepEqual(additional, { dirty: false, busy: false, unknown: true, identity: [owner, 7, 'asset.import'] });
  assert.equal(f.session.getState().draft, draft);
  assert.equal(f.session.getState().consent, null);
  assert.deepEqual(f.calls, ['read']);
});

test('only the current cancellation resumes one Agent read and reuses retained authorization without sending', async t => {
  const f = await agentFixture(t), held = f.holdNextRead(), draft = f.session.getState().draft;
  const inspection = f.admission.inspect();
  f.scope.blur(); f.scope.focus();
  assert.equal(f.admission.cancel('wrong-token'), false);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.admission.cancel(inspection.token), true);
  assert.equal(f.scope.active, true);
  assert.deepEqual(f.calls, ['read', 'read']);
  assert.equal(f.session.getState().phase, 'loading');
  assert.equal(f.reporter.getState().busy, true);
  assert.equal(f.session.getState().consent, f.authorizationKey);
  assert.equal(agentChatCanSend(f.session.getState()), false, 'retained authorization cannot send while the resumed read is loading');
  f.scope.focus();
  assert.equal(f.admission.cancel(inspection.token), false);
  assert.equal(f.admission.commit(inspection.token, commitOptions()), false);
  held.resolve(); await settle();
  assert.equal(f.session.getState().phase, 'ready');
  assert.equal(f.session.getState().draft, draft);
  assert.equal(f.session.getState().consent, f.authorizationKey);
  assert.equal(agentChatCanSend(f.session.getState()), true);
  assert.equal(f.reporter.getState().busy, false);
  assert.deepEqual(f.calls, ['read', 'read']);
});

test('cancelling while still blurred waits for actual focus rather than reviving an inactive Agent', async t => {
  const f = await agentFixture(t), held = f.holdNextRead(), inspection = f.admission.inspect();
  f.scope.blur();
  assert.equal(f.admission.cancel(inspection.token), true);
  assert.equal(f.scope.active, false);
  assert.equal(f.session.getState().consent, null);
  assert.deepEqual(f.calls, ['read']);
  f.scope.focus(); f.scope.focus();
  assert.deepEqual(f.calls, ['read', 'read']);
  held.resolve(); await settle();
  assert.equal(f.session.getState().consent, f.authorizationKey);
  assert.equal(agentChatCanSend(f.session.getState()), true);
});

test('new inspection replaces pause ownership; late old cancel and commit cannot resume or authorize the new attempt', async t => {
  const f = await agentFixture(t), first = f.admission.inspect();
  f.scope.blur(); f.scope.focus();
  const second = f.admission.inspect(), held = f.holdNextRead();
  assert.notEqual(first.token, second.token);
  assert.equal(second.disposition, 'dirty');
  assert.equal(f.admission.cancel(first.token), false);
  assert.equal(f.admission.commit(first.token, commitOptions()), false);
  assert.equal(f.scope.active, false);
  assert.equal(f.session.getState().consent, null);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.admission.cancel(second.token), true);
  assert.deepEqual(f.calls, ['read', 'read']);
  held.resolve(); await settle();
  assert.equal(f.admission.commit(second.token, commitOptions()), false);
  assert.equal(f.session.getState().consent, f.authorizationKey);
  assert.equal(agentChatCanSend(f.session.getState()), true);
});

test('final unload veto never resumes reads inline; exact main cancellation resumes after consumed ticket', async t => {
  const f = await agentFixture(t), inspection = f.admission.inspect(), held = f.holdNextRead();
  f.scope.blur(); f.scope.focus();
  assert.equal(f.admission.commit(inspection.token, commitOptions()), true);
  f.admission.interacted();
  assert.deepEqual(unload(f.admission), { allowed: false, prevented: true });
  assert.equal(f.scope.active, false);
  assert.equal(f.reporter.getState().busy, false);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.admission.cancel('wrong-token'), false);
  assert.equal(f.admission.cancel(inspection.token), true);
  assert.deepEqual(f.calls, ['read', 'read']);
  held.resolve(); await settle();
  assert.equal(f.session.getState().consent, f.authorizationKey);
  assert.equal(agentChatCanSend(f.session.getState()), true);
  assert.equal(f.admission.commit(inspection.token, commitOptions()), false);
});

test('a disposed scope cannot be revived by a late modal cancellation or focus callback', async t => {
  const f = await agentFixture(t), inspection = f.admission.inspect();
  f.scope.blur(); f.scope.focus(); f.scope.dispose();
  assert.equal(f.admission.cancel(inspection.token), true);
  f.scope.focus(); f.scope.pauseObservation(false);
  assert.equal(f.scope.active, false);
  assert.equal(await f.scope.open('agent'), false);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.session.getState().draft, 'Keep this exact unsent draft');
  assert.equal(f.session.getState().consent, null);
});

test('native close detaches only observation of an accepted Agent run and never stops or repeats it', async t => {
  const f = await agentFixture(t, { accepted: true }), saved = structuredClone(f.session.getState().snapshot.runs);
  assert.equal(f.streams.length, 1);
  const inspection = f.admission.inspect();
  assert.equal(inspection.disposition, 'clean');
  assert.equal(f.streams[0].signal.aborted, true);
  assert.equal(f.session.getState().phase, 'detached');
  f.scope.blur(); f.scope.focus(); await settle();
  assert.deepEqual(f.session.getState().snapshot.runs, saved);
  assert.equal(f.reporter.getState().busy, false);
  assert.equal(f.admission.commit(inspection.token, commitOptions({ discardDirty: false })), true);
  assert.deepEqual(unload(f.admission), { allowed: true, prevented: false });
  assert.deepEqual(f.calls, ['read', 'stream']);
});

test('actual image draft stays unchanged through native modal focus and cancellation performs reads only', async t => {
  const registry = createNativeCloseRegistry(), reporter = createImageGenerationCloseReporter(registry);
  const calls = [], stored = new Map(), timers = new Map(); let timerId = 0, session;
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  session = createImageGenerationSession({
    projectId, storage, requestId: () => requestId,
    api: async operation => {
      calls.push(operation);
      if (['image.group.list', 'image.task.list', 'image.review.list'].includes(operation)) return { projectId, items: [], nextCursor: null };
      throw new Error(`Unexpected image operation: ${operation}`);
    },
    onChange: state => reporter.publish({ state, dirty: imageDraftDirty(state), rejectionBlocked: session.getNativeCloseState().rejectionBlocked }),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; }, clearTimer: key => timers.delete(key),
  });
  reporter.publish({ state: session.getState(), dirty: imageDraftDirty(session.getState()), rejectionBlocked: session.getNativeCloseState().rejectionBlocked });
  const scope = createEditorSettingsScope(async () => true), unsubscribe = scope.subscribe(active => session.setVisible(active));
  const admission = closeFixture(registry, scope);
  t.after(() => { scope.dispose(); admission.dispose(); unsubscribe(); session.dispose(); reporter.release(); });
  assert.equal(await session.load(), true);
  assert.equal(session.edit('name', 'Keep this image name'), true);
  assert.equal(session.edit('prompt', 'Keep this exact image prompt'), true);
  const draft = structuredClone(session.getState().draft), before = [...calls];
  const first = admission.inspect(), captured = registry.capture();
  assert.equal(first.disposition, 'dirty');
  scope.blur(); scope.focus(); await settle();
  assert.equal(registry.isCurrent(captured), true);
  assert.deepEqual(calls, before);
  assert.equal(admission.commit(first.token, commitOptions()), true);
  assert.deepEqual(unload(admission), { allowed: true, prevented: false });
  assert.deepEqual(session.getState().draft, draft);
  assert.deepEqual(calls, before);
  // Model main cancelling after a prevented/did-not-close window lifetime.
  assert.equal(admission.cancel(first.token), true);
  await settle();
  assert.deepEqual(calls, [...before, 'image.group.list', 'image.task.list', 'image.review.list']);
  assert.deepEqual(session.getState().draft, draft);
  assert.equal(stored.size, 0);
  assert.equal(reporter.getState().busy, false);
});
