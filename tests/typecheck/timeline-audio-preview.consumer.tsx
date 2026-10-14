import React from 'react';
import TimelineAudioPreview from '../../apps/web/src/TimelineAudioPreview.tsx';
import {useTimelineAudioPreview,createTimelineAudioPreviewController} from '../../apps/web/src/use-timeline-audio-preview.ts';
import type {TimelineAudioPreviewView,TimelineAudioPreviewContext} from '../../apps/web/src/use-timeline-audio-preview.ts';
import {createTimelineAudioPreviewTransport} from '../../apps/web/src/timeline-audio-preview-engine.ts';

function consumer(view:TimelineAudioPreviewView,context:TimelineAudioPreviewContext):void {
  const valid=<TimelineAudioPreview audioPreview={view} startFrame={0}/>;
  // @ts-expect-error The interval starts at an integer frame, never a path.
  const badFrame=<TimelineAudioPreview audioPreview={view} startFrame="source.wav"/>;
  // @ts-expect-error A flag is not a checked transport/controller.
  const badOwner=<TimelineAudioPreview audioPreview={true} startFrame={0}/>;
  // @ts-expect-error Saved revision is a number, not an unverified display label.
  const badContext:TimelineAudioPreviewContext={...context,revision:'current'};
  // @ts-expect-error Public input cannot select local filesystem paths.
  createTimelineAudioPreviewController({readPlan:async input=>input.path});
  // @ts-expect-error The hook requires explicit visibility/project ownership.
  useTimelineAudioPreview({readPlan:async()=>null});
  void [valid,badFrame,badOwner,badContext];
}
void consumer;
type IsAny<T>=0 extends(1&T)?true:false;
type Assert<T extends true>=T;
export type CheckedView=Assert<IsAny<ReturnType<typeof useTimelineAudioPreview>> extends false?true:false>;
export type CheckedTransport=Assert<IsAny<ReturnType<typeof createTimelineAudioPreviewTransport>> extends false?true:false>;
