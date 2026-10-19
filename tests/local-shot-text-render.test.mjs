import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const id = n => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`, projectId = id(1), shotId = id(2);
const stamp = '2026-10-12T00:00:00.000Z', baseText = { title: 'Original', prompt: 'Original prompt' };
const base = { scope: 'project:1', projectId, shotId, phase: 'ready', raw: baseText, dirty: false, baseline: null, baselineConflict: false, candidate: null, savedAt: null, draftFailure: null, draftError: '', autosavePaused: false, leaveWithoutSaving: false, draftRetry: null, retainedDraftWrite: null, retainedDeletion: null, retainedPreparation: null, intent: null, intentPhase: 'idle', intentUncertain: false, intentFailure: null, intentError: '', busy: false, pending: false, projectPendingIntent: null };
const draft = { draftId: id(4), baseRevision: 2, baseText, raw: { title: '  <script>raw title  ', prompt: '' }, updatedAt: stamp };
const intent = { intentId: id(5), baseRevision: 2, baseText, draft: { draftId: id(4), revision: 1, raw: draft.raw }, input: { requestId: 'original-text-request', shotId, expectedRevision: 2, patch: { title: draft.raw.title, prompt: '' } }, createdAt: stamp, outcome: { status: 'pending' } };
const fixtures = {
  empty: base, candidate: { ...base, candidate: draft }, conflict: { ...base, baseline: { baseRevision: 2, baseText }, baselineConflict: true },
  invalid: { ...base, phase: 'error', autosavePaused: true, draftRetry: 'current', draftFailure: { code: 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION', status: 400, kind: 'refused' } },
  unknown: { ...base, phase: 'error', autosavePaused: true, draftRetry: 'same', draftFailure: { code: 'LOCAL_SHOT_TEXT_NETWORK_UNKNOWN', status: null, kind: 'unknown' }, draftError: '未知', retainedDraftWrite: { raw: draft.raw } },
  deletion: { ...base, phase: 'error', autosavePaused: true, retainedDeletion: { projectId, shotId, draftId: id(4), expectedDraftRevision: 1 } },
  pending: { ...base, intent, intentPhase: 'pending', pending: true }, other: { ...base, pending: true, projectPendingIntent: { shotId: id(20), intentId: id(21) } },
  lostPrepare: { ...base, intentUncertain: true, pending: true, retainedPreparation: intent },
  applied: { ...base, intent: { ...intent, outcome: { status: 'applied', shotRevision: 3, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, intentPhase: 'applied' },
  notApplied: { ...base, intent: { ...intent, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT', resolvedAt: stamp } }, intentPhase: 'not_applied' },
  unsupported: { ...base, phase: 'unsupported' }, busy: { ...base, candidate: draft, busy: true, intent, intentPhase: 'executing', pending: true },
};
let rendered;
before(() => {
  const fixture = `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server.browser'; import ShotTextDraftRecovery from './src/ShotTextDraftRecovery.tsx';
    const fixtures = ${JSON.stringify(fixtures)}; const controller = new Proxy({}, { get() { return () => { throw Error('Passive view invoked an action'); }; } });
    export const html = Object.fromEntries(Object.entries(fixtures).map(([key,state]) => [key,renderToStaticMarkup(<ShotTextDraftRecovery state={state} controller={controller} onInspect={() => { throw Error('Passive view jumped'); }} />)]));`;
  const script = `import {build} from 'esbuild'; globalThis.fetch = () => { throw Error('Passive view fetched'); }; const {outputFiles} = await build({stdin:{contents:${JSON.stringify(fixture)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root,'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}); const result = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')); process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('passive inline disclosure includes plaintext scope, backup exclusion and explicit text save', () => {
  assert.match(rendered.empty, /aria-label="本地标题和提示词草稿"/); assert.match(rendered.empty, /保存标题和提示词/); assert.match(rendered.empty, /本机私有目录中以明文保存/); assert.match(rendered.empty, /不包含在工作区备份中/); assert.match(rendered.empty, /打开面板、重新连接和读取记录都不会/);
  assert.doesNotMatch(rendered.empty, /<input|<textarea|role="dialog"|<dialog/);
});

test('candidate preserves escaped raw title and explicit empty prompt without duplicate editable form', () => {
  assert.match(rendered.candidate, /&lt;script&gt;raw title/); assert.match(rendered.candidate, /（空提示词）/); assert.match(rendered.candidate, /rev 2/); assert.match(rendered.candidate, /恢复文字，替换当前标题和提示词/); assert.match(rendered.candidate, /保留当前文字，替换已保存草稿/); assert.doesNotMatch(rendered.candidate, /<script>|<textarea|<input/);
});

test('unknown write, local refusal and ambiguous delete expose distinct choices', () => {
  assert.match(rendered.invalid, /本地输入未通过校验，尚未发送保存请求/); assert.match(rendered.invalid, /允许离开，不保存当前本地草稿/);
  assert.match(rendered.unknown, /本次草稿保存结果未知/); assert.match(rendered.unknown, /重试保存同一文字草稿/); assert.doesNotMatch(rendered.unknown, /允许离开，不保存当前本地草稿/);
  assert.match(rendered.deletion, /核对并接受当前草稿状态/); assert.match(rendered.deletion, /原草稿删除结果尚未确认/);
});

test('pending original recovery is explicit and terminal outcomes never offer redispatch', () => {
  for (const html of [rendered.pending, rendered.lostPrepare]) { assert.match(html, /original-text-request/); assert.match(html, /确认恢复同一原文字请求/); assert.match(html, /可能首次执行/); assert.match(html, /不会改用当前输入，也不会生成镜头/); }
  assert.match(rendered.lostPrepare, /即使读取结果为空/);
  assert.match(rendered.applied, /恢复旧请求不会覆盖当前表单或继续生成/); assert.match(rendered.notApplied, /不会再次重试同一请求/);
  for (const html of [rendered.applied, rendered.notApplied]) assert.doesNotMatch(html, /确认恢复同一原文字请求|可能首次执行/);
});

test('pending other shot is visible and all busy controls are disabled type buttons', () => {
  assert.match(rendered.other, /本项目另一个镜头的文字保存结果待确认/); assert.match(rendered.other, /查看原镜头/);
  for (const button of rendered.busy.match(/<button[^>]*>/g)) { assert.match(button, /type="button"/); assert.match(button, /disabled/); }
  assert.match(rendered.unsupported, /现有镜头编辑与保存仍可使用/); assert.doesNotMatch(rendered.unsupported, /data-testid="save-shot-text"/);
});

test('new logic is typed and isolated from broad RPC, renderer storage, modal and duplicate field paths', () => {
  for (const file of ['local-shot-text-client.ts', 'local-shot-text-state.ts', 'ShotTextDraftRecovery.tsx']) {
    const source = readFileSync(path.join(root,'apps/web/src',file),'utf8'); assert.doesNotMatch(source, /from ['"]@mioon\/contracts['"]|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|localStorage|sessionStorage|workbench-confirm|rpc\(/);
  }
  const inspector = readFileSync(path.join(root,'apps/web/src/Inspector.tsx'),'utf8'); assert.equal((inspector.match(/id="shot-title"/g) || []).length, 2); assert.equal((inspector.match(/id="shot-prompt"/g) || []).length, 2);
  assert.match(inspector, /完整“保存修改”不会跳过文字修改/); assert.match(inspector, /mergeFreshShotTextAck/); assert.match(inspector, /onShotTextController\(shotText.controller, \(\) => \(\{ mounted: mounted.current,/);
});
