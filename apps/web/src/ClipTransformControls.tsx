import React, { useId, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import type { ClipTransform } from '@mioon/contracts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { keyframeAt, savedClipTransform, transformFields, transformIssue, withKeyframe, withoutKeyframe, type TransformClip, type TransformFields } from './clip-transform-state.ts';

const number = (value: number): string => String(Number(value.toFixed(2)));

/** Position and scale keyframes at the playhead's clip frame. Each button is
 * one saved timeline edit, not a draft change, so it waits for a clean draft.
 * The parent remounts it when the frame or the saved transform changes. */
export default function ClipTransformControls({ clip, frame, disabled, disabledReason, onSetTransform }: {
  clip: TransformClip; frame: number; disabled: boolean; disabledReason?: string; onSetTransform?: (transform: ClipTransform | null) => unknown;
}) {
  const { t } = useI18n();
  const id = useId();
  const [fields, setFields] = useState<TransformFields>(() => transformFields(clip, frame));
  const saved = savedClipTransform(clip), atKeyframe = Boolean(keyframeAt(clip, frame)), issue = transformIssue(clip, frame, fields);
  const apply = (next: ClipTransform | null) => { if (!disabled) void onSetTransform?.(next); };
  const field = (key: keyof TransformFields, label: string) => <div key={key}>
    <Label className="field-label" htmlFor={`${id}-${key}`}>{label}</Label>
    <Input id={`${id}-${key}`} data-testid={`clip-transform-${key}`} type="number" step={key === 'scale' ? '1' : '2'} required value={fields[key]} disabled={disabled}
      onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} />
  </div>;
  return <fieldset className="clip-transform" data-testid="clip-transform" aria-describedby={`${id}-hint`}>
    <legend>{t('clip.transform.title')}</legend>
    <p className="input-hint" data-testid="clip-transform-frame">{t('clip.transform.frame', { frame })} · {t(atKeyframe ? 'clip.transform.atKeyframe' : saved ? 'clip.transform.derived' : 'clip.transform.none')}</p>
    <div className="rect-grid clip-transform-grid">{field('x', t('clip.transform.x'))}{field('y', t('clip.transform.y'))}{field('scale', t('clip.transform.scale'))}</div>
    {issue && <p className="notice warning" role="alert" data-testid="clip-transform-issue">{t(issue)}</p>}
    <div className="clip-transform-actions">
      <Button type="button" variant="outline" size="sm" data-testid="clip-transform-set" disabled={disabled || Boolean(issue) || !onSetTransform}
        onClick={() => { const next = withKeyframe(clip, frame, fields); if (next) apply(next); }}>{t('clip.transform.setKeyframe')}</Button>
      <Button type="button" variant="outline" size="sm" data-testid="clip-transform-remove" disabled={disabled || !atKeyframe || !onSetTransform}
        onClick={() => apply(withoutKeyframe(clip, frame))}>{t('clip.transform.removeKeyframe')}</Button>
      <Button type="button" variant="ghost" size="sm" data-testid="clip-transform-clear" disabled={disabled || !saved || !onSetTransform}
        onClick={() => apply(null)}>{t('clip.transform.reset')}</Button>
    </div>
    {saved && <ol className="clip-transform-keyframes" data-testid="clip-transform-keyframes">{saved.keyframes.map(point =>
      <li key={point.frame} aria-current={point.frame === frame ? 'true' : undefined}>{t('clip.transform.keyframe', { frame: point.frame, x: number(point.x), y: number(point.y), scale: number(point.scale * 100) })}</li>)}</ol>}
    {saved && (saved.rotation !== 0 || Object.values(saved.crop).some(edge => edge !== 0)) && <p className="input-hint" data-testid="clip-transform-static">{t('clip.transform.static', {
      rotation: number(saved.rotation), left: number(saved.crop.left * 100), top: number(saved.crop.top * 100), right: number(saved.crop.right * 100), bottom: number(saved.crop.bottom * 100) })}</p>}
    {disabledReason && <p className="input-hint" role="status" data-testid="clip-transform-disabled">{disabledReason}</p>}
    <p id={`${id}-hint`} className="input-hint">{t('clip.transform.hint')}</p>
  </fieldset>;
}
