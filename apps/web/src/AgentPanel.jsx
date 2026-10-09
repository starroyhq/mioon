import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Textarea } from '@mioon/ui/components/textarea';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchTooltip } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import './agent-chat-history.css';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { AGENT_PROTOCOLS, deriveAgentEndpoint, AGENT_CHAT_PROMPT_BYTES, activeAgentChatRun, agentChatCanSend, agentChatConsentKey, agentChatErrorText,
  agentChatPromptIssue, createAgentChatSession, initialAgentChatState } from './agent-chat.js';

const runLabel = status => ({ running: '正在回复', completed: '回复结束', stopped: '已停止 · 保留部分文字', failed: '回复失败', interrupted: '回复中断' }[status] || '状态未知');
const phaseLabel = phase => ({ loading: '正在读取对话', submitting: '正在确认发送', streaming: '正在接收文字', stopping: '正在请求停止', detached: '显示连接已断开', unknown: '运行状态待确认', load_error: '读取失败', ready: '等待你的消息' }[phase] || '状态待确认');

function renderRun(run, kind = 'recent') {
  return <article className="agent-chat-turn" key={`${kind}-${run.id}`} data-run-id={run.id} data-history-kind={kind} data-status={run.status}>
          <div className="agent-chat-message is-user"><div className="agent-chat-speaker">你</div><p>{run.userText}</p></div>
          <div className="agent-chat-message is-assistant"><div className="agent-chat-speaker"><Icon name="sparkle" size={12} />Agent<span>{runLabel(run.status)}</span></div>
            <p data-testid={kind === 'recent' ? 'agent-chat-response' : 'agent-chat-history-response'}>{run.assistantText || (run.status === 'running' ? '等待第一段文字…' : '没有收到回复文字。')}</p>
            {run.status === 'interrupted' && <div className="agent-chat-run-error" role="status" data-testid="agent-chat-interrupted">已保存的回复中断，不会自动续接或重新发送；远端仍可能已计算或计费。</div>}
            {run.error && <div className="agent-chat-run-error" role="status">{agentChatErrorText(run.error.code)}</div>}
            <div className="agent-chat-run-model" data-testid="agent-chat-run-destination">{AGENT_PROTOCOLS[run.configuration.protocol].label} · {run.configuration.model} · {deriveAgentEndpoint(run.configuration)}</div>
          </div>
        </article>;
}

