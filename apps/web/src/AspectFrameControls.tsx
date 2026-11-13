import React, {useId} from 'react';
import {Button} from '@mioon/ui/components/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@mioon/ui/components/dropdown-menu';
import {ChevronDown, Info, Ratio, X} from '@mioon/ui/components/workbench-icons';
import {
  TIMELINE_OUTPUT_RATIOS, timelineOutputPresetForRatio, type TimelineOutputRatio,
  type TimelineOutputShortEdge,
} from '../../../packages/contracts/src/timeline-output-geometry.ts';
import type {DisplayMessage} from '../../../packages/i18n/src/index.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import './aspect-frame.css';

export interface AspectFrameView {
  readonly ratio: TimelineOutputRatio;
  readonly shortEdge: TimelineOutputShortEdge;
  readonly disabled?: boolean;
  readonly onSelect: (ratio: TimelineOutputRatio) => void;
  readonly changed?: {
    readonly ratio: TimelineOutputRatio;
    readonly clips: number;
    readonly onUndo: () => void;
    readonly undoDisabled?: boolean;
    readonly onDismiss: () => void;
  } | null;
  readonly suggestion?: {
    readonly ratio: TimelineOutputRatio;
    readonly onChange: () => void;
    readonly onKeep: () => void;
  } | null;
  readonly error?: DisplayMessage | null;
}

type Translate = ReturnType<typeof useI18n>['t'];

export function aspectFrameFormatLabel({ratio, shortEdge}: Pick<AspectFrameView, 'ratio' | 'shortEdge'>): string | null {
  const preset = timelineOutputPresetForRatio(ratio, shortEdge);
  return preset ? `${preset.width}×${preset.height} · ${preset.fps}fps` : null;
}

function ratioName(ratio: TimelineOutputRatio, t: Translate): string {
  switch (ratio) {
    case '9:16': return t('timeline.aspectFrame.portrait', {ratio});
    case '16:9': return t('timeline.aspectFrame.landscape', {ratio});
    case '1:1': return t('timeline.aspectFrame.square', {ratio});
    default: return ratio;
  }
}

export function AspectFrameMenu({ratio, shortEdge, disabled, onSelect}: AspectFrameView) {
  const {t} = useI18n();
  const titleId = useId();
  const presets = TIMELINE_OUTPUT_RATIOS.flatMap(value => {
    const preset = timelineOutputPresetForRatio(value, shortEdge);
    return preset ? [{value, ...preset}] : [];
  });
  return <DropdownMenu>
    <DropdownMenuTrigger disabled={disabled} aria-label={`${t('timeline.aspectFrame.label')} ${ratio}`}
      data-testid="aspect-frame-trigger" render={<Button type="button" variant="ghost" size="xs" className="aspect-frame-trigger" />}>
      <Ratio className="size-3.5" aria-hidden="true" />
      <span>{ratio}</span>
      <ChevronDown className="size-3" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="aspect-frame-menu"
      data-testid="aspect-frame-menu" aria-labelledby={titleId}>
      <DropdownMenuGroup>
        <DropdownMenuLabel id={titleId} className="aspect-frame-menu-title">{t('timeline.aspectFrame.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={ratio} onValueChange={value => {
          const selected = presets.find(preset => preset.value === value);
          if (!disabled && selected && selected.value !== ratio) onSelect(selected.value);
        }}>
          {presets.map(preset => <DropdownMenuRadioItem key={preset.id} value={preset.value} closeOnClick
            disabled={disabled} className="aspect-frame-option" data-ratio={preset.value}>
            <span>{ratioName(preset.value, t)}</span>
            <span className="aspect-frame-dimensions">{preset.width}×{preset.height}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <p className="aspect-frame-menu-note">
        <Info size={12} aria-hidden="true" />
        <span>{t('timeline.aspectFrame.menuHint')}</span>
      </p>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function AspectFrameFeedback({changed, error, disabled}: AspectFrameView) {
  const {t, renderMessage} = useI18n();
  if (!changed && !error) return null;
  return <div className="aspect-frame-feedback">
    {error && <div className="aspect-frame-notice aspect-frame-error" role="alert" data-testid="aspect-frame-error">
      <Info size={16} aria-hidden="true" />
      <span>{renderMessage(error)}</span>
    </div>}
    {changed && <div className="aspect-frame-notice" data-testid="aspect-frame-changed">
      <Ratio size={16} aria-hidden="true" />
      <span role="status">{t('timeline.aspectFrame.changed', {frame: ratioName(changed.ratio, t), count: changed.clips})}</span>
      <Button type="button" variant="ghost" size="xs" className="aspect-frame-undo"
        data-testid="aspect-frame-undo" disabled={disabled || changed.undoDisabled} onClick={changed.onUndo}>
        {t('timeline.history.undo')}
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" className="aspect-frame-dismiss"
        aria-label={t('common.close')} onClick={changed.onDismiss}>
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>}
  </div>;
}

export function AspectFrameSuggestion({ratio, suggestion, disabled}: AspectFrameView) {
  const {t} = useI18n();
  if (!suggestion) return null;
  return <div className="aspect-frame-notice aspect-frame-suggestion" data-testid="aspect-frame-suggestion">
    <Ratio size={16} aria-hidden="true" />
    <span role="status">{t('timeline.aspectFrame.suggestion', {ratio: suggestion.ratio})}</span>
    <div className="aspect-frame-suggestion-actions">
      <Button type="button" size="xs" className="aspect-frame-suggestion-accept"
        data-testid="aspect-frame-suggestion-accept" disabled={disabled} onClick={suggestion.onChange}>
        {t('timeline.aspectFrame.accept', {ratio: suggestion.ratio})}
      </Button>
      <Button type="button" variant="outline" size="xs" className="aspect-frame-suggestion-keep"
        data-testid="aspect-frame-suggestion-keep" onClick={suggestion.onKeep}>
        {t('timeline.aspectFrame.keep', {ratio})}
      </Button>
    </div>
  </div>;
}

export function AspectFrameExportRatio({ratio}: {ratio: TimelineOutputRatio}) {
  const {t} = useI18n();
  return <dl className="export-settings-field aspect-frame-export" data-testid="export-aspect-frame">
    <dt>{t('timeline.aspectFrame.label')}</dt>
    <dd>
      <Ratio size={14} aria-hidden="true" />
      <span>{ratio}</span>
      <small>{t('timeline.aspectFrame.exportHint')}</small>
    </dd>
  </dl>;
}
