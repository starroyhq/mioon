import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LOCALES, translate, renderMessage, validateCatalogs } from '../packages/i18n/src/index.ts';
import { creationMessages } from '../packages/i18n/src/catalogs/creation.ts';
import { agentChatErrorDescriptor, agentChatPromptIssue, agentChatPromptIssueDescriptor } from '../apps/web/src/agent-chat.ts';
import { agentEditStatusDescriptor } from '../apps/web/src/agent-edits.ts';
import { imageTaskLabelDescriptor, imageTaskMessageDescriptor, imageInputIssue, imageInputIssueDescriptor } from '../apps/web/src/image-generation.ts';
import { jobStatusDescriptor, taskErrorDescriptor, safeTaskErrorCode, providerDisplayName } from '../apps/web/src/creation-i18n.ts';
import { providerAvailabilityDescriptor, generationInputIssueDescriptor } from '../apps/web/src/generation-settings.ts';

test('creation catalog has complete four-language templates with exact placeholder parity', () => {
  assert.deepEqual(validateCatalogs(creationMessages), []);
  for (const [key, entry] of Object.entries(creationMessages)) {
    const base = entry['zh-Hans'];
    const templates = typeof base === 'string' ? [base] : Object.values(base);
    const params = Object.fromEntries(templates.flatMap(template => [...template.matchAll(/\{(\w+)\}/g)].map(match => [match[1], 2])));
    if (typeof base !== 'string') params.count = 2;
    for (const locale of LOCALES) { assert.ok(translate(locale, key, params).length); assert.doesNotMatch(translate(locale, key, params), /\{\w+\}/); }
  }
});

test('creation diagnostics map only stable codes, handle prototype-shaped codes, and preserve original DTOs', () => {
  const original = { phase: 'output_review_required', status: 'succeeded', error: { code: 'NETWORK_ERROR', message: 'private provider text', details: { secret: 'not for UI' } }, snapshot: { prompt: '用户原文 / user <script> / 日本語' } };
  const before = JSON.stringify(original);
  const descriptors = [jobStatusDescriptor(original), taskErrorDescriptor(original.error), agentChatErrorDescriptor('AGENT_CHAT_TIMEOUT'), imageTaskLabelDescriptor('outcome_unknown'), imageTaskMessageDescriptor('outcome_unknown')];
  for (const locale of LOCALES) for (const descriptor of descriptors) { const rendered = renderMessage(locale, descriptor); assert.ok(rendered); assert.doesNotMatch(rendered, /private provider|secret|<script>/); }
  assert.equal(JSON.stringify(original), before);
  assert.equal(safeTaskErrorCode(original.error), 'NETWORK_ERROR');
  for (const code of ['__proto__', 'constructor', 'toString', 'Raw private body with spaces']) {
    assert.equal(agentChatErrorDescriptor(code).key, 'agent.chat.state.incompleteFallback');
    assert.equal(agentEditStatusDescriptor(code).key, 'agent.proposal.state.statusUnknown');
    assert.equal(imageTaskLabelDescriptor(code).key, 'image.state.statusUnconfirmed');
    assert.equal(imageTaskMessageDescriptor(code), null); assert.equal(safeTaskErrorCode({ code }), null);
  }
});

test('validation display sidecars preserve the old validation decision without translating or mutating drafts', () => {
  for (const prompt of ['', '  ', 'line 1\n日本語\t原文', 'x\u0000y', 'x'.repeat(17000)]) {
    assert.equal(Boolean(agentChatPromptIssueDescriptor(prompt)), Boolean(agentChatPromptIssue(prompt)));
    const draft = { name: 'Exact original name', prompt }, before = JSON.stringify(draft);
    assert.equal(Boolean(imageInputIssueDescriptor(draft)), Boolean(imageInputIssue(draft))); assert.equal(JSON.stringify(draft), before);
  }
});

test('generation provider display ignores backend translated labels and instructions', () => {
  for (const id of ['mock', 'runway', 'ark', 'veo', 'minimax', 'vidu']) for (const locale of LOCALES) {
    const t = (key, params) => translate(locale, key, params);
    const provider = { id, name: 'INJECTED DISPLAY', configured: false, enabled: false };
    assert.equal(providerDisplayName(provider, t), providerDisplayName({ id }, t));
    assert.doesNotMatch(renderMessage(locale, providerAvailabilityDescriptor(provider)), /INJECTED DISPLAY/);
  }
});

