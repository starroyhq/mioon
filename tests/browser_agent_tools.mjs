/** Actual-UI acceptance entry points for the bounded read-tool increment.
 * Import these in the supported CUA runtime after the fresh app build and
 * --tools fixture are ready. This module does not launch a browser or fixture.
 * All UI actions use supported locators; evaluate is observation-only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { responsesBrowserHarness, runRightDockDrafts } from './browser_agent_responses.mjs';
import { finishChatBrowser } from './browser_agent_chat.mjs';

const countRequests = audit => audit.mock.requests.length;
const last = snapshot => snapshot.runs.at(-1);
const sourceMode = run => run.contextMode || 'typed_chat_only';
const toolSteps = run => (run.activity || []).filter(step => step.kind === 'tool');
const modelSteps = run => (run.activity || []).filter(step => step.kind === 'model');
const root = (h, id) => h.tab.playwright.locator(`[data-run-id="${id}"][data-history-kind="recent"]`);

export async function toolsBrowserHarness(tab) {
  const h = await responsesBrowserHarness(tab, { iteration: 'tools' });
  const changeProtocol = h.protocol;
  h.protocol = async value => {
    // Saving an unchanged settings draft is deliberately disabled in the app.
    if ((await h.configuration()).configuration.protocol === value) return;
    return changeProtocol(value);
  };
  let selectedProjectId = h.fixture.project.id;
  h.current = () => h.snapshot(selectedProjectId);
  h.finalRun = (status, projectId = selectedProjectId) => h.waitFor(async () => { const run = last(await h.snapshot(projectId)); return run && (status ? run.status === status : run.status !== 'running') ? run : false; }, `terminal tool run ${status || ''}`);
  const switchProject = async project => {
    await h.close(); await h.tab.playwright.getByTestId('project-switcher').click();
    await h.tab.playwright.getByRole('menuitem', { name: project.name, exact: false }).click();
    selectedProjectId = project.id; await h.open();
    assert.equal(await h.tid('dialog').getAttribute('data-project-id'), project.id);
  };
  Object.assign(h.report, { integrationBaseline: '8341029', scope: 'chat_and_project_inspection', persistence: 'local_database',
    toolLimit: 1, modelRequestLimit: 2, claim: 'actual scoped read-only Agent flow against a synthetic local provider' });
  const chooseMode = async mode => {
    await h.waitFor(async () => await h.phase() === 'ready', 'ready for explicit context choice');
    const choice = h.tid(mode === 'project_inspection' ? 'mode-project' : 'mode-typed');
    if (!await choice.evaluate(element => element.checked)) await choice.click();
    assert.equal(await choice.evaluate(element => element.checked), true);
  };
  const sendInMode = async (text, mode = 'project_inspection') => {
    await chooseMode(mode);
    const previous = last(await h.current()), before = await h.audit();
    await h.tid('prompt').fill(text);
    if (!await h.tid('consent').evaluate(element => element.checked)) await h.tid('consent').click();
    await h.waitFor(async () => await h.tid('send').evaluate(element => !element.disabled), 'explicit scoped send enabled');
    await h.tid('send').click();
    const accepted = await h.waitFor(async () => { const run = last(await h.current()); return run && run.id !== previous?.id && run.userText === text ? run : false; }, 'one accepted scoped run');
    assert.equal(sourceMode(accepted), mode);
    await h.waitFor(async () => countRequests(await h.audit()) > countRequests(before), 'accepted inference begins');
    return { accepted, before };
  };
  const shownRun = async run => {
    await h.waitFor(async () => await h.phase() === 'ready', 'terminal activity shown in dock');
    await root(h, run.id).waitFor({ state: 'visible', timeoutMs: 10000 });
  };
  return { ...h, chooseMode, sendInMode, shownRun, switchProject, projectId: () => selectedProjectId };
}

export async function runToolsDefaultConsent(h) {
  await h.open(); const before = await h.audit(), snapshot = await h.current();
  assert.equal(snapshot.scope, 'chat_and_project_inspection'); assert.equal(snapshot.persistence, 'local_database');
  assert.equal(snapshot.inspection.available, true); assert.equal(snapshot.inspection.maxModelRequests, 2); assert.equal(snapshot.inspection.maxToolCalls, 1); assert.equal(snapshot.inspection.maxResultBytes, 8192);
  assert.equal(await h.tid('mode-typed').evaluate(element => element.checked), true);
  assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
  await h.tid('prompt').fill('未发送：只读项目检查需要我的明确选择');
  assert.equal(await h.tid('send').getAttribute('disabled'), '');
  await h.tid('consent').click(); await h.tid('mode-project').click();
  assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
  assert.equal(await h.tid('send').getAttribute('disabled'), '');
  const text = await h.tid('destination').textContent(); assert.ok(text.includes(snapshot.settings.configuration.model));
  assert.match(text, /2 次模型请求/); assert.match(text, /1 次只读工具调用/);
  await h.capture('tools-01-project-scope-destination-and-unchecked-consent.jpg');
  await h.tid('details-toggle').click();
  assert.match(await h.tid('details').textContent(), /隐藏窗口/); assert.match(await h.tid('details').textContent(), /重启后不会自动/);
  await h.capture('tools-02-expanded-storage-scope-and-lifecycle-details.jpg');
  await h.tid('details-toggle').click(); await h.tid('prompt').fill(''); await h.chooseMode('typed_chat_only');
  assert.equal(countRequests(await h.audit()), countRequests(before));
  await h.log('Opening, typing, choosing scope and reading details make no inference request; project inspection invalidates typed-chat approval and requires exact destination/project/limit consent');
}

export async function runToolsDraftRetention(h) {
  await h.chooseMode('typed_chat_only'); await h.protocol('responses');
  await runRightDockDrafts(h);
  await h.tid('prompt').fill('');
  await h.log('Read-tool UI retains existing draft, right-dock tab, collapse, inline settings and Editing/Canvas behavior with no automatic send');
}

const resultDigest = text => createHash('sha256').update(text).digest('hex');
async function completedTool(h, sent, operation) {
  const run = await h.finalRun('completed'); await h.shownRun(run);
  assert.equal(run.id, sent.accepted.id); assert.equal(sourceMode(run), 'project_inspection');
  assert.equal(run.provenance.projectId, h.projectId());
  assert.equal(toolSteps(run).length, 1); assert.equal(toolSteps(run)[0].status, 'completed');
  assert.equal(toolSteps(run)[0].operation, operation); assert.equal(modelSteps(run).length, 2);
  const result = toolSteps(run)[0].resultJson, value = JSON.parse(result);
  assert.equal(value.kind, 'untrusted_project_inspection'); assert.equal(value.operation, operation);
  const after = await h.audit(), requests = after.mock.requests.slice(countRequests(sent.before));
  assert.equal(requests.length, 2); assert.deepEqual(requests.map(request => request.phase), ['request', 'answer']);
  assert.ok(requests.every(request => request.protocol === run.configuration.protocol));
  assert.equal(requests[1].resultHash, resultDigest(result));
  assert.equal(requests[1].resultBytes, Buffer.byteLength(result));
  const evidence = after.agent.runs.find(value => value.id === run.id); assert.ok(evidence);
  const models = evidence.steps.filter(step => step.kind === 'model'), tools = evidence.steps.filter(step => step.kind === 'tool');
  assert.equal(models.length, 2); assert.equal(tools.length, 1);
  assert.deepEqual(models.map(step => step.bodyHash), requests.map(request => request.requestHash));
  assert.equal(tools[0].resultHash, requests[1].resultHash);
  return { run, value, requests };
}
async function showResult(h, run) {
  const selector = `[data-run-id="${run.id}"][data-history-kind="recent"]`;
  await h.tab.playwright.locator(`${selector} [data-testid="agent-tool-result-toggle"]`).click();
  await h.tab.playwright.locator(`${selector} [data-testid="agent-tool-result"]`).waitFor({ state: 'visible', timeoutMs: 10000 });
  const observed = await root(h, run.id).evaluate(element => ({ text: element.textContent,
    activeElements: element.querySelectorAll('a, img, script, iframe, video, audio').length }));
  assert.equal(observed.activeElements, 0); assert.ok(observed.text.includes(toolSteps(run)[0].resultJson));
  return observed;
}

export async function runToolsBothProtocolReads(h) {
  const results = [];
  for (const protocol of ['chat_completions', 'responses']) {
    await h.protocol(protocol);
    for (const name of ['project', 'asset', 'shot', 'timeline']) {
      const sent = await h.sendInMode(`mock:${name} 只读检查当前项目 ${protocol} ${name}`);
      const result = await completedTool(h, sent, `${name}.inspect`);
      if (name === 'project') assert.equal(result.value.data.id, h.fixture.project.id);
      if (['asset', 'shot'].includes(name)) assert.ok(Array.isArray(result.value.data.items));
      if (name === 'timeline') assert.ok(result.value.data === null || Array.isArray(result.value.data.tracks));
      await showResult(h, result.run);
      if (name === 'project') await h.capture(`tools-03-${protocol}-actual-project-result.jpg`);
      results.push({ protocol, operation: `${name}.inspect`, runId: result.run.id, resultHash: resultDigest(toolSteps(result.run)[0].resultJson) });
    }
  }
  await h.log('Both protocols completed project, asset, shot and timeline read operations through real scoped runtime; each saved result matches the second request hash, with one persisted read step and exactly two HTTP requests', { results });
}

export async function runToolsInertResultAndTypedContext(h) {
  await h.protocol('responses'); await h.switchProject(h.fixture.secondProject);
  const sent = await h.sendInMode('mock:project mock:hostileresult 展示已保存的不可信文字');
  const { run, requests } = await completedTool(h, sent, 'project.inspect');
  const observed = await showResult(h, run);
  assert.ok(h.fixture.inspectionMarker, 'Synthetic saved marker must be seeded before the initial domain hash');
  assert.ok(toolSteps(run)[0].resultJson.includes(h.fixture.inspectionMarker));
  assert.ok(observed.text.includes('<img'));
  assert.equal(requests[1].containsInspectionMarker, true);
  await h.capture('tools-04-saved-hostile-result-and-answer-are-inert-text.jpg');
  const typed = await h.sendInMode('mock:nocall 现在只讨论我输入的这句话', 'typed_chat_only');
  const typedRun = await h.finalRun('completed'); await h.shownRun(typedRun);
  const sentRequests = (await h.audit()).mock.requests.slice(countRequests(typed.before));
  assert.equal(sentRequests.length, 1); assert.equal(sentRequests[0].phase, 'typed');
  assert.equal(sentRequests[0].containsInspectionMarker, false);
  assert.equal(sentRequests[0].containsDerivedAnswer, false); assert.equal(sentRequests[0].containsInspectionResult, false);
  assert.equal(sourceMode(typedRun), 'typed_chat_only'); assert.equal(toolSteps(typedRun).length, 0);
  assert.match(await root(h, run.id).textContent(), /不加入纯聊天上下文/);
  await h.capture('tools-05-typed-mode-keeps-old-provenance-without-resending-project-text.jpg');
  await h.switchProject(h.fixture.project);
  await h.log('Saved hostile project text and model HTML remain inert; switching to typed mode sends one request with no seeded project marker, while retained project-derived history keeps its provenance label');
}

export async function runToolsHiddenBoundedRun(h) {
  await h.protocol('chat_completions');
  const sent = await h.sendInMode('mock:project mock:slowfirst 隐藏后仍只允许原项目的一次读取');
  assert.equal(toolSteps(last(await h.current())).length, 0);
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click();
  assert.equal(await h.tid('prompt').isVisible(), false);
  await h.tab.playwright.getByTestId('right-dock-tab-agent').click();
  const otherBefore = (await h.snapshot(h.fixture.secondProject.id)).runs;
  await h.switchProject(h.fixture.secondProject);
  assert.deepEqual((await h.current()).runs, otherBefore);
  await h.releaseToolBoundary('first');
  const original = await h.finalRun('completed', h.fixture.project.id);
  assert.equal(original.id, sent.accepted.id); assert.equal(original.projectId, h.fixture.project.id);
  assert.equal(toolSteps(original).length, 1); assert.equal(modelSteps(original).length, 2);
  assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 2);
  assert.deepEqual((await h.current()).runs, otherBefore);
  await h.capture('tools-06-navigation-keeps-accepted-run-on-original-project.jpg');
  await h.switchProject(h.fixture.project);
  await h.shownRun(original); await showResult(h, original);
  assert.equal(await h.tid('mode-typed').evaluate(element => element.checked), true);
  assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
  assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 2);
  await h.capture('tools-07-reopened-run-restores-original-project-result.jpg');
  await h.log('Tabs, collapse and project navigation detach display only; original accepted run completes its single read and two-request bound, other project history stays unchanged, reopening never starts inference');
}

export async function runToolsStopBoundaries(h) {
  const outcomes = [];
  for (const [protocol, mode, expectedRequests, expectedTools] of [
    ['chat_completions', 'toolsfragmenthold', 1, 0], ['responses', 'slowanswer', 2, 1],
  ]) {
    await h.protocol(protocol);
    const sent = await h.sendInMode(`mock:project mock:${mode} 停止后续步骤 ${protocol}`);
    await h.waitFor(async () => countRequests(await h.audit()) === countRequests(sent.before) + expectedRequests, 'held bounded phase');
    if (expectedTools) await h.waitFor(async () => last(await h.current()).assistantText.length > 0 && toolSteps(last(await h.current()))[0]?.status === 'completed', 'saved read result and partial second answer');
    else assert.equal(toolSteps(last(await h.current())).length, 0);
    await h.tid('stop').click(); const stopped = await h.finalRun('stopped'); await h.shownRun(stopped);
    await h.waitFor(async () => (await h.audit()).mock.active === 0, 'Stop closes synthetic upstream');
    assert.equal(stopped.id, sent.accepted.id); assert.equal(toolSteps(stopped).length, expectedTools);
    assert.equal(countRequests(await h.audit()), countRequests(sent.before) + expectedRequests);
    assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
    await h.close(); await h.open();
    assert.equal(countRequests(await h.audit()), countRequests(sent.before) + expectedRequests);
    await h.capture(`tools-08-stop-${mode}-preserves-truthful-activity.jpg`);
    outcomes.push({ protocol, phase: mode, requests: expectedRequests, savedTools: expectedTools, runId: stopped.id });
  }
  await h.log('Stop during incomplete tool arguments prevents any saved read/continuation; Stop during the answer retains its completed read and partial text with no third request or restart on reopen', { outcomes });
}

/** observerTab must be a second authenticated tab on this same disposable app.
 * The caller obtains/navigates it with the supported browser tab API. */
