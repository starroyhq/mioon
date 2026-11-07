import React, {Profiler, useState} from 'react';
import type {ProfilerOnRenderCallback} from 'react';
import {createRoot} from 'react-dom/client';
import Timeline from '../../../apps/web/src/Timeline.tsx';
import type {AppAsset, AppTimeline} from '../../../apps/web/src/App.tsx';
import {ProjectMediaProvider} from '../../../apps/web/src/project-media-read-gate.tsx';
import {createProjectMediaController} from '../../../apps/web/src/project-media-state.ts';
import type {ProjectMediaBinding} from '../../../apps/web/src/use-project-media.ts';
import {timelineHistoryState} from '../../../apps/web/src/timeline-history.ts';
import {timelineSplitState} from '../../../apps/web/src/timeline-split.ts';
import '../../../apps/web/src/styles.css';

const projectId = '11111111-1111-4111-8111-111111111111';
const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Keep this exact array across local renders: the regression is caused by the
// Timeline's derived filtered array, not by a deliberately unstable fixture.
const assets: AppAsset[] = [{id: assetId, projectId, name: 'Synthetic audio', mimeType: 'audio/wav', sizeBytes: 960044, duration: 10, hasAudio: true, referenceRevision: 1}];
const emptyTimeline: AppTimeline = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectId, revision: 1, fps: 30, width: 1080, height: 1920,
  durationFrames: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  tracks: [{id: 'audio', name: 'Audio 1', kind: 'audio', orderIndex: 0, hidden: false, muted: false}], clips: [],
};
const clipTimeline: AppTimeline = {...emptyTimeline, revision: 2, durationFrames: 300, clips: [{
  id: 'clip-one', trackId: 'audio', assetId, name: 'Synthetic audio clip', startFrame: 0, durationFrames: 300,
  sourceInFrame: 0, rect: {x: 0, y: 0, width: 1080, height: 1920}, gain: 1,
}]};
const controller = createProjectMediaController({readOwner: () => null, readAssets: () => []});
const report = {stage: 'empty', commits: 0, commitsByStage: {} as Record<string, number>};
const onRender: ProfilerOnRenderCallback = id => {
  report.stage = id; report.commits++;
  report.commitsByStage[id] = (report.commitsByStage[id] ?? 0) + 1;
  // The report is outside the React root, so a real #185 does not erase the red
  // evidence. Do not call setState from the Profiler or record duration values.
  const output = document.getElementById('report');
  if (output) output.textContent = JSON.stringify(report);
};
const noop = (): void => {};
function Fixture() {
  const [stage, setStage] = useState('empty');
  const [readable, setReadable] = useState(true);
  const [hasClip, setHasClip] = useState(false);
  const timeline = hasClip ? clipTimeline : emptyTimeline;
  // This is a controlled permission port, with the real context/hook consumers.
  // Like useProjectMedia, the binding changes on a parent render; Timeline's
  // own state renders retain the same Provider value.
  const media: ProjectMediaBinding = {controller, state: controller.getState(),
    canRead: value => readable && typeof value === 'object' && value !== null && 'id' in value && value.id === assetId && 'projectId' in value && value.projectId === projectId,
    statusFor: () => readable ? {kind: 'online'} : {kind: 'checking'},
  };
  const history = {projectId, timelineId: timeline.id, revision: timeline.revision, cursor: 0, length: 0, canUndo: false, canRedo: false, undoEntry: null, redoEntry: null};
  return <>
    <div className="fixture-controls">
      <button data-testid="fixture-add-clip" onClick={() => {setHasClip(true); setStage('clip');}}>Add synthetic clip</button>
      <button data-testid="fixture-deny" onClick={() => {setReadable(false); setStage('denied');}}>Revoke media read</button>
      <button data-testid="fixture-parent-render" onClick={() => setStage('denied-parent-render')}>Render parent again</button>
      <button data-testid="fixture-allow" onClick={() => {setReadable(true); setStage('allowed');}}>Allow media read</button>
      <output data-testid="fixture-stage">{stage}</output>
    </div>
    <ProjectMediaProvider media={media}><Profiler id={stage} onRender={onRender}><div className="fixture-timeline">
      <Timeline timeline={timeline} assets={assets} historyState={timelineHistoryState({projectId, timeline, history})}
        splitState={timelineSplitState({projectId, timeline, history, playhead: 0, selectedClipId: null})}
        selectedClipId={null} selectedCueId={null} playhead={0} collapsed={false}
        onHistory={noop} onSplit={noop} onSelectSubtitle={noop} onAddSubtitle={noop} onSelectClip={noop}
        onAddAsset={noop} onMoveClip={noop} onTrackAdd={noop} onTrackUpdate={noop} onSeed={noop} onRender={noop} onSeek={noop} onCollapse={noop}/>
    </div></Profiler></ProjectMediaProvider>
  </>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<Fixture/>);
