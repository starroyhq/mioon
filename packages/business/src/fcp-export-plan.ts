import {lstatSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import type {FcpExportError, FcpExportPreviewOutput, FcpItem, FcpItemCode} from '../../contracts/src/fcp-export.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {fcpxmlTransitions, type FcpXmlAsset} from './fcp-xml.ts';
import type {PreparedAssetReference, ProjectAssetReferenceServices} from './project-asset-references.ts';

type Row = Record<string, unknown>;
type Preview = FcpExportPreviewOutput;
const mediaExtensions = new Map([
  ['video/mp4', '.mp4'], ['image/png', '.png'], ['image/jpeg', '.jpg'],
  ['audio/mp4', '.m4a'], ['audio/wav', '.wav'], ['audio/mpeg', '.mp3'],
]);
const offlineCodes = new Set(['NOT_FOUND', 'MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_CHANGED_DURING_READ',
  'MEDIA_REFERENCE_INVALID', 'MEDIA_OUTSIDE_NOT_CONFIRMED', 'MEDIA_NOT_MEDIA']);

export class FcpExportFailure extends Error {
  readonly detail: FcpExportError;
  constructor(detail: FcpExportError) {super(detail.code); this.detail = detail;}
}

export function fcpSafeName(value: string, fallback: string): string {
  const cleaned = value.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}]/gu, '_').trim().replace(/^[. ]+|[. ]+$/gu, '');
  let result = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(result + character) > 160) break;
    result += character;
  }
  return result.replace(/[. ]+$/gu, '') || fallback;
}

export function fcpDisplayPath(file: string): string {
  const home = homedir();
  if (file === home) return '~';
  return file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}

export function fcpFileIdentity(info: {dev: bigint; ino: bigint; birthtimeNs: bigint}): string {
  return [info.dev, info.ino, info.birthtimeNs].join(':');
}

export function fcpSourceIdentity(info: {dev: bigint; ino: bigint; birthtimeNs: bigint; size: bigint; ctimeNs: bigint; mtimeNs: bigint}): string {
  return [fcpFileIdentity(info), info.size, info.ctimeNs, info.mtimeNs].join(':');
}

export interface FcpSource {
  readonly reference: PreparedAssetReference;
  readonly identity: string;
  readonly name: string;
}

export interface FcpMediaCopy {
  readonly source: FcpSource;
  readonly fileName: string;
  readonly sha256: string;
}

export interface FcpPlan {
  readonly preview: Preview;
  readonly copies: ReadonlyArray<FcpMediaCopy>;
  readonly assets: ReadonlyMap<string, {
    readonly metadata: Omit<FcpXmlAsset, 'fileUrl'>;
    readonly source?: FcpSource;
    readonly bundleRelativePath?: string;
  }>;
}

const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const transitions = {
  dipToBlack: ['淡入黑场', 'Dip to Color'], wipeLeft: ['向左擦除', 'Edge Wipe'], wipeRight: ['向右擦除', 'Edge Wipe'],
  pushLeft: ['向左推入', 'Push'], pushRight: ['向右推入', 'Push'],
} as const;

