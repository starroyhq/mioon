import React from 'react';
import TimelineMixLoudness from '../../apps/web/src/TimelineMixLoudness.tsx';
import {createTimelineMixLoudnessController} from '../../apps/web/src/timeline-mix-loudness-state.ts';
import type {TimelineMixLoudnessContext,TimelineMixLoudnessView} from '../../apps/web/src/timeline-mix-loudness-state.ts';
import {useTimelineMixLoudness} from '../../apps/web/src/use-timeline-mix-loudness.ts';
import {readTimelineMixLoudnessRpc} from '../../apps/web/src/timeline-mix-loudness-rpc.ts';
function consume(view:TimelineMixLoudnessView,context:TimelineMixLoudnessContext):void{
  const valid=<TimelineMixLoudness loudness={view}/>;
  // @ts-expect-error Requires checked controller+state, not an enable flag.
  const flag=<TimelineMixLoudness loudness={true}/>;
  // @ts-expect-error No apply callback can be supplied to this read-only UI.
  const apply=<TimelineMixLoudness loudness={view} onApply={()=>undefined}/>;
  // @ts-expect-error No caller-controlled path through the shared strict request.
  createTimelineMixLoudnessController({read:async input=>input.path});
  // @ts-expect-error A live saved project context is required.
  useTimelineMixLoudness({read:async()=>null});
  // @ts-expect-error Consumers cannot mark their own report successful.
  view.state.phase='ready';
  const rev:number|null=context.revision;
  const read:typeof readTimelineMixLoudnessRpc=readTimelineMixLoudnessRpc;
  void[valid,flag,apply,rev,read];
}
void consume;
type IsAny<T>=0 extends(1&T)?true:false;
type Expect<T extends false>=T;
export type CheckedView=Expect<IsAny<ReturnType<typeof useTimelineMixLoudness>>>;
