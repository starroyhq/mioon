import { translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');

test('the clip inspector leads with the fields people edit most and keeps source and replacement after them', () => {
  const source = read('TimelineInspector.tsx');
  const order = ['id="clip-name"', 'id="clip-track"', 'id="clip-start"', 'id="clip-source-in"',
    "timeline.inspector.rect", '<ClipAudioControls', '<div className="clip-source">', '<ClipSourceReplacement', '<footer className="edit-inspector-save"'];
  const at = order.map(marker => source.indexOf(marker));
  assert.ok(at.every(index => index >= 0), `missing markers: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'inspector sections are out of order');
  // The frozen-source card keeps both of its actions and the replacement workflow keeps its exact binding.
  assert.match(source, /data-testid="return-to-source"/); assert.match(source, /data-testid="preview-clip-source"/);
  assert.match(source, /ClipSourceReplacement context=\{\{ \.\.\.replacementContext, timeline, clipId: clip\.id, dirty \}\}/);
  assert.match(source, /<form id="clip-properties-form"[^>]*onSubmit=\{save\}/);
  assert.match(source, /data-testid="save-clip"[^>]*type="submit" form="clip-properties-form"/,'The fixed save footer must still submit the exact retained form');
});

test('Agent authorization status, review entrance and send stay in the sticky composer; explicit consent belongs to its review dialog', () => {
  const source = read('AgentPanel.tsx');
  const start = source.indexOf('<div className="agent-chat-composer-input">'), end = source.indexOf('</form>', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  for (const marker of ['data-testid="agent-chat-authorization-status"', 'data-testid="agent-chat-authorization-open"', 'data-testid="agent-chat-prompt"', 'data-testid="agent-chat-send"']) assert.ok(block.includes(marker), `${marker} must stay inside the sticky block`);
  const approval = source.slice(source.indexOf('<Dialog open={Boolean(visible&&!sendConsented&&authorizationIntent.key===disclosureKey)}'));
  assert.ok(approval.includes('data-testid="agent-chat-consent"'), 'The explicit checkbox remains in the current visible disclosure dialog');
  assert.match(approval, /data-testid="agent-chat-authorization-confirm" disabled=\{!authorizationReady\|\|!authorizationIntent\.checked\}/);
  assert.match(source, /if\(!sendConsented\)\{if\(canStart\)setAuthorizationIntent\(\{key:disclosureKey,checked:false,sendAfterApproval:true,message:state\.draft\}\);return;\}/,'Send without consent must enter review and capture the exact draft before dispatch');
  assert.match(source,/if\(sendAfterApproval&&current\?\.getState\(\)\.draft!==message\)return/,'Approval must reject a draft changed since review opened');
  assert.ok(source.indexOf('data-testid="agent-chat-destination"') < start, 'the send destination stays above the consent it describes');
  // The scope, target and destination sit in their own block above it, so the sticky block can pin to the page itself:
  // the form is display: contents, otherwise a short dock would leave the form (its containing block) off screen.
  const options = source.indexOf('data-testid="agent-chat-composer-options"');
  assert.ok(options > 0 && options < source.indexOf('<fieldset className="agent-chat-context-mode"') && source.indexOf('<fieldset className="agent-chat-context-mode"') < source.indexOf('data-testid="agent-chat-destination"') && source.indexOf('data-testid="agent-chat-destination"') < start);
  assert.match(source, /<CollapsibleContent keepMounted className="agent-chat-composer-options"[^>]*hidden=\{!composerOptionsVisible\} inert=\{!composerOptionsVisible\} aria-hidden=\{!composerOptionsVisible\}/);
  assert.match(css, /\.agent-workspace \.agent-chat-composer \{ display: contents; \}/);
  assert.match(css, /\.agent-workspace \.agent-chat-composer-input \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*background: var\(--wb-raised\);/);
});

test('selecting a shot, node or clip closes reference overlays after the existing navigation fence', () => {
  const app = read('App.tsx');
  assert.match(app, /function leaveReferencePage\(\) \{ setShowTasks\(false\); setShowDelivery\(false\); \}/);
  const inspect = app.slice(app.indexOf('async function inspect('), app.indexOf('function checkGeneration('));
  const selectClip = app.slice(app.indexOf('async function selectClip('), app.indexOf('async function selectClip(') + 2000);
  assert.match(inspect, /if \(!canDiscard\(\)\) return false/);
  assert.match(selectClip, /if \(!canDiscard\(\) \|\| !clip\) return/);
  assert.match(inspect, /navigationEpoch\.current\+\+;\s*leaveReferencePage\(\);/);
  const guard = selectClip.indexOf('if (!canDiscard() || !clip) return');
  const epoch = selectClip.indexOf('navigationEpoch.current++;');
  const presentation = selectClip.indexOf('setNavigationPresentation(value => value + 1);');
  const close = selectClip.indexOf('leaveReferencePage();');
  assert.ok(guard < epoch && epoch < presentation && presentation < close);
});

test('the generate button explains why it is idle while the title or prompt text still has to be saved', () => {
  const inspector = read('Inspector.tsx');
  assert.match(inspector, /data-testid="generation-save-first"[^>]*>[\s\S]*?inspector\.saveTextFirst/);
  assert.match(inspector, /dirty && !textBlocksLegacy \? t\('inspector.saveGenerate'\) : t\('inspector.generateShot'\)/);
});

test('an empty timeline is flagged before Check, and the empty preview offers building it from the storyboard', () => {
  const app = read('App.tsx'), preview = read('Preview.tsx'), preflight = read('TimelineExportPreflight.tsx');
  // The topbar button stays an always-open entrance to recovery (export-preflight-ui pins its exact source).
  assert.match(app, /<WorkbenchButton variant="primary"[^>]*data-testid="export-timeline" disabled=\{!canOpenExport\} onClick=\{openTimelineExport\}>/);
  assert.match(preflight, /Array\.isArray\(timeline\?\.clips\) && timeline\.clips\.length === 0 && <p className="notice warning" data-testid="preflight-empty-timeline">/);
  assert.match(app, /<Preview [^]*?canSeed=\{Boolean\(sortedShots\.length && selectedCount === sortedShots\.length\)\} seedBusy=\{timelineBusy\} onSeed=\{\(\) => mutateTimeline\('timeline\.seed', \{\}, timeline\?\.revision\)\}/);
  assert.match(preview, /canSeed && onSeed && !timeline\?\.clips\?\.length && <Button[^>]*data-testid="preview-seed-timeline"[^>]*>[^]*?timeline\.preview\.seed/);
});

test('localized layout labels retain the original semantic copy', () => {
  assert.equal(translate('zh-Hans', 'inspector.saveTextFirst'), '先点上方“保存标题和提示词”，再生成镜头');
  assert.equal(translate('zh-Hans', 'inspector.saveGenerate'), '保存并生成镜头');
  assert.equal(translate('zh-Hans', 'timeline.preview.seed'), '从分镜建立时间线');
});
