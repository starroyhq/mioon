import { translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');

test('the clip inspector leads with the fields people edit most and keeps source and replacement after them', () => {
  const source = read('TimelineInspector.jsx');
  const order = ['id="clip-name"', 'id="clip-track"', 'id="clip-start"', 'id="clip-source-in"', '<div className="clip-source">',
    "timeline.inspector.rect", '<ClipAudioControls', '<ClipSourceReplacement', '<div className="clip-form-actions">'];
  const at = order.map(marker => source.indexOf(marker));
  assert.ok(at.every(index => index >= 0), `missing markers: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'inspector sections are out of order');
  // The frozen-source card keeps both of its actions and the replacement workflow keeps its exact binding.
  assert.match(source, /data-testid="return-to-source"/); assert.match(source, /data-testid="preview-clip-source"/);
  assert.match(source, /ClipSourceReplacement context=\{\{ \.\.\.replacementContext, timeline, clipId: clip\.id, dirty \}\}/);
});

test('the Agent message box, consent and send button share one sticky block at the bottom of the dock page', () => {
  const source = read('AgentPanel.jsx');
  const start = source.indexOf('<div className="agent-chat-composer-input">'), end = source.indexOf('<p className="agent-chat-stop-note">');
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  for (const marker of ['data-testid="agent-chat-consent"', 'data-testid="agent-chat-prompt"', 'data-testid="agent-chat-send"']) assert.ok(block.includes(marker), `${marker} must stay inside the sticky block`);
  assert.ok(source.indexOf('data-testid="agent-chat-destination"') < start, 'the send destination stays above the consent it describes');
  // The scope, target and destination sit in their own block above it, so the sticky block can pin to the page itself:
  // the form is display: contents, otherwise a short dock would leave the form (its containing block) off screen.
  const options = source.indexOf('<div className="agent-chat-composer-options">');
  assert.ok(options > 0 && options < source.indexOf('<fieldset className="agent-chat-context-mode"') && source.indexOf('<fieldset className="agent-chat-context-mode"') < source.indexOf('data-testid="agent-chat-destination"') && source.indexOf('data-testid="agent-chat-destination"') < start);
  assert.match(css, /\.agent-workspace \.agent-chat-composer \{ display: contents; \}/);
  assert.match(css, /\.agent-workspace \.agent-chat-composer-input \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*background: #1d2226;/);
});

test('selecting a shot, node or clip leaves the Tasks and Delivery pages for Properties', () => {
  const app = read('App.jsx');
  assert.match(app, /function leaveReferencePage\(\) \{ setRightDockTab\(value => value === 'tasks' \|\| value === 'delivery' \? 'properties' : value\); \}/);
  const inspect = app.slice(app.indexOf('async function inspect('), app.indexOf('function checkGeneration('));
  const selectClip = app.slice(app.indexOf('async function selectClip('), app.indexOf('async function selectClip(') + 900);
  assert.match(inspect, /navigationEpoch\.current\+\+;\s*leaveReferencePage\(\);/); assert.match(selectClip, /navigationEpoch\.current\+\+;\s*leaveReferencePage\(\);/);
});

test('the generate button explains why it is idle while the title or prompt text still has to be saved', () => {
  const inspector = read('Inspector.jsx');
  assert.match(inspector, /data-testid="generation-save-first"[^>]*>[\s\S]*?inspector\.saveTextFirst/);
  assert.match(inspector, /dirty && !textBlocksLegacy \? t\('inspector.saveGenerate'\) : t\('inspector.generateShot'\)/);
});

test('an empty timeline is flagged before Check, and the empty preview offers building it from the storyboard', () => {
  const app = read('App.jsx'), preview = read('Preview.jsx'), preflight = read('TimelineExportPreflight.jsx');
  // The topbar button stays an always-open entrance to recovery (export-preflight-ui pins its exact source).
  assert.match(app, /<DropdownMenuItem data-testid="export-timeline" disabled=\{!canOpenExport\} onClick=\{openTimelineExport\}>/);
  assert.match(preflight, /Array\.isArray\(timeline\?\.clips\) && timeline\.clips\.length === 0 && <p className="notice warning" data-testid="preflight-empty-timeline">/);
  assert.match(app, /<Preview [^]*?canSeed=\{Boolean\(sortedShots\.length && selectedCount === sortedShots\.length\)\} seedBusy=\{timelineBusy\} onSeed=\{\(\) => mutateTimeline\('timeline\.seed', \{\}, timeline\?\.revision\)\}/);
  assert.match(preview, /canSeed && onSeed && !timeline\?\.clips\?\.length && <Button[^>]*data-testid="preview-seed-timeline"[^>]*>[^]*?timeline\.preview\.seed/);
});

test('localized layout labels retain the original semantic copy', () => {
  assert.equal(translate('zh-Hans', 'inspector.saveTextFirst'), '先点上方“保存标题和提示词”，再生成镜头。');
  assert.equal(translate('zh-Hans', 'inspector.saveGenerate'), '保存并生成镜头');
  assert.equal(translate('zh-Hans', 'timeline.preview.seed'), '从分镜建立时间线');
});
