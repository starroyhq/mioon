import React, { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent, WorkbenchProgress } from '@mioon/ui/components/workbench-controls';
import { AlertTriangle, CircleCheck, Film, Link } from '@mioon/ui/components/workbench-icons';
import { PROJECT_RULES_FILE } from '../../../../packages/contracts/src/project-file.ts';
import type { ProjectPackResult } from '../../../../packages/contracts/src/project-versions.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { displayPath, revealLabelKey } from './format.ts';
import { ProjectFileIcon } from './project-file-icons.tsx';
import type { HostPlatform, ViewState } from './types.ts';
import { useProjectFileDisplay } from './use-display.ts';
import './project-file-common.css';
import './project-file-pack.css';

/** What packing will copy, worked out before it starts. */
export interface PackManifest {
  readonly destination: string;
  readonly projectFile: { readonly name: string; readonly sizeBytes: number };
  /** Media that will be copied; `outsideCount` of them are outside the project folder. */
  readonly assets: { readonly count: number; readonly sizeBytes: number; readonly outsideCount: number };
  readonly rulesFile: boolean;
  /** Referenced media that cannot be found; they are left out. */
  readonly missing: number;
}
export type PackState = { readonly kind: 'idle' } | { readonly kind: 'packing'; /** 0–100 */ readonly progress: number } | { readonly kind: 'error' };
export interface PackProjectDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  readonly homeDirectory?: string | null;
  readonly manifest: ViewState<PackManifest>;
  readonly pack: PackState;
  readonly onChooseDestination?: () => void;
  readonly onRelink?: () => void;
  readonly onPack: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Package project (12-10): copies the project file, AGENTS.md and the used media into a new folder. */
