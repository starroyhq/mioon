import {message, translate} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage, Locale} from '../../../packages/i18n/src/index.ts';
import {FCP_EXPORT_TASK_KIND} from '../../../packages/contracts/src/fcp-export.ts';
import {fcpxmlExportTaskSchema} from '../../../packages/contracts/src/project-registry.ts';
import type {
  FcpExportError,
  FcpExportGetOutput,
  FcpExportPreviewOutput,
  FcpExportProgress,
  FcpExportResult,
  FcpExportStartInput,
  FcpExportStatus,
  FcpItem,
} from '../../../packages/contracts/src/fcp-export.ts';

export type FcpExportTaskKind = typeof FCP_EXPORT_TASK_KIND;

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
  readonly missing: FcpExportPreviewOutput['missing'];
  readonly approximations: FcpExportPreviewOutput['approximations'];
  readonly createdAt: string;
}

export function isFcpExportHistoryRow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as {mode?: unknown; kind?: unknown};
  return row.mode === FCP_EXPORT_TASK_KIND || row.kind === FCP_EXPORT_TASK_KIND;
}

/** Adopt only the public records from this project's durable task history.
 * Original start settings and the preview checklist exist only in the window
 * that submitted the request. A polling result can be newer than this snapshot.
 */
export function mergeFcpExportHistory(
  previous: readonly FcpExportTaskRecord[], projectId: string, rows: readonly unknown[],
): FcpExportTaskRecord[] {
  const tasks = new Map(previous.map(task => [task.exportId, task]));
  const pending = new Map(previous.filter(task => task.projectId === projectId && task.startUncertain)
    .map(task => [task.requestId, task]));
  for (const value of rows) {
    if (!isFcpExportHistoryRow(value)) continue;
    const parsed = fcpxmlExportTaskSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId) continue;
    const row = parsed.data;
    const attempt = pending.get(row.requestId);
    const local = attempt ?? tasks.get(row.id);
    if (attempt) tasks.delete(attempt.exportId);
    tasks.set(row.id, local ? applyFcpTaskUpdate({
      ...local, exportId: row.id, name: row.title, requestId: row.requestId,
      ...(attempt && {status: 'running', startUncertain: false, awaitingCompletion: true, error: undefined}),
    }, row) : {
      kind: FCP_EXPORT_TASK_KIND, exportId: row.id, projectId, name: row.title, requestId: row.requestId,
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
  const saved = previous.find(task => task.exportId === receipt.exportId && task.projectId === receipt.projectId);
  const task = saved ? {...receipt, ...saved, awaitingCompletion: true, startInput: receipt.startInput,
    displayPath: receipt.displayPath, missing: receipt.missing, approximations: receipt.approximations} : receipt;
  return [task, ...previous.filter(item => item.projectId !== receipt.projectId || (
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

export function fcpBundleFileName(name: string): string {
  const trimmed = name.trim();
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

export function fcpItemLabelMessage(item: FcpItem): DisplayMessage | string {
  switch (item.code) {
    case 'LUT': return message('fcpExport.item.LUT');
    case 'PLACEHOLDER': return message('fcpExport.item.PLACEHOLDER');
    case 'MEDIA_MISSING': return message('fcpExport.item.MEDIA_MISSING');
    case 'UNSUPPORTED_MEDIA': return message('fcpExport.item.UNSUPPORTED_MEDIA');
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
    case 'SPEED': return item.code;
  }
}

export function fcpItemAffectedText(item: FcpItem, locale: Locale): string {
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
  if (item.code === 'TRANSITION') {
    return count > 0 ? translate(locale, 'fcpExport.clips.places', {count}) : '';
  }
  if (item.code === 'SUBTITLE_STYLE') {
    return count > 0 ? translate(locale, 'fcpExport.clips.cues', {count}) : '';
  }
  if (count === 0) return '';
  const tracks = [...new Set(item.clips.map(clip => clip.trackLabel?.trim()).filter((label): label is string => Boolean(label)))];
  if (tracks.length > 0) {
    return translate(locale, 'fcpExport.clips.trackClips', {track: tracks.join(separator), count});
  }
  return translate(locale, 'fcpExport.clips.clips', {count});
}

export function fcpItemTooltipText(item: FcpItem, locale: Locale): string | undefined {
  if (item.clips.length === 0) return undefined;
  const separator = translate(locale, 'fcpExport.clips.separator');
  const parts = item.clips.map(clip => {
    const label = clip.trackLabel?.trim();
    const name = clip.name.trim();
    if (label && name) return `${label} · ${name}`;
    return name || label || clip.id;
  });
  return parts.join(separator);
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
