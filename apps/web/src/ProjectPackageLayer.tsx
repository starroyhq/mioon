import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent, WorkbenchProgress, WorkbenchTabs, WorkbenchToast, WorkbenchToastRegion } from '@mioon/ui/components/workbench-controls';
import { AlertTriangle, Check, CircleSlash, FolderOpen, Layers, LoaderCircle, X } from '@mioon/ui/components/workbench-icons';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { ProjectPackageFailure, ProjectPackageMissing } from './project-package-client.ts';
import { flowPercent, formatPackageBytes, isFlowRunning, projectPackageFlow } from './project-package-flow.ts';
import type { PackageFlow, PackageFlowController, PackageFlowState } from './project-package-flow.ts';
import { projectPackagesBridge, revealPlatform } from './project-package-bridge.ts';
import './project-package.css';

export function useProjectPackageState(controller: PackageFlowController = projectPackageFlow()): PackageFlowState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

type ErrorCopy = { readonly title: MessageKey; readonly body: MessageKey; readonly tone: 'danger' | 'neutral' };
const ERRORS: Readonly<Record<string, ErrorCopy>> = {
  PROJECT_PACKAGE_NOT_MIOON: { title: 'projectPackage.error.notMioon.title', body: 'projectPackage.error.notMioon.body', tone: 'danger' },
  PROJECT_PACKAGE_CORRUPT: { title: 'projectPackage.error.corrupt.title', body: 'projectPackage.error.corrupt.body', tone: 'danger' },
  PROJECT_PACKAGE_NEWER_FORMAT: { title: 'projectPackage.error.newer.title', body: 'projectPackage.error.newer.body', tone: 'danger' },
  PROJECT_PACKAGE_INVALID_CONTENT: { title: 'projectPackage.error.invalid.title', body: 'projectPackage.error.invalid.body', tone: 'danger' },
  PROJECT_PACKAGE_MEDIA_REJECTED: { title: 'projectPackage.error.media.title', body: 'projectPackage.error.media.body', tone: 'danger' },
  PROJECT_PACKAGE_NO_SPACE: { title: 'projectPackage.error.noSpace.title', body: 'projectPackage.error.noSpace.body', tone: 'danger' },
  PROJECT_PACKAGE_CANCELLED: { title: 'projectPackage.error.cancelled.title', body: 'projectPackage.error.cancelled.body', tone: 'neutral' },
  PROJECT_PACKAGE_SOURCE_MISSING: { title: 'projectPackage.error.source.title', body: 'projectPackage.error.source.body', tone: 'danger' },
  PROJECT_PACKAGE_SOURCE_CHANGED: { title: 'projectPackage.error.source.title', body: 'projectPackage.error.source.body', tone: 'danger' },
  PROJECT_PACKAGE_BUSY: { title: 'projectPackage.error.busy.title', body: 'projectPackage.error.busy.body', tone: 'danger' },
  PROJECT_PACKAGE_NOT_FOUND: { title: 'projectPackage.error.notFound.title', body: 'projectPackage.error.notFound.body', tone: 'danger' },
  SAVE_FAILED: { title: 'projectPackage.error.save.title', body: 'projectPackage.error.save.body', tone: 'danger' },
};
const UNKNOWN: ErrorCopy = { title: 'projectPackage.error.unknown.title', body: 'projectPackage.error.unknown.body', tone: 'danger' };
export const projectPackageErrorCopy = (failure: ProjectPackageFailure): ErrorCopy => ERRORS[failure.code] ?? UNKNOWN;
/** Media names reported with a rejected import, when the server lists them. */
function rejectedFiles(failure: ProjectPackageFailure): string[] {
  const list = failure.details?.files ?? failure.details?.media;
  return Array.isArray(list) ? list.flatMap(item => typeof item === 'string' ? [item] : item && typeof item === 'object' && typeof item.name === 'string' ? [item.name] : []).slice(0, 20) : [];
}

export interface ProjectPackageLayerProps {
  /** Where the layer is mounted; decides the "stay" label after import or duplicate. */
  readonly place: 'home' | 'workbench';
  readonly onOpenProject: (projectId: string) => void;
  /** "在素材库中查看" for an export blocked by missing media. */
  readonly onShowAssets?: (projectId: string) => void;
  /** A project was (or may have been) created; refresh any list. */
  readonly onProjectsChanged?: () => void;
  readonly controller?: PackageFlowController;
}