test('creation renderer text and lifecycle dependencies are locale-safe', () => {
  for (const filename of ['AgentPanel.tsx', 'AgentRunActivity.tsx', 'AgentEditProposal.tsx', 'AgentTimelineGain.tsx', 'AgentWorkspace.tsx', 'ImageGeneration.tsx', 'ComfyImageDetails.tsx', 'GenerationInputSummary.tsx', 'ProviderSettings.tsx', 'TaskCenter.tsx', 'TaskWorkspace.tsx', 'PendingSubmission.tsx']) {
    const source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
    const visit = node => {
      if (ts.isJsxText(node) || ts.isStringLiteralLike(node)) assert.doesNotMatch(node.text, /[\u3400-\u9fff]/, filename);
      if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect', 'useMemo'].includes(node.expression.getText(ast))) {
        const deps = node.arguments[1]; if (deps) assert.doesNotMatch(deps.getText(ast), /\blocale\b|\bt\b|\brenderMessage\b/, filename);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast); assert.doesNotMatch(source, /key=\{locale\}/);
  }
});


test('first/last-frame validation retains specific guidance from stable issue code and path', () => {
  const first = '11111111-1111-4111-8111-111111111111', tail = '22222222-2222-4222-8222-222222222222';
  const provider = { id: 'ark', configured: true, enabled: true };
  const missing = generationInputIssueDescriptor({ referenceAssetIds: [], lastFrameAssetId: tail }, provider, '', [], 'image');
  const same = generationInputIssueDescriptor({ referenceAssetIds: [first], lastFrameAssetId: first }, provider, '', [], 'image');
  assert.equal(missing.key, 'generation.frame.tailNeedsFirst'); assert.equal(same.key, 'generation.frame.distinctFrames');
  assert.match(renderMessage('zh-Hans', missing), /尾帧必须与一张首帧/); assert.match(renderMessage('zh-Hans', same), /不同素材.*当前应用限制/);
  for (const locale of LOCALES) { assert.ok(renderMessage(locale, missing)); assert.ok(renderMessage(locale, same)); }
});

test('actual provider renders creation details in all four locales and escapes untranslated user content', async () => {
  const { execFileSync } = await import('node:child_process');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const source = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { I18nProvider, createLanguageStore } from './i18n/I18nProvider.tsx';
    import ProviderSettings from './ProviderSettings.tsx';
    import { ComfyImageTaskDetails } from './ComfyImageDetails.tsx';
    import { AgentEditDiff } from './AgentEditProposal.tsx';
    import TaskWorkspace from './TaskWorkspace.tsx';
    export async function renderAll() {
      const result = {};
      const provider = { id: 'mock', name: 'UNTRUSTED BACKEND LABEL', mock: true, status: 'available', models: ['fixed-model-id'], configured: true, enabled: true };
      const proposal = { diff: { before: { title: 'User <script> title', prompt: '原文 / exact prompt / 日本語' }, after: { title: 'User <img> result', prompt: '模型输出 / model output / 生成結果' } } };
      for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
        const store = createLanguageStore({ systemLanguages: [locale] });
        await store.setPreference(locale);
        result[locale] = renderToStaticMarkup(<I18nProvider store={store}>
          <ProviderSettings providers={[provider]} provider={provider} model="fixed-model-id" capabilities={{inputModes:['text'], durations:[4], aspectRatios:['16:9']}} onChange={() => { throw Error('Render must not select a provider'); }} />
          <ComfyImageTaskDetails task={{model:'fixed-model-id'}} review={null} remoteState={{remote:{state:'submission_unknown'},observation:{state:'interrupted'}}} />
          <AgentEditDiff proposal={proposal} />
          <TaskWorkspace activeCount={1}><p>request-id-unchanged</p></TaskWorkspace>
        </I18nProvider>);
        store.dispose();
      }
      return result;
    }
  `;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // The browser SSR build creates a MessageChannel. Isolate it like the existing
  // renderer tests so a successful read-only render cannot retain the test worker.
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(source)}, loader: 'tsx', resolveDir: ${JSON.stringify(resolve(root, 'apps/web/src'))} }, bundle: true, format: 'esm', platform: 'browser', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '\"production\"' }, logLevel: 'silent' });
    const fixture = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(await fixture.renderAll())); process.exit(0);
  `;
  const rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }));
  for (const locale of LOCALES) {
    const html = rendered[locale];
    for (const key of ['generation.provider.heading', 'generation.provider.simulationWarning', 'image.comfy.details.observationScope', 'agent.proposal.before', 'tasks.workspace.heading']) assert.ok(html.includes(translate(locale, key)), `${locale}/${key}`);
    assert.ok(html.includes('User &lt;script&gt; title')); assert.ok(html.includes('User &lt;img&gt; result'));
    assert.ok(html.includes('原文 / exact prompt / 日本語')); assert.ok(html.includes('模型输出 / model output / 生成結果'));
    assert.ok(html.includes('request-id-unchanged')); assert.ok(html.includes('fixed-model-id'));
    assert.doesNotMatch(html, /<script|UNTRUSTED BACKEND LABEL/);
  }
});
