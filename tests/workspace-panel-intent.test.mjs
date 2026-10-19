import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.ts';

// Execute the actual App bridge body with a held real-result boundary. Browser
// acceptance separately holds the real HTTP acknowledgement after SQLite commit.
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  async function addTimelineAsset(');
const end = source.indexOf('  async function returnToSource(', start);
assert.ok(start > 0 && end > start);
const bridgeSource = source.slice(start, end).trim();
const mobileStart = source.indexOf('  function mobileNavigate(');
const mobileEnd = source.indexOf('  const panelFallback', mobileStart);
assert.ok(mobileStart > 0 && mobileEnd > mobileStart);
const mobileSource = source.slice(mobileStart, mobileEnd).trim();
function fixture() {
  let release, dispatched;
  const held = new Promise(resolve => { release = resolve; });
  const state = defaultWorkspaceState();
  state.canvas.viewport = { x: 123, y: -77, zoom: .75 };
  state.editing.timelineCollapsed = true;
  state.layout.editing.inspectorCollapsed = true;
  const asset = { id: 'asset-one', name: 'Synthetic image', mimeType: 'image/png' };
  const timeline = { revision: 5, tracks: [{ id: 'video-one', kind: 'video' }], clips: [] };
  const env = { msg, ...createI18nTestContext(), localizedError: value => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }),
    application: null,
    panelIntent: { current: 0 }, currentProject: { current: 'project-one' },
    guardNavigation: async () => true,
    dataRef: { current: { assets: [asset], timeline } },
    assetKind: item => item.mimeType.split('/')[0],
    assetTimelineDuration: () => ({ known: true, durationFrames: 60 }),
    notify: message => notifications.push(message),
    mutateTimeline: async (...args) => { calls.push(args); dispatched(); return held; },
    navigationEpoch: { current: 0 },
    updateView: (section, patch) => { if (section === 'activeMode') state.activeMode = patch; else Object.assign(state[section], patch); },
    setMobilePanel: panel => mobile.push(panel),
  };
  const calls = [], notifications = [], mobile = [];
  const started = new Promise(resolve => { dispatched = resolve; });
  const add = Function(...Object.keys(env), `return (${bridgeSource});`)(...Object.values(env));
  const accepted = { ...timeline, revision: 6, clips: [{ id: 'accepted-clip', assetId: asset.id, trackId: 'video-one', startFrame: 0, durationFrames: 60 }] };
  return { state, env, add, release: () => release(accepted), started, calls, notifications, mobile, accepted };
}

test('an uninterrupted Add-to-Timeline acknowledgement reveals its accepted clip once without opening a collapsed inspector', async () => {
  const f = fixture(), beforeCanvas = structuredClone(f.state.canvas), beforeLayout = structuredClone(f.state.layout);
  const pending = f.add('asset-one'); await f.started; f.release(); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'timeline.clip.add');
  assert.equal(f.state.activeMode, 'editing'); assert.equal(f.state.editing.selectedClipId, 'accepted-clip');
  assert.equal(f.state.editing.timelineCollapsed, false); assert.equal(f.state.layout.editing.inspectorCollapsed, true);
  assert.deepEqual(f.state.canvas, beforeCanvas); assert.deepEqual(f.state.layout, beforeLayout);
  assert.equal(f.env.navigationEpoch.current, 1); assert.deepEqual(f.mobile, ['canvas']); assert.equal(f.notifications.length, 1);
});

for (const mode of ['canvas', 'editing']) {
  test(`a newer ${mode} panel hide wins over a held bridge reveal while preserving the accepted clip`, async () => {
    const f = fixture(); f.state.activeMode = mode;
    const beforeCanvas = structuredClone(f.state.canvas);
    const pending = f.add('asset-one'); await f.started;
    // This models collapse itself: no navigation invalidation or cancellation.
    f.env.panelIntent.current++;
    f.state.layout[mode].assetsCollapsed = true; f.state.layout[mode].inspectorCollapsed = true;
    const chosenLayout = structuredClone(f.state.layout);
    f.release(); await pending;
    assert.equal(f.calls.length, 1); assert.equal(f.accepted.clips.length, 1);
    assert.equal(f.state.activeMode, mode); assert.deepEqual(f.state.layout, chosenLayout);
    assert.equal(f.state.editing.timelineCollapsed, true); assert.equal(f.state.editing.selectedClipId, 'accepted-clip');
    assert.deepEqual(f.state.canvas, beforeCanvas);
    assert.equal(f.env.navigationEpoch.current, 0); assert.deepEqual(f.mobile, []); assert.equal(f.notifications.length, 1);
  });

  test(`newer narrow ${mode} navigation to its center suppresses a held bridge reveal`, async () => {
    const f = fixture(); f.state.activeMode = mode;
    const navigate = Function('markPanelIntent', 'setMobilePanel', 'setPanelOpen', 'clipDraftRef', `return (${mobileSource});`)(
      () => f.env.panelIntent.current++, f.env.setMobilePanel,
      () => assert.fail('Center navigation must not open a side panel'),
      { current: { hasPendingComposition: () => false } },
    );
    const pending = f.add('asset-one'); await f.started;
    navigate('canvas');
    f.release(); await pending;
    assert.equal(f.env.panelIntent.current, 1);
    assert.equal(f.state.activeMode, mode);
    assert.equal(f.state.editing.selectedClipId, 'accepted-clip');
    assert.equal(f.state.editing.timelineCollapsed, true);
    assert.equal(f.env.navigationEpoch.current, 0);
    assert.deepEqual(f.mobile, ['canvas'], 'Only the newer center navigation runs');
  });
}
