import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');

test('format-5 render entry is no longer blocked before export, preview and sample', () => {
  assert.doesNotMatch(app, /async function renderTimeline\([^)]*\)[^{]*\{[\s\S]{0,500}projectFormatVersion === 5\) \{ notify\(t\('editUi\.error\.GENERIC'\)/u,
    'renderTimeline must not immediately reject the format-5 project');
  assert.match(app, /onExport=\{\(binding: unknown\) => renderTimeline\('export', binding\)\}/u);
  assert.match(app, /onRender=\{renderTimeline\}/u);
  assert.match(app, /if \(sample && \(purpose !== 'export'/u);
  assert.match(app, /await renderTimeline\('export', checked.binding, undefined, true\)/u);
  // Render/delivery record guards state the project format, including muted/soundOnly.
  assert.match(app, /productionTimelineRenderRecord\(value, input, timelineRecordFormat\(\)\)/u);
  assert.match(app, /productionTimelineMutationResponse\(operation, input, value, timelineRecordFormat\(\)\)/u);
});

test('visible legacy format-5 entries are either connected to a format-5 action or hidden', () => {
  // Connected: dialogue loudness gains -> one FR-A clip-properties action.
  assert.match(app, /if \(format5\) \{\s*\/\/ Format 5 has no legacy gain batch[\s\S]{0,500}kind: 'clip-properties', edits/u);
  // Connected: scene split -> format5Session().splitAtScenes.
  assert.match(app, /if \(dataRef\.current\.projectFormatVersion === 5\) \{\s*const result = await format5Session\(\)\.splitAtScenes/u);
  // Connected: transition / transform / crossfade -> format5 property actions (tested in format5-panels).
  assert.match(app, /format5ClipPropertyEdit\(clipId, 'transform'/u);
  assert.match(app, /format5ClipPropertyEdit\(clipId, 'transition'/u);
  assert.match(app, /timelineCrossfadeEnvelopes/u);
  // Hidden: seed and storyboard append already require non-format-5 UI.
  assert.match(app, /canSeed=\{format5 \? false :/u);
  assert.match(app, /onSeed=\{format5 \? undefined :/u);
  assert.match(app, /workspaceMode === 'canvas' && !format5 && <StoryboardStrip/u);
  // Hidden: no format-5 sequence action for source refresh or clip source replacement.
  assert.match(app, /const sourceBanner = !format5 && timeline \?/u);
  assert.match(app, /replacementContext=\{format5 \? undefined :/u);
  assert.match(app, /onReplaceSource=\{format5 \? undefined :/u);
});
