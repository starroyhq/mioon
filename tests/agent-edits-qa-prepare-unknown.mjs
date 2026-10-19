/** One genuine approved-before-dispatch crash in this fixture's native database.
 * Run only while Electron is fully closed. The owned real HTTP backend kills
 * only itself at its trusted test boundary. No approved rows are fabricated. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {writeFile, access} from 'node:fs/promises';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {startEditBackend, EDIT_WIRE_TOKEN, chatRoute, editRoute, savedShot, savedProposal, until} from './helpers/agent-edit-wire-fixture.ts';
import {prepareEditQaFixture, assertNativeFixtureClosed, clearEditQaEnvironment, seedEditQaSettings,
  startEditQaModel, editQaAudit, jsonFile} from './helpers/agent-edits-qa-support.ts';

export async function prepareEditsQaUnknown({protocol = 'responses'} = {}) {
  clearEditQaEnvironment(process.env);
  await assertNativeFixtureClosed();
  const fixture = await prepareEditQaFixture('native'), descriptorFile = path.join(fixture.runtime, 'unknown-prepared.json');
  try { await access(descriptorFile); throw Error('This fixture already has a prepared crash; inspect unknown-prepared.json instead of replaying setup'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = await startEditQaModel(fixture, {label: 'prepare-unknown'});
  let backend, crashed = false;
  try {
    // The native main and the temporary real backend use separate ordinary
    // settings stores; both contain only this same synthetic loopback endpoint.
    await seedEditQaSettings(fixture.userData, model.baseUrl, protocol);
    backend = await startEditBackend(fixture.workspace);
    const data = async (route, input, method = input === undefined ? 'GET' : 'POST') => {
      const response = await fetch(backend.url + route, {method, signal: AbortSignal.timeout(12000),
        headers: {authorization: `Bearer ${EDIT_WIRE_TOKEN}`, 'content-type': 'application/json'},
        ...(input === undefined ? {} : {body: JSON.stringify(input)})});
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); return body.data;
    };
    const settings = await data('/api/agent/settings');
    assert.equal(settings.secret.configured, false);
    await data('/api/agent/settings', {expectedRevision: settings.revision,
      configuration: {protocol, presetId: 'ollama', platformId: 'local', baseUrl: model.baseUrl, model: 'qwen3:8b'}, secret: {action: 'remove'}}, 'PUT');
    const projectId = fixture.project.id, shot = savedShot(fixture.workspace, fixture.secondShot.id);
    const before = await editQaAudit(fixture, model, 'unknown-before-proposal');
    const chat = await data(chatRoute(projectId)), {available, ...policy} = chat.edit;
    assert.equal(available, true);
    model.plan({arguments: {title: 'Native crash recovery title 🎬', prompt: 'Synthetic native edit. Apply only when the user explicitly chooses Recover after app recreation.'}});
    const requestId = randomUUID(), input = {requestId, instanceId: chat.instanceId,
      expectedSettingsRevision: chat.settings.revision, expectedConversationRevision: chat.revision,
      message: 'Prepare a synthetic reviewed edit for this selected saved shot.',
      consent: {destination: deriveAgentEndpoint(chat.settings.configuration), protocol, model: 'qwen3:8b',
        context: 'selected_shot_edit', projectId, ...policy, shotId: shot.id, expectedRevision: shot.revision}};
    const sent = await data(`${chatRoute(projectId)}/runs`, input);
    const terminal = await until(async () => {
      const value = await data(`${chatRoute(projectId)}/requests/${requestId}`);
      return value.run.status !== 'running' && value;
    }, 'synthetic native preparation final answer', 15000);
    assert.equal(terminal.run.status, 'completed', JSON.stringify(terminal.run.error));
    const proposals = await data(editRoute(projectId) + '?view=all');
    const proposal = proposals.proposals.find(value => value.runId === sent.run.id);
    assert.ok(proposal); assert.equal(proposal.status, 'pending');
    assert.deepEqual(savedShot(fixture.workspace, shot.id), shot);
    const pending = await editQaAudit(fixture, model, 'unknown-pending-before-approval');
    assert.equal(pending.model.captures.length, 2);
    await backend.arm('afterApproval');
    let acknowledgement;
    try { acknowledgement = await data(editRoute(projectId, proposal.id, 'approve'), {instanceId: proposals.instanceId, digest: proposal.digest}); }
    catch (error) { acknowledgement = {lost: true, error: error.name}; }
    const exit = await backend.exited; crashed = true;
    assert.equal(exit.signal, 'SIGKILL'); assert.equal(acknowledgement.lost, true);
    const record = savedProposal(fixture.workspace, proposal.id);
    assert.equal(record.status, 'approved'); assert.ok(record.approval); assert.equal(record.outcome, null);
    assert.deepEqual(savedShot(fixture.workspace, shot.id), shot);
    const after = await editQaAudit(fixture, model, 'unknown-approved-before-relaunch');
    assert.deepEqual(after.data.shots, before.data.shots);
    assert.deepEqual(after.data.mutation_requests, before.data.mutation_requests);
    const approval = JSON.parse(record.approval);
    const descriptor = {at: new Date().toISOString(), synthetic: true, mode: 'native', workspace: fixture.workspace,
      projectId, shotId: shot.id, proposalId: proposal.id, digest: proposal.digest, requestId: approval.input.requestId,
      runId: sent.run.id, expectedRevision: shot.revision, diff: proposal.diff, mockBaseUrl: model.baseUrl, protocol,
      faultBoundary: 'afterApproval', backendPid: backend.child.pid, exit, storedStatus: record.status,
      expectedStatusAfterOrdinaryNativeStartup: 'unknown', modelSessionId: model.sessionId,
      requiresExplicitUiRecovery: true, domainUnchanged: true, modelRequests: after.model.captures.length};
    await writeFile(path.join(fixture.runtime, 'unknown-prepare-backend.log'), backend.output);
    await jsonFile(descriptorFile, descriptor);
    console.log(JSON.stringify(descriptor, null, 2)); return descriptor;
  } finally {
    if (backend && !crashed) await backend.close();
    await model.close();
    await jsonFile(path.join(fixture.runtime, 'unknown-prepare-exit.json'), {at: new Date().toISOString(), closed: true, crashed, synthetic: true});
  }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) await prepareEditsQaUnknown({protocol: process.argv.includes('--chat-completions') ? 'chat_completions' : 'responses'});
