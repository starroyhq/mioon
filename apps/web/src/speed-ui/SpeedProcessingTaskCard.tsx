import React from 'react';
import {WorkbenchBadge, WorkbenchButton, WorkbenchProgress} from '@mioon/ui/components/workbench-controls';
import type {WorkbenchTone} from '@mioon/ui/components/workbench-controls';
import {CircleAlert, Rewind, RotateCcw, Sparkles, X} from '@mioon/ui/components/workbench-icons';
import type {SpeedProcessingItem} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {MessageArguments, MessageKey} from '../../../../packages/i18n/src/index.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {processingItemActive, speedProcessingReasonKey} from './speed-model.ts';
import {speedProcessingItemStatusText, speedProcessingItemTitle} from './speed-presentation.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;

export interface SpeedProcessingTaskCenterEntry {
  readonly key: string;
  readonly label: string;
  readonly status: string;
  readonly active: boolean;
  readonly warning: boolean;
  readonly detail: React.ReactNode;
}

const badgeTone = (status: SpeedProcessingItem['status']): WorkbenchTone =>
  status === 'ready' ? 'success' : status === 'failed' ? 'danger' : 'neutral';

export function buildSpeedProcessingTaskCenterEntries(options: {
  readonly enabled: boolean;
  readonly items: readonly SpeedProcessingItem[];
  readonly busyTaskIds: ReadonlySet<string>;
  readonly clipNameFor: (clipId: string) => string;
  readonly t: Translator;
  readonly onRetry: (taskId: string) => void;
  readonly onCancel: (taskId: string) => void;
}): SpeedProcessingTaskCenterEntry[] {
  if (!options.enabled || !options.items.length) return [];
  return options.items.map(item => {
    const label = speedProcessingItemTitle(item, options.clipNameFor(item.clipId), options.t);
    const status = speedProcessingItemStatusText(item, options.t);
    const active = processingItemActive(item);
    return {
      key: `speed:${item.taskId}`,
      label,
      status,
      active,
      warning: item.status === 'failed',
      detail: (
        <SpeedProcessingTaskCard
          item={item}
          label={label}
          status={status}
          busy={options.busyTaskIds.has(item.taskId)}
          onRetry={() => options.onRetry(item.taskId)}
          onCancel={() => options.onCancel(item.taskId)}
        />
      ),
    };
  });
}

export function SpeedProcessingTaskCard({item, label, status, busy, onRetry, onCancel}: {
  readonly item: SpeedProcessingItem;
  readonly label: string;
  readonly status: string;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const {t} = useI18n();
  const active = processingItemActive(item);
  const failed = item.status === 'failed';
  const percent = item.status === 'running' && typeof item.progress === 'number'
    ? Math.max(0, Math.min(100, Math.round(item.progress)))
    : 0;

  return (
    <article
      className="job-card speed-task-card"
      data-testid={`speed-task-${item.taskId}`}
      data-state={item.status}
      data-kind={item.kind}
    >
      <div className="job-title">
        <span className={`speed-task-icon ${failed ? 'is-failed' : ''}`} aria-hidden="true">
          {failed ? <CircleAlert size={16} /> : item.kind === 'reverse' ? <Rewind size={16} /> : <Sparkles size={16} />}
        </span>
        <strong title={label}>{label}</strong>
        <WorkbenchBadge tone={badgeTone(item.status)}>{status}</WorkbenchBadge>
      </div>
      {active && <WorkbenchProgress value={percent} label={label} />}
      {failed && (
        <p className="helper speed-task-failure" data-testid={`speed-task-reason-${item.taskId}`}>
          {t(speedProcessingReasonKey(item.reason) as never)}
        </p>
      )}
      <div className="job-actions">
        {failed && (
          <WorkbenchButton
            variant="secondary"
            size="compact"
            data-testid={`speed-task-retry-${item.taskId}`}
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCcw size={13} />
            {t('speed.processing.retry')}
          </WorkbenchButton>
        )}
        {active && (
          <WorkbenchButton
            variant="secondary"
            size="compact"
            data-testid={`speed-task-cancel-${item.taskId}`}
            disabled={busy}
            onClick={onCancel}
          >
            <X size={13} />
            {t('speed.processing.cancel')}
          </WorkbenchButton>
        )}
      </div>
    </article>
  );
}
