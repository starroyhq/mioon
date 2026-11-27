import {lstatSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AppError} from '../../contracts/src/app-error.ts';
import type {FcpClipRef, FcpExportError, FcpExportPreviewOutput, FcpItemValues} from '../../contracts/src/fcp-export.ts';
import type {PremiereExportPreviewOutput, PremiereItemCode} from '../../contracts/src/premiere-export.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {fcpxmlTransitions, type FcpXmlAsset} from './fcp-xml.ts';
import {premiereTransitionCuts} from './premiere-xml.ts';
import type {PreparedAssetReference, ProjectAssetReferenceServices} from './project-asset-references.ts';

type Row = Record<string, unknown>;
export type EditorExportFormat = 'fcpxml' | 'premiere';
export type EditorExportPreview = PremiereExportPreviewOutput;
type MissingCode = FcpExportPreviewOutput['missing'][number]['code'];
type ApproximationCode = FcpExportPreviewOutput['approximations'][number]['code'];
type ChecklistItem<Code extends PremiereItemCode> = {code: Code; clips: FcpClipRef[]; values?: FcpItemValues};
const mediaExtensions = new Map([
  ['video/mp4', '.mp4'], ['image/png', '.png'], ['image/jpeg', '.jpg'],
  ['audio/mp4', '.m4a'], ['audio/wav', '.wav'], ['audio/mpeg', '.mp3'],
]);
const offlineCodes = new Set(['NOT_FOUND', 'MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_CHANGED_DURING_READ',
  'MEDIA_REFERENCE_INVALID', 'MEDIA_OUTSIDE_NOT_CONFIRMED', 'MEDIA_NOT_MEDIA']);

export class EditorExportFailure extends Error {
  readonly detail: FcpExportError;
  constructor(detail: FcpExportError) {super(detail.code); this.detail = detail;}
}

export function editorExportSafeName(value: string, fallback: string): string {
  const cleaned = value.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}]/gu, '_').trim().replace(/^[. ]+|[. ]+$/gu, '');
  let result = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(result + character) > 160) break;
    result += character;
  }
  return result.replace(/[. ]+$/gu, '') || fallback;
}

export function editorExportDisplayPath(file: string): string {
  const home = homedir();
  if (file === home) return '~';
  return file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}

export {editorExportDisplayPath as fcpDisplayPath};

export function editorExportFileIdentity(info: {dev: bigint; ino: bigint; birthtimeNs: bigint}): string {
  return [info.dev, info.ino, info.birthtimeNs].join(':');
}

export function editorExportSourceIdentity(info: {dev: bigint; ino: bigint; birthtimeNs: bigint; size: bigint; ctimeNs: bigint; mtimeNs: bigint}): string {
  return [editorExportFileIdentity(info), info.size, info.ctimeNs, info.mtimeNs].join(':');
}

export interface EditorExportSource {
  readonly reference: PreparedAssetReference;
  readonly identity: string;
  readonly name: string;
}

export interface EditorMediaCopy {
  readonly source: EditorExportSource;
  readonly fileName: string;
  readonly sha256: string;
}

interface PlannedAsset {
  readonly metadata: Omit<FcpXmlAsset, 'fileUrl'>;
  readonly source?: EditorExportSource;
  readonly bundleRelativePath?: string;
}

export interface EditorExportPlan<Preview extends EditorExportPreview> {
  readonly preview: Preview;
  readonly copies: ReadonlyArray<EditorMediaCopy>;
  readonly assets: ReadonlyMap<string, PlannedAsset>;
}

const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const transitions = {
  dissolve: {from: '叠化', premiere: 'Cross Dissolve'},
  dipToBlack: {from: '淡入黑场', fcpxml: 'Dip to Color', premiere: 'Dip to Black'},
  wipeLeft: {from: '向左擦除', fcpxml: 'Edge Wipe', premiere: 'Wipe'},
  wipeRight: {from: '向右擦除', fcpxml: 'Edge Wipe', premiere: 'Wipe'},
  pushLeft: {from: '向左推入', fcpxml: 'Push', premiere: 'Push'},
  pushRight: {from: '向右推入', fcpxml: 'Push', premiere: 'Push'},
} as const;

export interface EditorExportPlanInput {
  timeline: Format5Timeline; projectName: string; destination: string; copyMedia: boolean;
  references: ProjectAssetReferenceServices; readAsset(id: string): Row | undefined;
  signal?: AbortSignal; beforeEffect?: () => void;
}

