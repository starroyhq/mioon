import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { clipReplacementBlockedReason, clipReplacementBlockedMessage, clipReplacementCandidates, clipReplacementReviewIssue, clipReplacementReviewMessage, clipSelectedVersionCandidate, createClipReplacementController } from './clip-source-replacement.ts';

export default function ClipSourceReplacement({ context, getDirty, onReplace, onOpenRequests }) {
  const { t, renderMessage, formatNumber } = useI18n();
  const durationLabel = asset => asset.mimeType?.startsWith('image/') ? t('timeline.replace.still') : Number.isFinite(asset.duration) ? t('timeline.replace.duration', { seconds: formatNumber(asset.duration, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) }) : t('timeline.replace.unknownDuration');
  const candidateLabel = candidate => candidate.version ? `${candidate.source.name || candidate.assetId} · ${candidate.version.shotTitle} · V${candidate.version.number}` : t('timeline.replace.assetChoice', { name: candidate.source.name || candidate.assetId });
  const visible = useWorkspaceVisibility();
  const callbacks = useRef(null);
  callbacks.current = { context: { ...context, visible: visible && context.visible !== false }, getDirty, onReplace };
  const getContext = () => ({ ...callbacks.current.context, dirty: callbacks.current.getDirty() });
  const [state, setState] = useState(null), controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createClipReplacementController({
    getContext, submit: review => callbacks.current.onReplace(review), onChange: setState,
  });
  const controller = controllerRef.current;
  useLayoutEffect(() => { controller.activate(); controller.setContext(getContext()); return () => controller.dispose(); }, []);
  useLayoutEffect(() => { controller.setContext(getContext()); }, [context, visible]);
  const current = getContext(), blocked = clipReplacementBlockedReason(current);
  const phase = state?.phase || 'idle', review = state?.review;
  const candidates = clipReplacementCandidates(current);
  const suggested = phase === 'idle' && !blocked ? clipSelectedVersionCandidate(current) : null;
  const issue = phase === 'stale' ? state.error : review && phase === 'review' ? clipReplacementReviewIssue(review, current) : '';
  const sending = phase === 'sending';
  const selected = candidates.some(candidate => candidate.key === state?.selectedKey);
  return <section className="clip-source-replacement" aria-labelledby="clip-replacement-title" data-testid="clip-source-replacement" data-phase={phase} aria-busy={sending}>
    <h3 id="clip-replacement-title">{t('timeline.replace.title')}</h3>
    <p className="clip-replacement-note">{t('timeline.replace.scope')}</p>
    {blocked && <p id="clip-replacement-blocked" className="clip-replacement-warning" role="status">{renderMessage(clipReplacementBlockedMessage(current))}</p>}
    {suggested && <Button size="sm" type="button" data-testid="review-selected-version-replacement" onClick={() => { if (controller.begin() && controller.choose(suggested.key)) controller.review(); }}>{t('timeline.replace.suggested', { version: suggested.version.number })}</Button>}
    {phase === 'idle' && <Button variant="outline" size="sm" type="button" data-testid="begin-clip-replacement" disabled={Boolean(blocked)} aria-describedby={blocked ? 'clip-replacement-blocked' : undefined} onClick={() => controller.begin(state)}>{t('timeline.replace.choose')}</Button>}
    {phase === 'choosing' && <>
      <Label className="field-label" htmlFor="clip-replacement-candidate">{t('timeline.replace.candidates')}</Label>
      <WorkbenchSelect id="clip-replacement-candidate" data-testid="clip-replacement-candidate" value={state.selectedKey} disabled={Boolean(blocked) || !candidates.length} aria-describedby="clip-replacement-candidate-help" onChange={event => controller.choose(event.target.value, state)}>
        <option value="" disabled>{t('timeline.replace.select')}</option>
        {candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidateLabel(candidate)} · {durationLabel(candidate.source)}</option>)}
      </WorkbenchSelect>
      <p id="clip-replacement-candidate-help" className="clip-replacement-note">{candidates.length ? t('timeline.replace.candidatesHint') : t('timeline.replace.noCandidates')}</p>
      <div className="clip-replacement-actions"><Button size="sm" type="button" data-testid="review-clip-replacement" disabled={Boolean(blocked) || !selected} onClick={() => controller.review(state)}>{t('timeline.replace.review')}</Button><Button variant="ghost" size="sm" type="button" data-testid="cancel-clip-replacement" onClick={() => controller.cancel(state)}>{t('timeline.replace.cancel')}</Button></div>
    </>}
    {review && <div className="clip-replacement-review" data-testid="clip-replacement-review">
      <h4>{t('timeline.replace.revision', { revision: review.expectedRevision })}</h4>
      <dl>
        <div><dt>{t('timeline.replace.target')}</dt><dd>{review.clip.name || review.clip.id}</dd></div>
        <div><dt>{t('timeline.replace.previous')}</dt><dd>{review.previous.name || review.previous.id}<small>{durationLabel(review.previous)}</small></dd></div>
        <div><dt>{t('timeline.replace.replacement')}</dt><dd>{review.candidate.source.name || review.candidate.assetId}<small>{durationLabel(review.candidate.source)}</small><small>{review.candidate.version ? `${review.candidate.version.shotTitle} · V${review.candidate.version.number}` : t('timeline.replace.assetOnly')}</small></dd></div>
        <div><dt>{t('timeline.replace.keepIn')}</dt><dd>{t('timeline.replace.frames', { frames: review.clip.sourceInFrame })}</dd></div>
        <div><dt>{t('timeline.replace.keepDuration')}</dt><dd>{t('timeline.replace.durationFrames', { frames: review.clip.durationFrames, seconds: formatNumber(review.clip.durationFrames / 30, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) })}</dd></div>
        <div><dt>{t('timeline.replace.keepPosition')}</dt><dd>{t('timeline.replace.position', { start: review.clip.startFrame, end: review.clip.startFrame + review.clip.durationFrames })}</dd></div>
      </dl>
      {review.clip.colour && <p className="clip-replacement-warning" data-testid="clip-replacement-colour-warning">{t('timeline.replace.colourWarning')}</p>}
      <p className="clip-replacement-note">{t('timeline.replace.preserveHint')}</p>
    </div>}
    {issue && <p className="clip-replacement-warning" id="clip-replacement-review-issue" role="alert">{renderMessage(phase === 'stale' ? state.errorMessage : clipReplacementReviewMessage(review, current))}</p>}
    {phase === 'review' && <div className="clip-replacement-actions"><Button size="sm" type="button" data-testid="approve-clip-replacement" disabled={Boolean(issue || blocked)} aria-describedby={issue ? 'clip-replacement-review-issue' : blocked ? 'clip-replacement-blocked' : undefined} onClick={() => controller.approve(review)}>{t('timeline.replace.approve')}</Button><Button variant="ghost" size="sm" type="button" data-testid="cancel-clip-replacement" onClick={() => controller.cancel(state)}>{t('timeline.replace.cancel')}</Button></div>}
    {sending && <p className="clip-replacement-note" role="status">{t('timeline.replace.sending')}</p>}
    {phase === 'applied' && <p className="clip-replacement-success" role="status">{t('timeline.replace.applied')}</p>}
    {['error', 'unknown'].includes(phase) && <p className="clip-replacement-warning" role="alert">{state.errorMessage ? renderMessage(state.errorMessage) : t(phase === 'unknown' ? 'timeline.replace.error.unknown' : 'timeline.replace.error.failed')}</p>}
    {phase === 'unknown' && <><p className="clip-replacement-note">{t('timeline.replace.sessionRecovery')}</p><Button variant="outline" size="sm" type="button" data-testid="recover-clip-replacement" onClick={onOpenRequests}>{t('timeline.replace.recover')}</Button></>}
    {['stale', 'error'].includes(phase) && <div className="clip-replacement-actions"><Button variant="outline" size="sm" type="button" data-testid="restart-clip-replacement" disabled={Boolean(blocked)} onClick={() => controller.begin(state)}>{t('timeline.replace.restart')}</Button><Button variant="ghost" size="sm" type="button" onClick={() => controller.cancel(state)}>{t('timeline.replace.cancel')}</Button></div>}
    {(phase === 'applied' || (phase === 'unknown' && !current.pending && !current.busy)) && <Button variant="ghost" size="sm" type="button" data-testid="close-clip-replacement" onClick={() => controller.cancel(state)}>{t('timeline.replace.close')}</Button>}
  </section>;
}
