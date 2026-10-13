import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');

test('the clip inspector leads with the fields people edit most and keeps source and replacement after them', () => {
  const source = read('TimelineInspector.jsx');
  const order = ['id="clip-name"', 'id="clip-track"', 'id="clip-start"', 'id="clip-source-in"', '<div className="clip-source">',
    '画面位置与尺寸', '<ClipAudioControls', '<ClipSourceReplacement', '<div className="clip-form-actions">'];
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
