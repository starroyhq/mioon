/** Supported-CUA acceptance of real reviewed edits. Filesystem controls only
 * configure synthetic model behavior/audits; all user actions use the UI. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {editsQaClient} from './agent-edits-qa-client.mjs';

const records = (audit, table) => audit.data[table].map(row => JSON.parse(row.data));
const latestRun = audit => records(audit, 'agent_chat_runs').at(-1);
export async function editsBrowserHarness(tab) {
  const q = await editsQaClient(), output = path.join(q.root, 'browser'); await mkdir(output, {recursive: true});
  const report = {startedAt: new Date().toISOString(), baseline: '2ba58ee', synthetic: true, checks: [], screenshots: []};
  const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const capture = async name => { await writeFile(path.join(output, name), await tab.getScreenshot({emit: false})); report.screenshots.push(name); await save(); };
  const log = async (name, detail = {}) => { report.checks.push({name, passed: true, ...detail}); await save(); };
  const tid = name => tab.playwright.getByTestId(`agent-chat-${name}`);
  const card = id => tab.playwright.locator(`[data-testid="agent-edit-proposal"][data-proposal-id="${id}"]`);
  const phase = () => tid('page').getAttribute('data-phase');
  const ready = () => q.waitFor(async () => await phase() === 'ready', 'Agent ready');
  const open = async () => { await tab.playwright.getByTestId('right-dock-tab-agent').click(); await tid('page').waitFor({state: 'visible'}); await ready(); };
  const send = async (message, plan = {}, mode = 'edit') => {
    await ready(); const before = await q.audit(); await q.plan(plan);
    const choice = tid(`mode-${mode}`); if (!await choice.evaluate(node => node.checked)) await choice.click();
    await tid('prompt').fill(message); if (!await tid('consent').evaluate(node => node.checked)) await tid('consent').click();
    await q.waitFor(() => tid('send').isEnabled(), 'explicit send enabled'); await tid('send').click();
    const run = await q.waitFor(async () => { const run = latestRun(await q.audit()); return run?.id !== latestRun(before)?.id && run?.userText === message ? run : false; }, 'one accepted run');
    return {run, before};
  };
  const terminal = run => q.waitFor(async () => { const audit = await q.audit(), current = records(audit, 'agent_chat_runs').find(item => item.id === run.id); return current?.status !== 'running' && current ? current : false; }, 'terminal run');
  const proposalFor = run => q.waitFor(async () => (await q.audit()).data.agent_edit_proposals.find(item => item.runId === run.id), 'saved proposal');
  const refresh = async () => { await tab.playwright.getByTestId('agent-edits-refresh').click(); await q.waitFor(async () => await tab.playwright.getByTestId('agent-edit-review').getAttribute('data-phase') === 'ready', 'review GET ready'); };
  const protocol = async value => {
    await tid('settings').click(); const selector = tab.playwright.getByTestId('agent-settings-protocol'); await selector.click();
    await tab.playwright.getByRole('option', {name: value === 'responses' ? 'Responses' : 'Chat Completions', exact: true}).click();
    await tab.playwright.getByTestId('agent-settings-save').click();
    await q.waitFor(async () => await tab.playwright.getByTestId('agent-settings-page').getAttribute('data-phase') === 'saved', 'protocol saved');
    await tab.playwright.getByTestId('agent-settings-back').click(); await ready();
    assert.equal(await tid('consent').evaluate(node => node.checked), false);
  };
  const initial = await q.audit(), shot = records(initial, 'shots').find(item => item.id === q.fixture.shot.id);
  assert.ok(shot);
  return {...q, tab, report, save, capture, log, tid, card, phase, ready, open, send, terminal, proposalFor, refresh, protocol, initial, shot};
}

export async function runEditsConsentAndProposal(h) {
  await h.open(); assert.equal((await h.model()).captures.length, 0); assert.equal(await h.tab.playwright.getByRole('dialog').count(), 0);
  assert.equal(await h.tid('mode-typed').evaluate(node => node.checked), true);
  await h.tid('prompt').fill('Unsent review request'); await h.tid('mode-edit').click();
  assert.equal(await h.tid('consent').evaluate(node => node.checked), false); assert.equal(await h.tid('send').isEnabled(), false);
  assert.equal(await h.tab.playwright.getByTestId('agent-edit-selected-title').innerText(), h.shot.title);
  await h.capture('01-selected-saved-text-explicit-consent-no-network.jpg');
  const sent = await h.send('Improve the title and prompt of this selected saved shot.'); assert.equal((await h.terminal(sent.run)).status, 'completed');
  await h.ready(); await h.refresh(); const proposal = await h.proposalFor(sent.run); h.first = proposal;
  const audit = await h.audit(); assert.deepEqual(audit.data.shots, sent.before.data.shots); assert.deepEqual(audit.data.mutation_requests, sent.before.data.mutation_requests);
  assert.equal(proposal.status, 'pending'); assert.equal(await h.card(proposal.id).getByTestId('agent-edit-before-title').innerText(), h.shot.title);
  assert.equal(await h.card(proposal.id).getByTestId('agent-edit-approve').isEnabled(), true);
  await h.capture('02-responses-proposal-diff-not-applied.jpg');
  const model = await h.model(); assert.equal(model.captures.length, 2); assert.ok(model.captures.every(call => call.protocol === 'responses'));
  assert.ok(model.captures[0].body.input.at(-1).content.includes(h.shot.prompt)); assert.deepEqual(model.captures[1].body.tools, []);
  await h.log('Explicit selected saved-text disclosure; Responses model creates one immutable pending proposal, zero business writes before separate approval', {proposalId: proposal.id});
}

export async function runEditsApplyPreservesDraft(h) {
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click(); await h.tab.playwright.getByTestId('shot-prompt').fill('Human unsent draft must survive Agent approval');
  await h.tab.playwright.getByTestId('right-dock-tab-agent').click(); await h.ready(); await h.refresh();
  const before = await h.audit(); await h.card(h.first.id).getByTestId('agent-edit-approve').click();
  await h.waitFor(async () => (await h.audit()).data.agent_edit_proposals.find(item => item.id === h.first.id)?.status === 'applied', 'approved mutation committed');
  await h.card(h.first.id).getByTestId('agent-edit-applied').waitFor({state: 'visible'});
  const after = await h.audit(); assert.equal(after.data.mutation_requests.length, before.data.mutation_requests.length + 1);
  assert.equal(records(after, 'shots').find(item => item.id === h.fixture.shot.id).revision, h.shot.revision + 1);
  await h.capture('03-approved-diff-confirmed-applied.jpg');
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click();
  assert.equal(await h.tab.playwright.getByTestId('shot-prompt').evaluate(node => node.value), 'Human unsent draft must survive Agent approval');
  await h.capture('04-human-unsaved-draft-survives-agent-write.jpg');
  await h.tab.playwright.getByRole('button', {name: '载入最新内容', exact: true}).click(); await h.open();
  await h.log('Explicit approval applies once through the shared journal; newer unsaved Inspector draft remains unsaved and intact');
}

export async function runEditsRejectAndConflict(h) {
  let sent = await h.send('Propose a title that I will reject.', {arguments: {title: 'Rejected synthetic title', prompt: null}});
  assert.equal((await h.terminal(sent.run)).status, 'completed'); await h.ready(); await h.refresh(); let proposal = await h.proposalFor(sent.run);
  await h.card(proposal.id).getByTestId('agent-edit-reject').click();
  await h.waitFor(async () => (await h.audit()).data.agent_edit_proposals.find(item => item.id === proposal.id)?.status === 'rejected', 'proposal rejected');
  assert.deepEqual((await h.audit()).data.shots, sent.before.data.shots); await h.capture('05-rejected-proposal-no-write.jpg');
  sent = await h.send('Propose a title against the current saved revision.', {arguments: {title: 'Stale synthetic proposal', prompt: null}});
  assert.equal((await h.terminal(sent.run)).status, 'completed'); await h.ready(); await h.refresh(); proposal = await h.proposalFor(sent.run);
  const definition = JSON.parse(proposal.definition);
  await h.tab.playwright.getByTestId('right-dock-tab-properties').click(); await h.tab.playwright.getByTestId('shot-prompt').fill('A newer manually saved revision'); await h.tab.playwright.getByTestId('save-shot').click();
  await h.waitFor(async () => records(await h.audit(), 'shots').find(item => item.id === h.fixture.shot.id).revision > definition.target.expectedRevision, 'manual newer revision');
  await h.open(); await h.refresh(); const beforeApproval = await h.audit(); await h.card(proposal.id).getByTestId('agent-edit-approve').click();
  await h.card(proposal.id).getByTestId('agent-edit-failed').waitFor({state: 'visible'}); const after = await h.audit();
  assert.deepEqual(after.data.shots, beforeApproval.data.shots); assert.deepEqual(after.data.mutation_requests, beforeApproval.data.mutation_requests);
  assert.equal(after.data.agent_edit_proposals.find(item => item.id === proposal.id).definition, proposal.definition);
  await h.capture('06-stale-revision-original-diff-no-rebase.jpg'); await h.log('Reject changes no shot; intervening manual save causes confirmed revision conflict, retaining original immutable diff and no new mutation receipt');
}

export async function runEditsLostAckAndRestart(h) {
  await h.protocol('chat_completions');
  let sent = await h.send('Use Chat Completions for another reviewed change.', {arguments: {title: 'CC explicit approval', prompt: null}});
  assert.equal((await h.terminal(sent.run)).status, 'completed'); await h.ready(); await h.refresh(); let proposal = await h.proposalFor(sent.run);
  await h.fault(); const before = await h.audit(); await h.card(proposal.id).getByTestId('agent-edit-approve').click();
  await h.card(proposal.id).getByTestId('agent-edit-applied').waitFor({state: 'visible', timeoutMs: 15000});
  const after = await h.audit(); assert.equal(after.data.mutation_requests.length, before.data.mutation_requests.length + 1);
  assert.equal((await h.model()).captures.length, before.model.captures.length); await h.capture('07-cc-lost-approval-ack-read-only-confirmation.jpg');
  sent = await h.send('Keep this reviewed proposal across backend restart.', {arguments: {title: 'Saved pending across restart', prompt: null}});
  assert.equal((await h.terminal(sent.run)).status, 'completed'); await h.ready(); await h.refresh(); proposal = await h.proposalFor(sent.run);
  const pending = await h.audit(); await h.restart(); await h.tab.reload(); await h.tab.playwright.getByTestId('right-dock-tab-agent').waitFor({state: 'visible'}); await h.open(); await h.refresh();
  assert.equal(await h.card(proposal.id).getAttribute('data-status'), 'pending');
  const restarted = await h.audit(); assert.deepEqual(restarted.data.shots, pending.data.shots); assert.deepEqual(restarted.data.mutation_requests, pending.data.mutation_requests); assert.equal(restarted.model.captures.length, pending.model.captures.length);
  await h.capture('08-restarted-pending-proposal-original-diff-no-execution.jpg');
  await h.card(proposal.id).getByTestId('agent-edit-reject').click();
  await h.log('CC uses its own function-wire flow; lost approval acknowledgement is resolved by GET without a second write/model call; backend restart+renderer reload rediscovers original pending proposal without execution');
}

export async function runEditsStopAndTypedIsolation(h) {
  const sent = await h.send('Prepare but hold the final answer for Stop.', {arguments: {title: 'Cancelled by explicit Stop', prompt: null}, hold: 'answer'});
  const proposal = await h.proposalFor(sent.run); await h.refresh();
  assert.equal(await h.card(proposal.id).getByTestId('agent-edit-approve').isEnabled(), false);
  await h.tid('stop').click(); assert.equal((await h.terminal(sent.run)).status, 'stopped'); await h.ready(); await h.refresh();
  const stopped = await h.audit(); assert.equal(stopped.data.agent_edit_proposals.find(item => item.id === proposal.id).status, 'cancelled');
  assert.deepEqual(stopped.data.shots, sent.before.data.shots); await h.release('answer');
  await h.tab.playwright.getByTestId('agent-edits-all').click(); await h.capture('09-stop-invalidates-unapproved-proposal.jpg');
  const typed = await h.send('Discuss pacing using this typed message only.', {noCall: true}, 'typed'); assert.equal((await h.terminal(typed.run)).status, 'completed');
  const capture = (await h.model()).captures.at(-1), body = JSON.stringify(capture.body);
  for (const marker of [h.shot.title, h.shot.prompt, 'CC explicit approval', 'Saved pending across restart', 'Cancelled by explicit Stop']) assert.ok(!body.includes(marker), marker);
  await h.capture('10-typed-chat-excludes-edit-derived-history.jpg'); await h.log('Stop disables approval and durably cancels pending proposal; released late answer cannot write; later typed-only request excludes selected saved text and all edit-derived history');
}

export async function finishEditsBrowser(h) {
  const after = await h.audit('browser-final');
  for (const name of ['assets', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'reference_requests', 'idempotency', 'job_events']) assert.deepEqual(after.data[name], h.initial.data[name], name);
  assert.equal(after.model.errors.length, 0); assert.equal(after.model.active, 0);
  h.report.finishedAt = new Date().toISOString(); h.report.modelRequests = after.model.captures.length; h.report.proposals = after.data.agent_edit_proposals.length;
  h.report.mutationReceipts = after.data.mutation_requests.length; h.report.finalAuditHash = after.hash;
  h.report.scope = 'reviewed shot title/prompt only, synthetic local provider; no generation or broader editing';
  await h.log('Unrelated jobs/media/version/timeline/reference records unchanged; all synthetic SSE connections closed'); await h.save(); return h.report;
}
