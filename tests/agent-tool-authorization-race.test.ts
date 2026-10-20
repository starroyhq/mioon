import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {deriveAgentEndpoint} from '@mioon/contracts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import {readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {openStore} from '../packages/business/src/db.ts';
import type {WorkspaceStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createInspectionServices} from '../packages/business/src/inspection.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.ts';
import {AGENT_AUTHORIZATION_FILENAME} from '../packages/business/src/agent/authorizations.ts';
import type {AgentDispatchOptions, AgentStreamDone} from '../packages/business/src/agent/agent-gateway.ts';
import type {ChatStep} from '../packages/business/src/agent/chat-step-journal.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';

interface RunView {
  id: string;
  status: string;
  error?: {code: string};
  activity: {kind: string; status: string}[];
}
interface RunResponse {instanceId: string; run: RunView; replayed?: boolean}
function response(value: Record<string, unknown>): RunResponse {
  assert.equal(typeof value.instanceId, 'string');
  assert.ok(value.run && typeof value.run === 'object');
  return value as unknown as RunResponse;
}
function toolDone(protocol: AgentProtocol): AgentStreamDone {
  const id = 'call_authorization_race', name = 'mioon_project_inspect', argumentsJson = '{}';
  return {type: 'done', finishReason: 'tool_calls', toolCall: {id, name, arguments: {}, argumentsJson,
    ...(protocol === 'responses' ? {itemId: 'fc_authorization_race'} : {})},
    providerOutput: protocol === 'responses'
      ? [{id: 'fc_authorization_race', type: 'function_call', call_id: id, name, arguments: argumentsJson, status: 'completed'}]
      : {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: argumentsJson}}]}};
}
async function until<T>(check: () => T | false): Promise<T> {
  for (let count = 0; count < 300; count++) {
    const value = check();
    if (value !== false) return value;
    await delay(2);
  }
  assert.fail('The bounded synthetic authorization run did not settle');
}

