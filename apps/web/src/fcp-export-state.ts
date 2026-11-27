import {message, translate} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage, Locale} from '../../../packages/i18n/src/index.ts';
import {FCP_EXPORT_TASK_KIND} from '../../../packages/contracts/src/fcp-export.ts';
import {PREMIERE_EXPORT_TASK_KIND} from '../../../packages/contracts/src/premiere-export.ts';
import {fcpxmlExportTaskSchema, premiereExportTaskSchema} from '../../../packages/contracts/src/project-registry.ts';
import type {
  FcpClipRef,
  FcpExportError,
  FcpExportGetOutput,
  FcpExportPreviewOutput,
  FcpExportProgress,
  FcpExportResult,
  FcpExportStartInput,
  FcpExportStatus,
  FcpItemValues,
} from '../../../packages/contracts/src/fcp-export.ts';
import type {
  PremiereExportPreviewOutput,
  PremiereItemCode,
} from '../../../packages/contracts/src/premiere-export.ts';

export type FcpExportTaskKind = typeof FCP_EXPORT_TASK_KIND | typeof PREMIERE_EXPORT_TASK_KIND;
export type EditorExportItemCode = PremiereItemCode | 'SPEED';

export interface EditorExportItemValues extends FcpItemValues {
  readonly maxErrorFrames?: number | undefined;
}

export interface EditorExportItem {
  readonly code: EditorExportItemCode;
  readonly clips: ReadonlyArray<FcpClipRef>;
  readonly values?: EditorExportItemValues | undefined;
}

export type EditorExportPreviewOutput = FcpExportPreviewOutput | PremiereExportPreviewOutput;

export interface FcpExportTaskRecord {
  readonly kind: FcpExportTaskKind;
  readonly exportId: string;
  readonly projectId: string;
  readonly name: string;
  readonly requestId?: string;
  readonly startInput?: FcpExportStartInput;
  readonly startUncertain?: boolean;
  readonly displayPath?: string;
  readonly awaitingCompletion?: boolean;
  readonly status: FcpExportStatus;
  readonly progress: FcpExportProgress;
  readonly result?: FcpExportResult | undefined;
  readonly error?: FcpExportError | undefined;
  readonly missing: ReadonlyArray<EditorExportItem>;
  readonly approximations: ReadonlyArray<EditorExportItem>;
  readonly createdAt: string;
}

export function exportStartKey(kind: FcpExportTaskKind, projectId: string): string {
  return `${kind}:${projectId}`;
}

export function isFcpExportHistoryRow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as {mode?: unknown; kind?: unknown};
  return row.mode === FCP_EXPORT_TASK_KIND || row.kind === FCP_EXPORT_TASK_KIND;
}

export function isPremiereExportHistoryRow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as {mode?: unknown; kind?: unknown};
  return row.mode === PREMIERE_EXPORT_TASK_KIND || row.kind === PREMIERE_EXPORT_TASK_KIND;
}

export function isEditorExportHistoryRow(value: unknown): boolean {
  return isFcpExportHistoryRow(value) || isPremiereExportHistoryRow(value);
}

/** Adopt only the public records from this project's durable task history.
 * Original start settings and the preview checklist exist only in the window
 * that submitted the request. A polling result can be newer than this snapshot.
 */
