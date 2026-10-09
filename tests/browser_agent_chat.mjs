/** Actual own-cloud browser acceptance; UI actions use supported CUA locators.
 * The only inference peer is the local synthetic Ollama-shaped fixture. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chatQaClient} from './agent-chat-qa-client.mjs';

export async function chatBrowserHarness(tab, {iteration = 'chat', inline = false} = {}) {
  const q = await chatQaClient({iteration}), outDir = path.join(q.root, 'browser'); await mkdir(outDir, {recursive: true});
  const report = {startedAt: new Date().toISOString(), featureBaseline: '66a0193', integrationBaseline: iteration === 'durable' ? '9716677' : iteration === 'responses' ? '3db1a02' : '80334cf', scope: 'chat_only', persistence: iteration === 'durable' ? 'local_database' : 'backend_session', inference: 'synthetic local HTTP fixture through production gateway', realProviderCalls: 0, checks: [], screenshots: []};
  const saveReport = () => writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const log = async (name, detail = {}) => { report.checks.push({name, passed: true, ...detail}); await saveReport(); };
  const capture = async name => { const bytes = await tab.getScreenshot({emit: false}); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216); await writeFile(path.join(outDir, name), bytes); report.screenshots.push(name); await saveReport(); };
  const tid = name => tab.playwright.getByTestId(`agent-chat-${inline && name === 'dialog' ? 'page' : name}`);
  const phase = () => tid('dialog').getAttribute('data-phase');
  const open = async () => { await tid('open').click(); await tid('prompt').waitFor({state: 'visible', timeoutMs: 15000}); await q.waitFor(async () => ['ready', 'streaming'].includes(await phase()), 'chat panel ready'); };
  const close = async () => { await tid('close').click(); await tid('dialog').waitFor({state: 'hidden', timeoutMs: 10000}); };
  const current = () => q.snapshot();
  const finalRun = async (status, projectId = q.fixture.project.id) => q.waitFor(async () => { const run = (await q.snapshot(projectId)).runs.at(-1); return run && (status ? run.status === status : run.status !== 'running') ? run : false; }, `terminal run ${status || ''}`);
  const send = async text => {
    await q.waitFor(async () => await phase() === 'ready', 'ready to send explicitly');
    const before = (await q.audit()).mock.requests.length;
    await tid('prompt').fill(text);
    if (!await tid('consent').evaluate(element => element.checked)) await tid('consent').click();
    await q.waitFor(async () => await tid('send').evaluate(element => !element.disabled), 'explicit send enabled');
    await tid('send').click();
    await q.waitFor(async () => (await q.audit()).mock.requests.length === before + 1, 'one synthetic inference POST');
    return (await current()).runs.at(-1);
  };
  return {...q, tab, outDir, report, saveReport, log, capture, tid, phase, open, close, current, finalRun, send, initial: await q.audit()};
}

export async function runChatConsentAndStop(h) {
  await h.open(); const first = await h.current();
  assert.equal(first.scope, 'chat_only'); assert.equal(first.persistence, 'session'); assert.equal(first.runs.length, 0);
  assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
  await h.tid('prompt').fill('mock:slow 请用中文讨论一个镜头想法。');
  assert.equal(await h.tid('send').getAttribute('disabled'), '');
  assert.equal((await h.audit()).mock.requests.length, h.initial.mock.requests.length);
  await h.capture('01-explicit-destination-consent.jpg');
  await h.send('mock:slow 请用中文讨论一个镜头想法。');
  await h.waitFor(async () => (await h.current()).runs.at(-1)?.assistantText.includes('聊天文字'), 'partial streaming text');
  await h.capture('02-synthetic-streaming.jpg');
  await h.tid('stop').click(); const stopped = await h.finalRun('stopped');
  assert.ok(stopped.assistantText); await h.waitFor(async () => await h.phase() === 'ready', 'stop acknowledgement');
  await h.capture('03-stopped-partial-billing-warning.jpg');
  await h.waitFor(async () => (await h.audit()).mock.active === 0, 'mock upstream socket closed');
  const after = await h.current(); assert.equal(after.runs.at(-1).assistantText, stopped.assistantText);
  await h.log('Opening/typing does not call model; explicit visible destination/context consent starts one real local HTTP request; Stop closes upstream and retains truthful partial output');
}

export async function runChatFailureAndOutput(h) {
  await h.send('mock:truncated 测试截断。'); const truncated = await h.finalRun('failed'); assert.ok(truncated.assistantText); assert.ok(truncated.error);
  await h.waitFor(async () => await h.phase() === 'ready', 'truncation visible'); await h.capture('04-truncated-stream-preserves-partial.jpg');
  await h.send('mock:tools 尝试工具输出。'); const tools = await h.finalRun('failed'); assert.equal(tools.error.code, 'AGENT_CHAT_TOOLS_UNSUPPORTED');
  await h.send('mock:hostile 请显示模拟的不可信文本。'); const hostile = await h.finalRun('completed'); assert.ok(hostile.assistantText.includes('<img'));
  await h.waitFor(async () => await h.phase() === 'ready', 'hostile output rendered');
  const dom = await h.tid('history').evaluate(element => ({images: element.querySelectorAll('img').length, text: element.textContent}));
  assert.equal(dom.images, 0); assert.ok(dom.text.includes('<img src=')); await h.capture('05-hostile-output-is-inert-text.jpg');
  await h.log('Truncated streams fail with partial output; returned function calls are rejected without execution; model HTML/instructions render as inert text');
}

export async function runChatLostAck(h) {
  const before = (await h.audit()).mock.requests.length;
  await h.fault({kind: 'drop'}); await h.send('mock:slow 测试保存响应丢失，只发送一次。');
  const observed = await h.waitFault(); assert.equal(observed.status, 200);
  await h.waitFor(async () => ['streaming', 'ready'].includes(await h.phase()), 'lost acknowledgement read reconciliation');
  assert.equal((await h.audit()).mock.requests.length, before + 1);
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '');
  await h.capture('06-lost-acknowledgement-no-resend.jpg');
  await h.tid('stop').click(); await h.finalRun('stopped');
  await h.log('An accepted send with dropped HTTP acknowledgement is found by stable request identity through reads; only one inference POST occurs');
}

export async function runChatDetachAndProjects(h) {
  await h.send('mock:slow 关闭窗口和切换项目后继续原来这一条。');
  const before = (await h.current()).runs.at(-1), requests = (await h.audit()).mock.requests.length;
  await h.close(); await h.open(); assert.equal((await h.current()).runs.at(-1).id, before.id); assert.equal((await h.audit()).mock.requests.length, requests);
  await h.close(); await h.tab.playwright.getByTestId('project-switcher').click();
  await h.tab.playwright.getByRole('menuitem', {name: h.fixture.secondProject.name, exact: false}).click();
  await h.open(); assert.equal(await h.tid('dialog').getAttribute('data-project-id'), h.fixture.secondProject.id);
  assert.equal((await h.snapshot(h.fixture.secondProject.id)).runs.length, 0);
  await h.capture('07-navigation-isolates-project-conversation.jpg');
  const original = await h.snapshot(); assert.equal(original.runs.at(-1).id, before.id);
  const stopped = await h.request(h.route(h.fixture.project.id) + `/runs/${before.id}/stop`, {method: 'POST', body: JSON.stringify({instanceId: original.instanceId})}); assert.equal(stopped.status, 200);
  assert.equal((await h.snapshot(h.fixture.secondProject.id)).runs.length, 0); assert.equal((await h.audit()).mock.requests.length, requests);
  await h.close(); await h.tab.playwright.getByTestId('project-switcher').click();
  await h.tab.playwright.getByRole('menuitem', {name: h.fixture.project.name, exact: false}).click(); await h.open();
  assert.equal((await h.current()).runs.at(-1).status, 'stopped');
  await h.log('Dismiss/reopen reattaches to same run without a new request; navigation isolates the other project and the original run never retargets it');
}

export async function runChatHeldAckAndRestart(h) {
  const requests = (await h.audit()).mock.requests.length;
  await h.fault({kind: 'hold'}); await h.send('mock:slow 测试延迟确认与新窗口。'); await h.waitFault();
  await h.close(); await h.open(); await h.tid('prompt').fill('新窗口未发送的草稿'); await h.release();
  await h.waitFor(async () => await h.phase() === 'streaming', 'reopened existing stream');
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '新窗口未发送的草稿'); assert.equal((await h.audit()).mock.requests.length, requests + 1);
  await h.capture('08-late-ack-cannot-replace-new-draft.jpg');
  const oldInstance = (await h.current()).instanceId, restart = await h.restart(); assert.ok(restart.durationMs < 10000);
  await h.waitFor(async () => (await h.current()).instanceId !== oldInstance, 'new backend session');
  await h.close(); await h.open(); assert.equal((await h.current()).runs.length, 0);
  await h.tid('session-lost').waitFor({state: 'visible', timeoutMs: 10000}); await h.capture('09-backend-restart-explicit-session-loss.jpg');
  assert.equal((await h.audit()).mock.requests.length, requests + 1);
  await h.log('Closing a held send and reopening preserves a newer draft against late acknowledgement; backend restart closes active SSE/upstream and shows temporary-history loss without inference retry', {restartMs: restart.durationMs});
}

export async function finishChatBrowser(h) {
  const audit = await h.audit(); assert.equal(audit.domainHash, h.initial.domainHash);
  h.report.finalAudit = audit; h.report.finishedAt = new Date().toISOString();
  await h.log('All chat workflows leave project/media/timeline/job/history records unchanged', {domainHash: audit.domainHash}); return h.report;
}
