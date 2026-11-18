/** Baseline harness for UI-E1: renders the real editing timeline with no UI-E1
 * projection prop. The same file is built before and after the change so the
 * screenshots can be compared byte for byte. No application host starts. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import './fixture.css';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import {I18nProvider, createLanguageStore} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import {
  FIXTURE_PLAYHEAD, FIXTURE_PROJECT_ID, FIXTURE_SELECTED_CLIP_ID, FIXTURE_TIMELINE_ID,
  fixtureAssets, fixtureTimeline,
} from './scenes.ts';

const timeline = fixtureTimeline('main');
const assets = fixtureAssets(true);
const history = {
  projectId: FIXTURE_PROJECT_ID, timelineId: FIXTURE_TIMELINE_ID, revision: timeline.revision, cursor: 1, length: 3,
  canUndo: true, canRedo: true, undoEntry: {id: 'entry-1', operation: 'timeline.clip.update'},
  redoEntry: {id: 'entry-2', operation: 'timeline.clip.update'},
};
const viewState = {pixelsPerSecond: 76, scrollLeft: 0, scrollTop: 0, snappingEnabled: true};
const noop = (): undefined => undefined;

function Fixture(): React.ReactElement {
  const historyState = timelineHistoryState({projectId: FIXTURE_PROJECT_ID, timeline, history});
  const splitState = timelineSplitState({projectId: FIXTURE_PROJECT_ID, timeline, history,
    selectedClipId: FIXTURE_SELECTED_CLIP_ID, playhead: FIXTURE_PLAYHEAD, mode: 'editing'});
  return <div className="fixture-baseline dock-workbench workbench-v2">
    <Timeline timeline={timeline as never} assets={assets as never} historyState={historyState as never}
      splitState={splitState as never} onHistory={noop} onSplit={noop} onSelectSubtitle={noop} onAddSubtitle={noop}
      onSelectClip={noop} onAddAsset={noop} onMoveClip={noop} onTrackAdd={noop} onTrackUpdate={noop}
      onSeed={noop} onRender={noop} onSeek={noop} onCollapse={noop} playhead={FIXTURE_PLAYHEAD}
      selectedClipId={FIXTURE_SELECTED_CLIP_ID} selectedCueId={null} collapsed={false} onViewStateChange={noop}
      viewState={viewState} />
  </div>;
}

declare global {
  interface Window {__editUiBaseline?: {ready: boolean}}
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider store={createLanguageStore({systemLanguages: ['zh-Hans']})}><Fixture /></I18nProvider>,
);
window.__editUiBaseline = {ready: true};
