import React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import { AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, agentRunContextMode } from './agent-tool-state.js';

const statusLabel = (step, stopped, editing) => ({
  not_started: stopped ? '未发起 · 不会自动继续' : '尚未发起',
  intent: stopped ? '已记录 · 未继续' : '已记录，等待开始',
  dispatch_started: step.kind === 'tool' ? (editing ? '正在保存提议，未应用' : '正在读取') : '请求已开始',
  completed: step.kind === 'tool' ? (editing ? '提议已保存，未自动应用' : '读取完成') : '响应结束',
  unknown: '状态未知 · 不会自动重试',
}[step.status] || '状态未知');

// All model/tool strings stay React text. Results have no links, HTML, fetches,
// navigation, or action buttons, even when their contents look like commands.
export default function AgentRunActivity({ run, visible = true }) {
  const inspected = agentRunContextMode(run) === AGENT_PROJECT_CONTEXT, editing = agentRunContextMode(run) === AGENT_EDIT_CONTEXT;
  const stopped = run.status !== 'running';
  return <div className="agent-run-inspection" data-testid="agent-run-inspection" data-context-mode={agentRunContextMode(run)}>
    {editing ? <p className="agent-run-provenance" data-testid="agent-run-provenance">本轮授权：项目 {run.provenance.projectId} 的镜头 {run.editTarget.shotId}、保存版本 {run.editTarget.expectedRevision} 的完整标题和画面描述。{run.provenance.sourceRunIds.length ? `另包含 ${run.provenance.sourceRunIds.length} 轮已完成纯聊天文字。` : ''}不包含未保存编辑；本轮文字不加入纯聊天上下文。工具只提议，不代表已应用，请查看独立审阅区的保存状态。</p> : inspected ? <Collapsible className="agent-run-provenance" data-testid="agent-run-provenance">
      <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible}>本轮授权项目资料 · 不加入纯聊天上下文</CollapsibleTrigger>
      <CollapsibleContent><p>本轮授权：项目 {run.provenance.projectId} 的已保存文字与元数据{run.provenance.sourceRunIds.length ? `，引用 ${run.provenance.sourceRunIds.length} 轮已完成对话` : ''}。这类回复不会加入后续“仅文字聊天”的上下文；授权范围不代表所有资料均已读取。</p></CollapsibleContent>
    </Collapsible> : <p className="agent-run-provenance" data-testid="agent-run-provenance">本轮上下文：仅聊天文字，不含项目读取对话。</p>}
    {run.activity?.length > 0 && <ol className="agent-run-activity" data-testid="agent-run-activity" aria-label="本轮运行活动">
      {run.activity.map(step => <li key={step.id} data-step-id={step.id} data-kind={step.kind} data-status={step.status}>
        <div className="agent-run-step-heading"><strong>{step.kind === 'model' ? `模型请求 ${step.ordinal} / 2${step.ordinal === 2 ? ' · 工具已关闭' : ''}` : step.operation}</strong><span role="status">{statusLabel(step, stopped, editing)}</span></div>
        {step.kind === 'tool' && <p className="agent-run-tool-name">{step.name} · {editing ? '仅所选镜头的修改提议，尚需明确批准' : '本轮项目范围内只读'}</p>}
        {step.resultJson !== undefined && <Collapsible className="agent-run-result">
          <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible} data-testid="agent-tool-result-toggle">{editing ? '查看已保存的提议回执' : '查看已保存的读取结果'}</CollapsibleTrigger>
          <CollapsibleContent><pre data-testid="agent-tool-result">{step.resultJson}</pre></CollapsibleContent>
        </Collapsible>}
      </li>)}
    </ol>}
  </div>;
}
