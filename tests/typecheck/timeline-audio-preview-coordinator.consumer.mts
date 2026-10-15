import type {DatabaseSync} from 'node:sqlite';
import type {createTimelineAudioPreviewServices} from '../../packages/business/src/timeline-audio-preview.ts';
import type {createTimelineAudioContinuousServices} from '../../packages/business/src/timeline-audio-continuous.ts';
import {createSavedTimelineAudioReader, createTimelineAudioPreviewCoordinator} from '../../packages/business/src/timeline-audio-preview-coordinator.ts';

class PreviewError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {super(message); this.code = code; this.status = status;}
}

export function checkedAudioLanes(legacy: ReturnType<typeof createTimelineAudioPreviewServices>,
  continuous: ReturnType<typeof createTimelineAudioContinuousServices>) {
  const audio = createTimelineAudioPreviewCoordinator(legacy, continuous, PreviewError);
  const source: Promise<number> = audio.consumeSource({}, {consume: async (decoded, context) => {
    const rate: 48000 = decoded.sampleRate;
    const beforeEffect: () => void = context.beforeEffect;
    void [rate, beforeEffect]; return decoded.pcm.length;
  }, onResourceSettlement(settlement) {const retired: Promise<void> = settlement; void retired;}});
  const block: Promise<string> = audio.consumeBlock({}, {consume: async ({pcm}, context) => {
    const generation: number = context.input.generation;
    void pcm; return String(generation);
  }});
  // @ts-expect-error A resource proof never settles to a caller payload.
  audio.consumeSource({}, {consume: async () => 1, onResourceSettlement: (_proof: Promise<string>) => {}});
  // @ts-expect-error Both lane consumers retain their asynchronous contract.
  audio.consumeBlock({}, {consume: () => 1});
  return {audio, source, block};
}

export function checkedSavedReader(db: Pick<DatabaseSync, 'isTransaction' | 'exec'>) {
  const read = createSavedTimelineAudioReader({db,
    readTimeline: (projectId: string) => ({projectId, revision: 1}),
    readAssets: (_projectId, timeline) => new Map([[timeline.projectId, {id: timeline.projectId, sizeBytes: 32}]]),
    validate(timeline, assets) {const revision: number = timeline.revision; void [revision, assets];},
  });
  const saved = read('project-id');
  if (saved) {const bytes: number = saved.assets[0]!.sizeBytes; const revision: number = saved.timeline.revision; void [bytes, revision];}
  return read;
}

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
export type CheckedCoordinator = Assert<IsAny<ReturnType<typeof checkedAudioLanes>['audio']> extends false ? true : false>;
export type CheckedSourceResult = Assert<IsAny<Awaited<ReturnType<typeof checkedAudioLanes>['source']>> extends false ? true : false>;
export type CheckedBlockResult = Assert<IsAny<Awaited<ReturnType<typeof checkedAudioLanes>['block']>> extends false ? true : false>;
export type CheckedReader = Assert<IsAny<ReturnType<ReturnType<typeof checkedSavedReader>>> extends false ? true : false>;