export async function planFcpExport(input: {
  timeline: Format5Timeline; projectName: string; destination: string; copyMedia: boolean;
  references: ProjectAssetReferenceServices; readAsset(id: string): Row | undefined;
  signal?: AbortSignal; beforeEffect?: () => void;
}): Promise<FcpPlan> {
  const {timeline, projectName, destination, copyMedia, references, readAsset, signal, beforeEffect} = input;
  const {width, height, fps, durationFrames, clips} = timeline;
  const tracks = new Map(timeline.tracks.map(track => [track.id, track]));
  const uses = new Map<string, Format5Clip[]>();
  const missing = new Map<string, FcpItem>();
  const approximate = new Map<string, FcpItem>();

  function item(group: Map<string, FcpItem>, code: FcpItemCode, clip: FcpItem['clips'][number], values?: FcpItem['values']): void {
    const key = JSON.stringify([code, values]);
    const existing = group.get(key);
    if (existing) (existing.clips as Array<typeof clip>).push(clip);
    else group.set(key, {code, clips: [clip], ...(values && {values})});
  }
  function clipLabel(clip: Format5Clip): FcpItem['clips'][number] {
    const track = tracks.get(clip.trackId);
    return {id: clip.id, name: clip.name, ...(track && {trackLabel: track.name})};
  }
  function affected(group: Map<string, FcpItem>, code: FcpItemCode, clip: Format5Clip, values?: FcpItem['values']): void {
    item(group, code, clipLabel(clip), values);
  }

  for (const clip of clips) {
    if (clip.sourceState === 'placeholder' || !clip.assetId) {
      affected(missing, 'PLACEHOLDER', clip);
      continue;
    }
    const group = uses.get(clip.assetId) ?? [];
    group.push(clip);
    uses.set(clip.assetId, group);
    const colour = clip.colour as {look?: {enabled?: boolean; strength?: number}} | null;
    if (colour?.look?.enabled && colour.look.strength !== 0) affected(missing, 'LUT', clip);
  }

  const assets = new Map<string, FcpPlan['assets'] extends ReadonlyMap<string, infer T> ? T : never>();
  const copies = new Map<string, FcpMediaCopy>();
  for (const [id, used] of uses) {
    signal?.throwIfAborted();
    const asset = readAsset(id);
    const mime = typeof asset?.mimeType === 'string' ? asset.mimeType : '';
    const extension = mediaExtensions.get(mime);
    if (asset && !extension) {
      for (const clip of used) affected(missing, 'UNSUPPORTED_MEDIA', clip);
      continue;
    }
    const name = typeof asset?.name === 'string' ? asset.name : used[0]!.name;
    const still = mime.startsWith('image/');
    const metadata = {
      id, name, hasVideo: !mime.startsWith('audio/') && (mime !== '' || used.some(clip => tracks.get(clip.trackId)?.kind === 'video')),
      hasAudio: mime.startsWith('audio/') || asset?.hasAudio === true || used.some(clip => tracks.get(clip.trackId)?.kind === 'audio'),
      durationFrames: Math.max(Math.ceil((numeric(asset?.duration) ?? 0) * fps), ...used.map(clip => clip.sourceInFrame + clip.durationFrames)),
      width: numeric(asset?.width), height: numeric(asset?.height), audioChannels: numeric(asset?.audioChannels), audioRate: numeric(asset?.audioRate), isStill: still,
    };
    let reference: PreparedAssetReference;
    let identity: string;
    let sha256: string | null;
    try {
      reference = await references.resolve(id, {signal, beforeEffect});
      const info = lstatSync(reference.file, {bigint: true});
      if (!info.isFile() || realpathSync(reference.file) !== reference.file || Number(info.size) !== reference.reference.sizeBytes
          || Math.abs(Number(info.mtimeNs) / 1e6 - reference.reference.mtimeMs) > 1) {
        throw new FcpExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
      }
      identity = fcpSourceIdentity(info);
      sha256 = reference.reference.fullSha256;
      if (copyMedia && !sha256) {
        const hashed = await references.prepareFullHash(id, {signal, beforeEffect, expectedReferenceRevision: reference.referenceRevision});
        if (hashed.file !== reference.file || fcpSourceIdentity(lstatSync(reference.file, {bigint: true})) !== identity) {
          throw new FcpExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
        }
        sha256 = hashed.sha256;
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof FcpExportFailure) throw error;
      const noAccess = error instanceof AppError && (error.details as Row | undefined)?.reason === 'no-access';
      if (!noAccess && (code === 'ENOENT' || offlineCodes.has(code ?? ''))) {
        for (const clip of used) affected(missing, 'MEDIA_MISSING', clip);
        assets.set(id, {metadata, bundleRelativePath: 'Media/Offline_' + id + (extension ?? '.mp4')});
        continue;
      }
      throw new FcpExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
    }
    const source = {reference, identity, name};
    let bundleRelativePath: string | undefined;
    if (copyMedia && sha256) {
      let copy = copies.get(sha256);
      if (!copy) {
        const stem = fcpSafeName(path.parse(path.basename(name)).name, 'Media');
        const fileName = String(copies.size + 1).padStart(3, '0') + '_' + stem + extension;
        copy = {source, fileName, sha256};
        copies.set(sha256, copy);
      }
      bundleRelativePath = 'Media/' + copy.fileName;
    }
    assets.set(id, {metadata, source, bundleRelativePath});
  }

  const cuts = fcpxmlTransitions(timeline, assets);
  for (const clip of clips) {
    if (clip.sourceState !== 'ready' || !clip.assetId) continue;
    const asset = assets.get(clip.assetId);
    if (!asset) continue;
    const track = tracks.get(clip.trackId);
    if (clip.anchor) affected(approximate, 'ANCHOR', clip);
    if (clip.volumeEnvelope && volumeEnvelopeField(clip).volumeEnvelope != null) affected(approximate, 'VOLUME_KEYFRAMES', clip);
    if (clip.fadeInFrames || clip.fadeOutFrames) affected(approximate, 'FADES', clip);
    if (asset.metadata.hasAudio && (clip.muted || track?.muted)) affected(approximate, 'MUTE', clip);
    if (clip.soundOnly) affected(approximate, 'SEPARATE_SOUND', clip);
    if (clip.transform || clip.layout && (clip.rect.x || clip.rect.y || clip.rect.width !== width || clip.rect.height !== height)) {
      affected(approximate, 'TRANSFORM', clip);
    }
    const transition = cuts.get(clip.id);
    if (transition && transition.kind !== 'dissolve') {
      const [from, to] = transitions[transition.kind];
      affected(approximate, 'TRANSITION', clip, {from, to});
    }
  }
  for (const cue of timeline.subtitles?.cues ?? []) {
    const label = {id: cue.id, name: cue.text, trackLabel: '字幕'};
    item(approximate, 'SUBTITLE_STYLE', label);
    if (cue.anchor) item(approximate, 'ANCHOR', label);
  }

  const planCopies = [...copies.values()];
  return {
    preview: {
      timeline: {width, height, fps, durationFrames, clipCount: clips.length}, defaultName: projectName,
      projectDestination: {displayPath: fcpDisplayPath(destination)}, mediaFiles: planCopies.length,
      mediaBytes: planCopies.reduce((sum, copy) => sum + copy.source.reference.reference.sizeBytes, 0),
      missing: [...missing.values()] as Preview['missing'], approximations: [...approximate.values()] as Preview['approximations'],
    },
    copies: planCopies,
    assets,
  };
}

