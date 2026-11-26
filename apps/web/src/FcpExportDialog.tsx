import React, {useId, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Dialog} from '@mioon/ui/components/dialog';
import {Input} from '@mioon/ui/components/input';
import {Label} from '@mioon/ui/components/label';
import {
  WorkbenchButton,
  WorkbenchDialogContent,
  WorkbenchProgress,
  WorkbenchToast,
  WorkbenchToastRegion,
} from '@mioon/ui/components/workbench-controls';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  FolderOpen,
  Info,
  LoaderCircle,
  X,
} from '@mioon/ui/components/workbench-icons';
import type {
  FcpExportDestination,
  FcpExportPreviewOutput,
  FcpItem,
} from '../../../packages/contracts/src/fcp-export.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import type {TaskOverviewItem} from './TaskPopover.tsx';
import {
  fcpBundleFileName,
  fcpErrorMessage,
  fcpItemAffectedText,
  fcpItemLabelMessage,
  fcpItemTooltipText,
  fcpProgressPercent,
  fcpTaskStatusMessage,
  formatFcpBytes,
  formatFcpDuration,
  formatFcpFps,
} from './fcp-export-state.ts';
import type {FcpExportTaskRecord} from './fcp-export-state.ts';
import './fcp-export.css';

export type FcpExportDialogPhase = 'setup' | 'running' | 'done' | 'failed';

export interface FcpExportDialogProps {
  readonly open: boolean;
  readonly phase: FcpExportDialogPhase;
  readonly preview: FcpExportPreviewOutput | null;
  readonly previewLoading: boolean;
  readonly previewError: boolean;
  readonly name: string;
  readonly copyMedia: boolean;
  readonly displayPath: string;
  readonly starting: boolean;
  readonly cancelling: boolean;
  readonly task: FcpExportTaskRecord | null;
  readonly finalCutInstalled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNameChange: (name: string) => void;
  readonly onCopyMediaChange: (copyMedia: boolean) => void;
  readonly onChooseDestination: () => void;
  readonly onStart: () => void;
  readonly onCancelExport: () => void;
  readonly onReveal: () => void;
  readonly onOpenInFinalCut: () => void;
  readonly onRetry: () => void;
  readonly onChangeLocation: () => void;
}

function FcpItemList({
  items,
  tone,
  testId,
}: {
  readonly items: readonly FcpItem[];
  readonly tone: 'warning' | 'info';
  readonly testId: string;
}): React.ReactElement {
  const {locale, renderMessage} = useI18n();
  return <ul className="fcp-export-list" data-testid={testId}>
    {items.map((item, index) => {
      const label = renderMessage(fcpItemLabelMessage(item));
      const clipsText = fcpItemAffectedText(item, locale);
      const tooltip = fcpItemTooltipText(item, locale);
      return <li className="fcp-export-list-row" key={`${item.code}-${index}`} data-testid={`fcp-export-item-${item.code}`}>
        <span className="fcp-export-list-left" data-tone={tone}>
          {tone === 'warning'
            ? <CircleSlash size={14} aria-hidden="true" />
            : <Info size={14} aria-hidden="true" />}
          <span title={label}>{label}</span>
        </span>
        {clipsText && <span className="fcp-export-list-clips" title={tooltip ?? clipsText}>{clipsText}</span>}
      </li>;
    })}
  </ul>;
}

