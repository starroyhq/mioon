import React from 'react';
import { Label } from '@mioon/ui/components/label';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { ComponentType, ReactNode } from 'react';
import { AUDIO_ROLES, isClipAudioRole } from '../../../packages/contracts/src/timeline-audio-role.ts';
import type { ClipAudioRole } from '../../../packages/contracts/src/timeline-audio-role.ts';

type SelectProps = { id: string; 'data-testid': string; 'aria-describedby': string; value: string; disabled: boolean; children: ReactNode; onChange: (event: { target: { value: string } }) => void };
interface Props {
  Select: ComponentType<SelectProps>; kind: string; value?: ClipAudioRole; editable: boolean; blocked: boolean;
  onEdit: (value: ClipAudioRole) => void;
}
/** Editorial metadata, deliberately independent of gain/mute/audio evidence. */
export default function ClipAudioRoleControls({ kind, value, editable, blocked, onEdit, Select }: Props) {
  const { t } = useI18n();
  if (kind !== 'audio' && kind !== 'video') return null;
  const disabled = !editable || blocked;
  return <div className="clip-audio-role" data-testid="clip-audio-role-control">
    <Label className="field-label" htmlFor="clip-audio-role">{t('audio.role.label')}</Label>
    <Select id="clip-audio-role" data-testid="clip-audio-role" value={value ?? ''} disabled={disabled}
      aria-describedby="clip-audio-role-hint" onChange={(event: { target: { value: string } }) => {
        const next = event.target.value === '' ? null : event.target.value;
        if (!disabled && isClipAudioRole(next)) onEdit(next);
      }}>
      <option value="">{t('audio.role.unclassified')}</option>
      {AUDIO_ROLES.map(role => <option key={role} value={role}>{t(`audio.role.${role}`)}</option>)}
    </Select>
    <p className="input-hint" id="clip-audio-role-hint">{t(editable ? 'audio.role.hint' : 'audio.role.unavailable')}</p>
  </div>;
}
