import React from 'react';
import TimelineClipLoudness from '../../apps/web/src/TimelineClipLoudness.tsx';
import {createTimelineClipLoudnessController} from '../../apps/web/src/timeline-clip-loudness-state.ts';
import type {TimelineClipLoudnessContext,TimelineClipLoudnessView} from '../../apps/web/src/timeline-clip-loudness-state.ts';
import {useTimelineClipLoudness} from '../../apps/web/src/use-timeline-clip-loudness.ts';
import {readTimelineClipLoudnessRpc} from '../../apps/web/src/timeline-clip-loudness-rpc.ts';
function consume(view:TimelineClipLoudnessView,context:TimelineClipLoudnessContext):void{
  const valid=<TimelineClipLoudness loudness={view}/>;
  // @ts-expect-error Requires checked controller+state, not an enable flag.
  const flag=<TimelineClipLoudness loudness={true}/>;
  // @ts-expect-error No apply callback can be supplied to this read-only UI.
  const apply=<TimelineClipLoudness loudness={view} onApply={()=>undefined}/>;
  // @ts-expect-error No caller-controlled path through the shared strict request.
  createTimelineClipLoudnessController({read:async input=>input.path});
  // @ts-expect-error A live saved project context is required.
  useTimelineClipLoudness({read:async()=>null});
  // @ts-expect-error Consumers cannot mark their own report successful.
  view.state.phase='ready';
  const rev:number|null=context.revision;
  const read:typeof readTimelineClipLoudnessRpc=readTimelineClipLoudnessRpc;
  void[valid,flag,apply,rev,read];
}
void consume;
type IsAny<T>=0 extends(1&T)?true:false;
type Expect<T extends false>=T;
export type CheckedView=Expect<IsAny<ReturnType<typeof useTimelineClipLoudness>>>;