export function fcpMissingMarkdown(preview: Preview): string {
  const labels: Record<FcpItemCode, string> = {
    LUT: 'LUT 调色', PLACEHOLDER: '未生成的镜头（空隙）', MEDIA_MISSING: '找不到的素材（离线）',
    UNSUPPORTED_MEDIA: 'Final Cut Pro 不支持的素材', TRANSITION: '转场', VOLUME_KEYFRAMES: '音量关键帧',
    FADES: '淡入和淡出', SUBTITLE_STYLE: '字幕样式', ANCHOR: '挂靠', MUTE: '静音（−96 dB）',
    SEPARATE_SOUND: '分离声音', TRANSFORM: '位置、缩放、旋转或裁切',
  };
  const text = (value: string): string => value.replace(/[\\`*_{}\[\]()#+\-.!<>|]/gu, '\\$&').replace(/[\p{Cc}]/gu, ' ');
  const lines = ['# Final Cut Pro 导出清单'];
  for (const [title, group] of [['带不过去', preview.missing], ['近似处理', preview.approximations]] as const) {
    lines.push('', '## ' + title, '');
    if (!group.length) lines.push('无');
    for (const entry of group) {
      const change = entry.values ? '（' + text(entry.values.from ?? '') + ' → ' + text(entry.values.to ?? '') + '）' : '';
      lines.push('- ' + labels[entry.code] + change + '（' + entry.clips.length + '）');
      for (const clip of entry.clips) lines.push('  - ' + text(clip.name) + (clip.trackLabel ? ' · ' + text(clip.trackLabel) : ''));
    }
  }
  return lines.join('\n') + '\n';
}
