import React, {useRef} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {Lock, Upload, Layers} from '@mioon/ui/components/workbench-icons';
import {PROJECT_FORMAT_READ_ONLY_LIMITS} from '../../../../packages/contracts/src/project-format-upgrade.ts';
import type {ProjectFormatReadOnlyView} from '../../../../packages/contracts/src/project-format-upgrade.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import type {ProjectFormatChoice, ProjectFormatNotice} from '../project-format-upgrade-client.ts';
import {displayTimelineFrame} from '../timeline-removal.ts';
import './project-file-common.css';
import './project-format-upgrade.css';

export function ProjectFormatUpgradeDialog({busy, notice, recheck, blocked, onChoose, onClose}: {
  busy: ProjectFormatChoice | null;
  notice?: ProjectFormatNotice;
  recheck?: () => void;
  blocked?: boolean;
  onChoose: (choice: ProjectFormatChoice) => void;
  onClose: () => void;
}) {
  const {t} = useI18n();
  const safeChoice = useRef<HTMLButtonElement>(null);
  return <Dialog open onOpenChange={next => {if (!next && !busy && !recheck && !blocked) onClose();}}>
    <WorkbenchDialogContent size="confirm" className="pf-dialog pf-format-upgrade" showCloseButton={false}
      initialFocus={safeChoice} data-testid="pf-format-upgrade"
      title={<><span className="pf-format-upgrade-icon"><Upload size={18} aria-hidden="true" /></span>{t('projectFile.upgrade.title')}</>}
      description={t('projectFile.upgrade.body')}
      footer={<>
        <div className="pf-format-upgrade-actions">
          <WorkbenchButton ref={safeChoice} disabled={Boolean(busy || recheck || blocked) || notice === 'changed'} loading={busy === 'read-only'} data-testid="pf-format-read-only"
            onClick={() => onChoose('read-only')}>{t('projectFile.upgrade.readOnly')}</WorkbenchButton>
          <WorkbenchButton variant="primary" disabled={Boolean(busy || recheck || blocked) || notice === 'changed'} loading={busy === 'upgrade'}
            data-testid="pf-format-approve" onClick={() => onChoose('upgrade')}>{t('projectFile.upgrade.open')}</WorkbenchButton>
        </div>
        {notice === 'changed' && !recheck && <WorkbenchButton disabled={blocked} onClick={onClose}>{t('common.close')}</WorkbenchButton>}
        <p className="pf-format-upgrade-note">{t('projectFile.upgrade.readOnlyHint')}</p>
      </>}>
      <div className="pf-format-upgrade-backup">
        <Layers size={15} aria-hidden="true" />
        <div><strong>{t('projectFile.upgrade.backup')}</strong><span>{t('projectFile.upgrade.backupLocation')}</span></div>
      </div>
      {notice && <WorkbenchAlert tone="danger" data-testid="pf-format-upgrade-error">{t(`projectFile.upgrade.${notice}`)}</WorkbenchAlert>}
      {recheck && <WorkbenchAlert tone="warning" actions={<WorkbenchButton disabled={blocked} onClick={recheck}>{t('projectFile.create.recheck')}</WorkbenchButton>}>
        {t('projectFile.open.outcomeUnknown')}
      </WorkbenchAlert>}
    </WorkbenchDialogContent>
  </Dialog>;
}

export function ProjectFormatReadOnlyDialog({view, onClose}: {view: ProjectFormatReadOnlyView; onClose: () => void}) {
  const {t, formatNumber} = useI18n();
  const timeline = view.timeline;
  const tracks = new Map(timeline?.tracks.map(track => [track.id, track.name]));
  const timing = (frames: number) => displayTimelineFrame(frames, timeline?.fps);
  return <Dialog open onOpenChange={next => {if (!next) onClose();}}>
    <WorkbenchDialogContent size="standard" className="pf-dialog pf-format-read-only" showCloseButton={false}
      data-testid="pf-format-read-only-view" title={<><Lock size={16} aria-hidden="true" /> {t('projectFile.upgrade.readOnlyTitle', {name: view.name})}</>}
      description={view.description || undefined}
      footer={<WorkbenchButton onClick={onClose}>{t('common.close')}</WorkbenchButton>}>
      {view.truncated && <WorkbenchAlert tone="neutral">{t('projectFile.upgrade.truncated', {count: PROJECT_FORMAT_READ_ONLY_LIMITS.items})}</WorkbenchAlert>}
      <section>
        <h3>{t('projectFile.upgrade.shots')}</h3>
        {view.shots.length ? <ol className="pf-rows">{view.shots.map(shot => <li key={shot.id}>
          <span className="pf-row-main">{shot.title}</span>
          <span className="pf-row-end">{t('projectFile.upgrade.seconds', {duration: formatNumber(shot.duration)})} · {t('canvas.edit.versions', {count: shot.versionCount})}</span>
        </li>)}</ol> : <p>{t('projectFile.upgrade.noContent')}</p>}
      </section>
      {view.nodes.length > 0 && <section><h3>{t('projectFile.upgrade.nodes')}</h3><ul className="pf-rows">{view.nodes.map(node =>
        <li key={node.id}><span className="pf-row-main">{node.label}</span></li>)}</ul></section>}
      {timeline && <section><h3>{t('shell.timeline')} · {timeline.width}×{timeline.height} · {timing(timeline.durationFrames)}</h3>
        {timeline.clips.length ? <ul className="pf-rows">{timeline.clips.map(clip => <li key={clip.id}>
          <span className="pf-row-main">{clip.name}<span className="pf-row-detail">{tracks.get(clip.trackId)}</span></span>
          <span className="pf-row-end">{t('projectFile.upgrade.clipTiming', {start: timing(clip.startFrame), duration: timing(clip.durationFrames)})}</span>
        </li>)}</ul> : <p>{t('projectFile.upgrade.noContent')}</p>}
      </section>}
    </WorkbenchDialogContent>
  </Dialog>;
}
