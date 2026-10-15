import { translate } from '../packages/i18n/src/index.ts';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const projectId = 'ca000000-0000-4000-8000-000000000001', timelineId = 'ca000000-0000-4000-8000-000000000002';
const stamp = '2026-10-12T00:00:00.000Z';
const base = { scope: 'project:1', projectId, phase: 'ready', deliveryName: '', dirty: false, baseline: null, baselineConflict: false, candidate: null, savedAt: null, draftFailure: null, draftError: '', autosavePaused: false, leaveWithoutSaving: false, draftRetry: null, retainedDraftWrite: null, retainedPreparation: null, intent: null, intentPhase: 'idle', intentUncertain: false, intentFailure: null, intentError: '', busy: false, pending: false };
const draft = { draftId: 'ca000000-0000-4000-8000-000000000004', timelineId, baseRevision: 2, raw: { deliveryName: '  <script>原名称\n第二行  ' }, updatedAt: stamp };
const intent = { intentId: 'ca000000-0000-4000-8000-000000000005', timelineId, baseRevision: 2, draft: null, input: { projectId, expectedRevision: 2, requestId: 'original-request-unchanged', purpose: 'export' }, createdAt: stamp, outcome: { status: 'pending' } };
const fixtures = {
  empty: base,
  candidate: { ...base, candidate: draft, dirty: true },
  conflict: { ...base, baseline: { timelineId, baseRevision: 2 }, baselineConflict: true },
  capacity: { ...base, draftRetry: 'current', phase: 'error', autosavePaused: true, draftFailure: { code: 'LOCAL_DELIVERY_CAPACITY', status: 507, kind: 'refused' }, draftError: '原名称未保存' },
  retryOriginal: { ...base, phase: 'error', autosavePaused: true, draftRetry: 'same', retainedDraftWrite: { projectId, workspaceScope: 'a'.repeat(64), instanceId: 'ca000000-0000-4000-8000-000000000003', expectedDraftRevision: 0, draftId: draft.draftId, timelineId, baseRevision: 2, raw: { deliveryName: 'Original raw' } } },
  localInvalid: { ...base, phase: 'error', autosavePaused: true, draftRetry: 'current', draftFailure: { code: 'LOCAL_DELIVERY_LOCAL_VALIDATION', status: 400, kind: 'refused' } },
  profiled: { ...base, intent: { ...intent, input: { ...intent.input, exportSettings: { profileId: 'mp4_h264_v1', resolution: 'short_1080', rateControl: { mode: 'bitrate', targetKbps: 8000 } } } }, intentPhase: 'pending', pending: true },
  unknown: { ...base, phase: 'error', autosavePaused: true, draftFailure: { code: 'LOCAL_DELIVERY_NETWORK_UNKNOWN', status: null, kind: 'unknown' }, draftError: '状态待确认' },
  accepted: { ...base, intent: { ...intent, outcome: { status: 'accepted', exportId: projectId, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, intentPhase: 'accepted' },
  notApplied: { ...base, intent: { ...intent, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT', resolvedAt: stamp } }, intentPhase: 'not_applied' },
  pending: { ...base, intent, intentPhase: 'pending', pending: true },
  lostPrepare: { ...base, intentUncertain: true, intentPhase: 'error', pending: true, retainedPreparation: { projectId, intentId: intent.intentId, timelineId, baseRevision: 2, input: intent.input, draft: null, workspaceScope: 'a'.repeat(64), instanceId: 'ca000000-0000-4000-8000-000000000003', expectedIntentRevision: 0, expectedIntentId: null } },
  unsupported: { ...base, phase: 'unsupported' },
  busy: { ...base, candidate: draft, busy: true, intent, intentPhase: 'executing', pending: true },
};
let rendered;
before(() => {
  const fixture = `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server.browser'; import DeliveryDraftRecovery from './src/DeliveryDraftRecovery.tsx';
    const fixtures = ${JSON.stringify(fixtures)}; const controller = new Proxy({}, { get() { return () => { throw new Error('Passive view invoked a controller action'); }; } });
    export const html = Object.fromEntries(Object.entries(fixtures).map(([key, state]) => [key, renderToStaticMarkup(<DeliveryDraftRecovery state={state} controller={controller} />)]));`;
  const script = `import {build} from 'esbuild'; globalThis.fetch = () => { throw Error('Passive view fetched'); }; const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixture)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}); const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')); process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('passive right-dock disclosure uses a labelled region with explicit draft and request storage scope', () => {
  assert.match(rendered.empty, /aria-label="本地交付草稿与原导出请求"/); assert.match(rendered.empty, /role="status"/); assert.match(rendered.empty, /<details/); assert.match(rendered.empty, /名称草稿仅保存原始名称输入/); assert.match(rendered.empty, /原请求编号与完整参数，包括本次输出规格/); assert.match(rendered.empty, /打开面板、重新连接或读取记录均不会提交/); assert.doesNotMatch(rendered.empty, /role="dialog"|<dialog/);
});

test('candidate controls show exact escaped raw name, original baseline, and explicit replace wording', () => {
  assert.match(rendered.candidate, /&lt;script&gt;原名称\n第二行/); assert.ok(rendered.candidate.includes(translate('zh-Hans', 'export.revision', { revision: 2 }))); assert.match(rendered.candidate, /恢复名称，替换当前输入/); assert.match(rendered.candidate, /保留当前名称，替换已保存草稿/); assert.match(rendered.candidate, /放弃已保存名称/); assert.match(rendered.candidate, /data-slot="button"/); assert.doesNotMatch(rendered.candidate, /<script>/);
  const buttons = rendered.candidate.match(/<button[^>]*>/g); assert.ok(buttons.length >= 3); for (const button of buttons) assert.match(button, /type="button"/);
});

test('baseline mismatch requires explicit current timeline adoption', () => {
  assert.match(rendered.conflict, /不能直接用于当前检查/); assert.match(rendered.conflict, /明确改用于当前时间线，再检查/); assert.ok(rendered.conflict.includes(translate('zh-Hans', 'export.revision', { revision: 2 })));
});

test('capacity refusal and unknown write have distinct safe choices and inline alerts', () => {
  assert.match(rendered.capacity, /128 个项目槽位上限/); assert.match(rendered.capacity, /允许离开，不保存当前名称/); assert.match(rendered.capacity, /role="alert"/); assert.match(rendered.capacity, /已有记录不会自动删除/); assert.match(rendered.capacity, /尚未提供槽位清理/);
  assert.match(rendered.unknown, /本次保存结果未知/); assert.doesNotMatch(rendered.unknown, /允许离开，不保存当前名称/); assert.match(rendered.unknown, /重新核对本地记录/);
});

test('saved and unacknowledged original intents disclose execution authority and exact original request', () => {
  for (const html of [rendered.pending, rendered.lostPrepare]) { assert.match(html, /original-request-unchanged/); assert.ok(html.includes(translate('zh-Hans', 'export.revision', { revision: 2 }))); assert.match(html, /可能首次执行之前尚未提交的导出/); assert.match(html, /确认恢复同一原请求/); assert.match(html, /不会改用当前名称或输出规格/); }
  assert.match(rendered.lostPrepare, /即使读取结果为空/); assert.match(rendered.lostPrepare, /同一编号和原参数再次确认保存/);
});

test('restored mode preserves old explicit export scope and busy controls cannot submit forms', () => {
  assert.match(rendered.unsupported, /现有的明确确认本机导出流程仍可使用/); assert.doesNotMatch(rendered.unsupported, /data-testid="recover-original-delivery"/);
  for (const button of rendered.busy.match(/<button[^>]*>/g)) { assert.match(button, /disabled/); assert.match(button, /type="button"/); }
});

test('typed UI/controller avoid untyped contract barrel, arbitrary RPC, renderer storage and dialog graph', () => {
  for (const file of ['local-delivery-client.ts', 'local-delivery-state.ts', 'DeliveryDraftRecovery.tsx']) {
    const source = readFileSync(path.join(root, 'apps/web/src', file), 'utf8'); assert.doesNotMatch(source, /from ['"]@mioon\/contracts['"]|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|localStorage|sessionStorage|workbench-confirm|rpc\(/);
  }
});


test('explicit title retry is separate from export and distinguishes local validation from server refusal', () => {
  assert.match(rendered.retryOriginal, /重试保存同一名称/); assert.match(rendered.retryOriginal, /Original raw/); assert.match(rendered.retryOriginal, /同一草稿编号与保存版本/); assert.doesNotMatch(rendered.retryOriginal, /确认恢复同一原请求/);
  assert.match(rendered.localInvalid, /本地输入未通过校验，尚未发送保存请求/); assert.match(rendered.localInvalid, /明确保存当前名称/); assert.doesNotMatch(rendered.localInvalid, /服务明确拒绝了本次名称保存/);
});

test('long provenance is collapsed while frozen output settings remain visible in original-request summary', () => {
  assert.match(rendered.candidate, /<details data-testid="delivery-draft-provenance"><summary>查看草稿来源/);
  assert.match(rendered.pending, /<details data-testid="delivery-intent-provenance"><summary>查看原请求与完整参数/); assert.match(rendered.pending, /原有默认编码设置/);
  assert.match(rendered.profiled, /短边 1080 像素/); assert.match(rendered.profiled, /平均目标 8 Mb\/s/); assert.match(rendered.profiled, /white-space:pre-wrap;overflow-wrap:anywhere/); assert.doesNotMatch(rendered.profiled, /<details[^>]+open/);
});


test('terminal request copy does not imply another execution and keeps provenance collapsed', () => {
  assert.match(rendered.accepted, /原请求回执已确认接受/); assert.match(rendered.accepted, /是否完成渲染，请查看导出记录/); assert.doesNotMatch(rendered.accepted, /可能首次执行|确认恢复同一原请求/);
  assert.match(rendered.notApplied, /不会再次重试同一请求/); assert.doesNotMatch(rendered.notApplied, /可能首次执行|确认恢复同一原请求/);
  for (const html of [rendered.accepted, rendered.notApplied]) { assert.match(html, /data-testid="delivery-intent-provenance"/); assert.doesNotMatch(html, /<details[^>]+open/); }
});
