import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { selectedExportDelivery } from './export-settings-state.js';
import './export-settings.css';
import TimelineExportProfile from './TimelineExportProfile.tsx';

export default function TimelineExportSettings({ timeline, value, disabled, onChange }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const delivery = selectedExportDelivery(timeline, value);
  if (!value) return null;
  const choose = patch => onChange({ ...value, ...patch });
  return <section className="timeline-export-settings" data-testid="timeline-export-settings" aria-labelledby="timeline-export-settings-title">
    <h3 id="timeline-export-settings-title">{t('export.settings.title')}</h3>
    <p className="export-preflight-note">{t('export.settings.scope')}</p>
    <div className="export-settings-field"><Label htmlFor="export-resolution">{t('export.settings.resolution')}</Label>
      <WorkbenchSelect id="export-resolution" data-testid="export-resolution" value={value.resolution} disabled={disabled} onChange={event => choose({ resolution: event.target.value })}>
        <option value="native">{t('export.settings.native')}</option><option value="short_360">{t('export.settings.short360')}</option><option value="short_1080">{t('export.settings.short1080')}</option>
      </WorkbenchSelect></div>
    <div className="export-settings-field"><Label htmlFor="export-rate-mode">{t('export.settings.rateControl')}</Label>
      <WorkbenchSelect id="export-rate-mode" data-testid="export-rate-mode" value={value.rateControl.mode} disabled={disabled} onChange={event => choose({ rateControl: event.target.value === 'crf' ? { mode: 'crf', quality: 'standard' } : { mode: 'bitrate', targetKbps: 4000 } })}>
        <option value="crf">{t('export.settings.crf')}</option><option value="bitrate">{t('export.settings.bitrate')}</option>
      </WorkbenchSelect></div>
    {value.rateControl.mode === 'crf' ? <div className="export-settings-field"><Label htmlFor="export-quality">{t('export.settings.quality')}</Label>
      <WorkbenchSelect id="export-quality" data-testid="export-quality" value={value.rateControl.quality} disabled={disabled} onChange={event => choose({ rateControl: { mode: 'crf', quality: event.target.value } })}>
        <option value="compact">{t('export.settings.compact')}</option><option value="standard">{t('export.settings.standard')}</option><option value="high">{t('export.settings.high')}</option>
      </WorkbenchSelect></div> : <div className="export-settings-field"><Label htmlFor="export-bitrate">{t('export.settings.videoTarget')}</Label>
      <WorkbenchSelect id="export-bitrate" data-testid="export-bitrate" value={value.rateControl.targetKbps} disabled={disabled} onChange={event => choose({ rateControl: { mode: 'bitrate', targetKbps: Number(event.target.value) } })}>
        <option value="2000">2 Mb/s</option><option value="4000">4 Mb/s</option><option value="8000">8 Mb/s</option>
      </WorkbenchSelect></div>}
    <TimelineExportProfile value={value} disabled={disabled} onChange={onChange} Select={WorkbenchSelect} />
    {delivery && <dl className="export-preflight-summary" data-testid="export-settings-summary">
      <div><dt>{t('export.settings.composition')}</dt><dd>{timeline.width} × {timeline.height}</dd></div>
      <div><dt>{t('export.settings.output')}</dt><dd data-testid="export-output-dimensions">{delivery.dimensions}</dd></div>
      <div><dt>{t('export.settings.video')}</dt><dd>{renderMessage(delivery.rateMessage)}</dd></div>
      <div><dt>{t('export.settings.fixed')}</dt><dd>30 fps · AAC 128 kb/s</dd></div>
    </dl>}
    {delivery?.upscale && <p className="notice warning" data-testid="export-upscale-warning">{t('export.settings.upscaleHelp')}</p>}
    <p className="export-preflight-note" data-testid="export-rate-explanation">{value.rateControl.mode === 'bitrate' ? t('export.settings.bitrateHelp') : t('export.settings.crfHelp')}</p>
    <p className="export-preflight-note">{t('export.settings.previewHelp')}</p>
  </section>;
}
