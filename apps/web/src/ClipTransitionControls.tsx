import React, { useId, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { CLIP_TRANSITION_KINDS, type ClipTransition, type ClipTransitionKind } from '@mioon/contracts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { nextTransition, savedTransition, transitionChanged, transitionFields, transitionIssue, type TransitionContext, type TransitionFields } from './clip-transition-state.ts';
import './clip-transition.css';

/** The transition at the cut where this clip starts. Each button is one saved
 * timeline edit, not a draft change, so it waits for a clean draft. The parent
 * remounts it when the saved transition or the room at the cut changes. */
export default function ClipTransitionControls({ clip, context, disabled, disabledReason, onSetTransition }: {
  clip: { readonly transitionIn?: unknown }; context: TransitionContext; disabled: boolean; disabledReason?: string; onSetTransition?: (transition: ClipTransition | null) => unknown;
}) {
  const { t } = useI18n();
  const id = useId();
  const [fields, setFields] = useState<TransitionFields>(() => transitionFields(clip, context));
  const saved = savedTransition(clip), issue = transitionIssue(fields, context);
  const apply = (next: ClipTransition | null) => { if (!disabled) void onSetTransition?.(next); };
  const kindLabel = (kind: ClipTransitionKind) => t(`clip.transition.kind.${kind}`);
  return <fieldset className="clip-transition" data-testid="clip-transition" aria-describedby={`${id}-hint`}>
    <legend>{t('clip.transition.title')}</legend>
    <p className="input-hint" data-testid="clip-transition-status">{saved ? t('clip.transition.current', { kind: kindLabel(saved.kind), frames: saved.durationFrames }) : null}
      {saved && context.hasCut && context.maxFrames >= 2 ? ' · ' : null}{context.hasCut && context.maxFrames >= 2 ? t('clip.transition.room', { frames: context.maxFrames }) : null}</p>
    <div className="rect-grid clip-transition-grid">
      <div>
        <Label className="field-label" htmlFor={`${id}-kind`}>{t('clip.transition.kind')}</Label>
        <WorkbenchSelect id={`${id}-kind`} data-testid="clip-transition-kind" value={fields.kind} disabled={disabled || !context.hasCut}
          onChange={event => setFields(current => ({ ...current, kind: event.target.value as ClipTransitionKind }))}>
          {CLIP_TRANSITION_KINDS.map(kind => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
        </WorkbenchSelect>
      </div>
      <div>
        <Label className="field-label" htmlFor={`${id}-frames`}>{t('clip.transition.frames')}</Label>
        <Input id={`${id}-frames`} data-testid="clip-transition-frames" type="number" step="1" required value={fields.frames} disabled={disabled || !context.hasCut}
          onChange={event => setFields(current => ({ ...current, frames: event.target.value }))} />
      </div>
    </div>
    {issue && <p className={issue === 'clip.transition.invalid' ? 'notice warning' : 'input-hint'} role={issue === 'clip.transition.invalid' ? 'alert' : undefined} data-testid="clip-transition-issue">
      {issue === 'clip.transition.invalid' ? t(issue, { frames: context.maxFrames }) : t(issue)}</p>}
    <div className="clip-transition-actions">
      <Button type="button" variant="outline" size="sm" data-testid="clip-transition-apply" disabled={disabled || Boolean(issue) || !transitionChanged(clip, fields) || !onSetTransition}
        onClick={() => apply(nextTransition(fields))}>{t('clip.transition.apply')}</Button>
      <Button type="button" variant="ghost" size="sm" data-testid="clip-transition-remove" disabled={disabled || !saved || !onSetTransition}
        onClick={() => apply(null)}>{t('clip.transition.remove')}</Button>
    </div>
    {disabledReason && <p className="input-hint" role="status" data-testid="clip-transition-disabled">{disabledReason}</p>}
    <p id={`${id}-hint`} className="input-hint">{t('clip.transition.hint')}</p>
  </fieldset>;
}