export default function FcpExportDialog({
  open,
  phase,
  preview,
  previewLoading,
  previewError,
  name,
  copyMedia,
  displayPath,
  starting,
  cancelling,
  task,
  finalCutInstalled,
  onOpenChange,
  onNameChange,
  onCopyMediaChange,
  onChooseDestination,
  onStart,
  onCancelExport,
  onReveal,
  onOpenInFinalCut,
  onRetry,
  onChangeLocation,
}: FcpExportDialogProps): React.ReactElement {
  const {t, renderMessage} = useI18n();
  const nameInputId = useId();
  const copyMediaId = useId();
  const [approximationsOpen, setApproximationsOpen] = useState(false);
  const [doneMissingOpen, setDoneMissingOpen] = useState(false);

  const canStart = Boolean(preview && !previewLoading && !starting && name.trim().length > 0);
  const missingItems = preview?.missing ?? [];
  const approximationItems = preview?.approximations ?? [];
  const doneMissingItems = task?.missing ?? missingItems;

  const progress = task?.progress ?? {files: 0, totalFiles: 0, bytes: 0, totalBytes: 0};
  const percent = fcpProgressPercent(progress);
  const runningName = fcpBundleFileName(task?.name ?? name);
  const doneResult = task?.result;
  const doneBundleName = doneResult ? fcpBundleFileName(doneResult.bundleName) : runningName;

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (phase === 'setup') {
    body = <>
      {preview && <p className="fcp-export-summary" data-testid="fcp-export-timeline-summary">
        {t('fcpExport.timelineSummary', {
          width: preview.timeline.width,
          height: preview.timeline.height,
          fps: formatFcpFps(preview.timeline.fps),
          duration: formatFcpDuration(preview.timeline.durationFrames, preview.timeline.fps),
          count: preview.timeline.clipCount,
        })}
      </p>}
      {previewLoading && !preview && <div className="fcp-export-loading" data-testid="fcp-export-loading" role="status">
        <LoaderCircle size={16} className="fcp-export-spin" aria-hidden="true" />
        <span>{t('fcpExport.progress.loadingPreview')}</span>
      </div>}
      {previewError && !preview && <div className="fcp-export-failed" data-testid="fcp-export-preview-error" role="alert">
        <p className="fcp-export-status-reason">{t('fcpExport.error.previewFailed')}</p>
      </div>}
      {preview && <>
        <div className="fcp-export-field">
          <span className="fcp-export-label">{t('fcpExport.location')}</span>
          <div className="fcp-export-location-row">
            <div className="fcp-export-path-box" data-testid="fcp-export-location-path" title={displayPath}>
              <FolderOpen size={14} aria-hidden="true" />
              <span>{displayPath}</span>
            </div>
            <WorkbenchButton
              type="button"
              variant="secondary"
              className="fcp-export-choose-btn"
              data-testid="fcp-export-choose-destination"
              disabled={starting}
              onClick={onChooseDestination}
            >
              {t('fcpExport.choose')}
            </WorkbenchButton>
          </div>
        </div>

        <div className="fcp-export-field">
          <Label className="fcp-export-label" htmlFor={nameInputId}>{t('fcpExport.name')}</Label>
          <div className="fcp-export-name-box">
            <Input
              id={nameInputId}
              className="fcp-export-name-input"
              data-testid="fcp-export-name-input"
              value={name}
              disabled={starting}
              onChange={event => onNameChange(event.target.value)}
            />
            <span className="fcp-export-name-suffix" aria-hidden="true">{t('fcpExport.bundleSuffix')}</span>
          </div>
        </div>

        <div className="fcp-export-copy-row">
          <label className="fcp-export-checkbox-label" htmlFor={copyMediaId}>
            <input
              id={copyMediaId}
              type="checkbox"
              className="fcp-export-checkbox"
              data-testid="fcp-export-copy-media"
              checked={copyMedia}
              disabled={starting}
              onChange={event => onCopyMediaChange(event.target.checked)}
            />
            <span>{t('fcpExport.copyMedia')}</span>
          </label>
          <span className="fcp-export-media-size" data-testid="fcp-export-media-size">
            {formatFcpBytes(preview.mediaBytes)}
          </span>
        </div>

        {missingItems.length > 0 && <section className="fcp-export-group" data-testid="fcp-export-missing-group">
          <h3 className="fcp-export-group-heading">
            <span>{t('fcpExport.missingHeading')}</span>
            <span className="fcp-export-group-count">{missingItems.length}</span>
          </h3>
          <FcpItemList items={missingItems} tone="warning" testId="fcp-export-missing-list" />
        </section>}

        {approximationItems.length > 0 && <section className="fcp-export-group" data-testid="fcp-export-approximations-group">
          <Button
            type="button"
            variant={null}
            size={null}
            className="fcp-export-disclosure whitespace-normal focus-visible:ring-0"
            data-testid="fcp-export-approximations-toggle"
            aria-expanded={approximationsOpen}
            onClick={() => setApproximationsOpen(value => !value)}
          >
            {approximationsOpen
              ? <ChevronDown size={14} className="size-3.5" aria-hidden="true" />
              : <ChevronRight size={14} className="size-3.5" aria-hidden="true" />}
            <span>{t('fcpExport.approximationsHeading')}</span>
            <span className="fcp-export-group-count">{approximationItems.length}</span>
          </Button>
          {approximationsOpen && <FcpItemList items={approximationItems} tone="info" testId="fcp-export-approximations-list" />}
        </section>}
      </>}
    </>;
    footer = <>
      <WorkbenchButton
        type="button"
        variant="secondary"
        data-testid="fcp-export-cancel"
        onClick={() => onOpenChange(false)}
      >
        {t('common.cancel')}
      </WorkbenchButton>
      <WorkbenchButton
        type="button"
        variant="primary"
        data-testid="fcp-export-submit"
        disabled={!canStart}
        loading={starting}
        onClick={onStart}
      >
        {t('fcpExport.action.export')}
      </WorkbenchButton>
    </>;
  } else if (phase === 'running') {
    const statusText = progress.totalFiles > 0
      ? t('fcpExport.progress.copying', {files: progress.files, totalFiles: progress.totalFiles})
      : t('fcpExport.progress.exporting');
    body = <div className="fcp-export-running" data-testid="fcp-export-running" role="status" aria-live="polite">
      <div className="fcp-export-bundle-row">
        <Icon name="fcpExport" size={16} />
        <span data-testid="fcp-export-running-name" title={runningName}>{runningName}</span>
      </div>
      <div className="fcp-export-progress-block">
        <div className="fcp-export-progress-meta">
          <span className="fcp-export-progress-status" data-testid="fcp-export-progress-files">{statusText}</span>
          {progress.totalBytes > 0 && <span className="fcp-export-progress-bytes" data-testid="fcp-export-progress-bytes">
            {t('fcpExport.progress.bytes', {
              bytes: formatFcpBytes(progress.bytes),
              totalBytes: formatFcpBytes(progress.totalBytes),
            })}
          </span>}
        </div>
        <WorkbenchProgress
          className="fcp-export-progress-bar"
          value={percent}
          label={runningName}
        />
      </div>
    </div>;
    footer = <WorkbenchButton
      type="button"
      variant="secondary"
      data-testid="fcp-export-cancel-running"
      disabled={cancelling}
      loading={cancelling}
      onClick={onCancelExport}
    >
      {t('fcpExport.action.cancelExport')}
    </WorkbenchButton>;
  } else if (phase === 'done') {
    const missingCount = doneResult?.missingCount ?? 0;
    body = <div className="fcp-export-done" data-testid="fcp-export-done" role="status">
      <div className="fcp-export-status-head">
        <CircleCheck size={22} className="fcp-export-status-icon" data-tone="success" aria-hidden="true" />
        <div className="fcp-export-status-copy">
          <strong data-testid="fcp-export-done-name">{doneBundleName}</strong>
          {doneResult && <p className="fcp-export-status-meta" data-testid="fcp-export-done-meta" title={doneResult.displayPath}>
            {t('fcpExport.done.meta', {
              size: formatFcpBytes(doneResult.bytes),
              path: doneResult.displayPath,
            })}
          </p>}
        </div>
      </div>
      {missingCount > 0 && (doneMissingItems.length ? <>
        <Button
          type="button"
          variant={null}
          size={null}
          className="fcp-export-missing-link whitespace-normal focus-visible:ring-0"
          data-testid="fcp-export-done-missing-toggle"
          aria-expanded={doneMissingOpen}
          onClick={() => setDoneMissingOpen(value => !value)}
        >
          <CircleSlash size={14} className="size-3.5" aria-hidden="true" />
          <span>{t('fcpExport.done.missingCount', {count: missingCount})}</span>
          {doneMissingOpen
            ? <ChevronDown size={13} className="size-[13px]" aria-hidden="true" />
            : <ChevronRight size={13} className="size-[13px]" aria-hidden="true" />}
        </Button>
        {doneMissingOpen && doneMissingItems.length > 0 && (
          <FcpItemList items={doneMissingItems} tone="warning" testId="fcp-export-done-missing-list" />
        )}
      </> : <span className="fcp-export-status-meta">{t('fcpExport.done.missingCount', {count: missingCount})}</span>)}
    </div>;
    footer = finalCutInstalled ? <>
      <WorkbenchButton
        type="button"
        variant="secondary"
        data-testid="fcp-export-reveal"
        onClick={onReveal}
      >
        {t('fcpExport.action.revealInFinder')}
      </WorkbenchButton>
      <WorkbenchButton
        type="button"
        variant="primary"
        data-testid="fcp-export-open-fcp"
        onClick={onOpenInFinalCut}
      >
        {t('fcpExport.action.openInFcp')}
      </WorkbenchButton>
    </> : <WorkbenchButton
      type="button"
      variant="primary"
      data-testid="fcp-export-reveal"
      onClick={onReveal}
    >
      {t('fcpExport.action.revealInFinder')}
    </WorkbenchButton>;
  } else {
    body = <div className="fcp-export-failed" data-testid="fcp-export-failed" role="alert">
      <div className="fcp-export-status-head">
        <Icon name="circleX" size={22} className="fcp-export-status-icon" data-tone="danger" />
        <div className="fcp-export-status-copy">
          <strong>{t('fcpExport.failed.title')}</strong>
          <p className="fcp-export-status-reason" data-testid="fcp-export-failed-reason">
            {renderMessage(fcpErrorMessage(task?.error))}
          </p>
        </div>
      </div>
    </div>;
    footer = <>
      {task?.startInput && !task.startUncertain && <WorkbenchButton
        type="button"
        variant="secondary"
        data-testid="fcp-export-change-location"
        disabled={starting}
        onClick={onChangeLocation}
      >
        {t('fcpExport.action.changeLocation')}
      </WorkbenchButton>}
      {task?.startInput && <WorkbenchButton
        type="button"
        variant="primary"
        data-testid="fcp-export-retry"
        disabled={starting}
        loading={starting}
        onClick={onRetry}
      >
        {t('fcpExport.action.retry')}
      </WorkbenchButton>}
    </>;
  }

  return <Dialog open={open} onOpenChange={next => {
    if (!next) {
      setApproximationsOpen(false);
      setDoneMissingOpen(false);
    }
    onOpenChange(next);
  }}>
    <WorkbenchDialogContent
      title={t('fcpExport.title')}
      size="standard"
      className="fcp-export-dialog"
      data-testid="fcp-export-dialog"
      data-phase={phase}
      footer={footer}
    >
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}