function Result({ tone, title, body, children }: { tone: 'success' | 'danger' | 'neutral'; title: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return <section className="project-package-result" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
    <span className="project-package-result-icon" aria-hidden="true">{tone === 'success' ? <Check size={16} /> : tone === 'neutral' ? <CircleSlash size={16} /> : <AlertTriangle size={16} />}</span>
    <div><strong>{title}</strong>{body && <p>{body}</p>}{children}</div>
  </section>;
}
function Progress({ title, percent, detail, label }: { title: ReactNode; percent: number | null; detail: ReactNode; label: string }) {
  const { t } = useI18n();
  return <section className="project-package-progress" aria-live="polite">
    <header><strong>{title}</strong>{percent !== null && <span>{t('projectPackage.percent', { value: percent })}</span>}</header>
    {percent === null ? <div className="project-package-indeterminate" role="progressbar" aria-label={label}><span /></div> : <WorkbenchProgress value={percent} label={label} />}
    <p>{detail}</p>
  </section>;
}
function MissingList({ missing }: { missing: readonly ProjectPackageMissing[] }) {
  const { t } = useI18n();
  return <ul className="project-package-files" data-testid="project-package-missing">{missing.map(item => <li key={item.assetId}><AlertTriangle size={14} aria-hidden="true" /><span>{item.name}</span><small>{t(item.reason === 'changed' ? 'projectPackage.export.changed' : 'projectPackage.export.missing')}</small></li>)}</ul>;
}
function Note({ children }: { children: ReactNode }) { return <p className="project-package-note">{children}</p>; }

/** Dialogs and the background notice for project files. Mount one on every
 * surface; only the most recently mounted one renders. */
const OPENED_POLL_MS = 2000;

export default function ProjectPackageLayer({ place, onOpenProject, onShowAssets, onProjectsChanged, controller = projectPackageFlow() }: ProjectPackageLayerProps) {
  const { t, formatNumber, formatDate } = useI18n();
  const state = useProjectPackageState(controller);
  const [layer, setLayer] = useState(0);
  const fieldId = useId();
  const created = useRef(state.created);
  const changed = useRef(onProjectsChanged); changed.current = onProjectsChanged;
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const id = controller.claimLayer(); controller.registerPicker(id, () => fileInput.current?.click()); setLayer(id); return () => controller.releaseLayer(id); }, [controller]);
  useEffect(() => { if (state.created !== created.current) { created.current = state.created; changed.current?.(); } }, [state.created]);
  const flow = state.flow, top = layer > 0 && controller.isTopLayer(layer);
  // Only the top layer asks for files opened from the OS, so one window shows each.
  useEffect(() => {
    if (!top) return;
    const check = () => { if (document.visibilityState === 'visible') void controller.checkOpened(); };
    check();
    const timer = setInterval(check, OPENED_POLL_MS);
    window.addEventListener('focus', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); };
  }, [controller, top]);
  const picker = <Input ref={fileInput} type="file" accept=".mioon" className="project-package-file-input" data-testid="project-package-file" tabIndex={-1} aria-hidden="true" aria-label={t('projectPackage.home.filePicker')}
    onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) controller.openImport(file); }} />;
  if (!flow || !top) return picker;
  const size = (bytes: number) => formatPackageBytes(bytes, formatNumber);
  const percent = flowPercent(flow);
  const revealLabel = t(revealPlatform() === 'finder' ? 'projectPackage.revealFinder' : revealPlatform() === 'explorer' ? 'projectPackage.revealExplorer' : 'projectPackage.revealFiles');
  const stayLabel = t(place === 'home' ? 'projectPackage.stayHome' : 'projectPackage.close');
  const open = (projectId: string) => { controller.dismiss(); onOpenProject(projectId); };
  const errorTitle = (failure: ProjectPackageFailure) => t(projectPackageErrorCopy(failure).title);
  const errorBody = (failure: ProjectPackageFailure) => {
    const copy = projectPackageErrorCopy(failure), version = failure.details?.formatVersion, supported = failure.details?.supported;
    if (failure.code === 'PROJECT_PACKAGE_NEWER_FORMAT') return typeof version === 'number' && typeof supported === 'number' ? t('projectPackage.error.newer.body', { format: version, supported }) : t('projectPackage.error.newer.bodyGeneric');
    return t(copy.body);
  };
  const failed = (failure: ProjectPackageFailure) => {
    const files = rejectedFiles(failure);
    return <Result tone={projectPackageErrorCopy(failure).tone} title={errorTitle(failure)} body={errorBody(failure)}>
      {files.length > 0 && <ul className="project-package-files">{files.map(name => <li key={name}><AlertTriangle size={14} aria-hidden="true" /><span>{name}</span></li>)}</ul>}
    </Result>;
  };
  const closeButton = <WorkbenchButton size="large" data-testid="project-package-close" onClick={() => controller.dismiss()}>{t('projectPackage.close')}</WorkbenchButton>;
  const background = <WorkbenchButton variant="primary" size="large" data-testid="project-package-background" onClick={() => controller.toBackground()}>{t('projectPackage.background')}</WorkbenchButton>;

  if (flow.background) return <>{picker}<PackageToast flow={flow} controller={controller} percent={percent} size={size} revealLabel={revealLabel} onOpen={open} errorTitle={errorTitle} /></>;

  let title: ReactNode, description: ReactNode | undefined, body: ReactNode, footer: ReactNode, testId: string;
  if (flow.kind === 'export') {
    const view = flow.view; testId = 'project-package-export-dialog'; title = t('projectPackage.export.title'); description = flow.project.name;
    if (view.step === 'options') {
      const preview = view.preview, missing = preview?.missing ?? [];
      body = <>
        <div className="project-package-field"><span className="project-package-label">{t('projectPackage.export.media')}</span>
          <WorkbenchTabs className="project-package-segmented" label={t('projectPackage.export.media')} value={view.media} onValueChange={value => { if (value === 'all' || value === 'used') controller.setExportMedia(value); }}
            options={[{ value: 'all', label: t('projectPackage.export.mediaAll'), testId: 'project-package-media-all', disabled: view.choosing }, { value: 'used', label: t('projectPackage.export.mediaUsed'), testId: 'project-package-media-used', disabled: view.choosing }]} />
          {preview && <p className="project-package-caption">{view.media === 'used' ? t('projectPackage.export.usedHint', { used: preview.assets.used }) : t('projectPackage.export.assetCounts', { total: preview.assets.total, used: preview.assets.used })}</p>}
        </div>
        {view.loading && <p className="project-package-caption" role="status">{t('projectPackage.export.loading')}</p>}
        {view.previewFailed && <WorkbenchAlert tone="danger" actions={<WorkbenchButton size="compact" onClick={() => controller.retryExportPreview()}>{t('shell.retry')}</WorkbenchButton>}>{t('projectPackage.error.unknown.body')}</WorkbenchAlert>}
        {missing.length > 0 ? <div data-testid="project-package-export-blocked">
          <WorkbenchAlert tone="danger" icon={<AlertTriangle size={15} />}>{t('projectPackage.export.blockedTitle', { count: missing.length })}</WorkbenchAlert>
          <MissingList missing={missing} />
          <Note>{t('projectPackage.export.blockedHelp')}</Note>
        </div> : preview && <>
          <div className="project-package-estimate"><span>{t('projectPackage.export.estimate')}</span><strong>{t('projectPackage.sizeApprox', { size: size(preview.totalBytes) })}</strong></div>
          {preview.warnings.runningTasks > 0 && <WorkbenchAlert tone="warning" icon={<LoaderCircle size={15} />}>{t('projectPackage.export.runningTasks', { count: preview.warnings.runningTasks })}</WorkbenchAlert>}
          {flow.unsaved && <WorkbenchAlert tone="warning" icon={<AlertTriangle size={15} />}>{t('projectPackage.export.unsaved')}</WorkbenchAlert>}
          <Note>{t('projectPackage.export.excludes')}</Note>
        </>}
        {view.error && failed(view.error)}
      </>;
      footer = missing.length > 0
        ? <>{closeButton}<WorkbenchButton variant="primary" size="large" data-testid="project-package-show-assets" onClick={() => { const projectId = flow.project.id; controller.dismiss(); onShowAssets?.(projectId); }}>{t('projectPackage.export.showAssets')}</WorkbenchButton></>
        : <><WorkbenchButton size="large" disabled={view.choosing} onClick={() => controller.dismiss()}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton variant="primary" size="large" data-testid="project-package-export-submit" loading={view.choosing} disabled={!preview || view.loading} onClick={() => void controller.confirmExport()}>{t('projectPackage.export.submit')}</WorkbenchButton></>;
    } else if (view.step === 'running' || view.step === 'saving') {
      const status = view.status;
      body = <><Progress title={t('projectPackage.export.runningTitle', { name: flow.project.name })} percent={percent} label={t('projectPackage.progressLabel')}
        detail={view.step === 'saving' ? t('projectPackage.export.saving') : status.stage === 'verifying' ? t('projectPackage.export.verifying', { totalBytes: size(status.totalBytes) }) : t('projectPackage.export.writing', { files: status.files, total: status.totalFiles, bytes: size(status.bytes), totalBytes: size(status.totalBytes) })} />
        <Note>{t('projectPackage.export.keepEditing')}</Note></>;
      footer = <>{view.step === 'running' && <WorkbenchButton size="large" data-testid="project-package-export-cancel" onClick={() => void controller.cancelExport()}>{t('projectPackage.export.cancel')}</WorkbenchButton>}{background}</>;
    } else if (view.step === 'done') {
      body = <Result tone="success" title={t('projectPackage.export.doneTitle', { name: flow.project.name })} body={t(view.token ? 'projectPackage.export.doneVerified' : 'projectPackage.export.downloadStarted', { file: view.fileName, size: size(view.bytes) })} />;
      footer = <>{view.token && projectPackagesBridge() && <WorkbenchButton size="large" data-testid="project-package-reveal" onClick={() => void controller.reveal()}><FolderOpen size={15} aria-hidden="true" />{revealLabel}</WorkbenchButton>}<WorkbenchButton variant="primary" size="large" data-testid="project-package-done" onClick={() => controller.dismiss()}>{t('projectPackage.done')}</WorkbenchButton></>;
    } else { body = failed(view.error); footer = closeButton; }
  } else if (flow.kind === 'import') {
    const view = flow.view; testId = 'project-package-import-dialog'; title = t('projectPackage.import.title');
    if (view.step === 'uploading') {
      body = <Progress title={t('projectPackage.import.verifying')} percent={percent} label={t('projectPackage.progressLabel')} detail={t('projectPackage.import.uploaded', { loaded: size(view.loaded), total: size(view.total) })} />;
      footer = <><WorkbenchButton size="large" data-testid="project-package-import-cancel" onClick={() => controller.cancelUpload()}>{t('common.cancel')}</WorkbenchButton>{background}</>;
    } else if (view.step === 'preview') {
      const preview = view.preview, line = preview.timeline;
      const orientation = line ? t(line.width === line.height ? 'redesign.projects.square' : line.width > line.height ? 'redesign.projects.landscape' : 'redesign.projects.portrait') : '';
      body = <>
        <div className="project-package-file"><span className="project-package-file-icon" aria-hidden="true"><Layers size={18} /></span><div><strong>{flow.fileName}</strong><small>{size(preview.totalBytes)}</small></div><span className="project-package-badge"><Check size={12} aria-hidden="true" />{t('projectPackage.import.verifiedFiles', { count: preview.fileCount })}</span></div>
        <div className="project-package-field"><Label htmlFor={`${fieldId}-name`}>{t('projects.name')}</Label>
          <Input id={`${fieldId}-name`} data-testid="project-package-import-name" value={view.name} maxLength={150} autoFocus onChange={event => controller.setImportName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') controller.confirmImport(); }} />
          {preview.nameTaken && view.name === preview.suggestedName && <p className="project-package-caption">{t('projectPackage.import.renamed')}</p>}
        </div>
        <dl className="project-package-summary">
          <div><dt>{t('projectPackage.import.format')}</dt><dd>{line ? t('projectPackage.import.timeline', { orientation, width: line.width, height: line.height, fps: formatNumber(line.fps, { maximumFractionDigits: 3 }) }) : t('projectPackage.import.noTimeline')}</dd></div>
          <div><dt>{t('projectPackage.import.content')}</dt><dd>{t('projectPackage.import.counts', { shots: preview.counts.shots, assets: preview.counts.assets, versions: preview.counts.versions, clips: preview.counts.clips, subtitles: preview.counts.subtitles })}</dd></div>
          <div><dt>{t('projectPackage.import.origin')}</dt><dd>{t('projectPackage.import.source', { version: preview.appVersion, time: Number.isFinite(new Date(preview.createdAt).getTime()) ? formatDate(preview.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : preview.createdAt })}</dd></div>
        </dl>
        <Note>{t('projectPackage.import.generationNote')}</Note>
      </>;
      footer = <><WorkbenchButton size="large" onClick={() => controller.dismiss()}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton variant="primary" size="large" data-testid="project-package-import-submit" disabled={!view.name.trim()} onClick={() => controller.confirmImport()}>{t('projectPackage.import.submit')}</WorkbenchButton></>;
    } else if (view.step === 'committing') {
      body = <Progress title={t('projectPackage.import.committing', { name: view.name })} percent={null} label={t('projectPackage.progressLabel')} detail={t('projectPackage.import.copying', { count: view.preview.fileCount })} />;
      footer = background;
    } else if (view.step === 'done') {
      const c = view.counts;
      body = <Result tone="success" title={t('projectPackage.import.doneTitle', { name: view.name })} body={t('projectPackage.import.counts', { shots: c.shots, assets: c.assets, versions: c.versions, clips: c.clips, subtitles: c.subtitles })} />;
      footer = <><WorkbenchButton size="large" data-testid="project-package-stay" onClick={() => controller.dismiss()}>{stayLabel}</WorkbenchButton><WorkbenchButton variant="primary" size="large" data-testid="project-package-open" onClick={() => open(view.projectId)}>{t('projectPackage.openProject')}</WorkbenchButton></>;
    } else { body = failed(view.error); footer = closeButton; }
  } else {
    const view = flow.view; testId = 'project-package-duplicate-dialog'; title = t('projectPackage.duplicate.title');
    if (view.step === 'editing') {
      body = <>
        <div className="project-package-field"><Label htmlFor={`${fieldId}-duplicate`}>{t('projects.name')}</Label>
          <Input id={`${fieldId}-duplicate`} data-testid="project-package-duplicate-name" value={view.name} maxLength={150} autoFocus onChange={event => controller.setDuplicateName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void controller.confirmDuplicate(); }} /></div>
        <p className="project-package-help">{view.estimate !== null ? t('projectPackage.duplicate.help', { size: size(view.estimate) }) : t('projectPackage.duplicate.helpNoSize')}</p>
      </>;
      footer = <><WorkbenchButton size="large" onClick={() => controller.dismiss()}>{t('common.cancel')}</WorkbenchButton><WorkbenchButton variant="primary" size="large" data-testid="project-package-duplicate-submit" disabled={!view.name.trim()} onClick={() => void controller.confirmDuplicate()}>{t('projectPackage.duplicate.submit')}</WorkbenchButton></>;
    } else if (view.step === 'running') {
      body = <Progress title={t('projectPackage.duplicate.running', { name: flow.project.name })} percent={null} label={t('projectPackage.progressLabel')} detail={t('projectPackage.duplicate.copying')} />;
      footer = background;
    } else if (view.step === 'done') {
      body = <Result tone="success" title={t('projectPackage.duplicate.doneTitle', { name: view.name })} body={t('projectPackage.duplicate.doneBody')} />;
      footer = <><WorkbenchButton size="large" data-testid="project-package-stay" onClick={() => controller.dismiss()}>{stayLabel}</WorkbenchButton><WorkbenchButton variant="primary" size="large" data-testid="project-package-open" onClick={() => open(view.projectId)}>{t('projectPackage.openProject')}</WorkbenchButton></>;
    } else { body = failed(view.error); footer = closeButton; }
  }
  const running = isFlowRunning(flow);
  // A running dialog has no close button: "close" would be ambiguous between cancelling and continuing.
  return <>{picker}<Dialog open onOpenChange={next => { if (!next && !running) controller.dismiss(); }} disablePointerDismissal={running}>
    <WorkbenchDialogContent title={title} description={description} size="standard" showCloseButton={!running} className="project-package-dialog" data-testid={testId} data-step={flow.view.step} footer={footer}>
      <div className="project-package-body">{body}</div>
    </WorkbenchDialogContent>
  </Dialog></>;
}

