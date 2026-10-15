import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Label } from '@mioon/ui/components/label';
import { TIMELINE_EXPORT_FLOAT_PROFILE_ID } from '@mioon/contracts/timeline-export-float';
import type { TimelineExportSettings } from '@mioon/contracts/timeline-export-float';
export interface TimelineExportProfileProps {
  readonly value: TimelineExportSettings;
  readonly disabled?: boolean;
  readonly onChange: (value: TimelineExportSettings) => void;
  readonly Select: ComponentType<{ id: string; 'data-testid': string; value: string; disabled?: boolean; children: ReactNode; onChange: (event: { target: { value: string } }) => void }>;
}
export function chooseTimelineExportProfile(value: TimelineExportSettings, profileId: string): TimelineExportSettings | null {
  return profileId === 'mp4_h264_v1' || profileId === TIMELINE_EXPORT_FLOAT_PROFILE_ID ? { ...value, profileId } : null;
}
/** Reuses the dock's visibility-fenced select. Omitted/old settings are never
 * upgraded, and a loudness application has no connection to this selection. */
export default function TimelineExportProfile({ value, disabled, onChange, Select }: TimelineExportProfileProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <div className="export-settings-field">
    <Label htmlFor="export-audio-profile">{t('export.settings.profile')}</Label>
    <Select id="export-audio-profile" data-testid="export-audio-profile" value={value.profileId} disabled={disabled}
      onChange={event => { const next = chooseTimelineExportProfile(value, event.target.value); if (!disabled && next) onChange(next); }}>
      <option value="mp4_h264_v1">{t('export.settings.v1')}</option>
      <option value={TIMELINE_EXPORT_FLOAT_PROFILE_ID}>{t('export.settings.v2')}</option>
    </Select>
    <p className="export-preflight-note" data-testid="export-audio-profile-help">{value.profileId === TIMELINE_EXPORT_FLOAT_PROFILE_ID ?
      t('export.settings.v2Help') :
      t('export.settings.v1Help')}</p>
  </div>;
}