export interface FcpExportToastProps {
  readonly task: FcpExportTaskRecord | null;
  readonly onReveal: (task: FcpExportTaskRecord) => void;
  readonly onDismiss: () => void;
}

export function FcpExportToast({task, onReveal, onDismiss}: FcpExportToastProps): React.ReactElement | null {
  const {t} = useI18n();
  if (!task || task.status !== 'done') return null;
  return <WorkbenchToastRegion className="fcp-export-toasts" label={t('fcpExport.title')}>
    <WorkbenchToast className="fcp-export-toast" tone="success" data-testid="fcp-export-done-toast" role="status">
      <span className="fcp-export-toast-icon" aria-hidden="true"><CircleCheck size={16} /></span>
      <span className="fcp-export-toast-text">{t('fcpExport.done.toast')}</span>
      <WorkbenchButton
        type="button"
        variant="secondary"
        size="compact"
        data-testid="fcp-export-toast-reveal"
        onClick={() => onReveal(task)}
      >
        {t('fcpExport.action.revealInFinder')}
      </WorkbenchButton>
      <WorkbenchButton
        type="button"
        variant="icon"
        size="compact"
        data-testid="fcp-export-toast-dismiss"
        aria-label={t('shell.dismissNotice')}
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </WorkbenchButton>
    </WorkbenchToast>
  </WorkbenchToastRegion>;
}