function PackageToast({ flow, controller, percent, size, revealLabel, onOpen, errorTitle }: { flow: PackageFlow; controller: PackageFlowController; percent: number | null; size: (bytes: number) => string; revealLabel: string; onOpen: (projectId: string) => void; errorTitle: (failure: ProjectPackageFailure) => string }) {
  const { t } = useI18n();
  const view = flow.view, running = isFlowRunning(flow);
  const name = flow.kind !== 'import' ? flow.project.name : flow.view.step === 'committing' || flow.view.step === 'done' ? flow.view.name : flow.fileName;
  let tone: 'neutral' | 'success' | 'danger' = 'neutral', icon: ReactNode, title: string, detail: ReactNode = null, action: ReactNode = null;
  if (running) {
    icon = <LoaderCircle size={16} className="project-package-spin" />;
    title = flow.kind === 'export' ? t('projectPackage.export.runningTitle', { name }) : flow.kind === 'duplicate' ? t('projectPackage.duplicate.running', { name }) : view.step === 'uploading' ? t('projectPackage.import.verifying') : t('projectPackage.import.committing', { name });
    detail = percent === null ? <div className="project-package-indeterminate" role="progressbar" aria-label={t('projectPackage.progressLabel')}><span /></div> : <div className="project-package-toast-progress"><WorkbenchProgress value={percent} label={t('projectPackage.progressLabel')} /><span>{t('projectPackage.percent', { value: percent })}</span></div>;
    if (view.step === 'running' && flow.kind === 'export') action = <WorkbenchButton variant="ghost" size="compact" onClick={() => void controller.cancelExport()}>{t('common.cancel')}</WorkbenchButton>;
    if (view.step === 'uploading') action = <WorkbenchButton variant="ghost" size="compact" onClick={() => controller.cancelUpload()}>{t('common.cancel')}</WorkbenchButton>;
  } else if (view.step === 'done') {
    tone = 'success'; icon = <Check size={16} />;
    if (flow.kind === 'export' && 'fileName' in view) {
      title = t('projectPackage.export.doneTitle', { name }); detail = <small>{view.fileName} · {size(view.bytes)}</small>;
      if (view.token && projectPackagesBridge()) action = <WorkbenchButton variant="ghost" size="compact" data-testid="project-package-toast-reveal" onClick={() => void controller.reveal()}>{revealLabel}</WorkbenchButton>;
    } else {
      title = flow.kind === 'import' ? t('projectPackage.import.doneTitle', { name }) : t('projectPackage.duplicate.doneTitle', { name: 'name' in view ? view.name : name });
      if ('counts' in view) detail = <small>{t('projectPackage.import.counts', { shots: view.counts.shots, assets: view.counts.assets, versions: view.counts.versions, clips: view.counts.clips, subtitles: view.counts.subtitles })}</small>;
      if ('projectId' in view) { const projectId = view.projectId; action = <WorkbenchButton variant="ghost" size="compact" data-testid="project-package-toast-open" onClick={() => onOpen(projectId)}>{t('projectPackage.openProject')}</WorkbenchButton>; }
    }
  } else if (view.step === 'failed') {
    const failure = view.error, cancelled = failure.code === 'PROJECT_PACKAGE_CANCELLED';
    tone = cancelled ? 'neutral' : 'danger'; icon = cancelled ? <CircleSlash size={16} /> : <AlertTriangle size={16} />;
    const reason = errorTitle(failure);
    title = flow.kind === 'export' ? t('projectPackage.export.failedTitle', { reason }) : flow.kind === 'import' ? t('projectPackage.import.failedTitle', { reason }) : t('projectPackage.duplicate.failedTitle', { reason });
    action = <WorkbenchButton variant="ghost" size="compact" data-testid="project-package-toast-view" onClick={() => controller.toForeground()}>{t('projectPackage.view')}</WorkbenchButton>;
  } else { title = name; }
  return <WorkbenchToastRegion label={t('projectPackage.toastRegion')} className="project-package-toasts">
    <WorkbenchToast tone={tone} data-testid="project-package-toast" data-state={running ? 'running' : view.step === 'done' ? 'done' : 'failed'} className="project-package-toast">
      <span className="project-package-toast-icon" data-tone={tone} aria-hidden="true">{icon}</span>
      <div className="project-package-toast-copy"><strong>{title}</strong>{detail}</div>
      {action}
      {!running && <WorkbenchButton variant="icon" size="compact" aria-label={t('projectPackage.dismiss')} title={t('projectPackage.dismiss')} data-testid="project-package-toast-dismiss" onClick={() => controller.dismiss()}><X size={14} /></WorkbenchButton>}
    </WorkbenchToast>
  </WorkbenchToastRegion>;
}
