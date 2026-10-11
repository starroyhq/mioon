import React from 'react';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { selectedExportDelivery } from './export-settings-state.js';
import './export-settings.css';

export default function TimelineExportSettings({ timeline, value, disabled, onChange }) {
  const delivery = selectedExportDelivery(timeline, value);
  if (!value) return null;
  const choose = patch => onChange({ ...value, ...patch });
  return <section className="timeline-export-settings" data-testid="timeline-export-settings" aria-labelledby="timeline-export-settings-title">
    <h3 id="timeline-export-settings-title">本次成片设置</h3>
    <p className="export-preflight-note">MP4 · H.264。仅用于本次导出，不更改时间线或编辑预览；重新打开项目后恢复默认。</p>
    <div className="export-settings-field"><Label htmlFor="export-resolution">成片分辨率</Label>
      <WorkbenchSelect id="export-resolution" data-testid="export-resolution" value={value.resolution} disabled={disabled} onChange={event => choose({ resolution: event.target.value })}>
        <option value="native">原始合成尺寸</option><option value="short_360">短边 360 · 保持比例</option><option value="short_1080">短边 1080 · 放大</option>
      </WorkbenchSelect></div>
    <div className="export-settings-field"><Label htmlFor="export-rate-mode">视频码率控制</Label>
      <WorkbenchSelect id="export-rate-mode" data-testid="export-rate-mode" value={value.rateControl.mode} disabled={disabled} onChange={event => choose({ rateControl: event.target.value === 'crf' ? { mode: 'crf', quality: 'standard' } : { mode: 'bitrate', targetKbps: 4000 } })}>
        <option value="crf">按画质 · CRF</option><option value="bitrate">平均目标码率</option>
      </WorkbenchSelect></div>
    {value.rateControl.mode === 'crf' ? <div className="export-settings-field"><Label htmlFor="export-quality">画质</Label>
      <WorkbenchSelect id="export-quality" data-testid="export-quality" value={value.rateControl.quality} disabled={disabled} onChange={event => choose({ rateControl: { mode: 'crf', quality: event.target.value } })}>
        <option value="compact">紧凑 · CRF 28</option><option value="standard">标准 · CRF 23</option><option value="high">高画质 · CRF 18</option>
      </WorkbenchSelect></div> : <div className="export-settings-field"><Label htmlFor="export-bitrate">视频平均目标</Label>
      <WorkbenchSelect id="export-bitrate" data-testid="export-bitrate" value={value.rateControl.targetKbps} disabled={disabled} onChange={event => choose({ rateControl: { mode: 'bitrate', targetKbps: Number(event.target.value) } })}>
        <option value="2000">2 Mb/s</option><option value="4000">4 Mb/s</option><option value="8000">8 Mb/s</option>
      </WorkbenchSelect></div>}
    {delivery && <dl className="export-preflight-summary" data-testid="export-settings-summary">
      <div><dt>编辑合成</dt><dd>{timeline.width} × {timeline.height}</dd></div>
      <div><dt>本次成片</dt><dd data-testid="export-output-dimensions">{delivery.dimensions}</dd></div>
      <div><dt>视频</dt><dd>{delivery.rate}</dd></div>
      <div><dt>固定规格</dt><dd>30 fps · AAC 128 kb/s</dd></div>
    </dl>}
    {delivery?.upscale && <p className="notice warning" data-testid="export-upscale-warning">1080 短边会放大当前 720 短边合成，不增加原始画面细节。字幕随整幅画面缩放。</p>}
    <p className="export-preflight-note" data-testid="export-rate-explanation">{value.rateControl.mode === 'bitrate' ? '单遍编码的平均视频码率目标，不是严格带宽上限，也不保证文件大小。' : 'CRF 按画质编码，实际码率和文件大小随画面内容变化。'}</p>
    <p className="export-preflight-note">编辑预览始终使用原始合成尺寸与默认画质。检查或改选设置不会自动导出。</p>
  </section>;
}