export function mergeFcpExportHistory(
  previous: readonly FcpExportTaskRecord[], projectId: string, rows: readonly unknown[],
): FcpExportTaskRecord[] {
  const tasks = new Map(previous.map(task => [`${task.kind}:${task.exportId}`, task]));
  const pending = new Map(previous.filter(task => task.projectId === projectId && task.startUncertain && task.requestId)
    .map(task => [`${task.kind}:${task.requestId}`, task]));
  for (const value of rows) {
    const parsed = isFcpExportHistoryRow(value)
      ? fcpxmlExportTaskSchema.safeParse(value)
      : isPremiereExportHistoryRow(value)
        ? premiereExportTaskSchema.safeParse(value)
        : null;
    if (!parsed || !parsed.success || parsed.data.projectId !== projectId) continue;
    const row = parsed.data;
    const attempt = pending.get(`${row.kind}:${row.requestId}`);
    const key = `${row.kind}:${row.id}`;
    const local = attempt ?? tasks.get(key);
    if (attempt) tasks.delete(`${attempt.kind}:${attempt.exportId}`);
    tasks.set(key, local ? applyFcpTaskUpdate({
      ...local, kind: row.kind, exportId: row.id, name: row.title, requestId: row.requestId,
      ...(attempt && {status: 'running', startUncertain: false, awaitingCompletion: true, error: undefined}),
    }, row) : {
      kind: row.kind, exportId: row.id, projectId, name: row.title, requestId: row.requestId,
      status: row.status, progress: row.progress, awaitingCompletion: row.status === 'running',
      missing: [], approximations: [], createdAt: row.createdAt,
    });
  }
  return [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function needsFcpTaskStatus(task: FcpExportTaskRecord): boolean {
  return task.status === 'running' || (task.status === 'done' && !task.result) || (task.status === 'failed' && !task.error);
}

export function mergeFcpStartReceipt(previous: readonly FcpExportTaskRecord[], receipt: FcpExportTaskRecord): FcpExportTaskRecord[] {
  const saved = previous.find(task => task.kind === receipt.kind && task.exportId === receipt.exportId && task.projectId === receipt.projectId);
  const task = saved ? {...receipt, ...saved, awaitingCompletion: true, startInput: receipt.startInput,
    displayPath: receipt.displayPath, missing: receipt.missing, approximations: receipt.approximations} : receipt;
  return [task, ...previous.filter(item => item.projectId !== receipt.projectId || item.kind !== receipt.kind || (
    item.exportId !== receipt.exportId && !(item.startUncertain && item.requestId === receipt.requestId)
  ))];
}

export function fcpRetryInput(task: FcpExportTaskRecord, newRequestId: () => string): FcpExportStartInput | undefined {
  if (!task.startInput || task.startUncertain) return task.startInput;
  return {...task.startInput, requestId: newRequestId()};
}

interface FcpDialogOwner {
  readonly projectId: string | null;
  readonly projectEpoch: number;
  readonly dialogEpoch: number;
}

export function ownsFcpStartPresentation(expected: FcpDialogOwner, current: FcpDialogOwner, open: boolean): boolean {
  return open && expected.projectId === current.projectId && expected.projectEpoch === current.projectEpoch
    && expected.dialogEpoch === current.dialogEpoch;
}

export function formatFcpBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) {
    const value = bytes / gb;
    const rounded = value >= 100 ? Math.round(value) : Number(value.toFixed(1));
    return `${rounded} GB`;
  }
  if (bytes >= mb) {
    const value = bytes / mb;
    const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1));
    return `${rounded} MB`;
  }
  if (bytes >= kb) return `${Math.round(bytes / kb)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatFcpDuration(durationFrames: number, fps: number): string {
  const seconds = fps > 0 && Number.isFinite(durationFrames) && durationFrames > 0
    ? Math.round(durationFrames / fps)
    : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map(part => String(part).padStart(2, '0')).join(':');
}

export function formatFcpFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '30';
  return Number.isInteger(fps) ? String(fps) : Number(fps.toFixed(2)).toString();
}

export function formatFcpErrorFrames(frames: number): string {
  if (!Number.isFinite(frames) || frames <= 0) return '0';
  if (Number.isInteger(frames)) return String(frames);
  if (frames < 0.01) return Number(frames.toFixed(3)).toString();
  return Number(frames.toFixed(2)).toString();
}

export function fcpBundleFileName(name: string, kind: FcpExportTaskKind = FCP_EXPORT_TASK_KIND): string {
  const trimmed = name.trim();
  if (kind === PREMIERE_EXPORT_TASK_KIND) {
    if (!trimmed) return 'Premiere';
    return / Premiere(?: (?:[2-9]|[1-9][0-9]+))?$/iu.test(trimmed) ? trimmed : `${trimmed} Premiere`;
  }
  if (!trimmed) return '.fcpxmld';
  return trimmed.toLowerCase().endsWith('.fcpxmld') ? trimmed : `${trimmed}.fcpxmld`;
}

export function fcpProgressPercent(progress: FcpExportProgress): number {
  if (progress.totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100)));
  }
  if (progress.totalFiles > 0) {
    return Math.max(0, Math.min(100, Math.round((progress.files / progress.totalFiles) * 100)));
  }
  return 0;
}

export function fcpItemLabelMessage(item: EditorExportItem): DisplayMessage {
  switch (item.code) {
    case 'LUT': return message('fcpExport.item.LUT');
    case 'PLACEHOLDER': return message('fcpExport.item.PLACEHOLDER');
    case 'MEDIA_MISSING': return message('fcpExport.item.MEDIA_MISSING');
    case 'UNSUPPORTED_MEDIA': return message('fcpExport.item.UNSUPPORTED_MEDIA');
    case 'SUBTITLES': return message('fcpExport.item.SUBTITLES');
    case 'TRANSITION':
      return item.values?.from && item.values?.to
        ? message('fcpExport.item.TRANSITION', {from: item.values.from, to: item.values.to})
        : message('fcpExport.item.TRANSITION_GENERIC');
    case 'VOLUME_KEYFRAMES': return message('fcpExport.item.VOLUME_KEYFRAMES');
    case 'FADES': return message('fcpExport.item.FADES');
    case 'SUBTITLE_STYLE': return message('fcpExport.item.SUBTITLE_STYLE');
    case 'ANCHOR': return message('fcpExport.item.ANCHOR');
    case 'MUTE': return message('fcpExport.item.MUTE');
    case 'SEPARATE_SOUND': return message('fcpExport.item.SEPARATE_SOUND');
    case 'TRANSFORM': return message('fcpExport.item.TRANSFORM');
    case 'SPEED': {
      const from = item.values?.from?.trim();
      const to = item.values?.to?.trim();
      const speedTitle = translate('zh-Hans', 'fcpExport.item.SPEED');
      if (from && to && from !== speedTitle) {
        return message('fcpExport.item.SPEED_CHANGE', {from, to});
      }
      if (to) {
        return message('fcpExport.item.SPEED_HANDLING', {handling: to});
      }
      if (from && from !== speedTitle) {
        return message('fcpExport.item.SPEED_HANDLING', {handling: from});
      }
      return message('fcpExport.item.SPEED');
    }
  }
}

export function fcpItemAffectedText(item: EditorExportItem, locale: Locale): string {
  const separator = translate(locale, 'fcpExport.clips.separator');
  const names = item.clips.map(clip => clip.name.trim()).filter(Boolean);
  const count = item.clips.length;
  if (item.code === 'PLACEHOLDER') {
    if (names.length === 0) return translate(locale, 'fcpExport.item.placeholderGap');
    return translate(locale, 'fcpExport.item.placeholderClipsWithGap', {clips: names.join(separator)});
  }
  if (item.code === 'LUT' || item.code === 'MEDIA_MISSING' || item.code === 'UNSUPPORTED_MEDIA') {
    if (names.length > 0) return names.join(separator);
    return count > 0 ? translate(locale, 'fcpExport.clips.clips', {count}) : '';
  }
  if (item.code === 'SPEED') {
    const clipsText = names.length > 0
      ? names.join(separator)
      : count > 0
        ? translate(locale, 'fcpExport.clips.clips', {count})
        : '';
    if (typeof item.values?.maxErrorFrames === 'number' && Number.isFinite(item.values.maxErrorFrames)) {
      const maxErrorFrames = formatFcpErrorFrames(item.values.maxErrorFrames);
      return clipsText
        ? translate(locale, 'fcpExport.item.speedMaxErrorWithClips', {maxErrorFrames, clips: clipsText})
        : translate(locale, 'fcpExport.item.speedMaxError', {maxErrorFrames});
    }
    return clipsText;
  }
  if (item.code === 'TRANSITION') {
    return count > 0 ? translate(locale, 'fcpExport.clips.places', {count}) : '';
  }
  if (item.code === 'SUBTITLE_STYLE' || item.code === 'SUBTITLES') {
    return count > 0 ? translate(locale, 'fcpExport.clips.cues', {count}) : '';
  }
  if (count === 0) return '';
  const tracks = [...new Set(item.clips.map(clip => clip.trackLabel?.trim()).filter((label): label is string => Boolean(label)))];
  if (tracks.length > 0) {
    return translate(locale, 'fcpExport.clips.trackClips', {track: tracks.join(separator), count});
  }
  return translate(locale, 'fcpExport.clips.clips', {count});
}

export function fcpItemTooltipText(item: EditorExportItem, locale: Locale): string | undefined {
  const separator = translate(locale, 'fcpExport.clips.separator');
  const parts = item.clips.map(clip => {
    const label = clip.trackLabel?.trim();
    const name = clip.name.trim();
    if (label && name) return `${label} · ${name}`;
    return name || label || clip.id;
  });
  const clipsText = parts.join(separator);
  if (item.code === 'SPEED' && typeof item.values?.maxErrorFrames === 'number' && Number.isFinite(item.values.maxErrorFrames)) {
    const maxErrorFrames = formatFcpErrorFrames(item.values.maxErrorFrames);
    return clipsText
      ? translate(locale, 'fcpExport.item.speedMaxErrorWithClips', {maxErrorFrames, clips: clipsText})
      : translate(locale, 'fcpExport.item.speedMaxError', {maxErrorFrames});
  }
  return clipsText || undefined;
}

export function fcpErrorMessage(error: FcpExportError | null | undefined): DisplayMessage {
  if (!error) return message('fcpExport.error.EXPORT_FAILED');
  switch (error.code) {
    case 'DISK_FULL':
      return typeof error.values?.shortBytes === 'number' && error.values.shortBytes > 0
        ? message('fcpExport.error.DISK_FULL', {shortBytes: formatFcpBytes(error.values.shortBytes)})
        : message('fcpExport.error.DISK_FULL_GENERIC');
    case 'NOT_WRITABLE':
      return message('fcpExport.error.NOT_WRITABLE');
    case 'MEDIA_UNREADABLE':
      return error.values?.file?.trim()
        ? message('fcpExport.error.MEDIA_UNREADABLE', {file: error.values.file.trim()})
        : message('fcpExport.error.MEDIA_UNREADABLE_GENERIC');
    case 'EXPORT_FAILED':
      return message('fcpExport.error.EXPORT_FAILED');
  }
}

export function fcpTaskStatusMessage(status: FcpExportStatus): DisplayMessage {
  switch (status) {
    case 'running': return message('fcpExport.task.running');
    case 'done': return message('fcpExport.task.done');
    case 'failed': return message('fcpExport.task.failed');
    case 'cancelled': return message('fcpExport.task.cancelled');
  }
}

export function applyFcpTaskUpdate(
  task: FcpExportTaskRecord,
  update: FcpExportGetOutput,
): FcpExportTaskRecord {
  if (task.status !== 'running' && task.status !== update.status) return task;
  const previous = task.progress, next = update.progress;
  return {
    ...task,
    status: update.status,
    progress: {
      files: Math.max(previous.files, next.files), totalFiles: Math.max(previous.totalFiles, next.totalFiles),
      bytes: Math.max(previous.bytes, next.bytes), totalBytes: Math.max(previous.totalBytes, next.totalBytes),
    },
    ...(update.result !== undefined ? {result: update.result} : {}),
    ...(update.error !== undefined ? {error: update.error} : {}),
  };
}
