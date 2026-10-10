import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { Label } from '@mioon/ui/components/label';
import { Badge } from '@mioon/ui/components/badge';
import { IMAGE_LIMITS } from '@mioon/contracts';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { IMAGE_MODELS, createImageGenerationSession, imageCanGenerate, imageDraftDirty, imageInputIssue, imageTaskLabel, imageTaskMessage, initialImageGenerationState } from './image-generation.js';
import Icon from './icons.jsx';
import './image-generation.css';

const noop = () => {};
const shortDate = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Kept mounted by AgentDockPane. Hiding stops reads and media, never resets a draft. */
export default function ImageGeneration({ projectId, projectName, api, storage, onDirtyChange = noop, onGenerated = noop, onRevealAsset }) {
  const [state, setState] = useState(initialImageGenerationState);
  const visible = useWorkspaceVisibility(), session = useRef(null), lifetime = useRef(null);
  const callbacks = useRef({ onGenerated, onDirtyChange, onRevealAsset });
  const interaction = useMemo(() => ({ projectId, visible }), [projectId, visible]), interactionRef = useRef(interaction), visibilityRef = useRef(visible);
  useLayoutEffect(() => { callbacks.current = { onGenerated, onDirtyChange, onRevealAsset }; });
  useLayoutEffect(() => {
    const owner = { projectId, closed: false }; lifetime.current = owner;
    setState(initialImageGenerationState());
    if (!projectId) return () => { owner.closed = true; callbacks.current.onDirtyChange(false); };
    const current = createImageGenerationSession({ projectId, api, storage,
      onChange: value => { if (!owner.closed && lifetime.current === owner) setState(value); },
      onGenerated: (id, task) => { if (!owner.closed && lifetime.current === owner) callbacks.current.onGenerated(id, task); },
    });
    session.current = current;
    const page = typeof document === 'undefined' ? null : document;
    const visibilityChanged = () => current.setVisible(visibilityRef.current && page?.visibilityState !== 'hidden');
    page?.addEventListener('visibilitychange', visibilityChanged); visibilityChanged(); void current.load();
    return () => { owner.closed = true; page?.removeEventListener('visibilitychange', visibilityChanged); current.dispose(); if (session.current === current) session.current = null; callbacks.current.onDirtyChange(false); };
  }, [projectId, api, storage]);
  useLayoutEffect(() => {
    interactionRef.current = interaction; visibilityRef.current = visible;
    session.current?.setVisible(visible && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  }, [interaction]);
  useLayoutEffect(() => { callbacks.current.onDirtyChange(imageDraftDirty(state) && !state.pending); }, [state.draft, state.target, state.pending]);
  const owner = lifetime.current;
  const usable = () => Boolean(visible && interactionRef.current === interaction && owner && !owner.closed && lifetime.current === owner && owner.projectId === projectId);
  const group = state.groups.find(item => item.id === state.selectedGroupId), targetGroup = state.groups.find(item => item.id === state.target?.groupId);
  const targetStale = state.target && (!targetGroup || targetGroup.revision !== state.target.expectedRevision || targetGroup.activeTaskId);
  const busy = !visible || Boolean(state.pending || state.actionTaskId) || state.phase === 'targeting';
  const issue = imageInputIssue(state.draft);
  function run(action) { if (usable()) void action(session.current); }
  return <section className="image-generation-page" data-testid="image-generation-page" data-project-id={projectId || ''} data-phase={state.phase} hidden={!visible} inert={!visible} aria-label="图像生成">
    <header className="image-generation-heading"><div><span className="image-generation-eyebrow">IMAGE · STUDIO</span><h2>图像工坊</h2><p>{projectName || '当前项目'}</p></div><Badge className="small-badge neutral">Mock 测试</Badge></header>
    {!projectId ? <p className="image-generation-empty">选择一个项目开始创建图像。</p> : <div className="image-generation-scroll">
      <form className="image-generation-composer" onSubmit={event => { event.preventDefault(); run(current => current?.generate()); }} noValidate>
        <div className="image-generation-target"><strong>{state.target ? `此组的新版本 · 基准 r${state.target.expectedRevision}` : '新图像组'}</strong>{state.target && <span>{targetGroup?.name || state.draft.name}</span>}<Button type="button" variant="ghost" className="button quiet" data-testid="image-new-group" disabled={busy} onClick={() => run(current => current?.requestTarget(null))}>新图像组</Button></div>
        {state.targetRequest && <div className="image-generation-notice" role="alert" data-testid="image-draft-guard"><p>当前有未提交的描述。放弃草稿并切换生成目标？</p><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" disabled={busy} onClick={() => run(current => current?.keepDraft())}>保留草稿</Button><Button type="button" variant="ghost" className="button" data-testid="image-discard-draft" disabled={busy} onClick={() => run(current => current?.confirmTarget())}>放弃并切换</Button></div></div>}
        <Label htmlFor="image-generation-name">图像名称</Label>
        <Input id="image-generation-name" data-testid="image-generation-name" value={state.draft.name} maxLength={120} disabled={busy || Boolean(state.target)} placeholder="例如：清晨的山间小屋" onChange={event => run(current => current?.edit('name', event.target.value))} />
        <Label htmlFor="image-generation-prompt">图像描述</Label>
        <Textarea id="image-generation-prompt" data-testid="image-generation-prompt" rows={4} value={state.draft.prompt} maxLength={IMAGE_LIMITS.promptCharacters} disabled={busy} placeholder="描述主体、构图、光线与风格…" aria-describedby="image-prompt-help" onChange={event => run(current => current?.edit('prompt', event.target.value))} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); run(current => current?.generate()); } }} />
        <div id="image-prompt-help" className="image-generation-input-help"><span>仅使用这里输入的描述</span><span>{state.draft.prompt.length} / {IMAGE_LIMITS.promptCharacters}</span></div>
        <div className="image-generation-providers" aria-label="图像提供方"><div className="image-generation-provider is-selected"><strong>Mock · 本地测试</strong><span>{IMAGE_MODELS.mock}</span><p>确定性测试图案，不会按描述绘制 AI 图像，也不会连接外部服务。</p></div><div className="image-generation-provider is-disabled" data-testid="image-openai-disabled" aria-disabled="true"><strong>OpenAI · 暂未启用</strong><span>{IMAGE_MODELS.openai}</span><p>适配器仅完成离线测试，真实调用未验证。凭据、启用和自定义端点将在后续接入。</p></div></div>
        <p className="image-generation-format" data-testid="image-fixed-options">1024 × 1024 · PNG · 不透明 · low · 1 张</p>
        <p className="image-generation-storage">描述与历史保存在本地数据库中，未加密；待确认请求暂存在本页面会话。请勿输入密钥或其他秘密。</p>
        {targetStale && <p className="image-generation-notice" role="status">此组仍有待处理任务，或基准版本已变化。请读取最新记录，再明确选择生成目标。</p>}
        <Button type="submit" variant="ghost" className="button primary image-generation-submit" data-testid="image-generate" disabled={!visible || !imageCanGenerate(state)}>{state.phase === 'submitting' ? <span className="spinner" /> : <Icon name="image" size={14} />}{state.phase === 'submitting' ? '正在确认请求…' : '生成 Mock 图像'}</Button>
        {(state.draft.name || state.draft.prompt) && issue && <p className="image-generation-input-help">{issue}</p>}
      </form>
      {state.pending && <div className="image-generation-notice" role="status" data-testid="image-pending"><strong>原请求待确认</strong><p>只核对已保存的请求，不会自动重新生成。切换页签或重开面板也不会重发。</p><span className="image-generation-id">{state.pending.input.requestId}</span></div>}
      {(state.message || state.pollPaused) && <div className="image-generation-notice" role="status" data-testid="image-generation-notice">{state.message && <p>{state.message}</p>}{state.pollPaused && <p>已暂停定时读取。任务保留，可手动读取最新状态。</p>}</div>}
      <section className="image-generation-history" aria-label="已保存的图像历史">
        <div className="image-generation-history-heading"><h3>图像历史</h3><Button type="button" variant="ghost" className="button quiet" data-testid="image-refresh" disabled={busy || state.phase === 'loading'} onClick={() => run(current => current?.load())}><Icon name="refresh" size={12} />重新读取</Button></div>
        {state.groups.length ? <><Label className="sr-only" htmlFor="image-history-group">查看图像组</Label><WorkbenchSelect id="image-history-group" data-testid="image-history-group" value={state.selectedGroupId} disabled={busy} onChange={event => run(current => current?.selectGroup(event.target.value))}>{state.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</WorkbenchSelect><div className="image-generation-actions"><Button type="button" variant="ghost" className="button" data-testid="image-edit-version" disabled={busy || !group || Boolean(group.activeTaskId)} onClick={() => run(current => current?.requestTarget(group.id))}>编辑为此组的新版本</Button>{group?.activeTaskId && <span>此组有未结束任务</span>}</div></> : <p className="image-generation-empty">{state.phase === 'loading' ? '正在读取本地记录…' : '生成后会在这里保留原始结果与版本。'}</p>}
        {(state.nextGroupCursor || state.groupTrail.length > 0) && <div className="image-generation-actions"><Button type="button" variant="ghost" className="button" disabled={busy || !state.groupTrail.length} onClick={() => run(current => current?.pageGroups(false))}>较新图像组</Button><Button type="button" variant="ghost" className="button" disabled={busy || !state.nextGroupCursor} onClick={() => run(current => current?.pageGroups(true))}>更早图像组</Button></div>}
        {state.tasks.filter(task => !state.selectedGroupId || task.groupId === state.selectedGroupId).map(task => <article key={task.id} className="image-generation-task" data-testid="image-task" data-task-id={task.id} data-state={task.state}><div><strong>{task.name}</strong><Badge className={`small-badge ${task.state === 'succeeded' ? 'success' : 'neutral'}`}>{imageTaskLabel(task.state)}</Badge></div><span>{shortDate(task.createdAt)} · {task.providerId === 'mock' ? 'Mock 测试图案' : 'OpenAI'}</span>{imageTaskMessage(task.state) && <p>{imageTaskMessage(task.state)}</p>}<details><summary>原始描述与任务</summary><p className="image-generation-saved-prompt">{task.prompt}</p><span className="image-generation-id">任务 {task.id}</span><span className="image-generation-id">请求 {task.requestId}</span></details>{['queued', 'interrupted_before_dispatch'].includes(task.state) && !task.dispatched && <Button type="button" variant="ghost" className="button" data-testid="image-cancel-queued" disabled={busy} onClick={() => run(current => current?.act('cancelQueued', task))}>取消未发送任务</Button>}{['local_result_error', 'outcome_unknown'].includes(task.state) && <Button type="button" variant="ghost" className="button" data-testid="image-recover-result" disabled={busy} onClick={() => run(current => current?.act('recoverResult', task))}>{task.state === 'outcome_unknown' ? '检查并恢复本地结果' : '恢复同一份本地结果'}</Button>}</article>)}
        {state.versions.map(version => <article key={version.id} className="image-generation-version" data-testid="image-version" data-version-id={version.id}><div className="image-generation-version-heading"><strong>V{version.number}</strong><span>{version.isMock ? 'Mock · 确定性测试图案' : 'OpenAI'}</span></div><img src={visible ? `/media/${encodeURIComponent(version.assetId)}` : undefined} alt={`${group?.name || '已生成图像'}，版本 ${version.number}${version.isMock ? '，Mock 测试图案' : ''}`} width={1024} height={1024} loading="lazy" decoding="async" data-testid="image-version-preview" /><p>原始结果 · 1024 × 1024 PNG · {Math.ceil(version.byteLength / 1024)} KB</p><details><summary>不可变版本信息</summary><span className="image-generation-id">版本 {version.id}</span><span className="image-generation-id">SHA-256 {version.sha256}</span><span className="image-generation-id">{version.model}</span></details>{onRevealAsset && <Button type="button" variant="ghost" className="button" data-testid="image-reveal-asset" disabled={!visible} onClick={() => { if (usable()) callbacks.current.onRevealAsset?.(version.assetId, projectId); }}>在素材库中使用</Button>}</article>)}
        {(state.nextVersionCursor || state.versionTrail.length > 0) && <div className="image-generation-actions"><Button type="button" variant="ghost" className="button" disabled={busy || !state.versionTrail.length} onClick={() => run(current => current?.pageVersions(false))}>较新版本</Button><Button type="button" variant="ghost" className="button" disabled={busy || !state.nextVersionCursor} onClick={() => run(current => current?.pageVersions(true))}>更早版本</Button></div>}
        {state.versions.length > 0 && <p className="image-generation-reuse">结果已进入项目素材库。可沿用素材库的时间线、首帧与主体参考入口；这里不会自动创建或连接节点。</p>}
      </section>
    </div>}
  </section>;
}
