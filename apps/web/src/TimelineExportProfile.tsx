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
  return <div className="export-settings-field">
    <Label htmlFor="export-audio-profile">音频混音与检查</Label>
    <Select id="export-audio-profile" data-testid="export-audio-profile" value={value.profileId} disabled={disabled}
      onChange={event => { const next = chooseTimelineExportProfile(value, event.target.value); if (!disabled && next) onChange(next); }}>
      <option value="mp4_h264_v1">默认 v1 · 原有导出方式</option>
      <option value={TIMELINE_EXPORT_FLOAT_PROFILE_ID}>浮点检查 v2 · 编码前样本峰值检查</option>
    </Select>
    <p className="export-preflight-note" data-testid="export-audio-profile-help">{value.profileId === TIMELINE_EXPORT_FLOAT_PROFILE_ID ?
      '本次明确选择浮点 v2：完整检查编码前样本峰值；超过 1 则不生成成片，不会自动降增益。仍需测量导出文件，不能保证 AAC 真峰值或输出响度。' :
      '默认 v1 保持原有导出方式；浮点候选测量不代表 v1 成片响度。应用增益不会改选导出方式。'}</p>
  </div>;
}
