import React from 'react';
import type {ReactElement} from 'react';
import {WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {WorkbenchIcon} from '@mioon/ui/components/workbench-icons';
import {useI18n} from '../i18n/I18nProvider.tsx';
import './project-file-home.css';

/** Positive facts supplied by a trusted location probe. Missing/unknown facts
 * produce no claim that a location is local, writable or outside cloud sync. */
export type ProjectLocationRisk =
  | {readonly kind: 'cloud'; readonly serviceName?: string}
  | {readonly kind: 'permissions'; readonly fileSystem?: string}
  | {readonly kind: 'network'};
export type OpenedProjectLocationRisk = Exclude<ProjectLocationRisk, {readonly kind: 'network'}>;

export function ProjectLocationRiskNotice({risks, place = 'create'}: {readonly risks: readonly ProjectLocationRisk[]; readonly place?: 'create' | 'editor'}): ReactElement | null {
  const {t} = useI18n();
  if (risks.length === 0) return null;
  return <div className="pf-location-risks" data-testid="pf-location-risks">{risks.map((risk, index) => {
    const error = risk.kind === 'network';
    let text: string;
    if (risk.kind === 'cloud') text = t(place === 'editor' ? 'projectFile.location.cloudEditor' : 'projectFile.location.cloudCreate', {service: risk.serviceName?.trim() || t('projectFile.location.cloudService')});
    else if (risk.kind === 'permissions') text = risk.fileSystem?.toLowerCase() === 'exfat'
      ? t(place === 'editor' ? 'projectFile.location.exfatEditor' : 'projectFile.location.exfatCreate')
      : t(place === 'editor' ? 'projectFile.location.permissionsEditor' : 'projectFile.location.permissionsCreate');
    else text = t('projectFile.location.network');
    return <p key={`${risk.kind}-${index}`} className="pf-location-risk" data-tone={error ? 'danger' : 'warning'} data-testid={`pf-location-risk-${risk.kind}`} role={error ? 'alert' : undefined}>
      <WorkbenchIcon name="warning" size={15} /><span>{text}</span>
    </p>;
  })}</div>;
}

/** The caller dismisses this exact open session; the view stores no read flag. */
export function ProjectLocationRiskBanner({risks, onDismiss}: {readonly risks: readonly OpenedProjectLocationRisk[]; readonly onDismiss: () => void}): ReactElement | null {
  const {t} = useI18n();
  if (risks.length === 0) return null;
  return <section className="pf-location-banner" data-testid="pf-location-banner" role="status">
    <ProjectLocationRiskNotice risks={risks} place="editor" />
    <WorkbenchButton variant="ghost" size="compact" data-testid="pf-location-dismiss" onClick={onDismiss}>{t('projectFile.location.dismiss')}</WorkbenchButton>
  </section>;
}