export interface FcpExportTaskCenterEntry {
  readonly key: string;
  readonly label: string;
  readonly status: string;
  readonly active: boolean;
  readonly warning: boolean;
  readonly group: string;
  readonly detail: React.ReactNode;
}

export function fcpExportTaskOverviewItems(
  tasks: readonly FcpExportTaskRecord[],
  handlers: {
    readonly renderMessage: ReturnType<typeof useI18n>['renderMessage'];
    readonly t: ReturnType<typeof useI18n>['t'];
    readonly onOpen: (task: FcpExportTaskRecord) => void;
    readonly onCancel: (task: FcpExportTaskRecord) => void;
    readonly onRetry: (task: FcpExportTaskRecord) => void;
  },
): TaskOverviewItem[] {
  return tasks
    .filter(task => task.status === 'running' || task.status === 'failed')
    .map(task => {
      const running = task.status === 'running';
      const percent = fcpProgressPercent(task.progress);
      return {
        id: `fcpxml-export:${task.exportId}`,
        label: task.name,
        status: handlers.renderMessage(fcpTaskStatusMessage(task.status)),
        phase: running ? 'active' : 'attention',
        tone: running ? 'neutral' : 'danger',
        ...(running ? {
          progress: percent,
          detail: task.progress.totalFiles > 0
            ? handlers.t('fcpExport.progress.copying', {files: task.progress.files, totalFiles: task.progress.totalFiles})
            : undefined,
          onCancel: () => handlers.onCancel(task),
          cancelLabel: handlers.t('fcpExport.action.cancelExport'),
        } : {
          detail: handlers.renderMessage(fcpErrorMessage(task.error)),
          ...(task.startInput && {
            onRetry: () => handlers.onRetry(task), retryLabel: handlers.t('fcpExport.action.retry'),
          }),
        }),
        onOpen: () => handlers.onOpen(task),
      };
    });
}

