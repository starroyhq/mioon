import { Badge } from '@video-workbench/ui/components/badge';
import { useConfirmation } from '@video-workbench/ui/components/workbench-confirm';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@video-workbench/ui/components/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator } from '@video-workbench/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@video-workbench/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@video-workbench/ui/components/collapsible';
import { WorkbenchTooltip } from '@video-workbench/ui/components/workbench-tooltip';
import { Button } from '@video-workbench/ui/components/button';
import { Input } from '@video-workbench/ui/components/input';
import { Textarea } from '@video-workbench/ui/components/textarea';
import { Label } from '@video-workbench/ui/components/label';
import { WorkbenchSelect } from '@video-workbench/ui/components/workbench-select';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, useReactFlow } from '@xyflow/react';
import Icon from './icons.jsx';
import Inspector from './Inspector.jsx';
import AssetLibrary from './AssetLibrary.jsx';
import Timeline, { ASSET_DRAG, assetKind, dragAsset } from './Timeline.jsx';
import TimelineInspector from './TimelineInspector.jsx';
import Preview from './Preview.jsx';
import { Media, nodeTypes } from './Nodes.jsx';
import { rpc, requestId, activeJob, assetUrl, statusText, versionUrl, jobStatusText, outputReviewRequired, outputReviewMessage } from './api.js';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel } from './generation-settings.js';
import { pendingForProject, prepareSubmission, clearPending, reconcilePending } from './submissions.js';
import { timelineHistoryState } from './timeline-history.js';
import { timelineHistoryActionForKey } from './timeline-keyboard.js';

const emptyData = { project: null, assets: [], shots: [], nodes: [], edges: [], jobs: [], versions: [], exports: [], timeline: null, timelineHistory: null };
function readableError(error) {
  if (error.code === 'CONFLICT' || error.code === 'REVISION_CONFLICT') return '保存冲突：内容已在其他窗口更新。已刷新最新状态，请检查后再保存。';
  if (['CLIP_OVERLAP', 'TIMELINE_OVERLAP', 'OVERLAP'].includes(error.code) || /overlap/i.test(error.message || '')) return '同一轨道的片段不能重叠。请调整开始帧，或移到另一条兼容轨道；你的输入仍保留。';
  if (error.code === 'UNAUTHORIZED') return '会话已过期，请重新登录。';
  return error.message || '操作未完成，请检查连接后重试。';
}
function Login({ onLogin }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      const result = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!result.ok) throw new Error('访问令牌无效，请使用服务器配置的工作台令牌。');
      setToken(''); await onLogin();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  return <div className="login-page"><div className="login-atmosphere" /><div className="login-visual"><div className="brand large"><span className="brand-mark"><Icon name="film" size={23} /></span>frame<span className="brand-period">.</span></div><div className="login-headline"><div className="eyebrow">YOUR IDEAS, IN MOTION</div><h1>让每一个想法，<br />都有自己的镜头。</h1><p>从一张参考图出发，在无限画布中构思故事。<br />生成、比较、编排，让灵感一步步成为影像。</p></div><div className="login-footnote"><span className="status-dot green" />私有工作区 · 本地媒体管理 · 版本可追溯</div></div><div className="login-form-wrap"><form className="login-form" onSubmit={submit}><span className="login-icon"><Icon name="lock" size={23} /></span><h2>进入你的影像工作台</h2><p>使用工作台访问令牌登录。令牌仅用于建立安全会话。</p><Label className="field-label" htmlFor="access-token">访问令牌</Label><Input id="access-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder="输入工作台令牌" required autoFocus />{error && <div className="notice error" role="alert">{error}</div>}<Button variant="ghost" className="button primary full" type="submit" disabled={loading || !token}>{loading ? <span className="spinner" /> : <Icon name="arrow" size={16} />}进入工作台</Button><div className="login-security"><Icon name="lock" size={13} />服务商 API 密钥始终留在服务器</div></form></div></div>;
}
function Modal({ title, subtitle, children, onClose, wide = false }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={`modal ${wide ? 'wide' : ''}`} showCloseButton={false}><header className="modal-header"><div><DialogTitle>{title}</DialogTitle><DialogDescription className={subtitle ? '' : 'sr-only'}>{subtitle || title}</DialogDescription></div><DialogClose render={<Button variant="ghost" className="icon-button" aria-label="关闭对话框" />}><Icon name="close" /></DialogClose></header>{children}</DialogContent></Dialog>;
}
function Comparison({ shot, versions, onClose, onSelect, busy }) {
  const ordered = versions.filter(v => v.shotId === shot.id).sort((a, b) => b.number - a.number);
  const [left, setLeft] = useState(ordered[1]?.id || ordered[0]?.id);
  const [right, setRight] = useState(ordered[0]?.id);
  return <Modal title="版本对比" subtitle={`${shot.title} · 每个版本保留独立的生成参数与参考图快照`} onClose={onClose} wide><div className="comparison-grid">{[[left, setLeft, 'A'], [right, setRight, 'B']].map(([id, setter, label]) => { const version = ordered.find(v => v.id === id); return <div className="comparison-column" key={label}><div className="comparison-title"><span>{label}</span><WorkbenchSelect aria-label={`对比版本 ${label}`} value={id} onChange={e => setter(e.target.value)}>{ordered.map(v => <option value={v.id} key={v.id}>版本 {v.number}{v.isMock ? ' · 模拟' : ` · ${v.providerId}`}</option>)}</WorkbenchSelect></div><div className="comparison-media"><Media version={version} controls /></div><div className="comparison-specs"><span>{version?.snapshot?.aspectRatio || shot.aspectRatio}</span><span>{version?.snapshot?.duration || shot.duration} 秒</span><span>{version?.model || version?.providerId}</span></div><p className="comparison-prompt">{version?.snapshot?.prompt || '没有画面描述'}</p><Button variant="ghost" className={`button full ${shot.selectedVersionId === id ? '' : 'primary'}`} disabled={shot.selectedVersionId === id || busy} onClick={() => onSelect(shot, id)}><Icon name="check" size={16} />{shot.selectedVersionId === id ? '当前选用版本' : `选用版本 ${version?.number}`}</Button></div>; })}</div><div className="modal-note"><Icon name="info" size={15} />选用版本更新镜头预览与后续分镜导出；已有时间线片段和导出文件保持独立。</div></Modal>;
}
function CreateProject({ onClose, onCreate, busy }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  return <Modal title="开始一个新故事" subtitle="为这次创作命名，随时可以继续回来。" onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onCreate(name.trim(), description.trim()); }}><Label className="field-label" htmlFor="project-name">项目名称</Label><Input id="project-name" data-testid="project-name" value={name} onChange={e => setName(e.target.value)} placeholder="例如：山野之间 · 秋日短片" maxLength={150} required autoFocus /><Label className="field-label" htmlFor="project-description">创作方向 <span className="optional">可选</span></Label><Textarea id="project-description" rows={3} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} placeholder="关于这个故事，你最想表达什么？" /><Button variant="ghost" className="button primary full" data-testid="create-project-submit" disabled={!name.trim() || busy} type="submit"><Icon name="plus" size={16} />创建项目</Button></form></Modal>;
}

