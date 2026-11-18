import React from 'react';
import './edit-ui.css';
import {Button} from '@mioon/ui/components/button';
import Icon from '../icons.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {WorkbenchSelect} from '../WorkspaceControls.tsx';
import {editUiVersionChoice, editUiVersionLabel} from './status.tsx';
import type {EditUiInspectorSequence} from './status.tsx';

/** Properties-panel block above the clip groups: shot identity, board reveal and
 * the follow/locked version mode. Controls only report through the passed
 * callbacks; this component never writes project data. */
export default function ShotVersionBar({sequence}: {readonly sequence: EditUiInspectorSequence}): React.ReactElement {
  const {t} = useI18n();
  const locked = sequence.versionMode === 'locked';
  const choose = (mode: 'follow' | 'locked'): void => {
    sequence.onVersionChoice?.(editUiVersionChoice(sequence, mode));
  };
  return <section className="edit-ui-shot-bar" data-testid="edit-ui-shot-bar" data-version-mode={sequence.versionMode}>
    <div className="edit-ui-shot-heading">
      <Icon name="film" size={13} />
      <strong className="edit-ui-shot-name" data-testid="edit-ui-shot-name">{t('editUi.shot.title', {number: sequence.shotNumber, name: sequence.shotName})}</strong>
      {sequence.onRevealShot && <Button type="button" variant="outline" size="sm" className="edit-ui-shot-reveal" data-testid="edit-ui-shot-reveal"
        onClick={() => sequence.onRevealShot?.()}>{t('editUi.shot.reveal')}</Button>}
    </div>
    <div className="edit-ui-version-row">
      <span className="edit-ui-version-label">{t('editUi.version.label')}</span>
      <WorkbenchSelect className="edit-ui-version-select" data-testid="edit-ui-version-select" value={sequence.versionMode}
        disabled={!sequence.onVersionChoice} onChange={event => choose(event.target.value === 'locked' ? 'locked' : 'follow')}>
        <option value="follow">{editUiVersionLabel(t, 'follow', sequence)}</option>
        <option value="locked">{editUiVersionLabel(t, 'locked', sequence)}</option>
      </WorkbenchSelect>
      <Button type="button" variant="ghost" size="icon-sm" className="edit-ui-version-lock" data-testid="edit-ui-version-lock"
        aria-pressed={locked} aria-label={t(locked ? 'editUi.version.unlock' : 'editUi.version.lock')} disabled={!sequence.onVersionChoice}
        onClick={() => choose(locked ? 'follow' : 'locked')}><Icon name={locked ? 'lock' : 'unlock'} size={14} /></Button>
    </div>
  </section>;
}
