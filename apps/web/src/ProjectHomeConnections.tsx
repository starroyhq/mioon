import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useRef } from 'react';
import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';

export type HomeConnectionSlot = 'agent' | 'official' | 'custom' | 'comfy';
const slots: readonly { id: HomeConnectionSlot; label: 'shell.agentLabel' | 'shell.openaiImage' | 'shell.compatibleImage' | 'shell.localComfy' }[] = [
  { id: 'agent', label: 'shell.agentLabel' }, { id: 'official', label: 'shell.openaiImage' },
  { id: 'custom', label: 'shell.compatibleImage' }, { id: 'comfy', label: 'shell.localComfy' },
];

export default function ProjectHomeConnections({ selected, onSelect, panes }: {
  selected: HomeConnectionSlot;
  onSelect: (slot: HomeConnectionSlot) => void;
  panes: Readonly<Record<HomeConnectionSlot, ReactNode>>;
}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const opened = useRef(new Set<HomeConnectionSlot>());
  opened.current.add(selected);
  return <section className="project-home-connections" aria-label={t('shell.globalConnections')}>
    <p>{t('shell.connectionScope')}</p>
    <Tabs value={selected} onValueChange={value => { if (slots.some(slot => slot.id === value)) onSelect(value as HomeConnectionSlot); }}>
      <TabsList aria-label={t('shell.connectionType')}>{slots.map(slot => <TabsTrigger key={slot.id} value={slot.id}>{t(slot.label)}</TabsTrigger>)}</TabsList>
    </Tabs>
    {slots.filter(slot => opened.current.has(slot.id)).map(slot => <React.Fragment key={slot.id}>{panes[slot.id]}</React.Fragment>)}
  </section>;
}