export default function AgentPanel({ projectId, projectName, onClose, onSettings, onDraftChange = () => {} }) {
  const [state, setState] = useState(initialAgentChatState);
  const visible = useWorkspaceVisibility();
  const interaction = useMemo(() => ({ visible }), [visible]), interactionRef = useRef(interaction), visibilityRef = useRef(visible);
  const session = useRef(null), lifetime = useRef(null), composer = useRef(null), scroll = useRef(null), archiveScroll = useRef(null), follow = useRef(true);
  useLayoutEffect(() => {
    const owner = { projectId, closed: false }; lifetime.current = owner;
    setState(initialAgentChatState()); follow.current = true;
    const current = createAgentChatSession({ projectId, onChange: next => { if (lifetime.current === owner && !owner.closed) setState(next); } });
    session.current = current;
    const page = typeof document === 'undefined' ? null : document;
    const visibilityChanged = () => current.setVisible(visibilityRef.current && page?.visibilityState !== 'hidden');
    page?.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();
    void current.load();
    return () => { page?.removeEventListener('visibilitychange', visibilityChanged); owner.closed = true; current.dispose(); if (session.current === current) session.current = null; if (lifetime.current === owner) lifetime.current = null; };
  }, [projectId]);
  useLayoutEffect(() => {
    interactionRef.current = interaction; visibilityRef.current = visible;
    session.current?.setVisible(visible && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  }, [interaction]);
  useLayoutEffect(() => { onDraftChange(Boolean(state.draft.trim()) && !state.pending); }, [state.draft, state.pending, onDraftChange]);
  useLayoutEffect(() => () => onDraftChange(false), [projectId]);
  const owner = lifetime.current;
  // Every handler belongs to this render's immutable owner, including close.
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && owner.projectId === projectId);
  const dismiss = settings => {
    if (!usable()) return;
    interactionRef.current = null; session.current?.setVisible(false);
    if (settings) onSettings(); else onClose();
  };
  const { snapshot, phase } = state;
  const running = activeAgentChatRun(state), pending = Boolean(state.pending);
  const configuration = snapshot?.settings.configuration;
  const ready = visible && phase === 'ready', canSend = visible && agentChatCanSend(state);
  const promptBytes = new TextEncoder().encode(state.draft).length;
  const promptIssue = state.draft ? agentChatPromptIssue(state.draft) : '';
  const lastRun = snapshot?.runs.at(-1);
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastRun?.assistantText, lastRun?.status, snapshot?.runs.length, state.pending]);
  useLayoutEffect(() => { if (archiveScroll.current) archiveScroll.current.scrollTop = 0; }, [state.history.before]);
  function submit(event) { event.preventDefault(); if (usable()) void session.current?.send(); }
  return <section className="agent-chat-page" data-testid="agent-chat-page" data-project-id={projectId} data-phase={phase} aria-label="Agent 文字对话" hidden={!visible} inert={!visible}>
      <header className="modal-header agent-chat-header">
        <div className="agent-chat-heading"><span className="agent-chat-symbol"><Icon name="sparkle" size={21} /></span><div>
          <div className="agent-chat-eyebrow">AGENT · CONVERSATION</div><h2>聊聊你的创作想法</h2>
          <p>仅文字对话 · 无项目读取权限 · 无工具执行</p>
        </div></div>
        <div className="agent-chat-header-actions"><WorkbenchTooltip content="连接设置（保留聊天草稿）"><Button type="button" variant="ghost" className="icon-button" aria-label="Agent 连接设置" data-testid="agent-chat-settings" disabled={!visible} onClick={() => dismiss(true)}><Icon name="settings" size={17} /></Button></WorkbenchTooltip><Button type="button" variant="ghost" className="icon-button" aria-label="收起 Agent 面板" data-testid="agent-chat-close" disabled={!visible} onClick={() => dismiss(false)}><Icon name="close" /></Button></div>
      </header>
      <div className="agent-chat-project"><Icon name="folder" size={13} /><strong>{projectName || '当前项目'}</strong><span className="agent-chat-project-id">{projectId}</span><span className="agent-chat-local-label">仅本地标签，不会发送</span></div>
      <div className="agent-chat-session-note agent-chat-persistence-note" data-testid="agent-chat-persistence"><Icon name="info" size={13} /><p>已发送的聊天文字和回复保存在本地应用数据库，重启后可读取；并非密钥保险库加密，请勿输入密钥或其他秘密。切换页签、收起面板或重新读取会保留草稿；刷新页面或退出应用会丢失未发送草稿。切换项目前会确认放弃草稿。</p>{snapshot?.mode === 'simulated' && <Badge className="small-badge neutral" data-testid="agent-chat-simulated">模拟测试 · 无真实模型调用</Badge>}</div>
      <div className="agent-chat-scroll" ref={scroll} data-testid="agent-chat-history" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
        {state.sessionLost && <div className="agent-chat-warning" role="status" data-testid="agent-chat-session-lost">后端已重新启动。已保存的历史仍保留；中断的回复不会自动续接或重发。</div>}
        {!snapshot ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>{phase === 'loading' ? '正在读取已保存的对话…' : '对话暂不可用'}</h3><p>打开窗口只读取状态，不会连接模型。</p></div> : !snapshot.runs.length && !pending ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>从一个想法开始</h3><p>可以讨论叙事、镜头语言或台词。<br />Agent 看不到画板、素材或时间线，也不会执行修改。</p></div> : null}
        {(snapshot?.historyCursor || state.history.phase !== 'closed') && <section className="agent-chat-archive" data-testid="agent-chat-archive" aria-label="更早的已保存对话">
          <div className="agent-chat-archive-heading"><strong>更早的已保存对话</strong><span>每页最多 16 轮</span></div>
          <p>仅供查阅。查看更早记录不会把它们加入发送上下文；下方最近对话、当前回复与草稿保持独立。</p>
          <div className="agent-chat-archive-controls">
            <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-older" disabled={!visible || state.history.phase === 'loading' || !(state.history.page ? state.history.page.historyCursor : snapshot?.historyCursor)} onClick={() => { if (usable()) void session.current?.earlier(); }}>{state.history.phase === 'loading' ? '正在读取…' : state.history.page ? '更早一页' : '查看更早记录'}</Button>
            {state.history.page && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-newer" disabled={!visible || state.history.phase === 'loading' || !state.history.trail.length} onClick={() => { if (usable()) void session.current?.newer(); }}>较新一页</Button>}
            {state.history.phase !== 'closed' && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-history-close" disabled={!visible} onClick={() => { if (usable()) session.current?.closeHistory(); }}>收起历史</Button>}
          </div>
          {state.history.message && <p role="status" data-testid="agent-chat-history-error">{state.history.message}</p>}
          {state.history.page && <div className="agent-chat-archive-page" ref={archiveScroll} data-testid="agent-chat-history-page" aria-label="已保存历史页" aria-busy={state.history.phase === 'loading'} tabIndex={visible ? 0 : -1}>
            {state.history.page.runs.map(run => renderRun(run, 'archive'))}
            {!state.history.page.historyCursor && <p role="status">已到最早保存的记录。</p>}
          </div>}
        </section>}
        {state.recoveredRun && <section className="agent-chat-archive" data-testid="agent-chat-recovered-request" aria-label="已确认的原请求"><p>已找到原请求，未重新发送。这条记录不在最近 16 轮中，仅供查阅。</p>{renderRun(state.recoveredRun, 'recovered')}</section>}
        {snapshot?.runs.map(run => renderRun(run))}
        {state.pending && <div className="agent-chat-pending" data-testid="agent-chat-pending"><div className="agent-chat-speaker">发送待确认</div>{state.pending.userText && <p>{state.pending.userText}</p>}<span>正在核对原请求。请勿重复发送同一消息。</span>
          {phase === 'unknown' && snapshot && <div className="agent-chat-archive-controls">
            {!state.abandonRequest ? <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(true); }}>结束本地待确认状态…</Button> : <>
              <p role="alert" data-testid="agent-chat-pending-reset-warning">原请求可能已被接受，结束此状态不会停止它或撤回费用。草稿保留，但再次发送可能造成重复回复或计费。确定继续？</p>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-confirm" disabled={!visible} onClick={() => { if (usable()) session.current?.abandonPending(state.pending.requestId); }}>我理解风险，结束待确认</Button>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-cancel" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(false); }}>继续核对</Button>
            </>}
          </div>}
        </div>}
        {state.message && <div className={`agent-chat-notice ${['unknown', 'load_error', 'detached'].includes(phase) ? 'is-warning' : ''}`} role="status" data-testid="agent-chat-notice">{state.message}</div>}
      </div>
      <form className="agent-chat-composer" onSubmit={submit} noValidate>
        {configuration && <div className="agent-chat-destination" data-testid="agent-chat-destination"><div><span>发送目标</span><strong>{configuration.model || '未填写模型'}</strong><span data-testid="agent-chat-protocol">{AGENT_PROTOCOLS[configuration.protocol].label}</span></div><p>{configuration.baseUrl ? deriveAgentEndpoint(configuration) : '未填写服务地址'}</p><p className="agent-chat-context">仅发送本条输入及最近对话中选取的已完成聊天文字，最多 12 轮，连同固定提示与本条输入合计不超过 32 KiB。查阅更早历史不会扩大上下文。不发送项目名称、ID、记录、媒体或未保存编辑。</p></div>}
        <Label className="agent-chat-consent" htmlFor="agent-chat-consent"><Input id="agent-chat-consent" data-testid="agent-chat-consent" type="checkbox" checked={Boolean(snapshot && state.consent === agentChatConsentKey(snapshot))} disabled={!ready || pending} onChange={event => { if (usable()) session.current?.approve(event.target.checked); }} /><span>我确认按上述协议向该地址和模型发送本条输入及以上范围内的已完成聊天文字，并保存到本地数据库。服务商可能计费，每次发送仅生成一条回复。</span></Label>
        <Label className="sr-only" htmlFor="agent-chat-prompt">给 Agent 的消息</Label>
        <Textarea id="agent-chat-prompt" ref={composer} data-testid="agent-chat-prompt" value={state.draft} rows={3} maxLength={AGENT_CHAT_PROMPT_BYTES} disabled={!visible || pending || ['submitting', 'stopping'].includes(phase)} placeholder="输入想讨论的内容…" aria-describedby="agent-chat-input-help" onChange={event => { if (usable()) session.current?.edit(event.target.value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); if (usable()) void session.current?.send(); } }} />
        <div className="agent-chat-composer-bottom"><div id="agent-chat-input-help"><span className={promptIssue ? 'is-warning' : ''}>{promptIssue || `${promptBytes} / ${AGENT_CHAT_PROMPT_BYTES} 字节 · Ctrl / ⌘ + Enter 发送`}</span><span data-testid="agent-chat-phase" role="status">{phaseLabel(phase)}</span></div><div className="agent-chat-controls">
          {['unknown', 'load_error', 'detached'].includes(phase) && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-reload" disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}><Icon name="refresh" size={13} />重新读取</Button>}
          {running && <Button type="button" variant="ghost" className="button agent-chat-stop" data-testid="agent-chat-stop" disabled={!visible || ['stopping', 'loading', 'submitting'].includes(phase)} onClick={() => { if (usable()) void session.current?.stop(); }}>停止回复</Button>}
          {!running && <Button type="submit" variant="ghost" className="button primary" data-testid="agent-chat-send" disabled={!canSend}>{phase === 'submitting' ? <span className="spinner" /> : <Icon name="arrow" size={14} />}发送</Button>}
        </div></div>
        <p className="agent-chat-stop-note">停止会保留已收到的文字，无法撤回远端已发生的计算或费用。</p>
      </form>
  </section>;
}
