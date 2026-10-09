/** Supported own-cloud browser acceptance of durable chat. All inference uses
 * the same isolated synthetic HTTP service as the protocol acceptance. */
import assert from 'node:assert/strict';
import {responsesBrowserHarness} from './browser_agent_responses.mjs';
import {finishChatBrowser} from './browser_agent_chat.mjs';

export const durableBrowserHarness = tab => responsesBrowserHarness(tab, {iteration: 'durable'});

export async function runDurableCompletedHistory(h) {
  await h.open();
  assert.match(await h.tid('persistence').textContent(), /本地应用数据库/);
  assert.match(await h.tid('persistence').textContent(), /并非密钥保险库加密/);
  const initial = await h.current();
  assert.equal(initial.persistence, 'local_database'); assert.equal(initial.scope, 'chat_only');
  await h.tid('prompt').fill('未发送草稿：仅本地界面');
  assert.equal((await h.audit()).mock.requests.length, h.initial.mock.requests.length);
  await h.capture('10-local-database-disclosure-and-consent.jpg');
  await h.protocol('chat_completions');
  await h.send('mock:normal 持久化 Chat Completions 已完成对话。');
  const cc = await h.finalRun('completed');
  await h.protocol('responses');
  await h.send('mock:normal 持久化 Responses 已完成对话。');
  const responses = await h.finalRun('completed'), previous = await h.current();
  const count = (await h.audit()).mock.requests.length;
  await h.tid('prompt').fill('后端重启后保留的未发送草稿');
  const restart = await h.restart(); assert.ok(restart.durationMs < 10000);
  await h.close(); await h.open();
  const restored = await h.current();
  assert.notEqual(restored.instanceId, previous.instanceId); assert.equal(restored.threadId, previous.threadId);
  for (const saved of [cc, responses]) {
    const run = restored.runs.find(item => item.id === saved.id);
    assert.equal(run?.assistantText, saved.assistantText); assert.equal(run?.status, 'completed');
    const lookup = await h.request(`${h.route(h.fixture.project.id)}/requests/${saved.requestId}`);
    assert.equal(lookup.status, 200); assert.equal(lookup.data.run.id, saved.id);
  }
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '后端重启后保留的未发送草稿');
  assert.equal((await h.audit()).mock.requests.length, count);
  await h.capture('11-both-protocols-history-restored-after-restart.jpg');
  await h.log('Both protocols persist completed text and stable thread/run/request identities; restart only reads history and keeps mounted unsent draft, without another model POST', {restartMs: restart.durationMs});
}

export async function runDurableActiveRestart(h) {
  await h.send('mock:slow 重启时保留这条 Responses 的已保存部分。');
  await h.waitFor(async () => (await h.current()).runs.at(-1)?.assistantText.includes('聊天文字'), 'committed partial text');
  const before = await h.current(), run = before.runs.at(-1), count = (await h.audit()).mock.requests.length;
  await h.capture('12-active-responses-before-backend-restart.jpg');
  await h.tid('prompt').fill('仍未发送的下一条草稿');
  await h.restart(); await h.close(); await h.open();
  const after = await h.current(), recovered = after.runs.find(item => item.id === run.id);
  assert.equal(after.threadId, before.threadId); assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(recovered.status, 'interrupted'); assert.ok(recovered.assistantText.startsWith(run.assistantText));
  assert.ok(recovered.lastEventId > run.lastEventId);
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '仍未发送的下一条草稿');
  await h.waitFor(async () => (await h.audit()).mock.active === 0, 'upstream closes during restart');
  assert.equal((await h.audit()).mock.requests.length, count);
  await h.capture('13-interrupted-partial-restored-without-resend.jpg');
  await h.log('Active Responses restart persists partial text and interrupted terminal, closes upstream/SSE, fences late responses, and never resumes or re-sends');
}

export async function runDurableLostAcknowledgement(h) {
  const count = (await h.audit()).mock.requests.length;
  await h.fault({kind: 'drop'});
  await h.send('mock:slow 丢失确认后的持久化请求查找。');
  const observed = await h.waitFault(); assert.equal(observed.status, 200);
  await h.restart(); await h.close(); await h.open();
  const current = await h.current(), saved = observed.result.data.run;
  const found = await h.request(`${h.route(h.fixture.project.id)}/requests/${saved.requestId}`);
  assert.equal(found.data.run.id, saved.id); assert.equal(found.data.run.status, 'interrupted');
  assert.equal(found.data.instanceId, current.instanceId);
  assert.equal((await h.audit()).mock.requests.length, count + 1);
  await h.waitFor(async () => await h.phase() === 'ready', 'lost acknowledgment reconciled by reads');
  await h.capture('14-lost-acknowledgement-recovered-after-restart.jpg');
  await h.log('Dropped send acknowledgement is resolved by durable request lookup across backend epoch, with exactly one original inference POST');
}

export async function runDurableOlderHistory(h) {
  for (let index = (await h.current()).runs.length; index < 18; index++) {
    await h.send(`mock:normal 历史分页模拟记录 ${index}`); await h.finalRun('completed');
  }
  const latest = await h.current(); assert.equal(latest.runs.length, 16); assert.ok(latest.historyCursor);
  const count = (await h.audit()).mock.requests.length;
  await h.tid('prompt').fill('查阅历史时保留此未发送草稿');
  await h.tid('history-older').click();
  await h.tid('history-response').first().waitFor({state: 'visible', timeoutMs: 10000});
  assert.ok(await h.tid('history-response').count() <= 16);
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '查阅历史时保留此未发送草稿');
  await h.capture('15-bounded-older-history-read-only.jpg');
  await h.tid('history-close').click();
  assert.equal((await h.audit()).mock.requests.length, count);
  assert.equal((await h.current()).runs.at(-1).id, latest.runs.at(-1).id);
  await h.tid('prompt').fill('');
  await h.log('Older durable history is paged separately in bounded reads, preserving latest conversation/draft and never adding history to outbound context or calling a model');
}

export async function finishDurableBrowser(h) {
  h.report.protocols = ['chat_completions', 'responses'];
  h.report.presentation = 'shared right dock, no modal';
  return finishChatBrowser(h);
}
