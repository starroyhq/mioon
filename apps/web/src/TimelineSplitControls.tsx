import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';

interface TimelineSplitState {
  clipSelected?: boolean; clipName: string; canSplit?: boolean; atFrame: number; leftDuration: number; rightDuration: number;
  blockedMessage?: import('../../../packages/i18n/src/index.ts').DisplayMessage | null;
}
export default function TimelineSplitControls({ state, onSplit }: {state: TimelineSplitState; onSplit: () => void}) {
  const { t, renderMessage } = useI18n();
  const blocked = renderMessage(state.blockedMessage), name = state.clipSelected === false ? t('timeline.split.unselected') : state.clipName;
  return <div className="timeline-split-controls" role="group" aria-label={t('timeline.split.group')}>
    <Button variant="ghost" className="button small" data-testid="timeline-split" disabled={!state.canSplit} onClick={onSplit} aria-keyshortcuts="Control+B Meta+B" aria-label={t('timeline.split.aria', { name, frame: state.atFrame })} title={blocked || t('timeline.split.hint', { left: state.leftDuration ?? 0, right: state.rightDuration ?? 0 })}><Icon name="scissors" size={13} />{t('timeline.split.action')}</Button>
    <span className="timeline-split-target" data-testid="timeline-split-target" title={blocked || t('timeline.split.target', { name, frame: state.atFrame })}><span>{name}</span><b> @ {state.atFrame}f</b></span>
  </div>;
}
