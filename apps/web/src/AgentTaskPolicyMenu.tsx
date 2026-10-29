import React, { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Dialog } from '@mioon/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@mioon/ui/components/dropdown-menu';
import { WorkbenchButton as Button, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import { AGENT_TASK_POLICY_PRESETS, agentTaskPolicyPreset } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskPolicyModes, AgentTaskPolicyPreset } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import { agentTaskPolicyMenuStep, sameAgentTaskPolicyModes } from './agent-task-policy-menu.ts';
import type { AgentTaskPolicyMenuStep } from './agent-task-policy-menu.ts';

const PRESETS = ['step', 'default', 'full'] as const satisfies readonly AgentTaskPolicyPreset[];
const ICONS = { step: 'hand', default: 'shield', full: 'bolt', custom: 'settings' } as const;

export interface AgentTaskPolicyMenuProps {
  /** The modes the selected conversation runs with; null while unknown. */
  modes: AgentTaskPolicyModes | null;
  /** The global modes a new conversation starts with. */
  global: AgentTaskPolicyModes | null;
  disabled: boolean;
  /** The composer: the menu opens above it at its full width. */
  anchor: RefObject<HTMLElement | null>;
  onChoose: (modes: AgentTaskPolicyModes) => unknown;
  onSetGlobal: (modes: AgentTaskPolicyModes) => unknown;
}

/** Composer button and menu for this conversation's confirmation modes (09-01, 09-02). */
export default function AgentTaskPolicyMenu({ modes, global, disabled, anchor, onChoose, onSetGlobal }: AgentTaskPolicyMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [confirming, setConfirming] = useState<'conversation' | 'global' | null>(null), [placement, setPlacement] = useState<{ width: number; offset: number; gap: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const preset = modes ? agentTaskPolicyPreset(modes) : null, name = (value: AgentTaskPolicyPreset | 'custom') => t(`agent.panel.policy.preset.${value}`);
  const followsGlobal = Boolean(modes && global && sameAgentTaskPolicyModes(modes, global));
  useLayoutEffect(() => {
    if (!open) return;
    const box = anchor.current?.getBoundingClientRect(), own = trigger.current?.getBoundingClientRect();
    // Open above the whole composer, 6px clear of its top edge.
    if (box && own) setPlacement({ width: Math.round(box.width), offset: Math.round(box.left - own.left), gap: Math.round(own.top - box.top) + 6 });
  }, [open]);
  function run(step: AgentTaskPolicyMenuStep) {
    setOpen(false);
    if (disabled) return;
    if (step.kind === 'confirm') setConfirming(step.scope);
    else if (step.kind === 'choose') void onChoose(step.modes);
    else if (step.kind === 'global') void onSetGlobal(step.modes);
  }
  function confirmFull() {
    const scope = confirming;
    setConfirming(null);
    if (!modes || disabled) return;
    if (scope === 'conversation') void onChoose({ ...AGENT_TASK_POLICY_PRESETS.full });
    else if (scope === 'global') void onSetGlobal({ ...modes });
  }
  const label = preset ? t('agent.panel.policy.tooltip', { name: name(preset) }) : t('agent.panel.policy.title');
  return <>
    <DropdownMenu open={open && !disabled && modes !== null} onOpenChange={value => setOpen(value)}>
      <WorkbenchTooltip content={label}>
        <DropdownMenuTrigger render={<Button ref={trigger} variant="ghost" className="mio-policy-trigger" data-preset={preset ?? 'unknown'} data-testid="agent-task-policy-trigger" aria-label={label} disabled={disabled || modes === null} />}>
          <Icon name={ICONS[preset ?? 'default']} /><span className="mio-policy-name">{preset ? name(preset) : '…'}</span><Icon name="down" className="mio-policy-chevron" />
        </DropdownMenuTrigger>
      </WorkbenchTooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={placement?.gap ?? 6} alignOffset={placement?.offset ?? 0} style={placement ? { width: placement.width } : undefined} className="mio-policy-menu" data-testid="agent-task-policy-menu">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="mio-policy-title">{t('agent.panel.policy.title')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={preset ?? ''} onValueChange={value => run(agentTaskPolicyMenuStep(modes, global, value as AgentTaskPolicyPreset))}>
            {PRESETS.map(item => <DropdownMenuRadioItem key={item} value={item} closeOnClick className="mio-policy-option" data-preset={item} data-testid={`agent-task-policy-${item}`}>
              <Icon name={ICONS[item]} /><span className="mio-policy-copy"><strong>{name(item)}</strong><span>{t(`agent.panel.policy.preset.${item}.hint`)}</span></span>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {preset === 'custom' && <p className="mio-policy-custom" data-testid="agent-task-policy-custom"><Icon name={ICONS.custom} />{t('agent.panel.policy.preset.custom.hint')}</p>}
        <div className="mio-policy-foot">
          <span>{followsGlobal || !global ? t('agent.panel.policy.same') : t('agent.panel.policy.own', { name: name(agentTaskPolicyPreset(global)) })}</span>
          {!followsGlobal && global && <DropdownMenuItem className="mio-policy-global" data-testid="agent-task-policy-global" onClick={() => run(agentTaskPolicyMenuStep(modes, global, 'global'))}>{t('agent.panel.policy.setGlobal')}</DropdownMenuItem>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={confirming !== null} onOpenChange={value => { if (!value) setConfirming(null); }}>
      <WorkbenchDialogContent size="confirm" showCloseButton={false} className="mio-policy-dialog" initialFocus={cancel} finalFocus={trigger} data-testid="agent-task-policy-dialog"
        title={<span className="mio-policy-dialog-title"><span className="mio-policy-dialog-icon"><Icon name="bolt" /></span>{t('agent.panel.policy.fullTitle')}</span>}
        description={t(confirming === 'global' ? 'agent.panel.policy.fullGlobalBody' : 'agent.panel.policy.fullBody')}
        footer={<><Button ref={cancel} variant="secondary" data-testid="agent-task-policy-cancel" onClick={() => setConfirming(null)}>{t('common.cancel')}</Button><Button className="mio-policy-full-confirm" data-testid="agent-task-policy-confirm" onClick={confirmFull}>{confirming === 'global' ? t('agent.panel.policy.setGlobal') : name('full')}</Button></>} />
    </Dialog>
  </>;
}
