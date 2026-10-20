import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import { AGENT_TASK_TIERS } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskPolicy, AgentTaskMode, AgentTaskTier } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createAgentTaskClient, agentTaskDefinitiveFailure } from './agent-tasks-v2.ts';

const policyReceiptKey='mioon.agent-task-v2.policy-pending';
function readPolicyReceipt():string|null {try{return sessionStorage.getItem(policyReceiptKey);}catch{return null;}}
function writePolicyReceipt(value:string|null):void{if(value)sessionStorage.setItem(policyReceiptKey,value);else sessionStorage.removeItem(policyReceiptKey);}
export interface AgentTaskPolicyNavigation {dirty: boolean; busy: boolean; unknown: boolean}
export default function AgentTaskPolicy({ visible = true, onNavigationChange = () => {} }: { visible?: boolean; onNavigationChange?: (state: AgentTaskPolicyNavigation) => void }) {
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
  return <section className="agent-settings-section" data-testid="agent-task-policy" aria-busy={busy}><div className="agent-settings-section-title"><h3>{t('agent.task.policyTitle')}</h3><Button variant="ghost" type="button" disabled={!visible || busy} onClick={() => { void load(); }}>{t('agent.task.reload')}</Button></div><p className="agent-settings-help">{t('agent.task.policyHelp')}</p>{draft && <><div className="agent-settings-grid">{AGENT_TASK_TIERS.map(tier => <div key={tier} className="agent-settings-field"><Label htmlFor={`agent-policy-${tier}`}>{t(`agent.task.tier.${tier}`)}</Label><WorkbenchSelect id={`agent-policy-${tier}`} data-testid={`agent-policy-${tier}`} disabled={!visible || readOnly || busy || notice === 'unknown'} value={draft.modes[tier]} onChange={event => { void mode(tier, event.target.value as AgentTaskMode); }}><option value="direct">{t('agent.task.direct')}</option><option value="confirm">{t('agent.task.confirm')}</option></WorkbenchSelect></div>)}<div className="agent-settings-field"><Label htmlFor="agent-policy-steps">{t('agent.task.stepLimit')}</Label><Input id="agent-policy-steps" data-testid="agent-policy-steps" type="number" min={1} max={Number.MAX_SAFE_INTEGER} value={draft.stepLimit} disabled={!visible || readOnly || busy || notice === 'unknown'} onChange={event => { const value = Number(event.target.value); if (!visibility.current || readOnly || busy || pending.current) return; if (Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER) { serial.current++; report.current({dirty:true,busy:false,unknown:false}); setDraft({ ...draft, stepLimit: value }); } }} /></div></div>{draft.modes.paid === 'direct' && <p className="notice warning" data-testid="agent-policy-fee-warning">{t('agent.task.feeWarning')}</p>}<Button type="button" data-testid="agent-policy-save" disabled={!visible || readOnly || busy || notice === 'unknown' || JSON.stringify(saved) === JSON.stringify(draft)} onClick={() => { void save(); }}>{t('agent.task.savePolicy')}</Button></>}{notice && <p role={notice === 'saved' ? 'status' : 'alert'}>{t(notice === 'saved' ? 'agent.task.policySaved' : notice === 'unknown' ? 'agent.task.unknown' : 'agent.task.error')}</p>}</section>;
}
