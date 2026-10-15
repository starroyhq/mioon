import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { TIMELINE_OUTPUT_PRESETS, timelineFormatCanSave, timelineFormatReasonMessage } from './timeline-format-state.js';
import './timeline-format.css';

export default function TimelineFormatPanel({ state, controller, onBack, onOpenTasks }) {
  const { t, renderMessage } = useI18n();
  const saved = state?.saved, draft = TIMELINE_OUTPUT_PRESETS.find(preset => preset.id === state?.draftPresetId);
  return <aside className="timeline-format-panel" data-testid="timeline-format-panel" aria-labelledby="timeline-format-title">
    <header><Button variant="ghost" type="button" size="sm" data-testid="timeline-format-back" onClick={onBack}>{t('subtitles.ui.back')}</Button><h2 id="timeline-format-title">{t('timeline.format.title')}</h2></header>
    <div className="timeline-format-body">
      <p>{t('timeline.format.scope')}</p>
      <p>{t('timeline.format.eligibility')}</p>
      <div role="status" aria-live="polite">{state?.submitting ? t('timeline.format.saving') : state?.dirty ? t('timeline.format.dirty') : state?.phase === 'error' ? t('timeline.format.unavailable') : saved ? saved.timelineId ? t('timeline.format.saved') : t('timeline.format.default') : t('timeline.format.checking')}</div>
      {saved && <p data-testid="timeline-format-saved">{saved.width} × {saved.height} · {saved.fps} fps · {saved.timelineId ? t('timeline.format.revision', { revision: saved.timelineRevision }) : t('timeline.format.notCreated')}</p>}
      <Label htmlFor="timeline-format-preset">{t('timeline.format.aspect')}</Label>
      <WorkbenchSelect id="timeline-format-preset" data-testid="timeline-format-preset" value={state?.draftPresetId || ''} disabled={!saved || !saved.eligible || !state?.connected} onChange={event => controller.choose(event.target.value, state?.scope ?? null)}>
        {!saved && <option value="">{t('timeline.format.waiting')}</option>}{TIMELINE_OUTPUT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{t(`timeline.format.preset.${preset.id}`)} · {preset.width} × {preset.height}</option>)}
      </WorkbenchSelect>
      {draft && <p className="input-hint">{t('timeline.format.selected', { width: draft.width, height: draft.height })}</p>}
      <dl><div><dt>{t('timeline.format.fps')}</dt><dd data-testid="timeline-format-fps">30 fps</dd></div></dl>
      {saved?.blockedReasons.length > 0 && <div className="notice warning" role="status"><p>{t('timeline.format.serverBlocks')}</p><ul>{saved.blockedReasons.map(reason => <li key={reason}>{renderMessage(timelineFormatReasonMessage(reason))}</li>)}</ul></div>}
      {state?.pending && <p className="notice warning">{t('timeline.format.pending')}</p>}
      {state?.conflict && <p className="notice warning" role="alert">{t('timeline.format.conflict')}</p>}
      {state?.error && <p className="notice error" role="alert">{renderMessage(state.errorMessage || message('timeline.format.readFailed'))}</p>}
      {(state?.pending || state?.uncertain) && <Button variant="outline" type="button" size="sm" onClick={onOpenTasks}>{t('subtitles.ui.tasks')}</Button>}
      <p className="input-hint">{t('timeline.format.retained')}</p>
    </div>
    <footer><Button type="button" data-testid="timeline-format-save" disabled={!timelineFormatCanSave(state)} onClick={() => controller.save(state?.scope ?? null)}>{t('timeline.format.save')}</Button><Button variant="outline" type="button" disabled={!state?.connected || state?.submitting} onClick={() => controller.load(state?.scope ?? null)}>{t('timeline.format.reload')}</Button>{state?.dirty && <Button variant="ghost" type="button" disabled={state?.submitting} onClick={() => controller.discardDraft(state?.scope ?? null)}>{t('timeline.format.loadSaved')}</Button>}</footer>
  </aside>;
}