export function fcpExportTaskCenterEntries(
  tasks: readonly FcpExportTaskRecord[],
  handlers: {
    readonly renderMessage: ReturnType<typeof useI18n>['renderMessage'];
    readonly t: ReturnType<typeof useI18n>['t'];
    readonly onOpen: (task: FcpExportTaskRecord) => void;
    readonly onCancel: (task: FcpExportTaskRecord) => void;
    readonly onReveal: (task: FcpExportTaskRecord) => void;
    readonly onRetry: (task: FcpExportTaskRecord) => void;
  },
): FcpExportTaskCenterEntry[] {
  const group = handlers.t('fcpExport.task.group');
  return tasks.map(task => {
    const running = task.status === 'running';
    const done = task.status === 'done';
    const failed = task.status === 'failed';
    const percent = fcpProgressPercent(task.progress);
    const key = `fcpxml-export:${task.exportId}`;
    return {
      key,
      label: task.name,
      status: handlers.renderMessage(fcpTaskStatusMessage(task.status)),
      active: running,
      warning: failed,
      group,
      detail: <div className="fcp-export-task-card" data-testid={`fcp-export-task-${task.exportId}`} data-task-kind={task.kind}>
        <div className="fcp-export-bundle-row">
          <Icon name="fcpExport" size={16} />
          <span>{fcpBundleFileName(task.result?.bundleName ?? task.name)}</span>
        </div>
        {running && <div className="fcp-export-progress-block">
          <div className="fcp-export-progress-meta">
            <span className="fcp-export-progress-status">
              {task.progress.totalFiles > 0
                ? handlers.t('fcpExport.progress.copying', {files: task.progress.files, totalFiles: task.progress.totalFiles})
                : handlers.t('fcpExport.progress.exporting')}
            </span>
            {task.progress.totalBytes > 0 && <span className="fcp-export-progress-bytes">
              {handlers.t('fcpExport.progress.bytes', {
                bytes: formatFcpBytes(task.progress.bytes),
                totalBytes: formatFcpBytes(task.progress.totalBytes),
              })}
            </span>}
          </div>
          <WorkbenchProgress className="fcp-export-progress-bar" value={percent} label={task.name} />
        </div>}
        {done && task.result && <p className="fcp-export-status-meta">
          {handlers.t('fcpExport.done.meta', {size: formatFcpBytes(task.result.bytes), path: task.result.displayPath})}
        </p>}
        {failed && <p className="fcp-export-status-reason">
          {handlers.renderMessage(fcpErrorMessage(task.error))}
        </p>}
        <div className="fcp-export-task-actions">
          {running && <WorkbenchButton type="button" variant="secondary" size="compact" onClick={() => handlers.onCancel(task)}>
            {handlers.t('fcpExport.action.cancelExport')}
          </WorkbenchButton>}
          {done && <WorkbenchButton type="button" variant="secondary" size="compact" onClick={() => handlers.onReveal(task)}>
            {handlers.t('fcpExport.action.revealInFinder')}
          </WorkbenchButton>}
          {failed && task.startInput && <WorkbenchButton type="button" variant="secondary" size="compact" onClick={() => handlers.onRetry(task)}>
            {handlers.t('fcpExport.action.retry')}
          </WorkbenchButton>}
          <WorkbenchButton type="button" variant="ghost" size="compact" onClick={() => handlers.onOpen(task)}>
            {handlers.t('shell.details')}
          </WorkbenchButton>
        </div>
      </div>,
    };
  });
}

export type {FcpExportDestination};
