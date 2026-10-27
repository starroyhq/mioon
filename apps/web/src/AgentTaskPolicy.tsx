import React, { useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Input } from '@mioon/ui/components/input';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import type { AgentTaskPolicy, AgentTaskMode, AgentTaskTier } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentTaskClient, agentTaskDefinitiveFailure } from './agent-tasks-v2.ts';

const policyReceiptKey='mioon.agent-task-v2.policy-pending';
function readPolicyReceipt():string|null {try{return sessionStorage.getItem(policyReceiptKey);}catch{return null;}}
function writePolicyReceipt(value:string|null):void{if(value)sessionStorage.setItem(policyReceiptKey,value);else sessionStorage.removeItem(policyReceiptKey);}
export interface AgentTaskPolicyNavigation {dirty: boolean; busy: boolean; unknown: boolean}
/** Lets the settings page save and discard the policy from its shared footer. */
export interface AgentTaskPolicyController {save: () => Promise<void>; discard: () => void}
const tierCopy = {
  read_only: {title: 'mio.settings.tier.read_only', hint: 'mio.settings.tier.read_only.hint'},
  local_reversible: {title: 'agent.task.tier.local_reversible', hint: 'mio.settings.tier.local_reversible.hint'},
  local_irreversible: {title: 'agent.task.tier.local_irreversible', hint: 'mio.settings.tier.local_irreversible.hint'},
  paid: {title: 'mio.settings.tier.paid', hint: 'mio.settings.tier.paid.hint'},
} as const satisfies Record<AgentTaskTier, {title: string; hint: string}>;
export default function AgentTaskPolicy({ visible = true, onNavigationChange = () => {}, controller }: { visible?: boolean; onNavigationChange?: (state: AgentTaskPolicyNavigation) => void; controller?: MutableRefObject<AgentTaskPolicyController | null> }) {
  const { t } = useI18n(), confirm = useConfirmation(), [saved, setSaved] = useState<AgentTaskPolicy | null>(null), [draft, setDraft] = useState<AgentTaskPolicy | null>(null), [busy, setBusy] = useState(false), [readOnly,setReadOnly]=useState(false), [notice, setNotice] = useState<'error' | 'saved' | 'unknown' | null>(null);
  const client = useRef(createAgentTaskClient()), serial = useRef(0), mutation = useRef(false), mounted = useRef(false), viewEpoch=useRef(0),visibility=useRef(visible),paidAcknowledged = useRef(false), pending = useRef<string|null>(readPolicyReceipt()), report = useRef(onNavigationChange); report.current=onNavigationChange;
  useLayoutEffect(() => { report.current({dirty:JSON.stringify(saved)!==JSON.stringify(draft),busy,unknown:notice==='unknown'}); }, [saved,draft,busy,notice]);
  useLayoutEffect(()=>{visibility.current=visible;viewEpoch.current++;},[visible]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  async function load() { const token = ++serial.current; setBusy(true); try { let next:AgentTaskPolicy; if(pending.current){const receipt=await client.current.lookupPolicy(pending.current);if(!receipt.found||!receipt.policy){setNotice('unknown');return;}pending.current=null;writePolicyReceipt(null);const current=await client.current.policy();next=current.policy;setReadOnly(current.readOnly);}else {const response=await client.current.policy();next=response.policy;setReadOnly(response.readOnly);} if (mounted.current && serial.current === token) { setSaved(next); setDraft(next); paidAcknowledged.current=false; setNotice(null); } } catch { if (mounted.current && serial.current === token) setNotice(pending.current?'unknown':'error'); } finally { if (mounted.current && serial.current === token) setBusy(false); } }
  useLayoutEffect(() => { if (visible && !draft) void load(); }, [visible]);
  async function mode(tier: AgentTaskTier, value: AgentTaskMode) { if (!visibility.current || readOnly || busy || !draft || mutation.current || pending.current) return; const before = draft, token = ++serial.current, view=viewEpoch.current; if (tier === 'paid' && value === 'direct' && before.modes.paid !== 'direct') {if(!await confirm(message('agent.task.feeWarning')))return;paidAcknowledged.current=true;} if (!mounted.current || token !== serial.current || view!==viewEpoch.current || !visibility.current) return; report.current({dirty:true,busy:false,unknown:false}); setDraft({ ...before, modes: { ...before.modes, [tier]: value } }); setNotice(null); }
  async function save() {
    if (!draft || !saved || readOnly || mutation.current || !visibility.current || busy || pending.current) return;
    mutation.current=true;setBusy(true);report.current({dirty:true,busy:true,unknown:false});const token=++serial.current;pending.current=crypto.randomUUID();let dispatched=false;
    try {
      writePolicyReceipt(pending.current);dispatched=true;
      const response=await client.current.savePolicy({...draft,requestId:pending.current,expectedRevision:saved.revision,...(paidAcknowledged.current&&draft.modes.paid==='direct'?{acknowledgePaid:true}:{})});
      if(mounted.current&&token===serial.current){pending.current=null;writePolicyReceipt(null);paidAcknowledged.current=false;setReadOnly(response.readOnly);setSaved(response.policy);setDraft(response.policy);setNotice('saved');}
    } catch(error) {
      if(!mounted.current||token!==serial.current)return;
      if(!dispatched){pending.current=null;setNotice('error');report.current({dirty:true,busy:false,unknown:false});}
      else if(agentTaskDefinitiveFailure(error)&&pending.current){
        try{const receipt=await client.current.lookupPolicy(pending.current);if(!mounted.current||token!==serial.current)return;const current=await client.current.policy();if(!mounted.current||token!==serial.current)return;pending.current=null;writePolicyReceipt(null);setSaved(current.policy);setReadOnly(current.readOnly);if(receipt.found){setDraft(current.policy);setNotice('saved');}else setNotice('error');}
        catch{report.current({dirty:true,busy:false,unknown:true});setNotice('unknown');}
      }else {report.current({dirty:true,busy:false,unknown:true});setNotice('unknown');}
    } finally {mutation.current=false;if(mounted.current&&token===serial.current)setBusy(false);}
  }
  function discard() { if (!visibility.current || busy || mutation.current || pending.current || !saved) return; serial.current++; paidAcknowledged.current=false; setDraft(saved); setNotice(null); }
  useLayoutEffect(() => { if (!controller) return; const own: AgentTaskPolicyController = { save, discard }; controller.current = own; return () => { if (controller.current === own) controller.current = null; }; });
  const locked = !visible || readOnly || busy || notice === 'unknown';
  // Viewing is always direct by default; only a stored exception (for example set through the CLI) is shown as a choice.
  const tiers: readonly AgentTaskTier[] = draft && (draft.modes.read_only !== 'direct' || saved?.modes.read_only !== 'direct') ? ['read_only', 'local_reversible', 'local_irreversible', 'paid'] : ['local_reversible', 'local_irreversible', 'paid'];
  return <>
    <section className="mio-settings-section" data-testid="agent-task-policy" aria-busy={busy}>
      <header className="mio-settings-section-head"><h2>{t('agent.task.policyTitle')}</h2><p>{t('mio.settings.policy.description')}</p></header>
      {draft && <div className="mio-settings-tiers">
        {tiers.map(tier => <div key={tier} className={`mio-settings-tier ${tier === 'paid' ? 'is-paid' : ''}`} data-testid={`agent-policy-row-${tier}`}>
          <div className="mio-settings-tier-main">
            <div className="mio-settings-tier-copy"><span className="mio-settings-tier-title">{t(tierCopy[tier].title)}{tier === 'paid' && <WorkbenchBadge tone="warning">{t('mio.settings.policy.paidBadge')}</WorkbenchBadge>}</span><span className="agent-settings-help">{t(tierCopy[tier].hint)}</span></div>
            <WorkbenchTabs data-testid={`agent-policy-${tier}`} value={draft.modes[tier]} label={t(tierCopy[tier].title)} onValueChange={value => { void mode(tier, value as AgentTaskMode); }}
              options={[{ value: 'direct', label: t('agent.task.direct'), disabled: locked, testId: `agent-policy-${tier}-direct` }, { value: 'confirm', label: t('agent.task.confirm'), disabled: locked, testId: `agent-policy-${tier}-confirm` }]} />
          </div>
          {tier === 'paid' && <WorkbenchAlert tone="warning" icon={<Icon name="warning" size={14} />} data-testid="agent-policy-fee-warning">{t('mio.settings.policy.paidWarning')}</WorkbenchAlert>}
        </div>)}
        {!tiers.includes('read_only') && <p className="mio-settings-locked" data-testid="agent-policy-locked"><Icon name="lock" size={12} />{t('mio.settings.policy.locked')}</p>}
      </div>}
      {notice && <div className="mio-settings-notice" role={notice === 'saved' ? 'status' : 'alert'}><span>{t(notice === 'saved' ? 'agent.task.policySaved' : notice === 'unknown' ? 'agent.task.unknown' : 'agent.task.error')}</span>{notice !== 'saved' && <WorkbenchButton type="button" variant="ghost" size="compact" data-testid="agent-policy-reload" disabled={!visible || busy} onClick={() => { void load(); }}>{t('agent.task.reload')}</WorkbenchButton>}</div>}
    </section>
    <section className="mio-settings-section mio-settings-steps" data-testid="agent-task-steps">
      <div className="mio-settings-section-head"><h2><label htmlFor="agent-policy-steps">{t('mio.settings.steps.title')}</label></h2><p>{t('mio.settings.steps.description')}</p></div>
      {draft && <div className="mio-settings-number"><Input id="agent-policy-steps" data-testid="agent-policy-steps" type="number" min={1} max={Number.MAX_SAFE_INTEGER} value={draft.stepLimit} disabled={locked} onChange={event => { const value = Number(event.target.value); if (!visibility.current || readOnly || busy || pending.current) return; if (Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER) { serial.current++; report.current({dirty:true,busy:false,unknown:false}); setDraft({ ...draft, stepLimit: value }); } }} /><span aria-hidden="true">{t('mio.settings.steps.unit')}</span></div>}
    </section>
  </>;
}
