import React from 'react';
import TimelineAudioPreview from '../../apps/web/src/TimelineAudioPreview.tsx';
import {useTimelineAudioPreview,createTimelineAudioPreviewController} from '../../apps/web/src/use-timeline-audio-preview.ts';
import type {TimelineAudioPreviewView,TimelineAudioPreviewContext} from '../../apps/web/src/use-timeline-audio-preview.ts';
import {createTimelineAudioPreviewTransport} from '../../apps/web/src/timeline-audio-preview-engine.ts';
import {createNativeAudioPreviewAdmission} from '../../apps/web/src/native-audio-preview-adapter.ts';
import type {NativeAudioPreviewAdmission,NativeAudioPreviewAttempt} from '../../apps/web/src/native-audio-preview-adapter.ts';
import type {NativeAudioPreviewBridge,NativeAudioLease} from '@mioon/contracts/native-audio-preview';
import type {AudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import type {AudioPreviewPrepareOptions} from '../../apps/web/src/timeline-audio-preview-client.ts';

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

function nativeConsumer(bridge:NativeAudioPreviewBridge,plan:AudioPreviewPlan,context:AudioPreviewPrepareOptions['context'],signal:AbortSignal):void {
  const admission:NativeAudioPreviewAdmission=createNativeAudioPreviewAdmission(bridge);
  const attempt:NativeAudioPreviewAttempt=admission.begin({onRevoke(){},onWaiting(state){const bounded:'waiting'|'blocked'=state;void bounded;}});
  const granted:Promise<NativeAudioLease>=attempt.acquire(plan,signal);
  const options:AudioPreviewPrepareOptions={context,signal,reserveNative:(checked,abort)=>attempt.acquire(checked,abort)};
  const controller=createTimelineAudioPreviewController({readPlan:async()=>plan,nativeAdmission:admission});
  attempt.retire(Promise.resolve());
  // @ts-expect-error A renderer cannot turn a native reservation into an arbitrary URL Fetch.
  admission.begin({onRevoke(){},onWaiting(){},url:'https://example.invalid'});
  // @ts-expect-error Admission requires a checked plan object rather than a renderer-declared byte budget.
  attempt.acquire({admittedBytes:1},signal);
  // @ts-expect-error Retirement requires an actual local resource-settlement promise, not a boolean assertion.
  attempt.retire(true);
  // @ts-expect-error Source preparation requires the exact native lease, not a claimed lease identifier alone.
  const wrongReservation:AudioPreviewPrepareOptions={context,signal,reserveNative:async()=>({leaseId:'id'})};
  // @ts-expect-error Native admission cannot be replaced with an always-allow flag.
  createTimelineAudioPreviewController({readPlan:async()=>plan,nativeAdmission:true});
  void [granted,options,controller,wrongReservation];
}
export type CheckedNativeAdmission=Assert<IsAny<ReturnType<typeof createNativeAudioPreviewAdmission>> extends false?true:false>;
export type CheckedNativeAttempt=Assert<IsAny<ReturnType<NativeAudioPreviewAdmission['begin']>> extends false?true:false>;
export type CheckedNativeGrant=Assert<IsAny<Awaited<ReturnType<NativeAudioPreviewAttempt['acquire']>>> extends false?true:false>;
void nativeConsumer;
