import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { Separator } from '@mioon/ui/components/separator';
import { Badge } from '@mioon/ui/components/badge';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { Textarea } from '@mioon/ui/components/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import Icon from './icons.jsx';
import { activeJob, assetUrl, statusText, jobStatusText, outputReviewRequired, outputReviewMessage } from './api.js';
import { Media } from './Nodes.jsx';
import { dragAsset } from './Timeline.jsx';
import ProviderSettings from './ProviderSettings.jsx';
import VideoFrameControls, { VideoFrameSummary } from './VideoFrameControls.jsx';
import SubjectVideoSelection from './SubjectVideoSelection.jsx';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoConflictIssue } from './subject-video.js';
import ShotSubjectBindings from './ShotSubjectBindings.jsx';
import { ReferenceSourcePanel, BoundReference } from './ReferenceConnections.jsx';
import { referenceForShot } from './reference-connections.js';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel } from './generation-settings.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { schemas } from '@mioon/contracts';
import { useLocalShotText, mergeFreshShotTextAck } from './local-shot-text-state.ts';
import ShotTextDraftRecovery from './ShotTextDraftRecovery.tsx';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';

const editable = (s) => ({ title: s.title, prompt: s.prompt || '', referenceAssetIds: s.referenceAssetIds || [], ...(Object.hasOwn(s, 'lastFrameAssetId') ? { lastFrameAssetId: s.lastFrameAssetId } : {}), duration: s.duration || 2, aspectRatio: s.aspectRatio || '9:16', parameters: s.parameters || {} });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export default function Inspector({ generationUnavailableReason = '', subjects, subjectBlocked, shot, node, project, assets, versions, jobs, providers, tab, setTab, busy, onSave, onNodeSave, onGenerate, onSelectVersion, onCompare, onOpenJobs, onDirtyChange, onAddVersion, generationOptions = {}, onGenerationOptionsChange, shots = [], nodes = [], edges = [], referenceBusy = false, referencePending = false, onAttachReference, onDetachReference, onInspect, highlightedVersionId, actionScopeKey = '', shotTextContext = null, onShotTextController, onShotTextAccepted }) {
  const confirm = useConfirmation();
  const initial = shot ? editable(shot) : { label: node?.label || '', text: node?.text || '' };
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState((shot || node)?.revision);
  const [conflict, setConflict] = useState(false);
  const baseline = useRef(initial);
  const mounted = useRef(false);
  const editSerial = useRef(0);
  const textVersion = useRef(0), draftRef = useRef(draft), dirtyRef = useRef(dirty), baseRevisionRef = useRef(baseRevision);
  draftRef.current = draft; dirtyRef.current = dirty; baseRevisionRef.current = baseRevision;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const highlightedVersion = useRef(null);
  const visible = useWorkspaceVisibility();
  const visibleRef = useRef(visible);
  const highlightFocusRequest = useRef(null);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible && highlightFocusRequest.current) {
      cancelAnimationFrame(highlightFocusRequest.current.frame);
      highlightFocusRequest.current = null;
    }
  }, [visible]);
  const [advanced, setAdvanced] = useState(false);
  const record = shot || node;
  const boundReference = referenceForShot(edges, shot?.id);
  const referenceBlocked = Boolean(referenceBusy || referencePending || conflict);
  const referenceLocked = Boolean(boundReference || referenceBlocked);
  const actionScope = `${project?.id || ''}:${record?.id || ''}:${tab}:${actionScopeKey}`;
  const renderSerial = editSerial.current;
  const generationOptionsKey = JSON.stringify(generationOptions);
  const actionState = useRef(null);
  const actionEpoch = useRef(0);
  const frameEpoch = useRef(0);
  const renderedAction = {};
  useLayoutEffect(() => { frameEpoch.current++; }, [visible, actionScope, generationOptionsKey]);
  useLayoutEffect(() => { actionEpoch.current++; }, [actionScope, generationOptionsKey]);
  useLayoutEffect(() => {
    renderedAction.epoch = actionEpoch.current; renderedAction.frameEpoch = frameEpoch.current;
    actionState.current = { actionScope, referenceBlocked, referenceLocked, generationOptionsKey };
  }, [renderedAction]);
  const actionCurrent = (epoch, serial, { requireVisible = true } = {}) => mounted.current && actionEpoch.current === epoch &&
    editSerial.current === serial && (!requireVisible || visibleRef.current) && actionState.current?.actionScope === actionScope;
  const frameActionAllowed = () => (!shotTextContext || !shotText.controller.getState().pending && !shotText.controller.getState().busy) && mounted.current && visibleRef.current && frameEpoch.current === renderedAction.frameEpoch && editSerial.current === renderSerial && actionState.current?.actionScope === actionScope && !actionState.current?.referenceBlocked;
  function currentTextContext() {
    const local = shotTextContext?.getCurrent?.() ?? shotTextContext;
    return { scope: local?.scope || actionScope, projectId: shot ? project?.id : null, shotId: shot?.id || null, revision: shot?.revision || null,
      baseRevision: baseRevisionRef.current || null, baseText: { title: baseline.current.title || '', prompt: baseline.current.prompt || '' }, savedText: { title: shot?.title || '', prompt: shot?.prompt || '' },
      raw: { title: draftRef.current.title || '', prompt: draftRef.current.prompt || '' }, textVersion: textVersion.current, formSerial: editSerial.current,
      textDirty: draftRef.current.title !== baseline.current.title || draftRef.current.prompt !== baseline.current.prompt, formDirty: dirtyRef.current,
      restored: !shotTextContext || !shot || Boolean(local?.restored), connected: Boolean(local?.connected), visible: visibleRef.current && tab === 'settings',
      busy: Boolean(local?.busy || referenceBusy || referencePending || busy[`save:${shot?.id}`]), executionEpoch: `${local?.executionEpoch || ''}:${actionScope}:${actionEpoch.current}:${generationOptionsKey}` };
  }
  const shotText = useLocalShotText({ context: currentTextContext(), getContext: currentTextContext,
    isShotUpdateInput: value => schemas['shot.update'].safeParse(value).success,
    onRestore: (stored, token) => {
      if (!mounted.current || !shotText.controller.isCurrent(token)) return false;
      editSerial.current++; textVersion.current++; draftRef.current = { ...draftRef.current, ...stored.raw }; baseline.current = { ...baseline.current, ...stored.baseText };
      baseRevisionRef.current = stored.baseRevision; dirtyRef.current = true;
      setDraft(draftRef.current); setBaseRevision(stored.baseRevision); setDirty(true); setConflict(shot.revision !== stored.baseRevision); return true;
    },
    onRebase: token => {
      if (!mounted.current || !shotText.controller.isCurrent(token)) return false;
      const latest = editable(shot), unchangedNontext = same({ ...latest, title: '', prompt: '' }, { ...baseline.current, title: '', prompt: '' });
      baseline.current = { ...baseline.current, title: latest.title, prompt: latest.prompt };
      if (unchangedNontext) { baseRevisionRef.current = shot.revision; setBaseRevision(shot.revision); }
      dirtyRef.current = !same(draftRef.current, baseline.current); setDirty(dirtyRef.current); setConflict(!unchangedNontext); return true;
    },
    onAccepted: result => {
      const accepted = mergeFreshShotTextAck({ result, current: currentTextContext(), draft: draftRef.current, baseline: baseline.current,
        currentCapture: mounted.current && shotText.controller.isCurrent(result.capture), visible: visibleRef.current, busy: currentTextContext().busy });
      if (accepted) { draftRef.current = accepted.draft; baseline.current = accepted.baseline; baseRevisionRef.current = accepted.baseRevision; dirtyRef.current = accepted.dirty; setDraft(accepted.draft); setBaseRevision(accepted.baseRevision); setDirty(accepted.dirty); setConflict(false); }
      onShotTextAccepted?.(result); return Boolean(accepted);
    } });
  useLayoutEffect(() => { if (!shot || !onShotTextController) return; const unregister = onShotTextController(shotText.controller, () => ({ mounted: mounted.current, formSerial: editSerial.current, textVersion: textVersion.current, dirty: dirtyRef.current, draft: draftRef.current, baseline: baseline.current, baseRevision: baseRevisionRef.current ?? null })); return typeof unregister === 'function' ? unregister : undefined; }, [shotText.controller, onShotTextController, shot?.id]);
  const textBlocksLegacy = Boolean(shot && shotTextContext && shotText.controller.blocksLegacy(shot.id));
  useEffect(() => {
    if (!record) return;
    const latest = shot ? editable(shot) : { label: node?.label || '', text: node?.text || '' };
    if (shot && shotTextContext && (shotText.controller.getState().dirty || currentTextContext().textDirty)) { if (record.revision !== baseRevisionRef.current) setConflict(true); return; }
    if (!dirty || same(latest, baseline.current)) {
      if (!dirty) { draftRef.current = latest; setDraft(latest); baseline.current = latest; }
      baseRevisionRef.current = record.revision; setBaseRevision(record.revision); setConflict(false);
    } else if (record.revision !== baseRevision) setConflict(true);
  }, [record?.revision]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const { provider, model, capabilities, inputMode, scenario } = generationSelection(providers, generationOptions, draft);
  function updateGeneration(patch) { onGenerationOptionsChange?.(shot?.id, { ...generationOptions, ...patch }); }
  async function changeInputMode(mode) {
    if (!frameActionAllowed() || actionState.current.referenceLocked) return;
    const epoch = actionEpoch.current, serial = editSerial.current;
    if (mode === 'text' && (draft.referenceAssetIds.length || draft.lastFrameAssetId)) {
      if (!await confirm('切换为文生视频会清除此镜头的首帧与尾帧参考图选择，素材库中的原图会保留。继续？') || !actionCurrent(epoch, serial) || !frameActionAllowed() || actionState.current.referenceLocked) return;
      editSerial.current++;
      draftRef.current = { ...draftRef.current, referenceAssetIds: [], ...(Object.hasOwn(draftRef.current, 'lastFrameAssetId') ? { lastFrameAssetId: null } : {}) }; dirtyRef.current = true;
      setDraft(draftRef.current); setDirty(true);
    }
    updateGeneration({ inputMode: mode });
  }
  function chooseLastFrame(assetId) {
    if (!frameActionAllowed()) return;
    if (draft.lastFrameAssetId === assetId) return;
    updateGeneration({ inputMode: 'image' });
    edit('lastFrameAssetId', assetId);
  }
  async function clearLastFrame() {
    if (!frameActionAllowed() || !draft.lastFrameAssetId) return;
    const epoch = actionEpoch.current, serial = editSerial.current;
    if (!await confirm('清除此镜头的尾帧参考图选择？首帧选择与素材库中的原图会保留。') || !actionCurrent(epoch, serial) || !frameActionAllowed()) return;
    edit('lastFrameAssetId', null);
  }
  function edit(key, value) { editSerial.current++; if (key === 'title' || key === 'prompt') textVersion.current++; draftRef.current = { ...draftRef.current, [key]: value }; dirtyRef.current = true; setDraft(draftRef.current); setDirty(true); shotText.controller.setContext(currentTextContext()); }
  async function save() {
    if (shot && shotTextContext && (shotText.controller.blocksLegacy(shot.id) || currentTextContext().busy) || referenceBlocked || !mounted.current || actionEpoch.current !== renderedAction.epoch || editSerial.current !== renderSerial || actionState.current?.actionScope !== actionScope) return null;
    const submittedEpoch = actionEpoch.current;
    const submittedSerial = editSerial.current, submittedTextVersion = textVersion.current;
    const result = shot ? await onSave(shot.id, baseRevision, draft) : await onNodeSave(node.id, baseRevision, draft);
    // A completed save may update project data after navigation, but it must
    // never continue an old inspector's save-and-generate chain.
    if (!mounted.current) return null;
    if (result) {
      if (shot && shotTextContext && textVersion.current !== submittedTextVersion) { dirtyRef.current = true; setDirty(true); setConflict(true); return null; }
      const saved = shot ? editable(result) : { label: result.label || '', text: result.text || '' };
      baseline.current = saved; baseRevisionRef.current = result.revision;
      setBaseRevision(result.revision); setConflict(false);
      if (editSerial.current !== submittedSerial) {
        // The submitted snapshot is saved; keep anything typed while waiting.
        setDirty(true);
        return null;
      }
      dirtyRef.current = false; draftRef.current = saved; setDirty(false); setDraft(saved);
    }
    return actionCurrent(submittedEpoch, submittedSerial, { requireVisible: false }) ? result : null;
  }
  async function clearManualReferences() {
    if (!frameActionAllowed() || actionState.current.referenceLocked || !draft.referenceAssetIds?.length) return;
    const epoch = actionEpoch.current, serial = editSerial.current;
    if (!await confirm('清除此镜头的手动参考图选择？素材库中的原图会保留。保存修改后才能连接首帧节点。') || !actionCurrent(epoch, serial) || !frameActionAllowed() || actionState.current.referenceLocked) return;
    edit('referenceAssetIds', []);
  }
  function reset() { if (shot && shotTextContext && (shotText.controller.getState().pending || shotText.controller.getState().busy || currentTextContext().busy)) return; editSerial.current++; textVersion.current++; const latest = shot ? editable(shot) : { label: node.label || '', text: node.text || '' }; draftRef.current = latest; dirtyRef.current = false; baseRevisionRef.current = record.revision; setDraft(latest); baseline.current = latest; setBaseRevision(record.revision); setDirty(false); setConflict(false); shotText.controller.setContext(currentTextContext()); }
  async function generate() { if (shotTextContext && (shotText.controller.blocksLegacy(shot.id) || currentTextContext().busy) || generationUnavailableReason || referenceBlocked || capabilityIssue || availabilityIssue || !mounted.current || actionEpoch.current !== renderedAction.epoch || editSerial.current !== renderSerial) return; const epoch = actionEpoch.current, serial = editSerial.current, optionsKey = generationOptionsKey; const latest = dirty ? await save() : shot; if (latest && actionCurrent(epoch, serial, { requireVisible: false }) && actionState.current?.generationOptionsKey === optionsKey) onGenerate(latest, { providerId: provider?.id, model, scenario, inputMode, ...(inputMode === 'subject' ? { subjectReference: generationOptions.subjectReference } : {}) }); }
  const selectedVersions = versions.filter(v => v.shotId === shot?.id).sort((a, b) => b.number - a.number);
  useEffect(() => {
    if (!visibleRef.current || !highlightedVersionId || tab !== 'versions') return;
    const request = { frame: null };
    highlightFocusRequest.current = request;
    request.frame = requestAnimationFrame(() => {
      if (!visibleRef.current || !mounted.current || highlightFocusRequest.current !== request) return;
      highlightFocusRequest.current = null;
      const element = highlightedVersion.current;
      if (!element?.isConnected) return;
      element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      element.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(request.frame);
      if (highlightFocusRequest.current === request) highlightFocusRequest.current = null;
    };
    // A resize, panel reopen, or data refresh must not steal focus again.
  }, [highlightedVersionId, tab, shot?.id]);
  const shotJobs = jobs.filter(j => j.shotId === shot?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = !generationUnavailableReason && shotJobs.find(activeJob);
  const generating = Boolean(running || busy[`generate:${shot?.id}`]);
  const referenceAssets = assets.filter(a => a.mimeType?.startsWith('image/'));
  const capabilityIssue = shot ? generationInputIssue(draft, provider, model, assets, inputMode, { subjectReference: generationOptions.subjectReference, savedShot: shot, boundReference }) : '';
  const availabilityIssue = generationUnavailableReason || providerAvailabilityIssue(provider);
  const inputModes = [...new Set([...(capabilities?.inputModes || []), inputMode])];
  const ratios = capabilities?.aspectRatios || [];
  const durations = capabilities?.durations || [];
  const imageRules = capabilities?.referenceImages;
  const seedSupported = Boolean(capabilities?.seed || capabilities?.parameters?.includes('seed'));
  const unsupportedParameters = Object.keys(draft.parameters || {}).filter(key => capabilities?.parameters && !capabilities.parameters.includes(key));
  if (!record) return <aside className="inspector"><header className="inspector-heading"><Icon name="settings" /><span>创作面板</span></header><div className="inspector-empty"><div className="empty-icon"><Icon name="film" size={28} /></div><h3>让灵感成为镜头</h3><p>选择画布中的一个镜头，编辑画面描述、参考图和生成参数。</p><div className="instruction-steps"><span><b>01</b> 导入参考素材</span><span><b>02</b> 编写镜头与提示词</span><span><b>03</b> 生成、比较并编排</span></div></div><div className="inspector-bottom-note"><Icon name="info" size={15} /><span>画布组织空间关系；分镜安排故事顺序；多轨时间线决定时序、叠层和声音。</span></div></aside>;
  if (node) return <aside className="inspector" data-testid="node-inspector"><header className="inspector-heading"><Icon name={node.type === 'text' ? 'text' : node.type === 'image' ? 'image' : 'film'} /><span>{node.type === 'text' ? '文字笔记' : '素材节点'}</span><span className="revision">rev {node.revision}</span></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll" style={{ overflow: 'visible' }}><Label className="field-label" htmlFor="node-label">节点名称</Label><Input id="node-label" maxLength={150} value={draft.label} onChange={e => edit('label', e.target.value)} />{node.type === 'text' ? <><Label className="field-label" htmlFor="node-text">文字内容</Label><Textarea id="node-text" rows={12} maxLength={5000} value={draft.text} onChange={e => edit('text', e.target.value)} placeholder="写下故事、场景或创作方向…" /></> : <div className="inspector-asset"><Media asset={assets.find(a => a.id === node.assetId)} controls={node.type !== 'image'} /></div>}{conflict && <div className="notice warning">其他编辑已更新此节点。<Button variant="ghost" size="sm" onClick={reset}>载入最新内容</Button></div>}<Button size="sm" className="button primary full" disabled={!dirty || conflict || referenceBusy || busy[`save:${node.id}`]} onClick={save}><Icon name="check" size={16} />保存节点</Button>{dirty && <Button variant="ghost" size="sm" className="text-button" onClick={reset}>放弃修改</Button>}<ReferenceSourcePanel node={node} project={project} assets={assets} shots={shots} edges={edges} busy={referenceBusy || Boolean(shotTextContext && shotText.state.pending)} pending={referencePending} dirty={dirty} conflict={conflict} onAttach={onAttachReference} onInspect={onInspect} /><p className="muted helper visual-connection-note">灰色端口创建视觉连线，仅用于整理思路，不参与生成。点击视觉连线后可按 Delete 删除。</p></div></ScrollArea></aside>;
  return <aside className="inspector" data-testid="shot-inspector">
    <header className="inspector-heading"><Icon name="settings" /><span>镜头设置</span><span className="revision">rev {shot.revision}</span></header>
    <Tabs value={tab} onValueChange={setTab} style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <TabsList variant="line" className="inspector-tabs w-auto justify-start rounded-none p-0" aria-label="镜头面板">
        <TabsTrigger value="settings" className={`flex-none rounded-none border-0 bg-transparent shadow-none ${tab === 'settings' ? 'active' : ''}`}>创作参数</TabsTrigger>
        <TabsTrigger value="versions" className={`flex-none rounded-none border-0 bg-transparent shadow-none ${tab === 'versions' ? 'active' : ''}`}>版本历史 <span>{selectedVersions.length}</span></TabsTrigger>
      </TabsList>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll" style={{ overflow: 'visible' }}><TabsContent value="versions"><div className="section-heading"><span>探索不同的可能</span><Button variant="ghost" size="sm" className="text-button" disabled={selectedVersions.length < 2} onClick={() => onCompare(shot.id)}><Icon name="compare" size={14} />比较</Button></div>{selectedVersions.length ? selectedVersions.map(v => <div className={`version-card ${shot.selectedVersionId === v.id ? 'chosen' : ''} ${highlightedVersionId === v.id ? 'source-highlighted' : ''}`} key={v.id} ref={highlightedVersionId === v.id ? highlightedVersion : undefined} tabIndex={highlightedVersionId === v.id ? -1 : undefined} data-testid={`version-card-${v.id}`} data-source-highlighted={highlightedVersionId === v.id || undefined} aria-label={highlightedVersionId === v.id ? `片段来源：版本 ${v.number}` : undefined} draggable={Boolean(v.assetId)} onDragStart={e => { if (v.assetId) dragAsset(e, v.assetId); }}><div className="version-preview"><Media version={v} controls /></div>{highlightedVersionId === v.id && <div className="version-source-note" data-testid="highlighted-source-version"><Icon name="link" size={12} />当前片段的固定来源 · 版本 {v.number}</div>}<div className="version-details"><strong>版本 {v.number}</strong><Badge className={`small-badge ${v.isMock ? 'neutral' : 'accent'}`}>{v.isMock ? '模拟' : v.providerId}</Badge><span className="spacer" />{shot.selectedVersionId === v.id && <Icon name="check" size={16} />}</div><p>{v.snapshot?.prompt || '未填写提示词'}</p><p className="version-generation-specs">{v.model || v.snapshot?.model || v.providerId} · {v.snapshot?.duration}s · {v.snapshot?.aspectRatio} · {v.snapshot?.referenceAssetIds?.length || 0} 张参考</p>{v.snapshot?.subjectReference ? <SubjectVideoSummary reference={v.snapshot.subjectReference} assets={assets} latestSubject={subjects?.state?.subjects[v.snapshot.subjectReference.subjectVersion?.subjectId]} compact /> : <VideoFrameSummary shot={v.snapshot} assets={assets} frozen compact />}<div className="version-card-footer"><span>{new Date(v.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><Button variant="ghost" size="sm" className="button small" disabled={shot.selectedVersionId === v.id || busy[`version:${shot.id}`]} onClick={() => onSelectVersion(shot, v.id)}>{shot.selectedVersionId === v.id ? '当前选用' : '选用此版本'}</Button></div><Button variant="ghost" size="sm" className="button small full version-to-timeline" disabled={!v.assetId} onClick={() => onAddVersion(v.assetId)}>将此固定版本加入时间线</Button></div>) : <div className="small-empty"><Icon name="layers" size={28} /><h4>还没有生成版本</h4><p>每次生成都保存为独立版本。你可以随时比较、切换，不会覆盖已有结果。</p><Button variant="ghost" size="sm" className="button" onClick={() => setTab('settings')}>开始创作</Button></div>}</TabsContent><TabsContent value="settings">
      {shot.selectedVersionId && <Button variant="ghost" size="sm" className="button small full version-to-timeline" data-testid="selected-version-to-timeline" onClick={() => { const selected = versions.find(v => v.id === shot.selectedVersionId); if (selected?.assetId) onAddVersion(selected.assetId); }}>当前选用版本 → 时间线（固定副本）</Button>}
      <div className="section-eyebrow">SHOT {String(shot.orderIndex + 1).padStart(2, '0')}<Badge className={`small-badge ${dirty ? 'warn' : 'neutral'}`}>{dirty ? '未保存' : '已同步'}</Badge></div>
      <Label className="field-label" htmlFor="shot-title">镜头名称</Label><Input id="shot-title" data-testid="shot-title" value={draft.title} onChange={e => edit('title', e.target.value)} maxLength={shotTextContext ? LOCAL_SHOT_TEXT_LIMITS.rawTitleUnits : 150} />
      <Label className="field-label" htmlFor="shot-prompt"><span>画面描述</span><span className="optional">PROMPT</span></Label><Textarea id="shot-prompt" data-testid="shot-prompt" className="prompt-input" rows={6} maxLength={shotTextContext ? LOCAL_SHOT_TEXT_LIMITS.rawPromptUnits : 5000} value={draft.prompt} onChange={e => edit('prompt', e.target.value)} placeholder="描述主体、动作、环境与镜头运动。例如：镜头缓慢推近，晨光穿过薄雾…" /><p className="input-hint">描述越具体，越接近你心中的画面。{capabilities?.maxPromptLength && <span> {draft.prompt.length} / {capabilities.maxPromptLength} 字符</span>}</p>
      {shotTextContext && <ShotTextDraftRecovery state={shotText.state} controller={shotText.controller} canSave={shotText.controller.canPrepare() && Boolean(draft.title.trim())} disabled={!visible || tab !== 'settings' || currentTextContext().busy} onInspect={onInspect} />}
      {textBlocksLegacy && <p className="input-hint" data-testid="shot-text-save-order">请先保存标题和提示词或处理文字恢复记录，再保存其余参考图和生成参数。完整“保存修改”不会跳过文字修改。</p>}
      {subjects && <ShotSubjectBindings shot={shot} subjects={subjects} assets={assets} blocked={subjectBlocked} onShowTasks={onOpenJobs} />}
      <ProviderSettings providers={providers} provider={provider} model={model} capabilities={capabilities} onChange={updateGeneration} />
      <SubjectVideoSelection shot={shot} draft={draft} subjects={subjects} assets={assets} provider={provider} model={model} options={generationOptions} disabled={referenceBlocked || subjectBlocked} boundReference={Boolean(boundReference)} onChange={patch => { if (frameActionAllowed()) updateGeneration(patch); }} />
      <Label className="field-label" htmlFor="generation-input-mode">生成方式</Label>
      <WorkbenchSelect id="generation-input-mode" data-testid="input-mode-select" disabled={referenceLocked || Boolean(shotTextContext && shotText.state.pending)} value={inputMode} onChange={e => changeInputMode(e.target.value)}>{inputModes.map(mode => <option key={mode} value={mode}>{inputModeLabel(mode)}{mode === 'subject' || capabilities?.inputModes?.includes(mode) ? '' : ' · 不支持'}</option>)}</WorkbenchSelect>
      <BoundReference edge={boundReference} nodes={nodes} assets={assets} busy={referenceBusy || Boolean(shotTextContext && shotText.state.pending)} pending={referencePending} dirty={dirty} conflict={conflict} onDetach={onDetachReference} onInspect={onInspect} />
      {referencePending && !boundReference && <div className="notice warning" data-testid="reference-pending">首帧连接操作结果待确认。请在任务面板恢复同一请求，再保存或生成。<Button variant="ghost" size="sm" onClick={onOpenJobs}>打开任务</Button></div>}
      {inputMode === 'subject' && !subjectVideoConflictIssue(draft, { savedShot: shot, boundReference }) ? <p className="input-hint">本次发送上方明确固定的主体图片；不会读取策划关联或修改画面描述。</p> : inputMode === 'text' ? <p className="input-hint" data-testid="text-mode-hint">只发送画面描述与生成参数，不发送参考图。选择图生视频可使用首帧图片。</p> : <>
        <div className="field-label"><span>首帧参考图</span><span className="optional">已选 {draft.referenceAssetIds.length}</span></div>
        <div className="reference-grid">{referenceAssets.map(a => <Button variant="ghost" size="sm" key={a.id} title={a.name} className={`reference-choice ${draft.referenceAssetIds.includes(a.id) ? 'selected' : ''}`} aria-label={`参考图 ${a.name}`} aria-pressed={draft.referenceAssetIds.includes(a.id)} disabled={referenceLocked || Boolean(shotTextContext && shotText.state.pending)} onClick={() => { if (!frameActionAllowed() || actionState.current.referenceLocked) return; updateGeneration({ inputMode: 'image' }); edit('referenceAssetIds', draft.referenceAssetIds.includes(a.id) ? [] : [a.id]); }}><img src={assetUrl(a)} alt={a.name} />{draft.referenceAssetIds.includes(a.id) && <span><Icon name="check" size={11} /></span>}</Button>)}{!referenceAssets.length && <p className="reference-empty">先在左侧导入一张图片作为参考。</p>}</div>
        {!boundReference && draft.referenceAssetIds.length > 0 && <Button variant="ghost" size="sm" className="text-button clear-manual-references" data-testid="clear-manual-references" disabled={referenceBlocked || Boolean(shotTextContext && shotText.state.pending)} onClick={clearManualReferences}>清除手动参考图选择</Button>}
        {boundReference && <p className="input-hint">参考图由首帧连接管理，断开后才能手动选择。</p>}
        {imageRules && <p className="input-hint" data-testid="reference-requirements">首帧图片{imageRules.mimeTypes?.length ? ` · ${imageRules.mimeTypes.map(type => type.replace('image/', '').toUpperCase()).join(' / ')}` : ''}{imageRules.minDimension ? ` · 最短边至少 ${imageRules.minDimension}px` : ''}{imageRules.maxDimension ? ` · 最长边不超过 ${imageRules.maxDimension}px` : ''}{imageRules.matchAspectRatio ? ' · 图片比例必须与镜头一致' : ''}</p>}
        <VideoFrameControls draft={draft} assets={referenceAssets} disabled={referenceBlocked || !visible || Boolean(shotTextContext && shotText.state.pending)} onChoose={chooseLastFrame} onClear={clearLastFrame} />
        <VideoFrameSummary shot={draft} assets={assets} />
      </>}
      <div className="field-row"><div><Label className="field-label" htmlFor="shot-ratio">画面比例</Label><WorkbenchSelect id="shot-ratio" data-testid="shot-ratio" value={draft.aspectRatio} onChange={e => edit('aspectRatio', e.target.value)}>{[...new Set([...ratios, draft.aspectRatio])].map(r => <option key={r} value={r}>{r}{ratios.includes(r) ? '' : ' · 不支持'}</option>)}</WorkbenchSelect></div><div><Label className="field-label" htmlFor="shot-duration">镜头时长</Label><WorkbenchSelect id="shot-duration" data-testid="shot-duration" value={draft.duration} onChange={e => edit('duration', Number(e.target.value))}>{[...new Set([...durations, draft.duration])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d} 秒{durations.includes(d) ? '' : ' · 不支持'}</option>)}</WorkbenchSelect></div></div>
      {conflict && <div className="notice warning">此镜头已在别处更新。你的输入还在，请先载入最新内容再继续。<Button variant="ghost" size="sm" onClick={reset}>载入最新内容</Button></div>}
      {dirty && <div className="save-row"><Button size="sm" className="button primary" data-testid="save-shot" disabled={textBlocksLegacy || referenceBlocked || !draft.title.trim() || busy[`save:${shot.id}`]} onClick={save}><Icon name="check" size={15} />保存修改</Button><Button variant="ghost" size="sm" className="text-button" onClick={reset}>放弃修改</Button></div>}
      <Separator className="section-divider" />
      <Collapsible open={advanced} onOpenChange={setAdvanced}><CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="advanced-toggle h-auto"><span>高级参数</span><Icon name={advanced ? 'minus' : 'plus'} size={15} /></CollapsibleTrigger><CollapsibleContent className="advanced-fields">{provider?.mock && <><Label className="field-label" htmlFor="mock-scenario">模拟场景</Label><WorkbenchSelect id="mock-scenario" data-testid="mock-scenario" value={scenario} onChange={e => updateGeneration({ scenario: e.target.value })}><option value="success">正常完成</option><option value="failure">明确失败（可手动重试）</option><option value="delay">延迟完成</option><option value="timeout">请求超时</option><option value="unknown">提交状态未知（禁止重提）</option></WorkbenchSelect></>}{(seedSupported || draft.parameters.seed !== undefined) && <><Label className="field-label" htmlFor="seed">随机种子（可选）{!seedSupported && <span className="optional">此模型不支持，请清空</span>}</Label><Input id="seed" type="number" min={capabilities?.seed?.min} max={capabilities?.seed?.max} step="1" value={draft.parameters.seed ?? ''} onChange={e => { const params = { ...draft.parameters }; if (e.target.value === '') delete params.seed; else params.seed = Number(e.target.value); edit('parameters', params); }} placeholder="自动" />{capabilities?.seed && <p className="input-hint">整数范围 {capabilities.seed.min}–{capabilities.seed.max}</p>}</>}<>{unsupportedParameters.length > 0 && <div className="notice warning"><p>此模型不支持：{unsupportedParameters.join('、')}</p><Button variant="ghost" size="sm" onClick={() => edit('parameters', Object.fromEntries(Object.entries(draft.parameters).filter(([key]) => !unsupportedParameters.includes(key))))}>清除不支持的参数</Button></div>}</><p className="helper muted">参数和参考图随每次生成保存快照，修改镜头不会改变历史版本。</p></CollapsibleContent></Collapsible>
    </TabsContent>
    {shotJobs[0] && <div className={`latest-job ${shotJobs[0].status === 'submission_unknown' || outputReviewRequired(shotJobs[0]) ? 'warning' : ''}`}><Button variant="ghost" size="sm" onClick={onOpenJobs}><Icon name="clock" size={15} /><span>{jobStatusText(shotJobs[0])}</span><Icon name="arrow" size={13} /></Button>{shotJobs[0].snapshot?.subjectReference && <SubjectVideoSummary reference={shotJobs[0].snapshot.subjectReference} assets={assets} compact />}{running && <div className="progress-track"><span style={{ width: `${Math.max(3, running.progress || 0)}%` }} /></div>}{outputReviewRequired(shotJobs[0]) && <p>{outputReviewMessage}</p>}{shotJobs[0].status === 'submission_unknown' && <p>服务商可能已接受任务并计费。先核实状态，不要重复提交。</p>}</div>}
    </div></ScrollArea></Tabs><footer className="inspector-action">{(generationUnavailableReason || capabilityIssue || availabilityIssue) && <p className="capability-issue" data-testid="generation-issue" role="status"><Icon name="info" size={13} />{generationUnavailableReason || capabilityIssue || availabilityIssue}</p>}{!generationUnavailableReason && !capabilityIssue && !availabilityIssue && (textBlocksLegacy || !draft.title.trim()) && <p className="capability-issue" data-testid="generation-save-first" role="status"><Icon name="info" size={13} />{textBlocksLegacy ? '先点上方“保存标题和提示词”，再生成镜头。' : '镜头名称不能为空。'}</p>}<Button size="sm" className="button generate-button full" data-testid="generate-shot" title={generationUnavailableReason || undefined} disabled={textBlocksLegacy || generating || referenceBlocked || Boolean(capabilityIssue) || !draft.title.trim() || Boolean(availabilityIssue) || busy[`save:${shot.id}`]} onClick={generate}>{generating ? <span className="spinner" /> : <Icon name="sparkle" size={17} />}{generating ? `${statusText(running?.status || 'queued')}` : dirty && !textBlocksLegacy ? '保存并生成镜头' : '生成镜头'}<span className="button-shortcut">{draft.duration}s</span></Button></footer>
  </aside>;
}
