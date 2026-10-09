import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Textarea } from '@mioon/ui/components/textarea';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mioon/ui/components/collapsible';
import AgentRunActivity from './AgentRunActivity.jsx';
import AgentEditProposal from './AgentEditProposal.jsx';
import { WorkbenchTooltip } from './WorkspaceControls.jsx';
import Icon from './icons.jsx';
import './agent-chat-history.css';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { AGENT_PROTOCOLS, deriveAgentEndpoint, AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, agentEditAvailable, agentInspectionAvailable, AGENT_CHAT_PROMPT_BYTES, activeAgentChatRun, agentChatCanSend, agentChatConsentKey, agentChatErrorText,
  agentChatPromptIssue, createAgentChatSession, initialAgentChatState } from './agent-chat.js';

const runLabel = status => ({ running: '正在回复', completed: '回复结束', stopped: '已停止 · 保留部分文字', failed: '回复失败', interrupted: '回复中断' }[status] || '状态未知');
const phaseLabel = phase => ({ loading: '正在读取对话', submitting: '正在确认发送', streaming: '正在接收运行进度', stopping: '正在请求停止', detached: '显示连接已断开', unknown: '运行状态待确认', load_error: '读取失败', ready: '等待你的消息' }[phase] || '状态待确认');

function renderRun(run, kind = 'recent', visible = true) {
  return <article className="agent-chat-turn" key={`${kind}-${run.id}`} data-run-id={run.id} data-history-kind={kind} data-status={run.status}>
          <div className="agent-chat-message is-user"><div className="agent-chat-speaker">你</div><p>{run.userText}</p></div>
          <div className="agent-chat-message is-assistant"><div className="agent-chat-speaker"><Icon name="sparkle" size={12} />Agent<span>{runLabel(run.status)}</span></div>
            <AgentRunActivity run={run} visible={visible} />
            <p data-testid={kind === 'recent' ? 'agent-chat-response' : 'agent-chat-history-response'}>{run.assistantText || (run.status === 'running' ? '等待第一段文字…' : '没有收到回复文字。')}</p>
            {run.status === 'interrupted' && <div className="agent-chat-run-error" role="status" data-testid="agent-chat-interrupted">已保存的回复中断，不会自动续接或重新发送；远端仍可能已计算或计费。</div>}
            {run.error && <div className="agent-chat-run-error" role="status">{agentChatErrorText(run.error.code)}</div>}
            <div className="agent-chat-run-model" data-testid="agent-chat-run-destination">{AGENT_PROTOCOLS[run.configuration.protocol].label} · {run.configuration.model} · {deriveAgentEndpoint(run.configuration)}</div>
          </div>
        </article>;
}