export async function runToolsLostAckTwoWindows(h, observerTab) {
  assert.ok(observerTab, 'A second supported browser tab is required for the two-window observation');
  await h.protocol('responses'); await h.fault({ kind: 'drop' });
  const sent = await h.sendInMode('mock:project mock:slowfirst 丢失发送确认，另一个窗口只读取');
  const fault = await h.waitFault(); assert.equal(fault.status, 200); assert.equal(fault.result.data.run.id, sent.accepted.id);
  const observer = await toolsBrowserHarness(observerTab); await observer.open();
  assert.equal(last(await observer.current()).id, sent.accepted.id);
  assert.equal(await observer.tid('consent').evaluate(element => element.checked), false);
  assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 1);
  await h.releaseToolBoundary('first');
  const result = await completedTool(h, sent, 'project.inspect'); await observer.shownRun(result.run);
  assert.equal(last(await observer.current()).id, result.run.id);
  assert.equal(toolSteps(last(await observer.current())).length, 1);
  assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 2);
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '');
  await showResult(h, result.run); await h.capture('tools-09-lost-acknowledgement-two-windows-one-accepted-run.jpg');
  await observer.close();
  await h.log('Dropped accepted acknowledgement and a second UI window converge on the same run through reads; one persisted read result and exactly two provider POSTs, with no duplicate accepted request');
}

