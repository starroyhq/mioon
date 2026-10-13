import React, { useRef } from 'react';
import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';

export type HomeConnectionSlot = 'agent' | 'official' | 'custom' | 'comfy';
const slots: readonly { id: HomeConnectionSlot; label: string }[] = [
  { id: 'agent', label: 'Agent' }, { id: 'official', label: 'OpenAI 图像' },
  { id: 'custom', label: '兼容图像服务' }, { id: 'comfy', label: '本机 ComfyUI' },
];

export default function ProjectHomeConnections({ selected, onSelect, panes }: {
  selected: HomeConnectionSlot;
  onSelect: (slot: HomeConnectionSlot) => void;
  panes: Readonly<Record<HomeConnectionSlot, ReactNode>>;
}) {
  const opened = useRef(new Set<HomeConnectionSlot>());
  opened.current.add(selected);
  return <section className="project-home-connections" aria-label="全局连接设置">
    <p>设置属于当前工作区，不需要先打开项目。查看设置不会发起生成；未保存的连接输入在离开前需要确认。</p>
    <Tabs value={selected} onValueChange={value => { if (slots.some(slot => slot.id === value)) onSelect(value as HomeConnectionSlot); }}>
      <TabsList aria-label="连接类型">{slots.map(slot => <TabsTrigger key={slot.id} value={slot.id}>{slot.label}</TabsTrigger>)}</TabsList>
    </Tabs>
    {slots.filter(slot => opened.current.has(slot.id)).map(slot => <React.Fragment key={slot.id}>{panes[slot.id]}</React.Fragment>)}
  </section>;
}