export default function AgentPanel({ projectId, projectName, selectedShot = null, onApplied, onClose, onSettings, onDraftChange = () => {} }) {
  const [state, setState] = useState(initialAgentChatState);
  const [disclosure, setDisclosure] = useState({ key: null, expanded: true, reviewed: false });
  const disclosureIdentity = useRef(null);
  const visible = useWorkspaceVisibility();
  const selectedKey = JSON.stringify(selectedShot ? [selectedShot.id, selectedShot.revision, selectedShot.title, selectedShot.prompt] : null);
  const interaction = useMemo(() => ({ visible, selectedKey }), [visible, selectedKey]), interactionRef = useRef(interaction), visibilityRef = useRef(visible);
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
  useLayoutEffect(() => { session.current?.setEditTarget(selectedShot); }, [projectId, selectedKey]);
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
  const inspectionAvailable = agentInspectionAvailable(snapshot), inspecting = state.contextMode === AGENT_PROJECT_CONTEXT;
  const editAvailable = agentEditAvailable(snapshot), editing = state.contextMode === AGENT_EDIT_CONTEXT;
  // Presentation state is tied to the exact displayed disclosure, never approval.
  // A changed target, saved text, scope, destination or policy reopens the details.
  const disclosureKey = JSON.stringify([projectId, state.contextMode, state.editTarget, snapshot?.instanceId, snapshot?.settings.revision, configuration, snapshot?.edit]);
  useLayoutEffect(() => {
    disclosureIdentity.current = disclosureKey;
    setDisclosure({ key: disclosureKey, expanded: true, reviewed: false });
  }, [disclosureKey]);
  const disclosureOpen = disclosure.key !== disclosureKey || disclosure.expanded;
  const disclosureReviewed = disclosure.key === disclosureKey && disclosure.reviewed;
  const sendConsented = Boolean(snapshot && state.consent !== null && state.consent === agentChatConsentKey(snapshot, state.contextMode, state.editTarget));
  const canCompactDisclosure = disclosureReviewed || sendConsented;

  const proposalRefresh = JSON.stringify(snapshot?.runs.map(run => [run.id, run.status, run.activity?.filter(step => step.kind === 'tool').map(step => [step.id, step.status])]) || []);
  const blockedRunIds = snapshot?.runs.filter(run => run.status !== 'completed').map(run => run.id) || [];
  const ready = visible && phase === 'ready', canSend = visible && agentChatCanSend(state);
  const promptBytes = new TextEncoder().encode(state.draft).length;
  const promptIssue = state.draft ? agentChatPromptIssue(state.draft) : '';
  const lastRun = snapshot?.runs.at(-1);
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastRun?.assistantText, lastRun?.status, lastRun?.lastEventId, snapshot?.runs.length, state.pending]);
  useLayoutEffect(() => { if (archiveScroll.current) archiveScroll.current.scrollTop = 0; }, [state.history.before]);
  async function send() {
    if (!usable()) return;
    const current = session.current, key = disclosureKey, editSend = editing;
    const accepted = await current?.send();
    if (accepted && editSend && owner && !owner.closed && lifetime.current === owner && session.current === current && disclosureIdentity.current === key)
      setDisclosure({ key, expanded: false, reviewed: true });
  }
  function submit(event) { event.preventDefault(); void send(); }
  return <section className="agent-chat-page" data-testid="agent-chat-page" data-project-id={projectId} data-phase={phase} aria-label="Agent 文字对话" hidden={!visible} inert={!visible}>
      <header className="modal-header agent-chat-header">
        <div className="agent-chat-heading"><span className="agent-chat-symbol"><Icon name="sparkle" size={21} /></span><div>
          <div className="agent-chat-eyebrow">AGENT · CONVERSATION</div><h2>聊聊你的创作想法</h2>
          <p>{editing ? '新消息范围：选中镜头修改提议' : inspecting ? '新消息范围：当前项目只读检查' : '新消息范围：仅文字聊天'}</p>
        </div></div>
        <div className="agent-chat-header-actions"><WorkbenchTooltip content="连接设置（保留聊天草稿）"><Button type="button" variant="ghost" className="icon-button" aria-label="Agent 连接设置" data-testid="agent-chat-settings" disabled={!visible} onClick={() => dismiss(true)}><Icon name="settings" size={17} /></Button></WorkbenchTooltip><Button type="button" variant="ghost" className="icon-button" aria-label="收起 Agent 面板" data-testid="agent-chat-close" disabled={!visible} onClick={() => dismiss(false)}><Icon name="close" /></Button></div>
      </header>
      <div className="agent-chat-project"><Icon name="folder" size={13} /><strong>{projectName || '当前项目'}</strong><span className="agent-chat-project-id" title={projectId}>{projectId}</span><span className="agent-chat-local-label">{inspecting || editing ? '本次选择的项目范围' : '仅文字聊天不会发送此标签'}</span></div>
      <Collapsible className="agent-chat-session-note agent-chat-persistence-note" data-testid="agent-chat-persistence">
        <div className="agent-chat-storage-summary"><Icon name="info" size={13} /><p>记录保存在本地应用数据库，并非密钥保险库加密。请勿输入密钥或其他秘密。</p>{snapshot?.mode === 'simulated' && <Badge className="small-badge neutral" data-testid="agent-chat-simulated">模拟测试 · 无真实模型调用</Badge>}</div>
        <CollapsibleTrigger className="agent-chat-details-trigger" disabled={!visible} data-testid="agent-chat-details-toggle">存储与运行说明</CollapsibleTrigger>
        <CollapsibleContent className="agent-chat-details" data-testid="agent-chat-details">
          <p>已发送文字、回复及读取结果会保存在本地。切换页签、收起面板或重新读取保留草稿；刷新页面或退出应用会丢失未发送草稿。切换项目前会确认放弃草稿。</p>
          <p>从最近 16 轮中最多选取 12 轮已完成对话。仅文字聊天会排除所有项目读取和修改提议轮次，与固定提示和本条输入合计最多 32 KiB；项目检查的首次上下文最多 20 KiB，镜头提议的首次上下文最多 30 KiB。更早历史仅供查阅，不扩大上下文。</p>
          {snapshot?.inspection && <p data-testid="agent-chat-inspection-policy">只读工具定义 v{snapshot.inspection.schemaVersion} · 目录 {snapshot.inspection.catalogHash.slice(0, 12)}</p>}
          <p>项目检查仅限 project.inspect、asset.inspect、shot.inspect、timeline.inspect 的固定只读范围：已保存项目、素材、镜头及时间线文字与元数据。每轮最多读取一次、结果最多 8 KiB；不发送媒体、路径、凭据或未保存编辑。文字中可能包含你保存的私人内容，请先核对。</p>
          <p>选中镜头修改提议只发送所选已保存镜头的完整标题与画面描述，不含属性面板的未保存草稿。每轮最多 2 次模型请求、1 次提议工具调用，工具只创建待审阅提议。null 保持字段不变，空画面描述会清空，标题不能为空；提议不能在审阅时编辑或自动重新基于新版本生成。</p>
          <p>隐藏窗口、切换页签、收起面板或切换项目后，已接受的限界运行可能继续。停止可阻止后续步骤，无法撤回已发生的计算或费用；重启后不会自动续接或重新发送。</p>
        </CollapsibleContent>
      </Collapsible>
      <div className="agent-chat-scroll" ref={scroll} data-testid="agent-chat-history" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }}>
        {state.sessionLost && <div className="agent-chat-warning" role="status" data-testid="agent-chat-session-lost">后端已重新启动。已保存的历史仍保留；中断的回复不会自动续接或重发。</div>}
        {!snapshot ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>{phase === 'loading' ? '正在读取已保存的对话…' : '对话暂不可用'}</h3><p>打开窗口只读取状态，不会连接模型。</p></div> : !snapshot.runs.length && !pending ? <div className="agent-chat-empty"><Icon name="sparkle" size={26} /><h3>从一个想法开始</h3><p>{editing ? '可请 Agent 为当前选中镜头的已保存标题或画面描述提出修改，审阅差异并明确批准后才会应用。' : inspecting ? '可请求查看本项目已保存的文字与元数据。不会查看媒体画面或执行修改。' : '可以讨论叙事、镜头语言或台词。需要项目资料时，请先选择只读检查。'}</p></div> : null}
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
            {state.history.page.runs.map(run => renderRun(run, 'archive', visible))}
            {!state.history.page.historyCursor && <p role="status">已到最早保存的记录。</p>}
          </div>}
        </section>}
        {state.recoveredRun && <section className="agent-chat-archive" data-testid="agent-chat-recovered-request" aria-label="已确认的原请求"><p>已找到原请求，未重新发送。这条记录不在最近 16 轮中，仅供查阅。</p>{renderRun(state.recoveredRun, 'recovered', visible)}</section>}
        {snapshot?.runs.map(run => renderRun(run, 'recent', visible))}
        {state.pending && <div className="agent-chat-pending" data-testid="agent-chat-pending"><div className="agent-chat-speaker">发送待确认</div>{state.pending.userText && <p>{state.pending.userText}</p>}<span>正在核对原请求。请勿重复发送同一消息。</span>
          {phase === 'unknown' && snapshot && <div className="agent-chat-archive-controls">
            {!state.abandonRequest ? <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(true); }}>结束本地待确认状态…</Button> : <>
              <p role="alert" data-testid="agent-chat-pending-reset-warning">原请求可能已被接受，结束此状态不会停止它或撤回费用。草稿保留，但再次发送可能造成重复回复或计费。确定继续？</p>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-confirm" disabled={!visible} onClick={() => { if (usable()) session.current?.abandonPending(state.pending.requestId); }}>我理解风险，结束待确认</Button>
              <Button type="button" variant="ghost" className="button" data-testid="agent-chat-pending-reset-cancel" disabled={!visible} onClick={() => { if (usable()) session.current?.confirmAbandonPending(false); }}>继续核对</Button>
            </>}
          </div>}
        </div>}
        <AgentEditProposal projectId={projectId} refreshKey={proposalRefresh} blockedRunIds={blockedRunIds} onApplied={onApplied} />
        {state.message && <div className={`agent-chat-notice ${['unknown', 'load_error', 'detached'].includes(phase) ? 'is-warning' : ''}`} role="status" data-testid="agent-chat-notice">{state.message}</div>}
      </div>
      <form className="agent-chat-composer" onSubmit={submit} noValidate>
        <fieldset className="agent-chat-context-mode" disabled={!ready || pending} data-testid="agent-chat-context-mode">
          <legend>本次发送的范围</legend>
          <Label htmlFor="agent-chat-mode-typed"><Input id="agent-chat-mode-typed" data-testid="agent-chat-mode-typed" type="radio" name="agent-chat-context-mode" value={AGENT_TYPED_CONTEXT} checked={state.contextMode === AGENT_TYPED_CONTEXT} disabled={!ready || pending} onChange={event => { if (usable() && event.target.checked) session.current?.setContextMode(AGENT_TYPED_CONTEXT); }} /><span>仅文字聊天</span></Label>
          <Label htmlFor="agent-chat-mode-project"><Input id="agent-chat-mode-project" data-testid="agent-chat-mode-project" type="radio" name="agent-chat-context-mode" value={AGENT_PROJECT_CONTEXT} checked={inspecting} disabled={!inspectionAvailable || !ready || pending} onChange={event => { if (usable() && event.target.checked) session.current?.setContextMode(AGENT_PROJECT_CONTEXT); }} /><span>当前项目只读检查</span></Label>
          <Label htmlFor="agent-chat-mode-edit"><Input id="agent-chat-mode-edit" data-testid="agent-chat-mode-edit" type="radio" name="agent-chat-context-mode" value={AGENT_EDIT_CONTEXT} checked={editing} disabled={!editAvailable || !ready || pending} onChange={event => { if (usable() && event.target.checked) session.current?.setContextMode(AGENT_EDIT_CONTEXT); }} /><span>选中镜头修改提议</span></Label>
          {!editAvailable && <span className="agent-chat-mode-unavailable">镜头修改提议暂不可用</span>}
          {!inspectionAvailable && <span className="agent-chat-mode-unavailable">项目只读检查暂不可用</span>}
        </fieldset>
        {editing && <section className="agent-edit-selected" data-testid="agent-edit-selected-target" aria-label="本次发送的已保存镜头文字">
          <strong>使用当前选中的已保存镜头</strong>
          {state.editTarget ? <><p data-testid="agent-edit-target-summary">镜头 {state.editTarget.shotId} · 基准版本 {state.editTarget.expectedRevision}</p>
            <p>范围：完整已保存标题与画面描述，不含未保存草稿。</p>
            <Collapsible className="agent-edit-selected-disclosure" data-testid="agent-edit-selected-disclosure" open={disclosureOpen} onOpenChange={open => {
              if (usable() && disclosureIdentity.current === disclosureKey && (open || canCompactDisclosure)) setDisclosure({ key: disclosureKey, expanded: open, reviewed: disclosureReviewed || sendConsented });
            }}>
              <CollapsibleTrigger className="agent-chat-details-trigger" data-testid="agent-edit-selected-details-toggle" disabled={!visible || !canCompactDisclosure}>{disclosureOpen ? '完整发送文字与工具限额' : '展开已核对的完整文字与工具限额'}</CollapsibleTrigger>
              <CollapsibleContent keepMounted className="agent-edit-selected-details" data-testid="agent-edit-selected-details">
                <p>以下是将发给模型的完整已保存文字。属性面板里的未保存输入不在其中；切换镜头或保存内容变化后需重新确认。</p>
                <div className="agent-edit-selected-text"><span>已保存标题</span><pre data-testid="agent-edit-selected-title">{state.editTarget.title}</pre><span>已保存画面描述</span><pre data-testid="agent-edit-selected-prompt">{state.editTarget.prompt || '（空）'}</pre></div>
                {snapshot?.edit && <p data-testid="agent-edit-policy">提议工具 v{snapshot.edit.schemaVersion} · 目录 {snapshot.edit.catalogHash.slice(0, 12)} · 标题最多 150 字符 / 600 字节，画面描述最多 5000 字符 / 20000 字节</p>}
              </CollapsibleContent>
            </Collapsible>
          </> : <p role="status">请先在画板中选择一个已保存镜头。标题或画面描述超出安全长度限制时不能发送。</p>}
        </section>}
        {configuration && <div className="agent-chat-destination" data-testid="agent-chat-destination"><div><span>发送目标</span><strong>{configuration.model || '未填写模型'}</strong><span data-testid="agent-chat-protocol">{AGENT_PROTOCOLS[configuration.protocol].label}</span></div><p>{configuration.baseUrl ? deriveAgentEndpoint(configuration) : '未填写服务地址'}</p><p className="agent-chat-context" data-testid="agent-chat-context">{editing ? '发送本条输入、范围内已完成的纯聊天文字，以及上方一个镜头的完整已保存标题和画面描述。仅允许 shot.update 的 title、prompt 提议，不发送其他镜头、媒体、未保存草稿或项目读取及修改提议轮次。最多 2 次模型请求、1 次提议工具调用、8 KiB 结果；续接关闭工具，提议不会自动应用。' : inspecting ? `发送本条输入、范围内的已完成对话，以及上方项目“${projectName || projectId}”的一次已保存文字与元数据读取结果。最多 2 次模型请求、1 次只读工具调用、8 KiB 结果；仅一次续接，续接时关闭工具。` : '仅发送本条输入及范围内的已完成纯聊天文字。不含项目名称、ID、记录、媒体或项目读取轮次。'}</p></div>}
        <Label className="agent-chat-consent" htmlFor="agent-chat-consent"><Input id="agent-chat-consent" data-testid="agent-chat-consent" type="checkbox" checked={Boolean(snapshot && state.consent !== null && state.consent === agentChatConsentKey(snapshot, state.contextMode, state.editTarget))} disabled={!ready || pending || (editing && !state.editTarget)} onChange={event => { if (usable()) session.current?.approve(event.target.checked); }} /><span>{editing ? '我授权按以上项目、镜头、已保存版本、完整文字、协议、地址、模型和工具限额发送本条输入、范围内纯聊天上下文及镜头文字，并保存本次记录；最多 2 次模型请求可能计费。此授权只允许提出差异，应用还需我另行明确批准。' : inspecting ? '我授权本次按以上协议、地址、模型和项目范围发送数据并保存记录；允许一次读取及关闭工具后的有限续接，不逐次询问。最多 2 次模型请求可能计费。' : '我确认按以上协议、地址和模型发送本条输入及纯聊天上下文，并保存记录。一次模型请求可能计费。'}隐藏面板、页签或切换项目后，已接受的运行仍可能继续。</span></Label>
        <Label className="sr-only" htmlFor="agent-chat-prompt">给 Agent 的消息</Label>
        <Textarea id="agent-chat-prompt" ref={composer} data-testid="agent-chat-prompt" value={state.draft} rows={3} maxLength={AGENT_CHAT_PROMPT_BYTES} disabled={!visible || pending || ['submitting', 'stopping'].includes(phase)} placeholder="输入想讨论的内容…" aria-describedby="agent-chat-input-help" onChange={event => { if (usable()) session.current?.edit(event.target.value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="agent-chat-composer-bottom"><div id="agent-chat-input-help"><span className={promptIssue ? 'is-warning' : ''}>{promptIssue || `${promptBytes} / ${AGENT_CHAT_PROMPT_BYTES} 字节 · Ctrl / ⌘ + Enter 发送`}</span><span data-testid="agent-chat-phase" role="status">{phaseLabel(phase)}</span></div><div className="agent-chat-controls">
          {['unknown', 'load_error', 'detached'].includes(phase) && <Button type="button" variant="ghost" className="button" data-testid="agent-chat-reload" disabled={!visible} onClick={() => { if (usable()) void session.current?.load(); }}><Icon name="refresh" size={13} />重新读取</Button>}
          {running && <Button type="button" variant="ghost" className="button agent-chat-stop" data-testid="agent-chat-stop" disabled={!visible || ['stopping', 'loading', 'submitting'].includes(phase)} onClick={() => { if (usable()) void session.current?.stop(); }}>停止后续步骤</Button>}
          {!running && <Button type="submit" variant="ghost" className="button primary" data-testid="agent-chat-send" disabled={!canSend}>{phase === 'submitting' ? <span className="spinner" /> : <Icon name="arrow" size={14} />}发送</Button>}
        </div></div>
        <p className="agent-chat-stop-note">停止阻止后续步骤，保留已有文字与结果；无法撤回已发生的费用。重启不会自动续接。</p>
      </form>
  </section>;
}
