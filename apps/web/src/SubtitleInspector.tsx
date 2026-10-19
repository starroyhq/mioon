import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useLayoutEffect, useRef } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { subtitleCanSave, subtitleDraftMessage, createSubtitleController } from './subtitle-state.ts';
import type { SubtitleState } from './subtitle-state.ts';
type SubtitleController = ReturnType<typeof createSubtitleController>;
export interface SubtitleRenderJobView {timelineRevision: number}
import Icon from './icons.tsx';
import './subtitles.css';

export default function SubtitleInspector({ state, controller, renderJob, onBack, onOpenTasks }: {state?: SubtitleState | null; controller: SubtitleController; renderJob?: SubtitleRenderJobView | null; onBack: () => void; onOpenTasks: () => void}) {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation(), visible = useWorkspaceVisibility(), live = useRef<{mounted: boolean; visible: boolean}>({ mounted: false, visible: false });
  useLayoutEffect(() => { live.current = { mounted: true, visible }; return () => { live.current.mounted = false; }; }, [visible]);
  const admit = (action: () => unknown): unknown => { const current = controller.getState(); if (live.current.mounted && live.current.visible && state?.scope === current.scope && state?.selection === current.selection) return action(); };
  const draft = state?.draft, issue = draft ? renderMessage(subtitleDraftMessage(state)) : '', stale = renderJob && state?.timeline && renderJob.timelineRevision !== state.timeline.revision;
  return <aside className="inspector subtitle-inspector" data-testid="subtitle-inspector" aria-labelledby="subtitle-title">
    <header className="inspector-heading"><Icon name="text" /><span id="subtitle-title">{t('subtitles.ui.title')}</span><Badge className="small-badge neutral">{t('subtitles.ui.fixed')}</Badge><Button type="button" variant="ghost" size="sm" data-testid="subtitle-back" onClick={() => admit(onBack)}>{t('subtitles.ui.back')}</Button></header>
    <ScrollArea className="subtitle-scroll" style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll subtitle-form">
      <p className="input-hint">{t('subtitles.ui.limits')}</p>
      <p className="input-hint" data-testid="subtitle-render-note">{t('subtitles.ui.renderNote')}</p>
      <p className={stale ? 'notice warning' : 'input-hint'} data-testid="subtitle-render-status" role="status">{!state?.timeline ? t('subtitles.ui.checking') : stale ? t('subtitles.ui.stale', { rendered: renderJob.timelineRevision, current: state.timeline.revision }) : renderJob ? t('subtitles.ui.matching', { revision: renderJob.timelineRevision }) : t('subtitles.ui.noPreview')}</p>
      <div role="status" aria-live="polite" data-testid="subtitle-save-status">{state?.submitting ? t('subtitles.ui.saving') : state?.uncertain ? t('subtitles.ui.unconfirmed') : state?.dirty ? t('subtitles.ui.dirty') : draft ? t('subtitles.ui.saved') : t('subtitles.ui.selectHint')}</div>
      {draft && <><Label className="field-label" htmlFor="subtitle-text">{t('subtitles.ui.text')}</Label><Textarea id="subtitle-text" data-testid="subtitle-text" value={draft.text} rows={3} spellCheck={false} aria-invalid={Boolean(issue)} aria-describedby="subtitle-validation" onChange={event => admit(() => controller.edit('text', event.target.value, state))} />
        <div className="field-row">{([['startFrame', t('timeline.inspector.start'), 0], ['durationFrames', t('timeline.inspector.duration'), 1]] as ReadonlyArray<readonly ['startFrame' | 'durationFrames', string, number]>).map(([key, label, min]) => <div key={key}><Label className="field-label" htmlFor={`subtitle-${key}`}>{label}</Label><Input id={`subtitle-${key}`} data-testid={`subtitle-${key}`} type="number" aria-describedby="subtitle-validation" aria-invalid={Boolean(issue)} step="1" min={min} max={state.timeline?.durationFrames || 0} value={draft[key]} onChange={event => admit(() => controller.edit(key, event.target.value, state as SubtitleState))} /></div>)}</div>
        <p className="input-hint">{t('subtitles.ui.bounds', { frames: state.timeline?.durationFrames || 0 })}</p>
        <p id="subtitle-validation" data-testid="subtitle-validation" className={issue ? 'notice warning' : 'input-hint'} role={issue ? 'alert' : undefined}>{issue || t('subtitles.ui.characters', { counts: draft.text.split('\n').map((line: string) => [...line].length).join(' / ') })}</p>
      </>}
      {state?.conflict && <p className="notice warning" role="alert">{t('subtitles.ui.conflict')}</p>}
      {state?.error && <p className="notice warning" role="alert">{renderMessage(state.errorMessage || message('subtitles.error.unknown'))}</p>}
      {(state?.pending || state?.uncertain) && <Button type="button" variant="outline" size="sm" data-testid="subtitle-open-tasks" onClick={() => admit(onOpenTasks)}>{t('subtitles.ui.tasks')}</Button>}
      <details className="input-hint"><summary>{t('subtitles.ui.punctuation')}</summary><p>，。！？；：、（）【】《》〈〉“”‘’—…·￥％～</p><p>{t('subtitles.ui.characterSupport')}</p></details>
      <p className="input-hint">{t('subtitles.ui.retained')}</p>
    </div></ScrollArea>
    <footer className="subtitle-actions"><Button type="button" data-testid="subtitle-save" disabled={!subtitleCanSave(state ?? undefined)} onClick={() => admit(() => controller.save(state as SubtitleState))}><Icon name="check" size={14} />{t('subtitles.ui.save')}</Button><Button type="button" variant="outline" data-testid="subtitle-discard" disabled={!draft || state?.submitting} onClick={() => admit(() => controller.discardDraft(state?.scope ?? null))}>{t('timeline.inspector.discard')}</Button><Button type="button" variant="ghost" className="danger-text" data-testid="subtitle-remove" disabled={!state?.cueId || state.dirty || state.conflict || state.submitting || state.pending || Boolean(state.uncertain) || !state.connected} onClick={() => admit(async () => { const snapshot = controller.getState(); if (await confirm(message('subtitles.ui.removeConfirm')) && snapshot === controller.getState()) admit(() => controller.remove(state as SubtitleState)); })}>{t('subtitles.ui.remove')}</Button></footer>
  </aside>;
}
