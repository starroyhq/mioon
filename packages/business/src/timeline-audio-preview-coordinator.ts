import type {DatabaseSync} from 'node:sqlite';
import type {createTimelineAudioPreviewServices} from './timeline-audio-preview.ts';
import type {createTimelineAudioContinuousServices} from './timeline-audio-continuous.ts';

type LegacyAudioLane = ReturnType<typeof createTimelineAudioPreviewServices>;
type ContinuousAudioLane = ReturnType<typeof createTimelineAudioContinuousServices>;
interface AudioPreviewErrorConstructor {
  new(code: string, message: string, status: number): Error;
}

/** Coordinate the existing lanes without treating observer completion as proof
 * that a legacy source's decoder, transport and retained PCM have retired. */
export function createTimelineAudioPreviewCoordinator(legacy: LegacyAudioLane, continuous: ContinuousAudioLane,
  ErrorType: AudioPreviewErrorConstructor) {
  let legacyResources = 0;
  const consumeSource: LegacyAudioLane['consumeSource'] = async (input, context) => {
    continuous.assertNoContinuousSession();
    legacyResources++;
    let registered = false, released = false;
    const release = (): void => {if (!released) {released = true; legacyResources--;}};
    try {
      return await legacy.consumeSource(input, {...context, onResourceSettlement: settlement => {
        registered = true;
        // Lane shutdown doubt remains sticky inside that lane. The shared
        // counter follows the existing policy of releasing on either outcome.
        settlement.then(release, release);
        context.onResourceSettlement?.(settlement);
      }});
    } finally {if (!registered) release();}
  };
  const consumeBlock: ContinuousAudioLane['consumeBlock'] = (input, context) => {
    if (legacyResources) throw new ErrorType('AUDIO_PREVIEW_BUSY', 'Audio resources are still retained', 429);
    return continuous.consumeBlock(input, context);
  };
  async function drain(): Promise<void> {await Promise.all([legacy.drain(), continuous.drain()]);}
  return {...legacy, ...continuous, handlers: {...legacy.handlers, ...continuous.handlers}, consumeSource, consumeBlock, drain};
}

export interface SavedTimelineAudioReaderDependencies<Timeline, Asset> {
  readonly db: Pick<DatabaseSync, 'isTransaction' | 'exec'>;
  readonly readTimeline: (projectId: string) => Timeline | null | undefined;
  readonly readAssets: (projectId: string, timeline: Timeline) => ReadonlyMap<string, Asset>;
  readonly validate: (timeline: Timeline, assets: ReadonlyMap<string, Asset>) => void;
}

/** Both audio profiles read the same saved graph in one synchronous read
 * transaction. The caller supplies the existing bounded readers and structural
 * validator; transaction ownership and COMMIT-on-error match their old adapter. */
export function createSavedTimelineAudioReader<Timeline, Asset>(
  {db, readTimeline, readAssets, validate}: SavedTimelineAudioReaderDependencies<Timeline, Asset>,
): (projectId: string) => {timeline: Timeline; assets: Asset[]} | null {
  return projectId => {
    const outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    try {
      const timeline = readTimeline(projectId);
      if (!timeline) return null;
      const assets = readAssets(projectId, timeline);
      validate(timeline, assets);
      return {timeline, assets: [...assets.values()]};
    } finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
  };
}
