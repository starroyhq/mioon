/** Supported-CUA acceptance of the actual shared right dock and both protocols.
 * Inference uses only the disposable local synthetic HTTP fixture. */
import assert from 'node:assert/strict';
import {chatBrowserHarness, runChatFailureAndOutput, runChatLostAck, finishChatBrowser} from './browser_agent_chat.mjs';

export async function responsesBrowserHarness(tab, {iteration = 'responses'} = {}) {
  const h = await chatBrowserHarness(tab, {iteration, inline: true});
  const settings = name => tab.playwright.getByTestId(`agent-settings-${name}`);
  const choose = async (name, label) => {
    await settings(name).click();
    const option = tab.playwright.getByRole('option', {name: label, exact: true});
    await option.waitFor({state: 'visible', timeoutMs: 10000}); await option.click();
    await h.waitFor(async () => await settings(name).getAttribute('aria-expanded') === 'false', 'inline setting selected');
  };
  const configuration = async () => (await h.request('/api/agent/settings')).data;
  const protocol = async value => {
    await h.tid('settings').click(); await settings('protocol').waitFor({state: 'visible', timeoutMs: 10000});
    await choose('protocol', value === 'responses' ? 'Responses' : 'Chat Completions');
    await settings('save').click();
    await h.waitFor(async () => await settings('page').getAttribute('data-phase') === 'saved', 'explicit protocol save');
    assert.equal((await configuration()).configuration.protocol, value);
    await settings('back').click();
    await h.waitFor(async () => ['ready', 'streaming'].includes(await h.phase()), 'chat after protocol save');
  };
  return {...h, settings, choose, configuration, protocol};
}

export async function runRightDockDrafts(h) {
  await h.open();
  assert.equal((await h.current()).settings.configuration.protocol, 'responses');
  assert.equal(await h.tab.playwright.getByRole('dialog').count(), 0);
  const canvas = h.tab.playwright.getByRole('region', {name: '画板工作区'});
  // The canvas is never replaced by a dialog. DOM reads are observation only.
  const before = await h.tab.playwright.evaluate(() => ({canvas: Boolean(document.querySelector('.react-flow')),
    transform: document.querySelector('.react-flow__viewport')?.getAttribute('style')}));
  assert.equal(before.canvas, true);
  await h.tid('prompt').fill('未发送草稿 · tab collapse settings mode');
  const requests = (await h.audit()).mock.requests.length;
  assert.equal(await h.tid('send').getAttribute('disabled'), '');
  await h.capture('01-inline-right-dock-canvas-and-consent.jpg');
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click();
  assert.equal(await h.tid('prompt').isVisible(), false);
  await h.tab.playwright.getByTestId('right-dock-tab-agent').click();
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '未发送草稿 · tab collapse settings mode');
  await h.close(); await h.open();
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '未发送草稿 · tab collapse settings mode');
  await h.tab.playwright.locator('.react-flow__node').first().click();
  assert.equal(await h.tab.playwright.getByTestId('right-dock-tab-agent').getAttribute('aria-selected'), 'true');
  const after = await h.tab.playwright.evaluate(() => ({canvas: Boolean(document.querySelector('.react-flow')),
    transform: document.querySelector('.react-flow__viewport')?.getAttribute('style')}));
  assert.deepEqual(after, before);
  await h.tid('settings').click();
  await h.settings('model').fill('qwen3:8b-local-unsaved-draft');
  await h.settings('key').fill('mioon-qa-dummy-inline-unsubmitted-key');
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click();
  await h.tab.playwright.getByTestId('right-dock-tab-agent').click();
  assert.equal(await h.settings('model').evaluate(element => element.value), 'qwen3:8b-local-unsaved-draft');
  assert.equal(await h.settings('key').evaluate(element => element.value), '');
  await h.settings('key-cleared').waitFor({state: 'visible', timeoutMs: 10000});
  await h.capture('02-inline-settings-hidden-key-cleared-draft-retained.jpg');
  await h.settings('model').fill('qwen3:8b'); await h.settings('back').click();
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '未发送草稿 · tab collapse settings mode');
  await h.tab.playwright.getByTestId('workspace-editing').click(); await h.open();
  assert.equal(await h.tid('prompt').evaluate(element => element.value), '未发送草稿 · tab collapse settings mode');
  await h.capture('03-inline-agent-beside-editing-workspace.jpg');
  await h.tab.playwright.getByTestId('workspace-canvas').click(); await h.open();
  assert.equal((await h.audit()).mock.requests.length, requests);
  await h.log('Right Properties/Agent tabs, collapse, inline settings and mode changes preserve chat draft; asset selection leaves Agent selected; canvas viewport stays unchanged; hidden key clears while nonsecret settings draft remains; no model call');
}

export async function runResponsesStreamingAndProtocolPinning(h) {
  await h.tid('prompt').fill('mock:slow 这是 Responses 本地模拟。');
  await h.send('mock:slow 这是 Responses 本地模拟。');
  await h.waitFor(async () => (await h.current()).runs.at(-1)?.assistantText.includes('聊天文字'), 'Responses text streaming');
  const active = (await h.current()).runs.at(-1), before = (await h.audit()).mock.requests.length;
  assert.equal(active.configuration.protocol, 'responses');
  await h.capture('04-responses-streaming-inline.jpg');
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click();
  await h.tab.playwright.getByTestId('right-dock-tab-agent').click();
  await h.close(); await h.open();
  assert.equal((await h.current()).runs.at(-1).id, active.id); assert.equal((await h.audit()).mock.requests.length, before);
  await h.protocol('chat_completions');
  const pinned = (await h.current()).runs.at(-1); assert.equal(pinned.configuration.protocol, 'responses');
  assert.equal(await h.tid('consent').evaluate(element => element.checked), false);
  await h.capture('05-active-response-pinned-after-protocol-switch.jpg');
  await h.tid('stop').click(); await h.finalRun('stopped');
  await h.send('mock:normal CC 明确选择后的新一轮。'); await h.finalRun('completed');
  assert.equal((await h.audit()).mock.requests.at(-1).protocol, 'chat_completions');
  await h.capture('06-chat-completions-explicit-selected-round.jpg');
  await h.protocol('responses');
  await h.send('mock:normal Responses 明确选择后的新一轮。'); await h.finalRun('completed');
  assert.equal((await h.audit()).mock.requests.at(-1).protocol, 'responses');
  await h.log('Both selected protocols use their own real local HTTP path and parser; active Responses run stays pinned after settings switch, tab/collapse reattach sends no new request, Stop preserves partial text, each new round needs fresh protocol/destination consent');
}

export async function runResponsesFailuresAndRecovery(h) {
  await runChatFailureAndOutput(h);
  for (const mode of ['incomplete', 'unknown', 'reasoning', 'error']) {
    const before = (await h.audit()).mock.requests.length;
    await h.send(`mock:${mode} Responses failure fixture`);
    const failed = await h.finalRun('failed'); assert.ok(failed.error);
    assert.equal((await h.audit()).mock.requests.length, before + 1);
    assert.equal((await h.audit()).mock.requests.at(-1).protocol, 'responses');
  }
  await h.capture('07-responses-safe-errors-no-fallback.jpg');
  await runChatLostAck(h);
  await h.log('Responses incomplete, unknown, reasoning and provider errors fail safely without alternate protocol/second POST; lost accepted acknowledgement is recovered by reads only');
}

export async function finishResponsesBrowser(h) {
  h.report.protocols = ['chat_completions', 'responses']; h.report.presentation = 'shared right dock, no modal';
  return finishChatBrowser(h);
}
