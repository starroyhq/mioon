import path from 'node:path';
import {statfs} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {AppError} from '../../contracts/src/app-error.ts';
import {SPEED_BUDGET_EXCEEDED, SPEED_SOURCE_UNSUPPORTED, TIMELINE_SPEED_EXPORT_MESSAGES}
  from '../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect} from './media-runtime.ts';
import type {SpeedExportLayout} from './timeline-speed-export-admission.ts';
import {prepareTimelineSpeedAudio} from './timeline-speed-export-audio.ts';
import {prepareSpeedExportVideo, type SpeedExportVideoStage} from './timeline-speed-export-video.ts';

interface SpeedSource {
  readonly path?: string;
  readonly videoStreamIndex?: string | number | null;
  readonly audioStreamIndex?: string | number | null;
}
interface Staging {
  readonly work: string;
  reserve(file: string): unknown;
  openOwnedFile(file: string): Promise<FileHandle>;
  writeOwnedFile(file: string, bytes: string): Promise<void>;
}
interface StageOptions {
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
  readonly beforeStart?: () => void;
}

export interface PreparedSpeedPicture extends SpeedExportVideoStage {
  readonly beginFrame: number;
  readonly endFrame: number;
}
export interface PreparedSpeedMedia {
  readonly video: readonly PreparedSpeedPicture[];
  readonly audio: {readonly path: string; readonly samples: number} | null;
}

const maxStageBytes = 10 * 1024 ** 3;
const pcmBytesPerFrame = 1600 * 2 * 4;
const budget = (): AppError => new AppError(SPEED_BUDGET_EXCEEDED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_BUDGET_EXCEEDED], 409);

export async function prepareTimelineSpeedInputs(layout: SpeedExportLayout, assets: ReadonlyMap<string, SpeedSource>,
  staging: Staging, options: StageOptions): Promise<ReadonlyMap<string, PreparedSpeedMedia>> {
  const prepared = new Map<string, PreparedSpeedMedia>();
  if (!layout.clips.length) return prepared;
  checkMediaEffect(options.beforeEffect, options.signal);
  const fs = await statfs(staging.work);
  checkMediaEffect(options.beforeEffect, options.signal);
  let remaining = Math.min(maxStageBytes, fs.bavail * fs.bsize);
  // Account for the entire continuous PCM window before starting any proxy.
  remaining -= layout.clips.reduce((sum, item) => sum + (item.audio ? item.plan.durationFrames * pcmBytesPerFrame : 0), 0);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw budget();
  try {
    for (const [index, item] of layout.clips.entries()) {
      const asset = assets.get(item.assetId);
      if (!asset?.path) {
        throw new AppError(SPEED_SOURCE_UNSUPPORTED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_SOURCE_UNSUPPORTED], 409,
          {clipId: item.clipId});
      }
      const video: PreparedSpeedPicture[] = [];
      for (const [part, window] of item.video.entries()) {
        const stem = path.join(staging.work, `speed-v-${index}-${part}`);
        const result = await prepareSpeedExportVideo({source: {path: asset.path, videoStreamIndex: asset.videoStreamIndex},
          timing: item.timing, plan: window.plan, file: stem + '.mkv', scriptFile: stem + '.filter',
          reserve: staging.reserve, writeOwnedFile: staging.writeOwnedFile, maxBytes: remaining, ...options});
        video.push({...result, beginFrame: window.beginFrame, endFrame: window.endFrame});
        remaining -= result.bytes;
      }
      const audio = item.audio ? await prepareTimelineSpeedAudio({timing: item.timing, plan: item.plan,
        source: {file: asset.path, streamIndex: asset.audioStreamIndex ?? 'a:0', videoStreamIndex: asset.videoStreamIndex},
        destination: path.join(staging.work, `speed-a-${index}.f32`)}, {signal: options.signal,
        beforeEffect: () => {checkMediaEffect(options.beforeEffect, options.signal); options.beforeStart?.();},
        openOwnedFile: staging.openOwnedFile}) : null;
      prepared.set(item.clipId, {video, audio});
    }
  } catch (error) {
    if ((error as {code?: string})?.code === 'ENOSPC') throw budget();
    throw error;
  }
  return prepared;
}
