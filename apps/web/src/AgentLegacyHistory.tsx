import React from 'react';
import {WorkbenchButton as Button} from '@mioon/ui/components/workbench-controls';
import {AGENT_TASK_STATUSES} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {taskOperationTitle} from './agent-task-presentation.ts';
import {useI18n} from './i18n/I18nProvider.tsx';
import {agentEditStatusDescriptor} from './agent-edits.ts';
import type {LegacyConversation} from './agent-conversations.ts';

/** V1 remains a read-only record. No approval, send or recovery callbacks. */
export default function AgentLegacyHistory({conversation,busy=false,onMore}:{conversation:LegacyConversation;busy?:boolean;onMore?:()=>void}){
  const {t,renderMessage,locale}=useI18n();
  return <section className="mio-legacy-conversation" data-testid="agent-task-legacy"><p className="mio-secondary">{t('agent.conversation.legacy')}</p>{conversation.runs.map(run=><article key={run.id}><p className="agent-chat-message is-user mio-user">{run.userText}</p><p className="agent-task-text mio-reply">{run.assistantText}</p><span className="mio-secondary">{t(AGENT_TASK_STATUSES.some(status=>status===run.status)?`agent.task.status.${AGENT_TASK_STATUSES.find(status=>status===run.status)!}`:'agent.chat.statusUnknown')}</span></article>)}{conversation.proposals.map(proposal=><article key={proposal.id}><strong>{taskOperationTitle(proposal.operation,locale)}</strong><span className="mio-secondary">{renderMessage(agentEditStatusDescriptor(proposal.status))}</span></article>)}{(conversation.chatCursor||conversation.editCursor)&&onMore&&<Button variant="ghost" disabled={busy} onClick={onMore}>{t('agent.conversation.loadMore')}</Button>}</section>;
}
