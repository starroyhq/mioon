import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LOCALES, catalogs, renderMessage, translate, validateCatalogs } from '../packages/i18n/src/index.ts';
import type { Locale, MessageKey } from '../packages/i18n/src/index.ts';
import type { Translate } from '../apps/web/src/agent-settings.ts';
const tr = (locale: Locale, key: string, params: Record<string, unknown> = {}): string => translate(locale, key as MessageKey, params as never);
import { connectionMessages } from '../packages/i18n/src/catalogs/creation-connections.ts';
import { agentSettingsIssue, agentSettingsIssueDescriptor, agentPresetLabel, agentPlatformLabel, agentPresetNote } from '../apps/web/src/agent-settings.ts';
import { imageKeyIssue, imageKeyIssueDescriptor } from '../apps/web/src/image-settings.ts';
import { comfyConnectorAvailabilityDescriptor, comfyImageCheckDescriptor } from '../apps/web/src/comfy-image-settings.ts';
import { providerAvailabilityDescriptor, providerStatusDescriptor, inputModeDescriptor, generationIssueDescriptor, generationProfileSelection, generationInputIssue, generationInputIssueDescriptor } from '../apps/web/src/generation-settings.ts';
import { AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION } from '../packages/business/src/agent/presets.ts';

test('all connection messages have four complete locales and matching placeholders', () => {
  assert.deepEqual(validateCatalogs(connectionMessages), []);
  for (const [key, entry] of Object.entries(connectionMessages)) {
    assert.ok(Object.hasOwn(catalogs, key), key);
    const params = Object.fromEntries([...entry['zh-Hans'].matchAll(/\{(\w+)\}/g)].map(m => [m[1], 3]));
    for (const locale of LOCALES) { const result = tr(locale, key, params); assert.ok(result.length, key); assert.doesNotMatch(result, /\{\w+\}/); }
  }
});

test('settings validation descriptors preserve legacy validation decisions and never include entered secrets', () => {
  for (const draft of [DEFAULT_AGENT_CONFIGURATION, { ...DEFAULT_AGENT_CONFIGURATION, protocol: '' }, { ...DEFAULT_AGENT_CONFIGURATION, model: '' }, { ...DEFAULT_AGENT_CONFIGURATION, baseUrl: 'https://user:password@example.com' }, { ...DEFAULT_AGENT_CONFIGURATION, baseUrl: 'http://example.com' }]) {
    for (const key of ['', 'synthetic-only', 'synthetic\nsecret']) {
      const descriptor = agentSettingsIssueDescriptor(draft, key); assert.equal(Boolean(descriptor), Boolean(agentSettingsIssue(draft, key)));
      assert.doesNotMatch(JSON.stringify(descriptor), /synthetic|password/);
      for (const locale of LOCALES) if (descriptor) assert.ok(renderMessage(locale, descriptor));
    }
  }
  for (const key of ['', 'synthetic-only', 'x\ny', ' ']) assert.equal(Boolean(imageKeyIssue(key)), Boolean(imageKeyIssueDescriptor(key)));
});

test('preset copy comes from stable provider and platform IDs, never translated backend text', () => {
  for (const locale of LOCALES) {
    const t = ((key: string, params?: Record<string, unknown>) => tr(locale, key, params)) as Translate;
    for (const preset of AGENT_PRESETS) for (const platform of preset.platforms) {
      const changedPreset = { ...preset, label: 'INJECTED-LABEL', description: 'INJECTED-DESCRIPTION' };
      const changedPlatform = { ...platform, label: 'INJECTED-REGION', notes: 'INJECTED-NOTES' };
      assert.equal(agentPresetLabel(changedPreset, t), agentPresetLabel(preset, t));
      assert.equal(agentPlatformLabel(preset.id, changedPlatform, t), agentPlatformLabel(preset.id, platform, t));
      assert.equal(agentPresetNote(changedPreset, changedPlatform, t), agentPresetNote(preset, platform, t));
    }
  }
});

test('generation and Comfy display descriptors use stable statuses, preserve originals and safely bound unknown codes', () => {
  const issue = { code: 'REFERENCE_TOO_LARGE', message: 'legacy diagnostic unchanged' }; const before = JSON.stringify(issue);
  const issueDescriptor = generationIssueDescriptor(issue); assert.ok(issueDescriptor); assert.equal(issueDescriptor.key, 'connections.generation.issue.tooLarge'); assert.equal(JSON.stringify(issue), before);
  for (const code of ['future secret with spaces', '__proto__', 'constructor', 'toString']) { const descriptor = generationIssueDescriptor({ code, message: 'raw provider text' }); assert.ok(descriptor); assert.equal(descriptor.params?.code, 'UNKNOWN'); }
  assert.equal(inputModeDescriptor('__proto__'), null);
  assert.equal(providerStatusDescriptor({ status: 'constructor' } as unknown as Parameters<typeof providerStatusDescriptor>[0]).key, 'connections.generation.unavailable');
  const profileSelection = generationProfileSelection(null, ''); assert.ok(profileSelection); assert.equal(profileSelection.displayMessage?.key, 'connections.generation.profileUnloaded');
  const inputIssue = generationInputIssueDescriptor({}, null, '', [], 'text'); assert.ok(inputIssue); assert.equal(typeof inputIssue === 'string' ? inputIssue : inputIssue?.key, 'connections.generation.providerMissing');
  assert.equal(Boolean(generationInputIssue({}, null, '', [], 'text')), Boolean(generationInputIssueDescriptor({}, null, '', [], 'text')));
  for (const locale of LOCALES) for (const descriptor of [providerAvailabilityDescriptor(null), providerAvailabilityDescriptor({ id: 'provider-id', enabled: false, configured: true }), providerStatusDescriptor(null), inputModeDescriptor('subject'), comfyConnectorAvailabilityDescriptor(null), comfyImageCheckDescriptor(null)]) {
    const rendered = renderMessage(locale, descriptor as never); assert.ok(rendered); assert.doesNotMatch(rendered, /raw provider text|legacy diagnostic unchanged/);
  }
});

test('settings components have no untranslated CJK literals or locale-dependent lifecycle keys/effects', () => {
  for (const filename of ['AgentSettings.tsx', 'ImageSettings.tsx', 'ComfyImageSettings.tsx']) {
    const source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    function visit(node: ts.Node): void {
      if (ts.isJsxText(node) || ts.isStringLiteralLike(node)) assert.doesNotMatch(node.text, /[\u3400-\u9fff]/, filename);
      if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect', 'useMemo'].includes(node.expression.getText(ast))) {
        const deps = node.arguments[1]; if (deps) assert.doesNotMatch(deps.getText(ast), /\blocale\b|\bt\b|\brenderMessage\b/, filename);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); assert.doesNotMatch(source, /key=\{locale\}/);
  }
});
