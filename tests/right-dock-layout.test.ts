import { translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');

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