export function planEditorExport(input: EditorExportPlanInput, format: 'fcpxml'): Promise<EditorExportPlan<FcpExportPreviewOutput>>;
export function planEditorExport(input: EditorExportPlanInput, format: 'premiere'): Promise<EditorExportPlan<PremiereExportPreviewOutput>>;
export async function planEditorExport(input: EditorExportPlanInput, format: EditorExportFormat): Promise<EditorExportPlan<EditorExportPreview>> {
  const {timeline, projectName, destination, copyMedia, references, readAsset, signal, beforeEffect} = input;
  const {width, height, fps, durationFrames, clips} = timeline;
  const tracks = new Map(timeline.tracks.map(track => [track.id, track]));
  const uses = new Map<string, Format5Clip[]>();
  const missing = new Map<string, ChecklistItem<MissingCode>>();
  const approximate = new Map<string, ChecklistItem<ApproximationCode>>();
  const subtitles: FcpClipRef[] = [];

  function item<Code extends PremiereItemCode>(group: Map<string, ChecklistItem<Code>>, code: NoInfer<Code>, clip: FcpClipRef, values?: FcpItemValues): void {
    const key = JSON.stringify([code, values]);
    const existing = group.get(key);
    if (existing) existing.clips.push(clip);
    else group.set(key, {code, clips: [clip], ...(values && {values})});
  }
  function clipLabel(clip: Format5Clip): FcpClipRef {
    const track = tracks.get(clip.trackId);
    return {id: clip.id, name: clip.name, ...(track && {trackLabel: track.name})};
  }
  function affected<Code extends PremiereItemCode>(group: Map<string, ChecklistItem<Code>>, code: NoInfer<Code>, clip: Format5Clip, values?: FcpItemValues): void {
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

  const assets = new Map<string, PlannedAsset>();
  const copies = new Map<string, EditorMediaCopy>();
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
        throw new EditorExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
      }
      identity = editorExportSourceIdentity(info);
      sha256 = reference.reference.fullSha256;
      if (copyMedia && !sha256) {
        const hashed = await references.prepareFullHash(id, {signal, beforeEffect, expectedReferenceRevision: reference.referenceRevision});
        if (hashed.file !== reference.file || editorExportSourceIdentity(lstatSync(reference.file, {bigint: true})) !== identity) {
          throw new EditorExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
        }
        sha256 = hashed.sha256;
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof EditorExportFailure) throw error;
      const noAccess = error instanceof AppError && (error.details as Row | undefined)?.reason === 'no-access';
      if (!noAccess && (code === 'ENOENT' || offlineCodes.has(code ?? ''))) {
        for (const clip of used) affected(missing, 'MEDIA_MISSING', clip);
        assets.set(id, {metadata, bundleRelativePath: 'Media/Offline_' + id + (extension ?? '.mp4')});
        continue;
      }
      throw new EditorExportFailure({code: 'MEDIA_UNREADABLE', values: {file: path.basename(name)}});
    }
    const source = {reference, identity, name};
    let bundleRelativePath: string | undefined;
    if (copyMedia && sha256) {
      let copy = copies.get(sha256);
      if (!copy) {
        const stem = editorExportSafeName(path.parse(path.basename(name)).name, 'Media');
        const fileName = String(copies.size + 1).padStart(3, '0') + '_' + stem + extension;
        copy = {source, fileName, sha256};
        copies.set(sha256, copy);
      }
      bundleRelativePath = 'Media/' + copy.fileName;
    }
    assets.set(id, {metadata, source, bundleRelativePath});
  }

  const cuts = format === 'fcpxml' ? fcpxmlTransitions(timeline, assets)
    : premiereTransitionCuts(timeline, editorExportXmlAssets(assets, destination));
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
    if (transition) {
      const names = transitions[transition.kind];
      const to = format === 'premiere' ? names.premiere : 'fcpxml' in names ? names.fcpxml : undefined;
      if (to) affected(approximate, 'TRANSITION', clip, {from: names.from, to});
    }
  }
  for (const cue of timeline.subtitles?.cues ?? []) {
    const label = {id: cue.id, name: cue.text, trackLabel: '字幕'};
    if (format === 'premiere') subtitles.push(label);
    else {
      item(approximate, 'SUBTITLE_STYLE', label);
      if (cue.anchor) item(approximate, 'ANCHOR', label);
    }
  }

  const planCopies = [...copies.values()];
  const missingItems: EditorExportPreview['missing'] = [...missing.values()];
  if (subtitles.length) missingItems.push({code: 'SUBTITLES', clips: subtitles});
  return {
    preview: {
      timeline: {width, height, fps, durationFrames, clipCount: clips.length}, defaultName: projectName,
      projectDestination: {displayPath: editorExportDisplayPath(destination)}, mediaFiles: planCopies.length,
      mediaBytes: planCopies.reduce((sum, copy) => sum + copy.source.reference.reference.sizeBytes, 0),
      missing: missingItems, approximations: [...approximate.values()],
    },
    copies: planCopies,
    assets,
  };
}

export function editorExportXmlAssets(assets: ReadonlyMap<string, PlannedAsset>, directory: string): Map<string, FcpXmlAsset> {
  return new Map([...assets].map(([id, asset]) => {
    const file = asset.bundleRelativePath ? path.join(directory, asset.bundleRelativePath) : asset.source!.reference.file;
    return [id, {...asset.metadata, fileUrl: pathToFileURL(file).href}];
  }));
}

export function editorExportMissingMarkdown(preview: EditorExportPreview, appName: string): string {
  const labels: Record<PremiereItemCode, string> = {
    LUT: 'LUT 调色', PLACEHOLDER: '未生成的镜头（空隙）', MEDIA_MISSING: '找不到的素材（离线）',
    UNSUPPORTED_MEDIA: appName + ' 不支持的素材', TRANSITION: '转场', VOLUME_KEYFRAMES: '音量关键帧',
    FADES: '淡入和淡出', SUBTITLE_STYLE: '字幕样式', SUBTITLES: '字幕', ANCHOR: '挂靠', MUTE: '静音（−96 dB）',
    SEPARATE_SOUND: '分离声音', TRANSFORM: '位置、缩放、旋转或裁切',
  };
  const text = (value: string): string => value.replace(/[\\`*_{}\[\]()#+\-.!<>|]/gu, '\\$&').replace(/[\p{Cc}]/gu, ' ');
  const lines = ['# ' + appName + ' 导出清单'];
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
