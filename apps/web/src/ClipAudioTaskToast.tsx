/** «Save clip sound as an audio asset» floating progress card (21-11c).
 *
 * Polls the owned task record through `clip.audio.export.get`; the backend
 * record is the only authority for stage/progress/outcome. The card can cancel
 * a queued/running task and retry a failed one with a new request id.
 */
import React, {useEffect, useRef, useState} from 'react';
import {useI18n} from './i18n/I18nProvider.tsx';
import {Button} from '@mioon/ui/components/button';

export interface ClipAudioToastTarget {
  readonly projectId: string;
  readonly exportId: string;
  readonly clipId: string;
  readonly clipName: string;
  readonly requestId: string;
  /** Bumped on retry so the poller restarts against the new task identity. */
  readonly token: number;
}

export interface ClipAudioToastProps {
  readonly target: ClipAudioToastTarget | null;
  readonly read: (projectId: string, exportId: string) => Promise<unknown>;
  readonly cancel: (projectId: string, exportId: string) => Promise<unknown>;
  readonly retry: (target: ClipAudioToastTarget) => unknown;
  readonly viewAsset: (assetId: string) => unknown;
  readonly onDone: (target: ClipAudioToastTarget, assetId: string) => unknown;
  readonly onClose: () => void;
}

interface TaskView {
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly progress: number | null;
  readonly assetId: string | null;
  readonly error: {readonly code: string; readonly message: string} | null;
}

const asTask = (value: unknown): TaskView | null => {
  const record = (value as {record?: unknown} | null)?.record as
    {status?: unknown; progress?: unknown; assetId?: unknown; error?: unknown} | undefined;
  if (!record || typeof record.status !== 'string') return null;
  const status = record.status;
  if (!['queued', 'running', 'succeeded', 'failed'].includes(status)) return null;
  const error = record.error && typeof record.error === 'object'
    ? {code: String((record.error as {code?: unknown}).code ?? ''), message: String((record.error as {message?: unknown}).message ?? '')}
    : null;
  return {status: status as TaskView['status'],
    progress: typeof record.progress === 'number' ? record.progress : null,
    assetId: typeof record.assetId === 'string' ? record.assetId : null, error};
};

export default function ClipAudioTaskToast({target, read, cancel, retry, viewAsset, onDone, onClose}: ClipAudioToastProps): React.ReactElement | null {
  const {t, formatNumber} = useI18n();
  const [task, setTask] = useState<TaskView | null>(null);
  const [busy, setBusy] = useState(false);
  const doneNotified = useRef<string | null>(null);
  useEffect(() => {
    if (!target) {setTask(null); return;}
    let active = true;
    const tick = async (): Promise<void> => {
      try {
        const value = await read(target.projectId, target.exportId);
        if (!active) return;
        const next = asTask(value);
        setTask(next);
        if (next?.status === 'succeeded' && next.assetId && doneNotified.current !== target.exportId) {
          doneNotified.current = target.exportId;
          onDone(target, next.assetId);
        }
      } catch {/* A missing/unreadable record leaves the last known card. */}
    };
    void tick();
    const timer = setInterval(() => {void tick();}, 700);
    return () => {active = false; clearInterval(timer);};
  }, [target, read, onDone]);
  if (!target) return null;
  const running = !task || task.status === 'queued' || task.status === 'running';
  const progress = task?.progress ?? null;
  return <div className="clip-audio-toast-stack" data-testid="clip-audio-toast" role="status" aria-live="polite">
    {running && <div className="clip-audio-toast clip-audio-toast-progress" data-testid="clip-audio-progress">
      <span className="clip-audio-toast-spinner" aria-hidden="true" />
      <div className="clip-audio-toast-main">
        <p>{t('clipSound.toast.progress', {name: target.clipName})}</p>
        <div className="clip-audio-toast-bar" aria-hidden="true"><span style={{width: `${progress ?? 4}%`}} /></div>
      </div>
      <span className="clip-audio-toast-percent">{progress === null ? '' : `${formatNumber(progress)}%`}</span>
      <Button type="button" className="clip-audio-toast-action" data-testid="clip-audio-cancel" disabled={busy}
        onClick={() => {setBusy(true); void cancel(target.projectId, target.exportId).finally(() => setBusy(false));}}>{t('clipSound.cancel')}</Button>
    </div>}
    {task?.status === 'succeeded' && <div className="clip-audio-toast clip-audio-toast-done" data-testid="clip-audio-done">
      <span className="clip-audio-toast-check" aria-hidden="true" />
      <div className="clip-audio-toast-main"><p>{t('clipSound.toast.done')}</p></div>
      <Button type="button" className="clip-audio-toast-action" data-testid="clip-audio-view"
        onClick={() => {if (task.assetId) viewAsset(task.assetId);}}>{t('clipSound.toast.viewInLibrary')}</Button>
      <Button type="button" className="clip-audio-toast-close" data-testid="clip-audio-close" aria-label={t('editUi.notice.dismiss')} onClick={onClose}>×</Button>
    </div>}
    {task?.status === 'failed' && <div className="clip-audio-toast clip-audio-toast-failed" data-testid="clip-audio-failed">
      <span className="clip-audio-toast-warning" aria-hidden="true" />
      <div className="clip-audio-toast-main">
        <p>{task.error?.code === 'EXPORT_CANCELLED' ? t('clipSound.toast.cancelled') : t('clipSound.toast.failed')}</p>
        {task.error?.code !== 'EXPORT_CANCELLED' && task.error?.message && <p className="clip-audio-toast-reason">{task.error.message}</p>}
      </div>
      {task.error?.code !== 'EXPORT_CANCELLED' && <Button type="button" className="clip-audio-toast-action" data-testid="clip-audio-retry"
        disabled={busy} onClick={() => {setBusy(true); retry(target);}}>{t('clipSound.retry')}</Button>}
      <Button type="button" className="clip-audio-toast-close" data-testid="clip-audio-close" aria-label={t('editUi.notice.dismiss')} onClick={onClose}>×</Button>
    </div>}
  </div>;
}
