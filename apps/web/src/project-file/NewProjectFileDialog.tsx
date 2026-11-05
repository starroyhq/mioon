import React, { useId, useRef } from 'react';
import type { ReactElement } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';
import { WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { Check } from '@mioon/ui/components/workbench-icons';
import { DEFAULT_TIMELINE_OUTPUT_PRESET, TIMELINE_CURRENT_OUTPUT_PRESETS } from '../../../../packages/contracts/src/timeline-output-geometry.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import Icon from '../icons.tsx';
import { aspectLabel, projectFilePathPreview, projectNameProblem } from './format.ts';
import {ProjectLocationRiskNotice} from './ProjectLocationRisk.tsx';
import type {ProjectLocationRisk} from './ProjectLocationRisk.tsx';
import './project-file-common.css';
import './project-file-home.css';

export type NewProjectPresetId = typeof TIMELINE_CURRENT_OUTPUT_PRESETS[number]['id'];
export interface NewProjectFileValues {
  readonly name: string;
  readonly description: string;
  readonly presetId: NewProjectPresetId;
  /** Put the project file in a new folder named after the project. */
  readonly createFolder: boolean;
}
export type NewProjectFileState =
  | { readonly kind: 'editing' }
  | { readonly kind: 'creating' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'created'; readonly projectName?: string; readonly opening?: boolean }
  | { readonly kind: 'error'; readonly code: 'PROJECT_FILE_EXISTS' | 'unknown' };
export interface NewProjectFileDialogProps {
  readonly open: boolean;
  readonly values: NewProjectFileValues;
  readonly onChange: (patch: Partial<NewProjectFileValues>) => void;
  /** The chosen folder as shown, e.g. `~/Movies/Mioon`. */
  readonly location: { readonly display: string; readonly risks?: readonly ProjectLocationRisk[]; readonly status?: 'ready' | 'checking' | 'unavailable' };
  /** Web creation currently always creates a folder. Do not offer a switch
   * until the selected creation capability can implement both layouts. */
  readonly folderMode?: 'choose' | 'always' | 'never';
  /** Absent on the web, where the server picks the folder. */
  readonly onChooseLocation?: () => void;
  readonly state: NewProjectFileState;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly onRecheck?: () => void;
  readonly onRetryOpen?: () => void;
}
/** Same limit as the current new project form. */
export const NEW_PROJECT_DESCRIPTION_MAX_LENGTH = 500;
/** Starting values for a new project besides its name: the default timeline format, in a folder of its own. */
export const NEW_PROJECT_FILE_DEFAULTS: Omit<NewProjectFileValues, 'name'> = Object.freeze({ description: '', presetId: DEFAULT_TIMELINE_OUTPUT_PRESET, createFolder: true });

/** New project (12-02): a controlled form; the caller creates the file. */
export function NewProjectFileDialog(props: NewProjectFileDialogProps): ReactElement {
  const {open, values, location, onChooseLocation, state, folderMode = 'choose'} = props;
  const { t } = useI18n();
  const id = useId();
  const current = useRef(props); current.current = props;
  const creating = state.kind === 'creating' || state.kind === 'created' && state.opening === true;
  const frozen = creating || state.kind === 'unknown' || state.kind === 'created';
  const createFolder = folderMode === 'always' || folderMode === 'choose' && values.createFolder;
  const problem = projectNameProblem(values.name);
  const canSubmit = problem === null && values.description.length <= NEW_PROJECT_DESCRIPTION_MAX_LENGTH && !frozen &&
    (location.status === undefined || location.status === 'ready') && !location.risks?.some(risk => risk.kind === 'network');
  const editable = (): boolean => current.current.open && ['editing', 'error'].includes(current.current.state.kind);
  const change = (patch: Partial<NewProjectFileValues>): void => {if (editable()) current.current.onChange(patch);};
  const submit = (): void => {
    const next = current.current;
    if (!editable() || projectNameProblem(next.values.name) !== null || next.values.description.length > NEW_PROJECT_DESCRIPTION_MAX_LENGTH ||
      next.location.status !== undefined && next.location.status !== 'ready' || next.location.risks?.some(risk => risk.kind === 'network')) return;
    next.onSubmit();
  };
  const close = (): void => {const next = current.current; if (next.open && next.state.kind !== 'creating' && next.state.kind !== 'unknown' && !(next.state.kind === 'created' && next.state.opening)) next.onClose();};
  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <WorkbenchDialogContent title={t('projectFile.create.title')} size="standard" className="pf-dialog pf-create-dialog" data-testid="pf-create-dialog" showCloseButton={!creating && state.kind !== 'unknown'}
      footer={<>
        <WorkbenchButton data-testid="pf-create-cancel" disabled={creating || state.kind === 'unknown'} onClick={close}>{t(state.kind === 'created' ? 'common.close' : 'common.cancel')}</WorkbenchButton>
        {state.kind === 'unknown' ? props.onRecheck && <WorkbenchButton variant="primary" data-testid="pf-create-recheck" onClick={() => {if (current.current.open && current.current.state.kind === 'unknown') current.current.onRecheck?.();}}>{t('projectFile.create.recheck')}</WorkbenchButton>
          : state.kind === 'created' ? props.onRetryOpen && <WorkbenchButton variant="primary" data-testid="pf-create-retry-open" loading={creating} disabled={creating} onClick={() => {const next = current.current; if (next.open && next.state.kind === 'created' && !next.state.opening) next.onRetryOpen?.();}}>{t('projectFile.create.retryOpen')}</WorkbenchButton>
            : <WorkbenchButton type="submit" form={`${id}-form`} variant="primary" data-testid="pf-create-submit" loading={creating} disabled={!canSubmit}>{t('projectFile.create.submit')}</WorkbenchButton>}
      </>}>
      <form id={`${id}-form`} className="pf-create-form" aria-busy={creating || undefined} onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="pf-field">
          <Label htmlFor={`${id}-name`}>{t('projectFile.create.name')}</Label>
          <Input id={`${id}-name`} data-testid="pf-create-name" value={values.name} maxLength={150} readOnly={frozen} autoFocus
            aria-invalid={problem === 'invalid' || undefined} aria-describedby={problem === 'invalid' ? `${id}-name-error` : undefined}
            onChange={event => change({ name: event.target.value })} />
          {problem === 'invalid' && <p id={`${id}-name-error`} className="wb-field-error" role="alert" data-testid="pf-create-name-error">{t('projectFile.create.nameInvalid')}</p>}
        </div>
        <div className="pf-field">
          <Label htmlFor={`${id}-location`}>{t('projectFile.create.location')}</Label>
          <div className="pf-create-location">
            <Input id={`${id}-location`} className="pf-mono" data-testid="pf-create-location" value={location.display} readOnly tabIndex={-1} />
            {onChooseLocation && <WorkbenchButton data-testid="pf-create-choose" disabled={frozen} onClick={() => {if (editable()) current.current.onChooseLocation?.();}}><Icon name="folder" size={14} />{t('projectFile.create.choose')}</WorkbenchButton>}
          </div>
          {location.status === 'checking' && <p className="pf-help" role="status" data-testid="pf-create-location-checking">{t('projectFile.location.checking')}</p>}
          {location.status === 'unavailable' && <p className="wb-field-error" role="alert" data-testid="pf-create-location-unavailable">{t('projectFile.location.unavailable')}</p>}
          {location.risks && <ProjectLocationRiskNotice risks={location.risks} />}
          <label className="pf-check">
            <input type="checkbox" data-testid="pf-create-folder" checked={createFolder} disabled={frozen || folderMode !== 'choose'} onChange={event => {if (current.current.folderMode === undefined || current.current.folderMode === 'choose') change({ createFolder: event.target.checked });}} />
            <span>{t('projectFile.create.createFolder')}</span>
          </label>
          {problem === null && <p className="pf-help" data-testid="pf-create-preview">{createFolder
            ? t('projectFile.create.willCreateInFolder', { path: projectFilePathPreview(location.display, values.name, true) })
            : t('projectFile.create.willCreate', { path: projectFilePathPreview(location.display, values.name, false) })}</p>}
        </div>
        <div className="pf-field">
          <Label htmlFor={`${id}-direction`} className="pf-label-with-icon">{t('projectFile.create.direction')}<span className="pf-info" title={t('projectFile.create.directionHelp')}><Icon name="info" size={13} /></span></Label>
          <div className="pf-create-direction">
            <Textarea id={`${id}-direction`} data-testid="pf-create-description" value={values.description} rows={2} maxLength={NEW_PROJECT_DESCRIPTION_MAX_LENGTH} readOnly={frozen}
              placeholder={t('projectFile.create.directionPlaceholder')} onChange={event => change({ description: event.target.value })} />
            <span className="pf-create-count" aria-hidden="true">{t('projectFile.create.directionCount', { length: values.description.length, limit: NEW_PROJECT_DESCRIPTION_MAX_LENGTH })}</span>
          </div>
        </div>
        <fieldset className="pf-create-presets" disabled={frozen}>
          <legend>{t('redesign.projects.format')}</legend>
          <div className="pf-create-preset-cards">{TIMELINE_CURRENT_OUTPUT_PRESETS.map(preset => {
            const selected = values.presetId === preset.id;
            return <label key={preset.id} data-selected={selected || undefined} data-testid={`pf-create-preset-${preset.id}`}>
              <input type="radio" name={`${id}-preset`} value={preset.id} checked={selected} onChange={() => change({ presetId: preset.id })} />
              {selected && <Check className="pf-create-preset-check" size={14} aria-hidden="true" />}
              <span className="pf-format-symbol" data-shape={preset.width > preset.height ? 'landscape' : preset.width < preset.height ? 'portrait' : 'square'} aria-hidden="true" />
              <span className="pf-create-preset-name">{t(`projectFile.create.preset.${preset.id}`)}</span>
              <small>{aspectLabel(preset.width, preset.height)} · {preset.width}×{preset.height}</small>
            </label>;
          })}</div>
          <p className="pf-help">{t('projectFile.create.formatHelp')}</p>
        </fieldset>
        {state.kind === 'error' && <WorkbenchAlert tone="danger" data-testid="pf-create-error">{t(state.code === 'PROJECT_FILE_EXISTS' ? 'projectFile.create.exists' : 'projectFile.create.failed')}</WorkbenchAlert>}
        {state.kind === 'unknown' && <WorkbenchAlert tone="warning" data-testid="pf-create-unknown">{t('projectFile.create.unknown')}</WorkbenchAlert>}
        {state.kind === 'created' && <WorkbenchAlert tone="warning" data-testid="pf-create-created">{t('projectFile.create.createdNotOpened', {name: state.projectName ?? values.name})}</WorkbenchAlert>}
      </form>
    </WorkbenchDialogContent>
  </Dialog>;
}