export default function App() {
  const confirm = useConfirmation();
  const [auth, setAuth] = useState(null);
  const [data, setData] = useState(emptyData);
  const dataRef = useRef(data); dataRef.current = data;
  const [projects, setProjects] = useState([]);
  const [providers, setProviders] = useState([]);
  const [generationOptions, setGenerationOptions] = useState({});
  const generationOptionsRef = useRef(generationOptions); generationOptionsRef.current = generationOptions;
  const updateGenerationOptions = useCallback((shotId, options) => { if (shotId) setGenerationOptions(current => ({ ...current, [shotId]: options })); }, []);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState({});
  const busyRef = useRef(new Set());
  const [toast, setToast] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [tab, setTab] = useState('settings');
  const [assetFilter, setAssetFilter] = useState('all');
  const [assetSearch, setAssetSearch] = useState('');
  const [showProjects, setShowProjects] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [showExports, setShowExports] = useState(false);
  const [comparisonId, setComparisonId] = useState(null);
  const [previewAsset, setPreviewAsset] = useState(null);
  const [realConfirm, setRealConfirm] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [shotDirty, setShotDirty] = useState(false);
  const [clipDirty, setClipDirty] = useState(false);
  const inspectorDirty = shotDirty || clipDirty;
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [workspaceMode, setWorkspaceMode] = useState('canvas');
  const [previewKind, setPreviewKind] = useState('source');
  const [quickAssetId, setQuickAssetId] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const [assetsCollapsed, setAssetsCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [sequenceOpen, setSequenceOpen] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [online, setOnline] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [miniMap, setMiniMap] = useState(false);
  const [mobilePanel, setMobilePanel] = useState('canvas');
  const [sequenceDrag, setSequenceDrag] = useState(null);
  useEffect(() => { setSequenceOpen(data.shots.length > 0); }, [data.project?.id, data.shots.length]);
  const [pending, setPending] = useState([]);
  const [reconcileIds, setReconcileIds] = useState({});
  const fileInput = useRef(null);
  const currentProject = useRef(null);
  const requestCounter = useRef(0);
  const dragging = useRef(false);
  const flow = useReactFlow();
  const notify = useCallback((message, type = 'success') => setToast({ message, type, time: Date.now() }), []);
  useEffect(() => { if (toast && toast.type !== 'error') { const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); } }, [toast]);
  const refresh = useCallback(async (projectId = currentProject.current, quiet = true) => {
    if (!projectId) return null;
    const call = ++requestCounter.current;
    try {
      const [next, caps] = await Promise.all([rpc('project.get', { projectId }), rpc('provider.list')]);
      if (currentProject.current === projectId && call === requestCounter.current) { dataRef.current = { ...emptyData, ...next }; setData(dataRef.current); setProviders(caps); setLastSync(new Date()); setOnline(true); reconcilePending(projectId, next); setPending(pendingForProject(projectId)); }
      return next;
    } catch (e) { if (e.code === 'UNAUTHORIZED') setAuth(false); setOnline(false); if (!quiet) notify(readableError(e), 'error'); return null; }
  }, [notify]);
  const selectProject = useCallback(async (id, initial = false) => {
    if (!initial && inspectorDirty && !await confirm('当前镜头有未保存的修改。放弃修改并打开另一个项目？')) return;
    currentProject.current = id; setShowProjects(false); setSelectedId(null); setSelectedClipId(null); setQuickAssetId(null); setPlayhead(0); setData(emptyData); setNodes([]); setLoading(true);
    const url = new URL(window.location.href); url.searchParams.set('project', id); window.history.replaceState({}, '', url); localStorage.setItem('frame.project', id);
    const next = await refresh(id, false); setLoading(false);
    const first = next?.shots?.length ? [...next.shots].sort((a, b) => a.orderIndex - b.orderIndex)[0] : next?.nodes?.find(n => n.type !== 'text') || next?.nodes?.[0];
    if (first) setSelectedId(first.id);
    setTimeout(() => { if (first) flow.fitView({ nodes: [{ id: first.id }], padding: 0.35, duration: 350, minZoom: .75, maxZoom: 1 }); }, 180);
  }, [refresh, inspectorDirty, flow]);
  async function boot() {
    try {
      const [list, caps] = await Promise.all([rpc('project.list'), rpc('provider.list')]);
      setProjects(list); setProviders(caps); setAuth(true); setOnline(true);
      const desired = new URLSearchParams(window.location.search).get('project') || localStorage.getItem('frame.project');
      const found = list.find(p => p.id === desired) || list[0];
      if (found) await selectProject(found.id, true);
      else { setData(emptyData); currentProject.current = null; }
    } catch (e) { if (e.code === 'UNAUTHORIZED') setAuth(false); else { setAuth('error'); notify(readableError(e), 'error'); } }
  }
  useEffect(() => { boot(); }, []);
  useEffect(() => { if (!inspectorDirty) return; const warn = e => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [inspectorDirty]);
  useEffect(() => { if (showProjects) rpc('project.list').then(setProjects).catch(e => notify(readableError(e), 'error')); }, [showProjects]);
  useEffect(() => {
    if (!auth || !data.project?.id) return;
    const timer = setInterval(() => { if (!dragging.current && document.visibilityState === 'visible') refresh(); }, 2500);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [auth, data.project?.id, refresh]);
  async function run(key, operation, input, message) {
    if (busyRef.current.has(key)) return null;
    busyRef.current.add(key); setBusy(b => ({ ...b, [key]: true }));
    const durable = ['generation.submit', 'job.retry', 'export.create'].includes(operation) || operation.startsWith('timeline.');
    const projectId = currentProject.current;
    const timelineMutation = operation.startsWith('timeline.') && operation !== 'timeline.render';
    const invalidateHistory = () => {
      if (!timelineMutation || currentProject.current !== projectId) return;
      // An earlier poll, mutation replay, or failed refresh must not re-enable
      // controls from a history snapshot that predates the dispatched edit.
      ++requestCounter.current;
      dataRef.current = { ...dataRef.current, timelineHistory: null };
      setData(current => current.project?.id === projectId ? { ...current, timelineHistory: null } : current);
    };
    let stored, dispatched = false;
    try {
      if (durable) {
        stored = prepareSubmission({ projectId, key, operation, input, createdAt: new Date().toISOString() });
        // Reuse the exact request, including expectedRevision and parameters, after a lost response.
        input = stored.input; operation = stored.operation;
        setPending(pendingForProject(projectId));
      }
      invalidateHistory();
      dispatched = true;
      const result = await rpc(operation, input);
      invalidateHistory();
      if (durable) { clearPending(projectId, key); setPending(pendingForProject(projectId)); }
      await refresh(); if (message) notify(message); return result;
    } catch (e) {
      if (dispatched) invalidateHistory();
      if (durable && stored && e.definitive) { clearPending(projectId, key); setPending(pendingForProject(projectId)); }
      if (e.code === 'UNAUTHORIZED') setAuth(false);
      if (durable && stored && dispatched && !e.definitive) { notify('连接中断，提交结果尚未确认。请求已保留，请在任务面板恢复同一请求；不会生成新的提交编号。', 'error'); setShowJobs(true); }
      else notify(readableError(e), 'error');
      await refresh(); return null;
    } finally { busyRef.current.delete(key); setBusy(b => ({ ...b, [key]: false })); }
  }
  async function inspect(id, nextTab = 'settings') {
    if (id !== selectedId && shotDirty && !await confirm('当前镜头有未保存的修改。放弃修改并切换？')) return;
    if (selectedClipId && clipDirty && !await confirm('当前片段有未保存修改。放弃修改并切换到镜头或节点？')) return;
    setSelectedClipId(null); setQuickAssetId(null); setSelectedId(id); setTab(nextTab); setInspectorCollapsed(false); setMobilePanel('inspector'); return true;
  }
  function checkGeneration(shot, provider, model, inputMode) {
    const issue = generationInputIssue(shot, provider, model, dataRef.current.assets, inputMode) || providerAvailabilityIssue(provider);
    if (issue) { notify(issue, 'error'); return false; }
    if (dataRef.current.jobs.some(j => j.shotId === shot.id && j.status === 'submission_unknown')) { notify('此镜头存在状态未知的提交，服务商可能已经计费。请先核实任务状态，不要重复提交。', 'error'); setShowJobs(true); return false; }
    return true;
  }
  const submitGeneration = async ({ shot, providerId, model, scenario, inputMode, retryJobId }) => {
    const provider = providers.find(item => item.id === providerId);
    if (!checkGeneration(shot, provider, model, inputMode)) return;
    if (retryJobId) return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, '已基于原始快照创建重试任务');
    const result = await run(`generate:${shot.id}`, 'generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: requestId(), providerId, ...(model ? { model } : {}), ...(providerId === 'mock' ? { parameters: { scenario } } : {}) });
    if (result) { notify(result.status === 'submission_unknown' ? '提交结果待确认。请查看任务状态，不要重复提交。' : '生成任务已提交，完成后会保存为新版本。', result.status === 'submission_unknown' ? 'warning' : 'success'); setShowJobs(true); }
  };
  function generate(shot, options = generationOptionsRef.current[shot.id] || {}) {
    const { provider, model, scenario, inputMode } = generationSelection(providers, options, shot);
    if (!checkGeneration(shot, provider, model, inputMode)) return;
    const args = { shot, providerId: provider.id, model, scenario, inputMode };
    if (!provider.mock) setRealConfirm(args); else submitGeneration(args);
  }
  function retryGeneration(job) {
    const provider = providers.find(item => item.id === job.providerId);
    const shot = { ...job.snapshot, id: job.shotId };
    const inputMode = shot.referenceAssetIds?.length ? 'image' : 'text';
    if (!checkGeneration(shot, provider, job.model, inputMode)) return;
    const args = { shot, providerId: job.providerId, model: job.model, inputMode, retryJobId: job.id };
    if (!provider.mock) { setShowJobs(false); setRealConfirm(args); } else submitGeneration(args);
  }
  async function createProject(name, description) {
    const created = await run('project-create', 'project.create', { name, description });
    if (created) { setProjects(await rpc('project.list')); setShowCreate(false); await selectProject(created.id, true); notify('项目已创建。导入素材，开始你的第一个镜头。'); }
  }
  async function addShot() {
    if (!data.project) return setShowCreate(true);
    const count = data.shots.length;
    const shot = await run('shot-create', 'shot.create', { projectId: data.project.id, title: `镜头 ${String(count + 1).padStart(2, '0')}`, prompt: '', duration: 2, aspectRatio: '9:16', referenceAssetIds: [], position: { x: 350 + (count % 3) * 330, y: Math.floor(count / 3) * 430 + 80 } });
    if (shot) { inspect(shot.id); setTimeout(() => flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1 }), 100); }
  }
  async function addStructure() {
    if (!data.project || busyRef.current.has('structure')) return;
    busyRef.current.add('structure'); setBusy(b => ({ ...b, structure: true }));
    const base = data.shots.length;
    const firstImage = data.assets.find(a => a.mimeType.startsWith('image/'));
    try {
      for (const [i, title] of ['建立场景', '展开故事', '留下余韵'].entries()) await rpc('shot.create', { projectId: data.project.id, title: `${String(base + i + 1).padStart(2, '0')} · ${title}`, prompt: '', referenceAssetIds: firstImage ? [firstImage.id] : [], duration: 2, aspectRatio: '9:16', position: { x: 100 + i * 340, y: 130 } });
      const next = await refresh(); if (next) inspect(next.shots.find(s => s.orderIndex === base)?.id); notify('三个镜头已准备好，逐个写下画面描述。'); setTimeout(() => flow.fitView({ padding: 0.18, duration: 350, maxZoom: 1 }), 100);
    } catch (e) { notify(readableError(e), 'error'); await refresh(); } finally { busyRef.current.delete('structure'); setBusy(b => ({ ...b, structure: false })); }
  }
  async function addNode(type, asset, dropPosition) {
    if (!data.project) return setShowCreate(true);
    if (type !== 'text' && !asset) { asset = data.assets.find(a => a.mimeType.startsWith(`${type}/`)); if (!asset) { notify(`请先导入${type === 'image' ? '图片' : type === 'audio' ? '音频' : '视频'}素材。`, 'warning'); fileInput.current?.click(); return; } }
    const location = dropPosition || flow.screenToFlowPosition({ x: window.innerWidth * 0.43, y: window.innerHeight * 0.35 });
    const node = await run('node-create', 'node.create', { projectId: data.project.id, type, label: type === 'text' ? '创作笔记' : asset.name, ...(type === 'text' ? { text: '' } : { assetId: asset.id }), position: location });
    if (node) { inspect(node.id); setWorkspaceMode('canvas'); setTimeout(() => flow.fitView({ nodes: [{ id: node.id }], padding: .35, minZoom: .75, maxZoom: 1, duration: 250 }), 100); }
  }
  async function importFiles(files) {
    if (!data.project) return setShowCreate(true);
    if (!files?.length || busyRef.current.has('import')) return;
    const projectId = data.project.id; busyRef.current.add('import'); setBusy(b => ({ ...b, import: true }));
    let done = 0;
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'].includes(file.type)) throw new Error(`「${file.name}」格式不支持。请使用 PNG、JPG、WEBP、MP4、WEBM、MP3、WAV 或 M4A。`);
        if (file.size > 30 * 1024 * 1024) throw new Error(`「${file.name}」超过 30 MiB，请压缩后导入。`);
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        await rpc('asset.import', { projectId, name: file.name, mimeType: ({ 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4' }[file.type] || file.type), dataBase64: base64 }); done++;
      }
      notify(`已导入 ${done} 个素材。拖入画布或时间线，即可开始编排。`);
    } catch (e) { notify(`${done ? `已导入 ${done} 个素材。` : ''}${readableError(e)}`, 'error'); }
    finally { await refresh(projectId); busyRef.current.delete('import'); setBusy(b => ({ ...b, import: false })); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function saveShot(shotId, expectedRevision, patch) { return run(`save:${shotId}`, 'shot.update', { shotId, expectedRevision, patch }, '镜头已保存'); }
  async function saveNode(nodeId, expectedRevision, patch) { return run(`save:${nodeId}`, 'node.update', { nodeId, expectedRevision, patch }, '节点已保存'); }
  async function savePosition(_, node) {
    const snapshot = dataRef.current;
    const record = snapshot.shots.find(s => s.id === node.id) || snapshot.nodes.find(n => n.id === node.id);
    if (record) await run(`position:${node.id}`, snapshot.shots.some(s => s.id === node.id) ? 'shot.update' : 'node.update', { [snapshot.shots.some(s => s.id === node.id) ? 'shotId' : 'nodeId']: record.id, expectedRevision: record.revision, patch: { position: node.position } });
    dragging.current = false;
  }
  async function connect(connection) {
    if (connection.source === connection.target) return notify('请选择两个不同的节点。', 'warning');
    await run(`edge:${connection.source}:${connection.target}`, 'edge.create', { projectId: data.project.id, source: connection.source, target: connection.target });
  }
  async function selectVersion(shot, versionId) { return run(`version:${shot.id}`, 'version.select', { shotId: shot.id, versionId, expectedRevision: shot.revision }, '已更新当前选用版本'); }
  async function reorder(id, targetIndex) {
    const ordered = [...dataRef.current.shots].sort((a, b) => a.orderIndex - b.orderIndex); const from = ordered.findIndex(s => s.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ordered.length || from === targetIndex) return;
    ordered.splice(targetIndex, 0, ordered.splice(from, 1)[0]);
    await run('reorder', 'shot.reorder', { projectId: data.project.id, expectedRevision: dataRef.current.project.revision, shotIds: ordered.map(s => s.id) }, '分镜顺序已更新，画布位置保持独立');
  }
  async function createExport() { const result = await run('export', 'export.create', { projectId: data.project.id, requestId: requestId() }); if (result) { setShowExports(true); notify('导出任务已创建，将按分镜板顺序拼接选用版本。'); } }
  const timeline = data.timeline;
  const timelinePending = pending.some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render');
  const timelineBusy = Boolean(busy['timeline:mutation'] || timelinePending);
  const historyState = timelineHistoryState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty, online: online && auth === true && !loading });
  function changeTimelineHistory(direction) {
    if (!['undo', 'redo'].includes(direction) || currentProject.current !== dataRef.current.project?.id) return null;
    const latest = timelineHistoryState({ projectId: currentProject.current, timeline: dataRef.current.timeline, history: dataRef.current.timelineHistory, busy: busyRef.current.has('timeline:mutation'), pending: timelinePending, dirty: clipDirty, online: online && auth === true && !loading });
    if (!(direction === 'undo' ? latest.canUndo : latest.canRedo)) return null;
    return mutateTimeline(`timeline.${direction}`);
  }
  useEffect(() => {
    const onKeyDown = event => {
      const direction = timelineHistoryActionForKey(event, { modalOpen: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) });
      if (!direction || !(direction === 'undo' ? historyState.canUndo : historyState.canRedo)) return;
      event.preventDefault();
      changeTimelineHistory(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  async function mutateTimeline(operation, input = {}, expectedRevision) {
    if (!dataRef.current.timeline) return null;
    if (timelinePending) { notify('上一条时间线操作的结果尚未确认。请先恢复同一请求，再继续编辑。', 'warning'); setShowJobs(true); return null; }
    return run('timeline:mutation', operation, { projectId: currentProject.current, expectedRevision: expectedRevision ?? dataRef.current.timeline.revision, requestId: requestId(), ...input });
  }
  async function selectClip(id, showPreview = true) {
    if (id !== selectedClipId && clipDirty && !await confirm('当前片段有未保存修改。放弃修改并切换片段？')) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === id);
    setSelectedClipId(id); setQuickAssetId(null); setInspectorCollapsed(false);
    if (clip) setPlayhead(clip.startFrame);
    if (showPreview) { setWorkspaceMode('preview'); setPreviewKind('source'); }
  }
  async function addTimelineAsset(assetId, trackId, startFrame) {
    if (clipDirty && !await confirm('当前片段有未保存修改。放弃修改并加入新片段？')) return;
    const state = dataRef.current; const asset = state.assets.find(a => a.id === assetId); const tl = state.timeline;
    if (!asset || !tl) return;
    const kind = assetKind(asset) === 'audio' ? 'audio' : 'video';
    const track = tl.tracks.find(t => t.id === trackId) || (!trackId && tl.tracks.find(t => t.kind === kind));
    if (!track || track.kind !== kind) { notify(`此素材需要${kind === 'audio' ? '音频' : '画面'}轨道。请拖到兼容轨道。`, 'warning'); return; }
    const durationFrames = assetKind(asset) === 'image' ? 90 : Math.max(1, Math.floor(Number(asset.duration || 2) * 30 + 1e-6));
    const start = startFrame ?? Math.max(0, ...tl.clips.filter(c => c.trackId === track.id).map(c => c.startFrame + c.durationFrames));
    const before = new Set(tl.clips.map(c => c.id));
    const result = await mutateTimeline('timeline.clip.add', { trackId: track.id, assetId, name: asset.name, startFrame: start, durationFrames, sourceInFrame: 0 });
    if (result) { const added = result.clips.find(c => !before.has(c.id)); if (added) { setSelectedClipId(added.id); setPlayhead(added.startFrame); setQuickAssetId(null); setInspectorCollapsed(false); } setTimelineCollapsed(false); notify('固定素材片段已加入时间线。'); }
  }
  async function moveTimelineClip(clipId, trackId, startFrame) {
    if (clipId !== selectedClipId && clipDirty && !await confirm('当前片段有未保存修改。放弃修改并移动其他片段？')) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === clipId);
    const track = dataRef.current.timeline?.tracks.find(t => t.id === trackId);
    const asset = dataRef.current.assets.find(a => a.id === clip?.assetId);
    if (!clip || !track) return;
    if (track.kind !== (assetKind(asset) === 'audio' ? 'audio' : 'video')) { notify('画面片段与音频片段只能移动到各自兼容的轨道。', 'warning'); return; }
    const result = await mutateTimeline('timeline.clip.update', { clipId, patch: { trackId, startFrame } });
    if (result) { setSelectedClipId(clipId); setPlayhead(startFrame); }
  }
  async function renderTimeline(purpose) {
    if (!dataRef.current.timeline?.clips.length) return;
    const result = await run(`timeline:render:${purpose}`, 'timeline.render', { projectId: currentProject.current, expectedRevision: dataRef.current.timeline.revision, requestId: requestId(), purpose });
    if (result) { if (purpose === 'preview') { setWorkspaceMode('preview'); setPreviewKind('timeline'); } else setShowExports(true); notify(purpose === 'preview' ? '时间线正在渲染；完成后会自动显示可播放的合成预览。' : '时间线导出已开始，使用当前编排的固定快照。'); }
  }
  function previewSource(asset) { setQuickAssetId(asset.id); setWorkspaceMode('preview'); setPreviewKind('source'); }
  function canvasDrop(event) {
    const assetId = event.dataTransfer.getData(ASSET_DRAG);
    if (!assetId) return;
    event.preventDefault(); const asset = dataRef.current.assets.find(a => a.id === assetId);
    if (asset) addNode(assetKind(asset), asset, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }
  const sortedShots = useMemo(() => [...data.shots].sort((a, b) => a.orderIndex - b.orderIndex), [data.shots]);
  const chosenShot = data.shots.find(s => s.id === selectedId);
  const chosenNode = data.nodes.find(n => n.id === selectedId);
  const chosenClip = timeline?.clips.find(c => c.id === selectedClipId);
  const chosenVersion = data.versions.find(v => v.id === chosenShot?.selectedVersionId);
  const sourceAsset = data.assets.find(a => a.id === (quickAssetId || chosenClip?.assetId || chosenNode?.assetId || chosenVersion?.assetId || chosenShot?.referenceAssetIds?.[0]));
  const timelineJobs = [...data.exports].filter(e => e.mode === 'timeline').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const previewJob = timelineJobs.find(e => ['succeeded','completed','ready'].includes(e.status));
  const latestRender = timelineJobs[0];
  const comparisonShot = data.shots.find(s => s.id === comparisonId);
  const jobs = useMemo(() => [...data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.jobs]);
  const activeCount = jobs.filter(activeJob).length;
  const selectedCount = data.shots.filter(s => s.selectedVersionId).length;
  const orderedExports = [...data.exports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => {
    if (dragging.current) return;
    const next = [...data.nodes.map(record => ({ id: record.id, type: record.type, position: record.position, selected: record.id === selectedId, data: { record, asset: data.assets.find(a => a.id === record.assetId) } })), ...sortedShots.map((record, index) => ({ id: record.id, type: 'shot', position: record.position, selected: record.id === selectedId, data: { record, index, asset: data.assets.find(a => a.id === record.referenceAssetIds?.[0]), version: data.versions.find(v => v.id === record.selectedVersionId), versionCount: data.versions.filter(v => v.shotId === record.id).length, job: jobs.find(j => j.shotId === record.id), busy: busy[`generate:${record.id}`], generationLabel: generationSelection(providers, generationOptions[record.id], record).provider?.name, onInspect: inspect, onGenerate: async shot => { if (!await inspect(shot.id)) return; if (shot.id === selectedId && inspectorDirty) { notify('请先在右侧保存镜头修改，再生成。', 'warning'); return; } generate(shot); } } }))];
    setNodes(next);
  }, [data, sortedShots, selectedId, jobs, busy, inspectorDirty, providers, generationOptions]);
  const edges = useMemo(() => data.edges.map(e => ({ id: e.id, source: e.source, target: e.target, selected: e.id === selectedEdgeId, type: 'smoothstep', animated: false, style: { stroke: '#777d58', strokeWidth: 1.5 }, interactionWidth: 20 })), [data.edges, selectedEdgeId]);
  const visibleAssets = data.assets.filter(a => (assetFilter === 'all' || a.mimeType?.startsWith(`${assetFilter}/`)) && a.name.toLowerCase().includes(assetSearch.toLowerCase()));
  if (auth === false) return <Login onLogin={boot} />;
  if (auth === null || auth === 'error') return <div className="boot-page"><div className="brand"><span className="brand-mark"><Icon name="film" /></span>frame.</div>{auth === null ? <><span className="spinner" /><p>正在连接你的工作区…</p></> : <><h2>暂时无法连接工作台</h2><p>{toast?.message || '请确认服务器已启动。'}</p><Button variant="ghost" className="button primary" onClick={() => { setAuth(null); boot(); }}><Icon name="refresh" />重新连接</Button></>}</div>;
  return <main className={`workbench workbench-v2 mobile-${mobilePanel} ${assetsCollapsed ? 'assets-collapsed' : ''} ${inspectorCollapsed ? 'inspector-collapsed' : ''} ${timelineCollapsed ? 'timeline-collapsed' : ''}`} data-testid="workbench">
    <Input ref={fileInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" multiple aria-label="导入本地素材" data-testid="asset-upload" onChange={e => importFiles(Array.from(e.target.files))} />
    <header className="topbar"><a className="brand" href={window.location.pathname} aria-label="Frame 影像工作台"><span className="brand-mark"><Icon name="film" size={19} /></span>frame<span className="brand-period">.</span></a><span className="topbar-divider" /><DropdownMenu open={showProjects} onOpenChange={setShowProjects}><DropdownMenuTrigger render={<Button variant="ghost" className="project-trigger" data-testid="project-switcher" />}><Icon name="folder" size={16} /><span>{data.project?.name || '选择一个项目'}</span><Icon name="down" size={13} /></DropdownMenuTrigger><DropdownMenuContent align="start" className="workbench-project-menu"><DropdownMenuGroup><DropdownMenuLabel>你的项目</DropdownMenuLabel>{projects.map(p => <DropdownMenuItem key={p.id} onClick={() => selectProject(p.id)}><Icon name="folder" size={15} /><span>{p.name}</span>{p.id === data.project?.id && <Icon name="check" size={14} />}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem className="new-project-menu" onClick={() => { setShowProjects(false); setShowCreate(true); }}><Icon name="plus" size={15} />新建项目</DropdownMenuItem></DropdownMenuContent></DropdownMenu><span className="project-type">多轨工作台</span><div className="topbar-sync" title={lastSync ? `最近同步：${lastSync.toLocaleTimeString('zh-CN')}` : ''}><span className={`status-dot ${!online ? 'red' : Object.values(busy).some(Boolean) ? 'orange' : 'green'}`} />{!online ? '连接中断' : Object.values(busy).some(Boolean) ? '正在同步' : inspectorDirty ? '有未保存修改' : '已保存'}</div><div className="topbar-actions"><Button variant="ghost" className="button quiet guide-trigger" data-testid="region-guide-toggle" aria-expanded={showGuide} onClick={() => setShowGuide(!showGuide)}><Icon name="info" size={15} />区域说明</Button><Button variant="ghost" className={`button quiet ${activeCount ? 'jobs-active' : ''}`} data-testid="jobs-button" onClick={() => setShowJobs(true)}><Icon name="clock" size={16} /><span>任务</span>{activeCount > 0 && <span className="count-pill">{activeCount}</span>}</Button><WorkbenchTooltip content="查看已保存的导出与预览"><Button variant="ghost" className="button quiet export-history" aria-label="查看导出记录" onClick={() => setShowExports(true)}><Icon name="layers" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`button ${timeline?.clips.length ? 'quiet' : 'primary'}`} data-testid="export-button" disabled={!data.shots.length || selectedCount !== data.shots.length || busy.export} title={selectedCount !== data.shots.length ? '请先为每个镜头生成并选用一个版本' : '按分镜板顺序导出成片'} onClick={createExport}><Icon name="download" size={16} /><span>导出分镜</span></Button><Button variant="ghost" className="button primary" data-testid="export-timeline" disabled={!timeline?.clips.length || busy['timeline:render:export']} onClick={() => renderTimeline('export')}><Icon name="download" size={15} />导出时间线</Button><span className="avatar" title="私有工作区">F</span></div></header>
    {showGuide && <section className="region-guide" role="region" aria-label="区域说明" data-testid="region-guide"><header><strong>四个区域，一条清晰的创作路径</strong><Button variant="ghost" className="icon-button" aria-label="关闭区域说明" onClick={() => setShowGuide(false)}><Icon name="close" size={16} /></Button></header><div><p><b>01 素材库</b>导入、搜索和查看原始媒体。拖入画布或时间线。</p><p><b>02 主工作区</b>画布用空间组织想法和镜头；预览用大画面查看源素材或实际合成。</p><p><b>03 属性</b>编辑选中对象。片段的起止、源入点、位置和音量可精确输入。</p><p><b>04 多轨时间线</b>按帧编排成片的时序、叠层与混音。上层画面覆盖下层，同轨片段不重叠。</p></div><footer>画布 = 空间关系；分镜 = 故事顺序；时间线 = 最终时序。三个区域各自独立。复制到时间线后素材固定，镜头重新生成不会替换已有片段。</footer></section>}
    {assetsCollapsed && <Button variant="ghost" className="panel-reopen assets-reopen" data-testid="reopen-assets" onClick={() => setAssetsCollapsed(false)}><Icon name="folder" size={14} /><span>01 素材库</span><Icon name="arrow" size={12} /></Button>}
    <AssetLibrary assets={data.assets} filter={assetFilter} onFilter={setAssetFilter} search={assetSearch} onSearch={setAssetSearch} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} onFiles={importFiles} onPreview={previewSource} onCanvas={addNode} onTimeline={addTimelineAsset} busy={{ ...busy, timeline: timelineBusy }} collapsed={assetsCollapsed} onCollapse={() => setAssetsCollapsed(true)} project={data.project} />
    <Tabs value={workspaceMode} onValueChange={setWorkspaceMode} className="canvas-area" render={<section aria-label="02 主工作区" />}><div className="canvas-heading"><div className="region-title"><span className="region-index">02</span><h2>主工作区</h2></div><TabsList className="segmented workspace-tabs" aria-label="主工作区模式"><TabsTrigger value="canvas" data-testid="workspace-canvas" className={workspaceMode === 'canvas' ? 'active' : ''}>画布</TabsTrigger><TabsTrigger value="preview" data-testid="workspace-preview" className={workspaceMode === 'preview' ? 'active' : ''}>预览</TabsTrigger></TabsList><div className="canvas-tools" hidden={workspaceMode !== 'canvas'}><Button variant="ghost" className="button small" data-testid="add-text-node" onClick={() => addNode('text')}><Icon name="text" size={14} /><span>文字</span></Button><Button variant="ghost" className="button small" data-testid="add-image-node" onClick={() => addNode('image')}><Icon name="image" size={14} /><span>图片</span></Button><Button variant="ghost" className="button small" data-testid="add-video-node" onClick={() => addNode('video')}><Icon name="film" size={14} /><span>视频</span></Button><Button variant="ghost" className="button small accent-outline" data-testid="add-shot" disabled={busy['shot-create']} onClick={addShot}><Icon name="plus" size={15} />添加镜头</Button></div></div>
      <div className="main-stage"><TabsContent value="canvas" keepMounted className={`flow-wrap ${workspaceMode === 'canvas' ? '' : 'workspace-hidden'}`} data-testid="canvas-drop-zone" onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={canvasDrop}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))} onNodeClick={(_, node) => inspect(node.id)} onNodeDoubleClick={(_, node) => { const record = dataRef.current.nodes.find(n => n.id === node.id); const shot = dataRef.current.shots.find(s => s.id === node.id); const version = dataRef.current.versions.find(v => v.id === shot?.selectedVersionId); const asset = dataRef.current.assets.find(a => a.id === (record?.assetId || version?.assetId || shot?.referenceAssetIds?.[0])); if (asset) previewSource(asset); }} onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={savePosition} onConnect={connect} onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)} onPaneClick={() => setSelectedEdgeId(null)} onEdgesDelete={deleted => { setSelectedEdgeId(null); deleted.forEach(edge => run(`delete-edge:${edge.id}`, 'edge.delete', { edgeId: edge.id })); }} onBeforeDelete={({ edges: removed }) => Promise.resolve({ nodes: [], edges: removed.filter(edge => edge.id === selectedEdgeId) })} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} fitView fitViewOptions={{ padding: 0.16, minZoom: .65, maxZoom: 1 }} minZoom={0.2} maxZoom={1.75} snapToGrid snapGrid={[12, 12]} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']} colorMode="dark"><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#34363b" />{miniMap && <MiniMap nodeColor={n => n.type === 'shot' ? '#b6c783' : '#6c7180'} maskColor="rgba(12,13,15,.8)" pannable zoomable />}</ReactFlow>
      {!data.project && !loading && <div className="canvas-empty"><div className="empty-composition"><div className="empty-mini-card"><Icon name="text" size={19} /><span>一个想法</span></div><span className="empty-connector" /><div className="empty-main-card"><Icon name="film" size={39} /><span>无限可能</span></div><span className="empty-connector" /><div className="empty-mini-card"><Icon name="sparkle" size={19} /><span>一部作品</span></div></div><div className="eyebrow">MAKE ROOM FOR YOUR NEXT STORY</div><h1>下一部作品，从这里开始。</h1><p>把素材、灵感和镜头，放到同一张画布上。</p><Button variant="ghost" className="button primary" data-testid="empty-create-project" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} />创建第一个项目</Button></div>}
      {data.project && !nodes.length && !loading && <div className="canvas-empty"><div className="empty-canvas-symbol"><Icon name="film" size={35} /><span className="small-plus">+</span></div><div className="eyebrow">A BLANK CANVAS, A NEW PERSPECTIVE</div><h1>给故事一个开场。</h1><p>从单个镜头开始，或先搭好三幕的故事结构。</p><div className="empty-actions"><Button variant="ghost" className="button primary" onClick={addShot}><Icon name="plus" size={16} />创建镜头</Button><Button variant="ghost" className="button" data-testid="create-three-shots" disabled={busy.structure} onClick={addStructure}><Icon name="layers" size={16} />创建三镜头结构</Button></div></div>}
      {loading && <div className="canvas-loading"><span className="spinner" />正在打开项目…</div>}
      <div className="canvas-controls"><WorkbenchTooltip content="缩小画布"><Button variant="ghost" className="icon-button" aria-label="缩小" onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16} /></Button></WorkbenchTooltip><span>{zoom}%</span><WorkbenchTooltip content="放大画布"><Button variant="ghost" className="icon-button" aria-label="放大" onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16} /></Button></WorkbenchTooltip><i /><WorkbenchTooltip content="适应画布 · 保留节点位置"><Button variant="ghost" className="icon-button" aria-label="适应画布" data-testid="fit-canvas" onClick={() => flow.fitView({ padding: 0.18, duration: 350, maxZoom: 1 })}><Icon name="zoom" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`icon-button ${miniMap ? 'active' : ''}`} aria-label="显示缩略地图" aria-pressed={miniMap} onClick={() => setMiniMap(!miniMap)}><Icon name="grid" size={16} /></Button></div><div className="canvas-hint"><Icon name="link" size={12} />双击媒体放大查看 · 拖动画布平移</div>
      </TabsContent><TabsContent value="preview" keepMounted className="preview-tab-panel"><Preview visible={workspaceMode === 'preview'} kind={previewKind} onKind={setPreviewKind} asset={sourceAsset} clip={quickAssetId ? null : chosenClip} timeline={timeline} job={previewJob} pendingJob={latestRender} playhead={playhead} onSeek={setPlayhead} onRender={renderTimeline} busy={Boolean(busy['timeline:render:preview'])} onCanvas={() => setWorkspaceMode('canvas')} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} /></TabsContent></div>
    <Collapsible open={sequenceOpen} onOpenChange={setSequenceOpen} className={`storyboard ${sequenceOpen ? '' : 'sequence-collapsed'}`} render={<section aria-label="分镜顺序" />}><header><div><Icon name="film" size={16} /><h2>分镜 · 故事顺序</h2><span className="storyboard-summary">{sortedShots.length} 个镜头<span>·</span>{sortedShots.reduce((sum, s) => sum + Number(data.versions.find(v => v.id === s.selectedVersionId)?.snapshot?.duration || s.duration), 0)} 秒</span></div><span className="order-hint"><Icon name="grip" size={13} />拖动排序 · 独立于时间线</span><Button variant="ghost" className="text-button" onClick={addShot}><Icon name="plus" size={14} />添加</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={sequenceOpen ? '收起分镜' : '展开分镜'} />}><Icon name={sequenceOpen ? 'minus' : 'plus'} size={14} /></CollapsibleTrigger></header><CollapsibleContent keepMounted className="storyboard-track" data-testid="storyboard">{sortedShots.map((shot, index) => { const v = data.versions.find(v => v.id === shot.selectedVersionId); const a = data.assets.find(a => a.id === shot.referenceAssetIds?.[0]); return <div key={shot.id} className={`storyboard-shot ${selectedId === shot.id ? 'selected' : ''} ${sequenceDrag === shot.id ? 'dragging' : ''}`} data-testid={`storyboard-shot-${shot.id}`} draggable={!busy.reorder} onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', shot.id); if (v?.assetId) e.dataTransfer.setData(ASSET_DRAG, v.assetId); e.dataTransfer.effectAllowed = 'copyMove'; setSequenceDrag(shot.id); }} onDragEnd={() => setSequenceDrag(null)} onDragOver={e => { if (sequenceDrag) e.preventDefault(); }} onDrop={e => { if (sequenceDrag) { e.preventDefault(); reorder(sequenceDrag, index); setSequenceDrag(null); } }}><Button variant="ghost" className="storyboard-preview" onClick={async () => { if (!await inspect(shot.id)) return; flow.fitView({ nodes: [{ id: shot.id }], duration: 250, maxZoom: 1 }); }} aria-label={`选择分镜 ${index + 1} ${shot.title}`}><Media version={v} asset={a} /><span className="storyboard-index">{String(index + 1).padStart(2, '0')}</span><span className="storyboard-duration">{v?.snapshot?.duration || shot.duration}s</span>{v && <span className="storyboard-version">V{v.number}</span>}</Button><div className="storyboard-shot-meta"><span title={shot.title}>{shot.title}</span><div><Button variant="ghost" aria-label={`将 ${shot.title} 前移`} disabled={index === 0 || busy.reorder} onClick={() => reorder(shot.id, index - 1)}><Icon name="left" size={11} /></Button><Button variant="ghost" aria-label={`将 ${shot.title} 后移`} disabled={index === sortedShots.length - 1 || busy.reorder} onClick={() => reorder(shot.id, index + 1)}><Icon name="arrow" size={11} /></Button></div></div></div>; })}{!sortedShots.length ? <div className="storyboard-empty"><Icon name="film" size={22} /><span>镜头会出现在这里。画布负责探索，分镜板负责叙事。</span></div> : <Button variant="ghost" className="storyboard-add" aria-label="添加下一个镜头" onClick={addShot}><Icon name="plus" size={22} /><span>下一幕</span></Button>}</CollapsibleContent></Collapsible>
    </Tabs>
    {inspectorCollapsed && <Button variant="ghost" className="panel-reopen inspector-reopen" data-testid="reopen-inspector" onClick={() => setInspectorCollapsed(false)}><Icon name="left" size={12} /><span>03 属性</span><Icon name="settings" size={14} /></Button>}
    <Collapsible open={!inspectorCollapsed} onOpenChange={open => setInspectorCollapsed(!open)} className={`inspector-region ${inspectorCollapsed ? 'panel-collapsed' : ''}`} render={<section aria-label="03 属性" />}><header className="inspector-region-heading"><div className="region-title"><span className="region-index">03</span><h2>属性</h2></div><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label="收起属性" title="收起属性" data-testid="toggle-inspector" />}><Icon name="arrow" size={16} /></CollapsibleTrigger></header><CollapsibleContent keepMounted className="inspector-region-content"><div className={`inspector-container ${chosenClip ? 'inspector-hidden' : ''}`}>
    <Inspector key={selectedId || 'empty'} shot={chosenShot} node={chosenNode} project={data.project} assets={data.assets} versions={data.versions} jobs={jobs} providers={providers} generationOptions={generationOptions[selectedId]} onGenerationOptionsChange={updateGenerationOptions} tab={tab} setTab={setTab} busy={busy} onSave={saveShot} onNodeSave={saveNode} onGenerate={generate} onSelectVersion={selectVersion} onCompare={setComparisonId} onOpenJobs={() => setShowJobs(true)} onDirtyChange={setShotDirty} onAddVersion={assetId => addTimelineAsset(assetId)} />
    </div>{chosenClip && <TimelineInspector key={chosenClip.id} clip={chosenClip} timeline={timeline} asset={data.assets.find(a => a.id === chosenClip.assetId)} onSave={(clipId, patch, revision) => mutateTimeline('timeline.clip.update', { clipId, patch }, revision)} onRemove={async clipId => { const result = await mutateTimeline('timeline.clip.remove', { clipId }); if (result) setSelectedClipId(null); }} onDirtyChange={setClipDirty} busy={timelineBusy} onPreview={() => { setQuickAssetId(null); setWorkspaceMode('preview'); setPreviewKind('source'); }} />}</CollapsibleContent></Collapsible>
    <Timeline timeline={timeline} historyState={historyState} onHistory={changeTimelineHistory} assets={data.assets} selectedClipId={selectedClipId} onSelectClip={selectClip} onAddAsset={addTimelineAsset} onMoveClip={moveTimelineClip} onTrackAdd={kind => mutateTimeline('timeline.track.add', { kind })} onTrackUpdate={(trackId, patch) => mutateTimeline('timeline.track.update', { trackId, patch })} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} onRender={renderTimeline} onSeek={setPlayhead} playhead={playhead} collapsed={timelineCollapsed} onCollapse={() => setTimelineCollapsed(!timelineCollapsed)} busy={timelineBusy} canSeed={Boolean(sortedShots.length && selectedCount === sortedShots.length)} renderJob={latestRender} />
    <nav className="mobile-nav" aria-label="移动工作区导航">{[['assets', 'folder', '素材'], ['canvas', 'grid', '画布'], ['inspector', 'settings', '设置']].map(([id, icon, label]) => <Button variant="ghost" className={mobilePanel === id ? 'active' : ''} key={id} onClick={() => setMobilePanel(id)}><Icon name={icon} size={17} />{label}</Button>)}</nav>
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'success' ? 'check' : 'info'} size={17} /><span>{toast.message}</span><Button variant="ghost" className="icon-button small" aria-label="关闭提示" onClick={() => setToast(null)}><Icon name="close" size={15} /></Button></div>}
    {showCreate && <CreateProject onClose={() => setShowCreate(false)} onCreate={createProject} busy={busy['project-create']} />}
    {comparisonShot && <Comparison shot={comparisonShot} versions={data.versions} onClose={() => setComparisonId(null)} onSelect={selectVersion} busy={busy[`version:${comparisonShot.id}`]} />}
    {previewAsset && <Modal title={previewAsset.name} subtitle={`${previewAsset.mimeType} · ${(previewAsset.sizeBytes / 1024 / 1024).toFixed(2)} MB`} onClose={() => setPreviewAsset(null)} wide><div className="asset-preview-large"><Media asset={previewAsset} controls /></div><div className="modal-footer"><Button variant="ghost" className="button primary" onClick={() => { addNode(assetKind(previewAsset), previewAsset); setPreviewAsset(null); }}><Icon name="plus" size={16} />添加到画布</Button></div></Modal>}
    {realConfirm && <Modal title="确认提交真实生成" subtitle="此操作会调用外部生成服务，可能产生费用。" onClose={() => setRealConfirm(null)}><div className="modal-form"><div className="confirmation-summary"><strong>{providers.find(p => p.id === realConfirm.providerId)?.name || realConfirm.providerId}</strong>{realConfirm.retryJobId && <p>重试明确失败的任务：使用原任务的固定镜头快照。</p>}<span>{realConfirm.model} · {inputModeLabel(realConfirm.inputMode)} · {realConfirm.shot.duration} 秒 · {realConfirm.shot.aspectRatio}</span><p>将发送此镜头的提示词、参数与 {realConfirm.shot.referenceAssetIds?.length || 0} 张参考图。费用由服务商按你的账户计费；工作台不保证远端任务可以取消。</p><p className="muted">此处不提供价格或预算承诺。请先确认服务商计费、账户额度与服务器侧已授权的调用上限。</p><p className="muted">提交状态不明确时，系统会停止重试，防止重复计费。</p></div><Button variant="ghost" className="button primary full" data-testid="confirm-live-generation" onClick={() => { const args = realConfirm; setRealConfirm(null); submitGeneration(args); }}>确认发送并生成</Button></div></Modal>}
    {showJobs && <Dialog open onOpenChange={open => { if (!open) setShowJobs(false); }}><DialogContent className="jobs-drawer" showCloseButton={false}><header className="drawer-header"><div><DialogTitle>生成任务</DialogTitle><DialogDescription>{activeCount ? `${activeCount} 个任务正在处理` : '每次提交都有迹可循'}</DialogDescription></div><Button variant="ghost" className="icon-button" aria-label="关闭生成任务" onClick={() => setShowJobs(false)}><Icon name="close" /></Button></header><div className="drawer-content">{pending.map(entry => <div className="job-card submission_unknown" key={entry.key} data-testid="pending-submission"><div className="job-title"><Icon name="info" size={17} /><strong>请求结果待确认</strong></div><p className="helper muted" style={{ marginTop: 12 }}>连接中断前的完整请求已保留。恢复时使用原编号与原参数，由服务器去重；不会重新生成请求编号。</p><div className="job-snapshot"><span>{entry.operation}</span><span>{new Date(entry.createdAt).toLocaleTimeString('zh-CN')}</span></div><div className="job-actions"><Button variant="ghost" className="button small" data-testid="resume-pending" disabled={busy[entry.key]} onClick={() => run(entry.key, entry.operation, entry.input, '原请求已恢复并确认')}><Icon name="refresh" size={13} />恢复同一请求</Button></div></div>)}{jobs.length ? jobs.map(job => <div className={`job-card ${job.status}`} key={job.id} data-testid={`job-${job.id}`}><div className="job-title"><span className={`job-state-icon ${job.status}`}>{activeJob(job) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : job.status === 'failed' ? 'close' : 'info'} size={16} />}</span><strong>{data.shots.find(s => s.id === job.shotId)?.title || '镜头任务'}</strong><Badge className="small-badge neutral">{job.providerId}</Badge></div><div className="job-status"><span>{jobStatusText(job)}</span><span>{activeJob(job) ? `${Math.round(job.progress || 0)}%` : new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div>{activeJob(job) && <div className="progress-track"><span style={{ width: `${Math.max(3, job.progress || 0)}%` }} /></div>}{job.error && <p className="job-error">{typeof job.error === 'string' ? job.error : job.error.message || job.error.code || '生成遇到问题'}</p>}{job.status === 'submission_unknown' && <div className="notice warning">服务商可能已接受任务并计费。请在服务商核实，系统不会盲目重新提交。</div>}{['submission_unknown', 'cancelled'].includes(job.status) && <div className="reconcile-job"><Label className="field-label" htmlFor={`reconcile-${job.id}`}>已有服务商任务 ID <span className="optional">可选</span></Label><Input id={`reconcile-${job.id}`} value={reconcileIds[job.id] || ''} onChange={e => setReconcileIds(ids => ({ ...ids, [job.id]: e.target.value }))} placeholder={job.providerJobId || '已知 ID 会自动恢复，无需填写'} /><Button variant="ghost" className="button small" data-testid={`reconcile-job-${job.id}`} disabled={busy[`reconcile:${job.id}`]} onClick={() => run(`reconcile:${job.id}`, 'job.reconcile', { jobId: job.id, ...(reconcileIds[job.id]?.trim() ? { providerJobId: reconcileIds[job.id].trim() } : {}) }, '已核对已有任务状态，没有重新提交生成')}><Icon name="refresh" size={13} />核对并恢复已有任务</Button></div>}{outputReviewRequired(job) && <div className="notice warning" data-testid="output-review-required">{outputReviewMessage}</div>}{job.status === 'cancelled' && !outputReviewRequired(job) && <p className="helper muted">停止范围：{job.cancelScope === 'remote' ? '远端任务已确认取消' : '仅停止本地等待，不代表服务商已取消或停止计费'}。</p>}<div className="job-snapshot"><span>{job.snapshot?.duration}s · {job.snapshot?.aspectRatio}</span><span>提交 {job.submissionCount ?? 1} 次</span></div><div className="job-actions"><Button variant="ghost" className="text-button" onClick={async () => { if (await inspect(job.shotId, job.status === 'succeeded' ? 'versions' : 'settings')) setShowJobs(false); }}>查看镜头<Icon name="arrow" size={12} /></Button>{job.status === 'failed' && <Button variant="ghost" className="button small" data-testid={`retry-job-${job.id}`} disabled={busy[`retry:${job.id}`] || jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown'))} title={jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? '原任务已有重试正在处理或待核实，请查看新任务' : '仅对明确失败的原始快照重试'} onClick={() => retryGeneration(job)}><Icon name="refresh" size={13} />{jobs.some(child => child.retryOfJobId === job.id && (activeJob(child) || child.status === 'submission_unknown')) ? '已有重试任务' : '重试失败任务'}</Button>}{activeJob(job) && <Button variant="ghost" className="button small" disabled={busy[`cancel:${job.id}`]} onClick={async () => { if (await confirm('停止本地等待不一定能取消服务商任务，也不保证停止计费。继续？')) run(`cancel:${job.id}`, 'job.cancel', { jobId: job.id }, '已请求停止。请查看任务记录中的实际取消范围。'); }}><Icon name="stop" size={12} />停止等待</Button>}</div></div>) : <div className="small-empty"><Icon name="clock" size={30} /><h4>还没有生成任务</h4><p>选择镜头并点击生成，这里会显示实时进度和结果。</p></div>}</div><footer className="drawer-note"><Icon name="lock" size={15} /><span>任务状态持久保存。刷新或重启不会重复提交已有任务。</span></footer></DialogContent></Dialog>}
    {showExports && <Modal title="导出记录" subtitle="每个文件使用创建时的固定快照。时间线合成与分镜顺序导出分别标记，后续修改不会覆盖旧文件。" onClose={() => setShowExports(false)}><div className="export-list">{orderedExports.length ? orderedExports.map(item => <div className="export-card" key={item.id}><div className="export-icon"><Icon name="film" size={24} /></div><div className="export-detail"><strong>{data.project?.name || '成片'}.mp4</strong><span>{statusText(item.status)} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>{item.error && <p className="job-error">{typeof item.error === 'string' ? item.error : item.error.message}</p>}<small>{item.mode === 'timeline' ? `${item.purpose === 'preview' ? '时间线预览' : '时间线导出'} · rev ${item.timelineRevision}${item.timelineRevision !== timeline?.revision ? ' · 旧快照' : ' · 当前'}` : `分镜顺序导出 · ${item.orderedVersionIds?.length || 0} 个镜头`}</small></div>{(item.url || item.assetId) && ['succeeded', 'completed', 'ready'].includes(item.status) ? <a className="button primary small" href={item.url || `/media/${item.assetId}`} download={`${data.project?.name || 'film'}.mp4`} data-testid="download-export"><Icon name="download" size={15} />下载</a> : item.status === 'failed' ? <Badge className="small-badge warn">失败</Badge> : <span className="spinner" />}</div>) : <div className="small-empty"><Icon name="download" size={29} /><h4>还没有导出记录</h4><p>将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出。</p></div>}</div></Modal>}
  </main>;
}