async function fixture(t: TestContext, protocol: AgentProtocol) {
  // macOS exposes tmpdir through a symlink; the real sidecar requires canonical ownership.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-authorization-race-'));
  let store = openStore(root), inspector = createInspectionServices(store);
  const project = await createServices(store, new Map()).call('project.create', {name: 'SYNTHETIC_AUTHORIZATION_PROJECT'}) as {id: string};
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await settings.get();
  await settings.put({expectedRevision: initial.revision, configuration: {...initial.configuration, protocol},
    secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_LOCAL_AUTHORIZATION_TEST'}});
  const authorizations = createTestAuthorizations(() => ({root: store.root, db: store.db}), settings), calls: AgentDispatchOptions[] = [];
  const counts = {contexts: 0, reads: 0};
  let afterFirstResponse: (() => Promise<void>) | undefined;
  let afterTransaction: ((value: unknown) => void) | undefined;
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const gateway = async function* (options: AgentDispatchOptions) {
    calls.push(options);
    if (calls.length === 1) {
      await firstGate;
      yield toolDone(protocol);
      // Complete the real revoke before the iterator returns control to the runner.
      await afterFirstResponse?.();
    } else {
      yield {type: 'delta' as const, text: 'SYNTHETIC_AUTHORIZED_ANSWER'};
      yield {type: 'done' as const, finishReason: 'stop' as const};
    }
  };
  function observeTransactions(current: WorkspaceStore): void {
    const transact = current.tx;
    current.tx = <T>(operation: () => T): T => {
      const saved = transact(operation);
      afterTransaction?.(saved);
      return saved;
    };
  }
  observeTransactions(store);
  const start = () => createChatRuntime({store, agentSettings: settings, authorizations, gateway,
    selfPort: () => 4318, mode: 'simulated', inspection: {
      createContext(input) { counts.contexts++; return inspector.createContext(input); },
      dispatch(context, operation, arguments_) {
        counts.reads++;
        assert.ok(context && typeof context === 'object');
        return inspector.dispatch(context, operation, arguments_);
      },
    }});
  let runtime = start();
  t.after(async () => {runtime.close(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const target = () => {
    const configuration = initial.configuration;
    return {destination: deriveAgentEndpoint({...configuration, protocol}), model: configuration.model, scope: 'project_inspection'};
  };
  async function revoke(): Promise<void> {
    const listed = await authorizations.list();
    const grant = listed.authorizations.find(row => row.scope === 'project_inspection');
    assert.ok(grant);
    await authorizations.revoke({requestId: randomUUID(), expectedRevision: listed.revision, authorizationId: grant.id});
    assert.throws(() => authorizations.assertAuthorized(target()), {code: 'AGENT_AUTHORIZATION_REQUIRED'});
    assert.equal((await authorizations.list()).authorizations.some(row => row.id === grant.id), false);
  }
  async function stagedRevocation(): Promise<() => void> {
    const file = path.join(root, AGENT_AUTHORIZATION_FILENAME);
    const allowed = readPrivateFile(file, {root, private: true});
    assert.ok(Buffer.isBuffer(allowed));
    await revoke();
    const revoked = readPrivateFile(file, {root, private: true});
    assert.ok(Buffer.isBuffer(revoked));
    writePrivateFileAtomic(file, allowed, {root});
    authorizations.assertAuthorized(target());
    // Intent publication and the two capture transactions are synchronous. A
    // fire-and-forget revoke in a listener would run too late and give a false
    // race test. Install a valid snapshot produced by the real revoke API at
    // that precise boundary, then verify the real authorizer sees it revoked.
    return () => {
      writePrivateFileAtomic(file, revoked, {root});
      assert.throws(() => authorizations.assertAuthorized(target()), {code: 'AGENT_AUTHORIZATION_REQUIRED'});
    };
  }
  return {
    get runtime() {return runtime;}, get store() {return store;}, root, project, calls, counts,
    releaseFirst, revoke, stagedRevocation,
    afterFirstResponse(callback: () => Promise<void>) {afterFirstResponse = callback;},
    afterTransaction(callback: (value: unknown) => void) {afterTransaction = callback;},
    async input() {
      await authorizeTestScope(authorizations, 'project_inspection');
      const snapshot = await runtime.snapshot(project.id), {available, ...policy} = snapshot.inspection;
      const epoch: Record<string, unknown> = snapshot, {instanceId, revision} = epoch;
      assert.ok(typeof instanceId === 'string' && typeof revision === 'number');
      assert.equal(available, true);
      return {requestId: randomUUID(), instanceId, expectedSettingsRevision: snapshot.settings.revision,
        expectedConversationRevision: revision, message: 'Inspect this synthetic project',
        consent: {destination: target().destination, model: target().model, protocol, context: 'project_inspection', projectId: project.id, ...policy}};
    },
    finish(sent: RunResponse) {
      return until(() => {const result = response(runtime.get(project.id, sent.run.id, sent.instanceId)); return result.run.status !== 'running' && result;});
    },
    steps(runId: string): ChatStep[] {
      return store.db.prepare('SELECT data FROM agent_chat_steps WHERE runId=? ORDER BY position').all(runId).map(row => {
        assert.ok(typeof row.data === 'string'); return JSON.parse(row.data) as ChatStep;
      });
    },
    reopen() {
      runtime.close(); store.close(); store = openStore(root); inspector = createInspectionServices(store); observeTransactions(store); runtime = start();
    },
  };
}

for (const protocol of ['chat_completions', 'responses'] as const) {
  for (const boundary of ['response_finished', 'intent_published', 'dispatch_started_committed'] as const) {
    test(`${protocol}: completed revocation at ${boundary} prevents the read and continuation`, async t => {
      const f = await fixture(t, protocol), input = await f.input();
      let revoked = false;
      const install = boundary === 'response_finished' ? undefined : await f.stagedRevocation();
      const revokeInside = () => {assert.ok(install); install(); revoked = true;};
      if (boundary === 'response_finished') f.afterFirstResponse(async () => {await f.revoke(); revoked = true;});
      if (boundary === 'dispatch_started_committed') f.afterTransaction(value => {
        const step = (value as {step?: ChatStep} | null)?.step;
        if (!revoked && step?.kind === 'tool' && step.status === 'dispatch_started') {
          const persisted = f.store.db.prepare('SELECT data FROM agent_chat_steps WHERE id=?').get(step.id);
          assert.ok(persisted && typeof persisted.data === 'string');
          assert.equal((JSON.parse(persisted.data) as ChatStep).status, 'dispatch_started');
          revokeInside();
        }
      });
      const sent = response(await f.runtime.send(f.project.id, input));
      if (boundary === 'intent_published') f.runtime.subscribe(f.project.id, sent.run.id, sent.instanceId, 0, (value: unknown) => {
        const event = value as {run?: RunView};
        if (!revoked && event.run?.activity.some(step => step.kind === 'tool' && step.status === 'intent')) {
          const persisted = f.store.db.prepare("SELECT data FROM agent_chat_steps WHERE runId=? AND kind='tool'").get(sent.run.id);
          assert.ok(persisted && typeof persisted.data === 'string');
          assert.equal((JSON.parse(persisted.data) as ChatStep).status, 'intent');
          revokeInside();
        }
      }, undefined);
      f.releaseFirst();
      const ended = await f.finish(sent);
      assert.equal(revoked, true, `The revoke must finish at ${boundary}`);
      assert.equal(f.counts.reads, 0, 'Revoked project metadata must never be read');
      assert.equal(f.calls.length, 1, 'Revoked tool output must never be sent to a continuation');
      if (boundary !== 'dispatch_started_committed') assert.equal(f.counts.contexts, 0);
      assert.equal(ended.run.status, 'failed');
      assert.equal(ended.run.error?.code, 'AGENT_CHAT_CONSENT_REQUIRED');
      const steps = f.steps(sent.run.id);
      assert.equal(steps.filter(step => step.kind === 'model').length, 1, 'No continuation may be prepared after revocation');
      assert.equal(steps.filter(step => step.kind === 'tool').length, boundary === 'response_finished' ? 0 : 1,
        'A revocation completed before intent must prevent creating the tool intent');
      for (const step of steps.filter(step => step.kind === 'tool')) {
        assert.equal(step.status, 'unknown'); assert.equal(step.observation, undefined);
      }
      const replay = response(await f.runtime.send(f.project.id, input));
      assert.equal(replay.replayed, true); assert.equal(replay.run.id, sent.run.id);
      const beforeReopen = {...f.counts, models: f.calls.length};
      f.reopen();
      const restored = response(f.runtime.lookup(f.project.id, input.requestId));
      assert.equal(restored.run.status, 'failed'); assert.equal(restored.run.error?.code, 'AGENT_CHAT_CONSENT_REQUIRED');
      assert.deepEqual(restored.run, ended.run);
      await assert.rejects(f.runtime.send(f.project.id, input), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
      assert.deepEqual({...f.counts, models: f.calls.length}, beforeReopen, 'Replay and reopening must never repeat the read or model dispatch');
    });
  }

  test(`${protocol}: a retained authorization completes one read and two durable model requests`, async t => {
    const f = await fixture(t, protocol), input = await f.input(), sent = response(await f.runtime.send(f.project.id, input));
    f.releaseFirst();
    const ended = await f.finish(sent);
    assert.equal(ended.run.status, 'completed'); assert.equal(f.counts.contexts, 1); assert.equal(f.counts.reads, 1); assert.equal(f.calls.length, 2);
    assert.equal((f.calls[1].readTools as {phase: string}).phase, 'answer');
    assert.match((f.calls[1].readTools as {result: string}).result, /SYNTHETIC_AUTHORIZATION_PROJECT/);
    assert.equal(ended.run.activity.length, 3); assert.ok(ended.run.activity.every(step => step.status === 'completed'));
    assert.equal(response(await f.runtime.send(f.project.id, input)).replayed, true);
    f.reopen();
    assert.equal(response(f.runtime.lookup(f.project.id, input.requestId)).run.status, 'completed');
    assert.equal(f.counts.reads, 1); assert.equal(f.calls.length, 2);
  });

  test(`${protocol}: an unreadable authorization after intent fails closed and retains evidence`, async t => {
    const f = await fixture(t, protocol), input = await f.input(), sent = response(await f.runtime.send(f.project.id, input));
    const file = path.join(f.root, AGENT_AUTHORIZATION_FILENAME), corrupt = '{SYNTHETIC_CORRUPT_AUTHORIZATION';
    let corrupted = false;
    f.runtime.subscribe(f.project.id, sent.run.id, sent.instanceId, 0, (value: unknown) => {
      const event = value as {run?: RunView};
      if (!corrupted && event.run?.activity.some(step => step.kind === 'tool' && step.status === 'intent')) {
        writePrivateFileAtomic(file, corrupt, {root: f.root}); corrupted = true;
      }
    }, undefined);
    f.releaseFirst();
    const ended = await f.finish(sent);
    assert.equal(corrupted, true); assert.equal(ended.run.status, 'failed');
    assert.equal(ended.run.error?.code, 'AGENT_CHAT_STORAGE_UNAVAILABLE');
    assert.equal(f.counts.contexts, 0); assert.equal(f.counts.reads, 0); assert.equal(f.calls.length, 1);
    assert.equal(readPrivateFile(file, {root: f.root, private: true, encoding: 'utf8'}), corrupt);
    const steps = f.steps(sent.run.id);
    assert.equal(steps.filter(step => step.kind === 'model').length, 1);
    assert.equal(steps.find(step => step.kind === 'tool')?.observation, undefined);
    f.reopen();
    assert.equal(response(f.runtime.lookup(f.project.id, input.requestId)).run.error?.code, 'AGENT_CHAT_STORAGE_UNAVAILABLE');
    assert.equal(f.counts.reads, 0); assert.equal(f.calls.length, 1);
    assert.equal(readPrivateFile(file, {root: f.root, private: true, encoding: 'utf8'}), corrupt);
  });
}