export async function runToolsRestartPartialAnswer(h) {
  await h.protocol('responses');
  const sent = await h.sendInMode('mock:project mock:slowanswer 重启后保留读取结果，不自动继续');
  const before = await h.waitFor(async () => { const snapshot = await h.current(), run = last(snapshot); return run.assistantText && toolSteps(run)[0]?.status === 'completed' && modelSteps(run).length === 2 ? snapshot : false; }, 'durably saved result and partial answer');
  const saved = last(before); assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 2);
  await h.capture('tools-10-partial-answer-before-restart.jpg');
  await h.tid('prompt').fill('重启后仍保留的未发送草稿');
  const restart = await h.restart(); assert.ok(restart.restarted);
  await h.close(); await h.open();
  const after = await h.current(), restored = after.runs.find(run => run.id === saved.id);
  assert.notEqual(after.instanceId, before.instanceId); assert.equal(after.threadId, before.threadId);
  assert.equal(restored.status, 'interrupted'); assert.equal(restored.contextMode, 'project_inspection');
  assert.deepEqual(restored.provenance, saved.provenance); assert.equal(toolSteps(restored)[0].resultJson, toolSteps(saved)[0].resultJson);
  assert.ok(restored.assistantText.startsWith(saved.assistantText));
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '重启后仍保留的未发送草稿');
  await h.waitFor(async () => (await h.audit()).mock.active === 0, 'restart closes pending synthetic answer');
  assert.equal(countRequests(await h.audit()), countRequests(sent.before) + 2);
  await showResult(h, restored); await h.capture('tools-11-interrupted-answer-retains-result-provenance-without-resume.jpg');
  await h.tid('prompt').fill('');
  await h.log('Restart during the second model request restores interrupted partial text, immutable project provenance and the committed read result; mounted draft survives and no inference resumes', { restartMs: restart.durationMs, runId: restored.id });
}

export async function finishToolsBrowser(h) {
  h.report.protocols = ['chat_completions', 'responses']; h.report.presentation = 'shared right dock, no modal';
  return finishChatBrowser(h);
}