export function PackProjectDialog(props: PackProjectDialogProps): ReactElement {
  const { t, formatNumber } = useI18n();
  const display = useProjectFileDisplay();
  const id = useId();
  const { manifest, pack } = props;
  const packing = pack.kind === 'packing';
  let body: ReactNode;
  if (manifest.kind === 'loading') body = <div className="pf-state" role="status" data-testid="pf-pack-loading"><span className="wb-spinner" aria-hidden="true" />{t('projectFile.pack.loading')}</div>;
  else if (manifest.kind === 'error') body = <div className="pf-state" role="alert" data-testid="pf-pack-read-error"><strong>{t('projectFile.pack.readError')}</strong>
    {manifest.retryable && <WorkbenchButton data-testid="pf-pack-retry" onClick={props.onRetry}>{t('projectFile.common.retry')}</WorkbenchButton>}</div>;
  else {
    const { destination, projectFile, assets, rulesFile, missing } = manifest.value;
    body = <>
      <div className="pf-field">
        <Label htmlFor={`${id}-destination`}>{t('projectFile.pack.destination')}</Label>
        <div className="pf-pack-destination-row">
          <Input id={`${id}-destination`} data-testid="pf-pack-destination" value={displayPath(destination, props.homeDirectory)} readOnly tabIndex={-1} />
          {props.onChooseDestination && <WorkbenchButton data-testid="pf-pack-choose" disabled={packing} onClick={props.onChooseDestination}><Icon name="folder" size={14} />{t('projectFile.create.choose')}</WorkbenchButton>}
        </div>
      </div>
      <ul className="pf-rows pf-pack-rows">
        <li><ProjectFileIcon name="file" className="pf-row-icon" /><span className="pf-row-main"><span className="pf-row-title">{t('projectFile.pack.projectFile')}</span>
          <span className="pf-row-detail pf-mono">{t('projectFile.pack.fileDetail', { file: projectFile.name, size: display.bytes(projectFile.sizeBytes) })}</span></span></li>
        <li data-testid="pf-pack-assets"><Film size={16} aria-hidden="true" className="pf-row-icon" /><span className="pf-row-main"><span className="pf-row-title">{t('projectFile.pack.assets', { count: assets.count })}</span>
          <span className="pf-row-detail pf-mono">{assets.count === 0 ? t('projectFile.pack.noAssets') : assets.outsideCount > 0
            ? t('projectFile.pack.assetsOutside', { size: display.bytes(assets.sizeBytes), count: assets.outsideCount }) : display.bytes(assets.sizeBytes)}</span></span></li>
        {rulesFile && <li data-testid="pf-pack-rules"><Icon name="note" size={16} className="pf-row-icon" /><span className="pf-row-main"><span className="pf-row-title">{t('projectFile.pack.rules')}</span>
          <span className="pf-row-detail pf-mono">{PROJECT_RULES_FILE}</span></span></li>}
      </ul>
      {missing > 0 && <WorkbenchAlert tone="warning" className="pf-pack-missing" data-testid="pf-pack-missing" icon={<AlertTriangle size={16} />}
        actions={props.onRelink && <WorkbenchButton size="compact" data-testid="pf-pack-relink" disabled={packing} onClick={props.onRelink}><Link size={14} aria-hidden="true" />{t('projectFile.media.relink.action')}</WorkbenchButton>}>
        {t('projectFile.pack.missing', { count: missing })}
      </WorkbenchAlert>}
      {pack.kind === 'packing' && <div className="pf-pack-progress" data-testid="pf-pack-progress">
        <span className="pf-pack-progress-text"><span>{t('projectFile.pack.packing')}</span><span className="pf-mono">{t('projectPackage.percent', { value: formatNumber(Math.round(pack.progress)) })}</span></span>
        <WorkbenchProgress value={pack.progress} label={t('projectFile.pack.progress')} />
      </div>}
      {pack.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-pack-failed">{t('projectFile.pack.failed')}</WorkbenchAlert>}
      <p className="pf-pack-note"><Icon name="shield" size={14} />{t('projectFile.pack.excludes')}</p>
    </>;
  }
  return <Dialog open={props.open} onOpenChange={next => { if (!next && !packing) props.onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.pack.title')} description={props.projectName} size="standard" className="pf-dialog pf-pack-dialog" data-testid="pf-pack-dialog" showCloseButton={!packing}
      footer={<>
        <WorkbenchButton data-testid="pf-pack-cancel" disabled={packing} onClick={props.onClose}>{t('common.cancel')}</WorkbenchButton>
        <WorkbenchButton variant="primary" data-testid="pf-pack-submit" loading={packing} disabled={manifest.kind !== 'ready'} onClick={props.onPack}>{t('projectFile.pack.submit')}</WorkbenchButton>
      </>}>
      {body}
    </WorkbenchDialogContent>
  </Dialog>;
}

export interface PackCompleteDialogProps {
  readonly open: boolean;
  readonly result: ProjectPackResult;
  /** Names of the media in `missingAssetIds`, as far as they are known. */
  readonly missingNames: readonly string[];
  readonly platform: HostPlatform;
  readonly homeDirectory?: string | null;
  readonly onReveal?: () => void;
  readonly onClose: () => void;
}
/** Packing finished (12-11): what was copied, and the media that could not be found. */
export function PackCompleteDialog({ open, result, missingNames, platform, homeDirectory, onReveal, onClose }: PackCompleteDialogProps): ReactElement {
  const { t } = useI18n();
  const display = useProjectFileDisplay();
  const missing = result.missingAssetIds.length, unnamed = missing - Math.min(missing, missingNames.length);
  const copied = { count: result.copiedAssets, size: display.bytes(result.copiedBytes) };
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <WorkbenchDialogContent title={t('projectFile.pack.doneTitle')} size="standard" className="pf-dialog pf-pack-dialog" data-testid="pf-pack-done-dialog"
      footer={<>
        {onReveal && <WorkbenchButton data-testid="pf-pack-reveal" onClick={onReveal}>{t(revealLabelKey(platform))}</WorkbenchButton>}
        <WorkbenchButton variant="primary" data-testid="pf-pack-done" onClick={onClose}>{t('projectPackage.done')}</WorkbenchButton>
      </>}>
      <div className="pf-pack-done" data-testid="pf-pack-copied">
        <span className="pf-pack-done-icon"><CircleCheck size={18} aria-hidden="true" /></span>
        <span className="pf-row-main">
          <span className="pf-pack-done-text">{result.rulesFileCopied ? t('projectFile.pack.copiedWithRules', { file: PROJECT_RULES_FILE, ...copied }) : t('projectFile.pack.copied', copied)}</span>
          <span className="pf-pack-done-path pf-mono">{t('projectFile.pack.folder', { path: displayPath(result.directory, homeDirectory) })}</span>
        </span>
      </div>
      {missing > 0 && <>
        <ul className="pf-rows pf-pack-missing-list" data-testid="pf-pack-missing-list">{missingNames.slice(0, missing).map((name, index) => <li key={`${index}:${name}`}>
          <ProjectFileIcon name="fileX" className="pf-row-icon pf-tone-danger" />
          <span className="pf-row-main"><span className="pf-row-title">{name}</span><span className="pf-row-detail">{t('projectFile.pack.missingItem')}</span></span>
        </li>)}</ul>
        {unnamed > 0 && <p className="pf-help">{t('projectFile.pack.missingMore', { count: unnamed })}</p>}
        <p className="pf-help" data-testid="pf-pack-missing-note">{t('projectFile.pack.missingNote', { count: missing })}</p>
      </>}
    </WorkbenchDialogContent>
  </Dialog>;
}
