import { useExportRange } from './export-range-state.ts';
import RestoredWorkspace, { RestoredUnavailable } from './RestoredWorkspace.jsx';
import { deriveTimelineAssetUsage, retainTimelineAssetUsage } from './timeline-asset-usage.ts';
import { locateTimelineAssetUse, matchesTimelineAssetUse, revealTimelineAssetUse } from './timeline-asset-navigation.ts';
import { pinNewWorkspaceIntent, assertWorkspaceIntent, workspaceIntentDisposition, workspaceOriginScope, retainWorkspaceIdentity } from './workspace-origin.js';
import { assertWorkspaceOperation, validateProjectWorkspace, RESTORE_DISABLED_REASON } from './restored-workspace.js';
import { Badge } from '@mioon/ui/components/badge';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@mioon/ui/components/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator } from '@mioon/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { WorkbenchTooltip } from './WorkspaceControls.jsx';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { schemas, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, isTimelineRenderRecord, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, isSubjectGenerationResponse, isSubjectGenerationRetryResponse } from '@mioon/contracts';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, useReactFlow } from '@xyflow/react';
import { measuredFitPadding } from './canvas-fit.ts';
import { staleClipSources } from './timeline-source-freshness.ts';
import Icon from './icons.jsx';
import BrandMark from './BrandMark.tsx';
import Inspector from './Inspector.jsx';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoIdentity, subjectVideoProfileIdentity, ARK_SUBJECT_WARNING, MOCK_SUBJECT_WARNING } from './subject-video.js';
import { VideoFrameSummary } from './VideoFrameControls.jsx';
import TaskCenter from './TaskCenter.jsx';
import { captureTaskWorkspaceIntent, navigateTaskShot } from './task-workspace-intent.ts';
import { createEditTaskController } from './edit-task-controller.js';
import { isDurableEditOperation, taskInputKey } from './edit-task-client.js';
import AgentWorkspace, { AgentDockPane } from './AgentWorkspace.jsx';
import { makeAgentTimelineClipSelection, makeAgentTimelineGainSelection, agentTimelineGainBlockedReason } from './agent-timeline-context.js';
import ImageGeneration from './ImageGeneration.jsx';
import AssetLibrary from './AssetLibrary.jsx';
import { useSubjects } from './use-subjects.js';
import { useAssetDispositions } from './use-asset-dispositions.js';
import { dispositionKey } from './asset-disposition-state.js';
import ExportHistoryList from './ExportHistoryList.jsx';
import DeliveryWorkspace from './DeliveryWorkspace.tsx';
import TimelineExportPreflight from './TimelineExportPreflight.jsx';
import { useExportPreflight } from './use-export-preflight.js';
import { useExportSamplePeak } from './use-export-sample-peak.ts';
import { useExportSettings } from './use-export-settings.js';
import { useTimelineDeliveryName } from './export-delivery-state.ts';
import { useLocalDelivery } from './local-delivery-state.ts';
import DeliveryDraftRecovery from './DeliveryDraftRecovery.tsx';
import Timeline, { ASSET_DRAG, assetKind, dragAsset } from './Timeline.jsx';
import TimelineInspector from './TimelineInspector.jsx';
import SubtitleInspector from './SubtitleInspector.jsx';
import { useSubtitles } from './use-subtitles.js';
import { subtitleAcknowledged } from './subtitle-state.js';
import TimelineFormatPanel from './TimelineFormatPanel.jsx';
import WorkspaceBackupPanel from './WorkspaceBackupPanel.jsx';
import { useTimelineFormat } from './use-timeline-format.js';
import { timelineFormatAcknowledged } from './timeline-format-state.js';
import { clipReplacementAcknowledged, clipReplacementErrorMessage, clipReplacementReviewIssue } from './clip-source-replacement.js';
import Preview from './Preview.jsx';
import SourceRangeInspector from './SourceRangeInspector.jsx';
import FrameExtractionPanel from './FrameExtractionPanel.jsx';
import { useFrameExtraction } from './use-frame-extraction.js';
import { frameCaptureBusy } from './frame-extraction.js';
import { useSourceRange } from './use-source-range.js';
import { sourceRangeAddPlan, sameSourceSnapshot } from './source-range-state.js';
import { Media, nodeTypes } from './Nodes.jsx';
import { rpc, requestId, activeJob, assetUrl, versionUrl } from './api.js';
import { importAcknowledged, importBusyFeedback, importFeedback } from './import-feedback.js';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel, generationReferences, generationReferenceIdentity } from './generation-settings.js';
import { pendingForProject, prepareSubmission, prepareRequestReplay, readPending, clearPending, reconcilePending, isSubjectRetryPending } from './submissions.js';
import { isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse } from './mutation-submissions.js';
import { defaultWorkspaceState, reconcileWorkspaceState, sourceForAsset } from './workspace-state.js';
import { createWorkspacePreferences } from './workspace-preferences.js';
import { createLastProjectController } from './last-project-state.ts';
import LastProjectStatus from './LastProjectStatus.tsx';
import TopbarSaveStatus from './TopbarSaveStatus.tsx';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard, assertLastProjectBootIdentity } from './last-project-navigation.ts';
import { migrateBrowserStorage } from './storage-migration.js';
import { timelineHistoryState } from './timeline-history.js';
import { timelineHistoryActionForKey, timelineSplitActionForKey } from './timeline-keyboard.js';
import { timelineSplitState } from './timeline-split.js';
import { assetTimelineDuration } from './timeline-snapping.js';
import { defaultWorkspaceLayout } from './workspace-layout.js';
import { PanelBoundary, PanelRecall, PanelResizeHandle, PanelsMenu, usePanelGeometry } from './WorkspacePanels.jsx';
import { REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, isReferenceEdge, referenceForShot, isReferenceOperation, hasPendingReference, isImageReferenceNode, referenceAttachIssue, canvasEdge } from './reference-connections.js';

const emptyData = { project: null, assets: [], shots: [], nodes: [], edges: [], jobs: [], versions: [], exports: [], timeline: null, timelineHistory: null };
const emptyBusy = Object.freeze({});
// Canvas fits leave room for the docks, heading and storyboard that float over the full-bleed pane.
const canvasFitPadding = fallback => measuredFitPadding(document.querySelector('[data-testid="canvas-drop-zone"]'), fallback);
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
  return <div className="login-page"><div className="login-atmosphere" /><div className="login-visual"><div className="brand large"><span className="brand-mark"><BrandMark /></span>Mioon</div><div className="login-headline"><div className="eyebrow">YOUR IDEAS, IN MOTION</div><h1>让每一个想法，<br />都有自己的镜头。</h1><p>从一张参考图出发，在无限画布中构思故事。<br />生成、比较、编排，让灵感一步步成为影像。</p></div><div className="login-footnote"><span className="status-dot green" />私有工作区 · 本地媒体管理 · 版本可追溯</div></div><div className="login-form-wrap"><form className="login-form" onSubmit={submit}><span className="login-icon"><Icon name="lock" size={23} /></span><h2>进入你的影像工作台</h2><p>使用工作台访问令牌登录。令牌仅用于建立安全会话。</p><Label className="field-label" htmlFor="access-token">访问令牌</Label><Input id="access-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder="输入工作台令牌" required autoFocus />{error && <div className="notice error" role="alert">{error}</div>}<Button variant="ghost" className="button primary full" type="submit" disabled={loading || !token}>{loading ? <span className="spinner" /> : <Icon name="arrow" size={16} />}进入工作台</Button><div className="login-security"><Icon name="lock" size={13} />服务商 API 密钥始终留在服务器</div></form></div></div>;
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
  const [workspace, setWorkspace] = useState(null);
  const workspaceRef = useRef(null);
  const restored = workspace?.restored === true;
  const generationUnavailableReason = restored ? RESTORE_DISABLED_REASON : '';
  const dataRef = useRef(data); dataRef.current = data;
  const [projects, setProjects] = useState([]);
  const [providers, setProviders] = useState([]);
  const [generationOptions, setGenerationOptions] = useState({});
  const generationOptionsRef = useRef(generationOptions); generationOptionsRef.current = generationOptions;
  const updateGenerationOptions = useCallback((shotId, options) => { if (shotId) { const next = { ...generationOptionsRef.current, [shotId]: options }; generationOptionsRef.current = next; setGenerationOptions(next); } }, []);
  const [loading, setLoading] = useState(false);
  const [busyByProject, setBusyByProject] = useState({});
  const busyRef = useRef(new Set());
  const [toast, setToast] = useState(null);

  const [showProjects, setShowProjects] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [rightDockTab, setRightDockTab] = useState('properties');
  const [propertiesPage, setPropertiesPage] = useState('inspector');
  const [subtitleDirty, setSubtitleDirty] = useState(false);
  const subtitlesRef = useRef(null);
  const [formatDirty, setFormatDirty] = useState(false);
  const timelineFormatRef = useRef(null);
  const deliveryNameRef = useRef(null);
  const localDeliveryRef = useRef(null);
  const clipDraftRef = useRef(null);
  const [agentClipDraftBlocked, setAgentClipDraftBlocked] = useState(true);
  const shotTextRef = useRef(null);
  const registerShotText = useCallback(controller => {
    shotTextRef.current = controller;
    return () => { if (shotTextRef.current === controller) shotTextRef.current = null; };
  }, []);
  const registerClipDraft = useCallback(controller => {
    clipDraftRef.current = controller;
    return () => { if (clipDraftRef.current === controller) clipDraftRef.current = null; };
  }, []);
  const [agentPage, setAgentPage] = useState('chat');
  const agentDraft = useRef(false);
  const onAgentDraftChange = useCallback(value => { agentDraft.current = value; }, []);
  const imageDraft = useRef(false);
  const onImageDraftChange = useCallback(value => { imageDraft.current = value; }, []);
  const [showExports, setShowExports] = useState(false);
  const [comparisonId, setComparisonId] = useState(null);
  const [previewAsset, setPreviewAsset] = useState(null);
  const [realConfirm, setRealConfirm] = useState(null);
  const realConfirmRef = useRef(null);
  const generationReviewScope = useRef(null);
  realConfirmRef.current = realConfirm;
  const [nodes, setNodes] = useState([]);
  const [shotDirty, setShotDirty] = useState(false);
  const [clipDirty, setClipDirty] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [subjectDirty, setSubjectDirty] = useState(false);
  const [subjectRefresh, setSubjectRefresh] = useState({});
  const subjectsRef = useRef(null);
  const [sourceRangeRefresh, setSourceRangeRefresh] = useState({});
  const [dispositionRefresh, setDispositionRefresh] = useState({});
  const inspectorDirty = shotDirty || clipDirty || sourceDirty || subjectDirty || subtitleDirty;
  const dirtyRef = useRef(inspectorDirty); dirtyRef.current = inspectorDirty;

  const [showGuide, setShowGuide] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [online, setOnline] = useState(true);
  const [zoom, setZoom] = useState(100);

  const [mobilePanel, setMobilePanel] = useState('canvas');
  const [sequenceDrag, setSequenceDrag] = useState(null);

  const [pending, setPending] = useState([]);

  const [reconcileIds, setReconcileIds] = useState({});
  const fileInput = useRef(null);
  const importSession = useRef({ active: true, selection: 0 });
  useEffect(() => {
    importSession.current.active = true;
    return () => { importSession.current.active = false; importSession.current.selection++; requestCounter.current++; };
  }, []);
  const currentProject = useRef(null);
  const [taskState, setTaskState] = useState({ phase: 'idle', items: [], uncertain: [], busy: [], error: null });
  const tasksRef = useRef(null);
  if (!tasksRef.current) tasksRef.current = createEditTaskController({ getWorkspace: () => workspaceRef.current, onChange: (projectId, snapshot) => {
    if (currentProject.current === projectId) setTaskState(snapshot);
  } });
  const navigationEpoch = useRef(0);
  const projectEpoch = useRef(0);
  const preferenceScope = useRef(null);
  const locatorIdentity = useRef(null);
  const bootGuard = useRef(null);
  if (!bootGuard.current) bootGuard.current = createProjectBootGuard(() => projectEpoch.current);
  const [lastProjectStatus, setLastProjectStatus] = useState(null);
  const lastProjectRef = useRef(null);
  if (!lastProjectRef.current) lastProjectRef.current = createLastProjectController({
    getEpoch: () => projectEpoch.current, onChange: setLastProjectStatus,
  });
  const [inspectorEpoch, setInspectorEpoch] = useState(0);
  const [view, setView] = useState(defaultWorkspaceState);
  const viewRef = useRef(view); viewRef.current = view;
  const viewReady = useRef(false);
  const [preferenceStatus, setPreferenceStatus] = useState({ phase: 'loading', pending: false });
  const preferencesRef = useRef(null);
  if (!preferencesRef.current) preferencesRef.current = createWorkspacePreferences({
    getWorkspace: () => workspaceRef.current, getStorageScope: () => lastProjectRef.current.getState().identityBlocked ? null : preferenceScope.current,
    onStatus: (projectId, status) => { if (currentProject.current === projectId) setPreferenceStatus(status); }
  });
  const busy = busyByProject[currentProject.current || 'none'] || emptyBusy;
  const activePending = pending.filter(entry => !workspaceIntentDisposition(entry, workspace).held);
  const activeTasks = taskState.items.filter(task => !taskState.heldIds?.includes(task.id));
  const referencePending = hasPendingReference(activePending) || activeTasks.some(task => task.lane === 'reference:mutation');
  const referenceBusy = Boolean(busy['reference:mutation'] || referencePending || taskState.phase !== 'ready');
  const updateView = useCallback((section, patch, { passive = false } = {}) => {
    if (!viewReady.current || dataRef.current.project?.id !== currentProject.current) return;
    const previous = viewRef.current;
    const value = typeof patch === 'function' ? patch(previous[section]) : patch;
    const next = section === 'activeMode' ? { ...previous, activeMode: value } : { ...previous, [section]: { ...previous[section], ...value } };
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    viewRef.current = next; setView(next);
    if (currentProject.current) {
      const frequent = ['viewport', 'playhead', 'pixelsPerSecond', 'scrollLeft', 'scrollTop', 'assetSearch'];
      const immediate = section === 'activeMode' || Object.keys(value).some(key => !frequent.includes(key));
      preferencesRef.current.update(currentProject.current, next, { immediate, ...(!passive && workspaceRef.current?.restored ? pinNewWorkspaceIntent({}, workspaceRef.current) : {}) });
    }
  }, []);
  const field = (section, key) => {
    const owner = currentProject.current, ownerEpoch = projectEpoch.current;
    return value => { if (owner === currentProject.current && ownerEpoch === projectEpoch.current) updateView(section, previous => ({ [key]: typeof value === 'function' ? value(previous[key]) : value })); };
  };
  const { selectedId, selectedEdgeId, inspectorTab: tab, storyboardOpen: sequenceOpen, miniMap, highlightedVersionId } = view.canvas;
  const { selectedClipId, quickAssetId, previewKind, playhead, timelineCollapsed } = view.editing;
  const { assetFilter, assetSearch } = view.shared;
  const workspaceMode = view.activeMode;
  const modeLayout = view.layout[workspaceMode];
  const { assetsCollapsed, inspectorCollapsed } = modeLayout;
  const panelSurface = useRef(null), panelIntent = useRef(0), taskWorkspaceState = useRef(null), taskShotAttempt = useRef(0);
  const [panelChange, setPanelChange] = useState(0);
  const panelScope = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${panelChange}`;
  const geometry = usePanelGeometry(panelSurface, modeLayout, workspaceMode, panelScope, auth === true);
  const markPanelIntent = () => { panelIntent.current++; setPanelChange(value => value + 1); };
  const layoutOwner = currentProject.current, layoutOwnerEpoch = projectEpoch.current;
  function updateModeLayout(mode, patch) {
    if (layoutOwner !== currentProject.current || layoutOwnerEpoch !== projectEpoch.current) return;
    updateView('layout', previous => ({ [mode]: { ...previous[mode], ...patch } }));
  }
  function setPanelOpen(name, open, mode = viewRef.current.activeMode) {
    markPanelIntent();
    if (name === 'timeline') updateView('editing', { timelineCollapsed: !open });
    else if (name === 'storyboard') updateView('canvas', { storyboardOpen: open });
    else updateModeLayout(mode, { [name === 'assets' ? 'assetsCollapsed' : 'inspectorCollapsed']: !open });
    if (geometry.narrow && mode === viewRef.current.activeMode && name !== 'storyboard') {
      if (open) setMobilePanel(name); else if (mobilePanel === name) setMobilePanel('canvas');
    }
  }
  function resetPanelLayout() {
    markPanelIntent(); updateView('layout', { [workspaceMode]: defaultWorkspaceLayout()[workspaceMode] });
    if (workspaceMode === 'canvas') updateView('canvas', { storyboardOpen: false });
    else updateView('editing', { timelineCollapsed: false });
    setMobilePanel('canvas');
  }
  function resizePanel(field, value) { markPanelIntent(); updateModeLayout(workspaceMode, { [field]: value }); }
  const panelVisible = name => name === 'canvas' ? !geometry.narrow || mobilePanel === 'canvas' : !(name === 'assets' ? assetsCollapsed : name === 'inspector' ? inspectorCollapsed : timelineCollapsed) && (!geometry.narrow || mobilePanel === name);
  function mobileNavigate(name) { if (name === 'canvas') { markPanelIntent(); setMobilePanel('canvas'); } else setPanelOpen(name, true); }
  const panelFallback = name => geometry.narrow ? `[data-testid=mobile-panel-${name}]` : `[data-testid=reopen-${name}]`;
  const resizeHandle = (name, field) => <PanelResizeHandle name={name} field={field} value={geometry.effective[field]} max={geometry.maxima[field]} scope={`${panelScope}:${geometry.size.width}:${geometry.size.height}`} enabled={!geometry.narrow && panelVisible(name) && !loading} onPreview={geometry.preview} onCommit={resizePanel} />;
  const setSelectedId = field('canvas', 'selectedId'), setSelectedEdgeId = field('canvas', 'selectedEdgeId'), setTab = field('canvas', 'inspectorTab'), setSequenceOpen = field('canvas', 'storyboardOpen'), setMiniMap = field('canvas', 'miniMap');
  const setSelectedClipId = field('editing', 'selectedClipId'), setQuickAssetId = field('editing', 'quickAssetId'), setPreviewKind = field('editing', 'previewKind'), setPlayhead = field('editing', 'playhead'), setTimelineCollapsed = field('editing', 'timelineCollapsed');
  const setAssetFilter = field('shared', 'assetFilter'), setAssetSearch = field('shared', 'assetSearch');
  const setAssetsCollapsed = value => setPanelOpen('assets', !value), setInspectorCollapsed = value => setPanelOpen('inspector', !value);
  const generationReviewKey = `${workspaceMode}:${selectedId}:${tab}:${rightDockTab}:${propertiesPage}:${JSON.stringify(generationOptions)}`;
  if (generationReviewScope.current?.key !== generationReviewKey) generationReviewScope.current = { key: generationReviewKey };
  const context = () => ({ projectId: currentProject.current, epoch: navigationEpoch.current, workspace: workspaceRef.current });
  const isCurrent = captured => captured.projectId === currentProject.current && captured.epoch === navigationEpoch.current && workspaceOriginScope(captured.workspace) === workspaceOriginScope(workspaceRef.current);
  taskWorkspaceState.current = { visible: rightDockTab === 'tasks' && panelVisible('inspector'), connected: online && auth === true && !loading };
  const taskViewScope = JSON.stringify([currentProject.current, projectEpoch.current, navigationEpoch.current, panelIntent.current, workspaceMode, rightDockTab, panelVisible('inspector'), workspaceOriginScope(workspaceRef.current)]);
  const isBusy = (key, projectId = currentProject.current) => busyRef.current.has(`${projectId || 'none'}:${key}`);
  function markBusy(projectId, key, value) {
    const scope = projectId || 'none';
    if (value) busyRef.current.add(`${scope}:${key}`); else busyRef.current.delete(`${scope}:${key}`);
    setBusyByProject(all => ({ ...all, [scope]: { ...all[scope], [key]: value } }));
  }
  async function guardNavigation(message = '当前面板有未保存的修改。放弃修改并切换工作区？', additionalDirty = false, canDiscard = () => true) {
    const captured = context(), subtitleController = subtitlesRef.current?.controller, subtitleDraft = subtitleController?.getState(), subtitleUnsaved = subtitleController?.hasUnsaved();
    const clipController = clipDraftRef.current, clipCapture = clipController?.capture(), clipUnsaved = clipController?.hasUnsaved();
    const shotController = shotTextRef.current, shotCapture = shotController?.capture(), shotUnsaved = shotController?.hasUnsaved();
    if ((dirtyRef.current || subtitleUnsaved || clipUnsaved || shotUnsaved || additionalDirty) && !await confirm(message)) return false;
    if (!isCurrent(captured) || !canDiscard() || shotController && (shotController !== shotTextRef.current || !shotController.isCurrent(shotCapture)) || subtitleController && (subtitleController !== subtitlesRef.current?.controller || subtitleController.getState() !== subtitleDraft) || clipController && (clipController !== clipDraftRef.current || !clipController.isCurrent(clipCapture))) return false;
    if (clipUnsaved && !await clipController.discard(clipCapture, canDiscard)) return false;
    if (!isCurrent(captured) || !canDiscard() || shotController && (shotController !== shotTextRef.current || !shotController.isCurrent(shotCapture)) || clipController && clipController !== clipDraftRef.current || subtitleController && (subtitleController !== subtitlesRef.current?.controller || subtitleController.getState() !== subtitleDraft)) return false;
    if (shotController && !shotController.abandonCurrentInput(shotCapture)) return false;
    if (dirtyRef.current || subtitleUnsaved || clipUnsaved || shotUnsaved) { subtitleController?.discardDraft(); subjectsRef.current?.controller.discardDrafts(subjectsRef.current.state?.scope); dirtyRef.current = false; setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false); setInspectorEpoch(value => value + 1); }
    return true;
  }
  async function guardProjectNavigation(message, additionalDirty = false) {
    const controller = timelineFormatRef.current?.controller, delivery = deliveryNameRef.current?.controller, deliveryCapture = delivery?.capture();
    const formatDraft = controller?.getState?.();
    const localDeliveryController = localDeliveryRef.current?.controller, localDeliveryCapture = localDeliveryController?.capture();
    const canDiscard = () => !(controller && (controller !== timelineFormatRef.current?.controller || controller.getState?.() !== formatDraft))
      && !(delivery && (delivery !== deliveryNameRef.current?.controller || deliveryCapture && ['scope', 'projectId', 'value', 'version'].some(field => delivery.getState()[field] !== deliveryCapture[field])))
      && !(localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.isCurrent(localDeliveryCapture)));
    if (!await guardNavigation(message, additionalDirty || controller?.hasUnsaved() || delivery?.hasUnsaved(), canDiscard) || !canDiscard()) return false;
    if (localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.abandonCurrentInput(localDeliveryCapture))) return false;
    if (delivery && (delivery !== deliveryNameRef.current?.controller || !delivery.discardDraft(deliveryCapture))) return false;
    controller?.discardDraft();
    return true;
  }
  async function changeMode(mode) {
    if (!viewReady.current || loading || !['canvas', 'editing'].includes(mode) || mode === viewRef.current.activeMode) return;
    if (!await guardNavigation()) return;
    navigationEpoch.current++; dragging.current = false;
    updateView('activeMode', mode); setMobilePanel('canvas');
    setPreviewAsset(null); setComparisonId(null);
  }
  function revealCanvas(id) {
    const captured = context();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isCurrent(captured) && viewRef.current.activeMode === 'canvas') flow.fitView({ ...(id ? { nodes: [{ id }] } : {}), padding: canvasFitPadding(.25), duration: 0, minZoom: .65, maxZoom: 1 });
    }));
  }

  const requestCounter = useRef(0);
  const dragging = useRef(false);
  const flow = useReactFlow();
  const notify = useCallback((message, type = 'success') => setToast({ message, type, time: Date.now() }), []);
  useEffect(() => { if (toast && toast.type !== 'error') { const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); } }, [toast]);
  const refresh = useCallback(async (projectId = currentProject.current, quiet = true) => {
    if (!projectId || currentProject.current !== projectId) return null;
    const call = ++requestCounter.current, epoch = projectEpoch.current, capturedWorkspace = workspaceRef.current;
    try {
      const [next, caps] = await Promise.all([rpc('project.get', { projectId }), capturedWorkspace?.restored ? [] : rpc('provider.list')]);
      if (currentProject.current !== projectId || epoch !== projectEpoch.current || call !== requestCounter.current || workspaceOriginScope(capturedWorkspace) !== workspaceOriginScope(workspaceRef.current)) return null;
      validateProjectWorkspace(next, capturedWorkspace);
      reconcilePending(projectId, next, { workspace: capturedWorkspace });
      dataRef.current = { ...emptyData, ...next }; setData(dataRef.current); setProviders(caps); setLastSync(new Date()); setOnline(true); setPending(pendingForProject(projectId));
      const reconciled = reconcileWorkspaceState(viewRef.current, next);
      if (viewReady.current && JSON.stringify(reconciled) !== JSON.stringify(viewRef.current)) { viewRef.current = reconciled; setView(reconciled); preferencesRef.current.update(projectId, reconciled, { immediate: true }); }
      return next;
    } catch (e) {
      if (currentProject.current === projectId && epoch === projectEpoch.current && call === requestCounter.current) { if (e.code === 'UNAUTHORIZED') setAuth(false); setOnline(false); if (!quiet) notify(readableError(e), 'error'); }
      return null;
    }
  }, [notify]);
  async function revealImageAsset(assetId, projectId, isStillCurrent = () => true) {
    if (currentProject.current !== projectId || !isStillCurrent()) return false;
    const epoch = projectEpoch.current, navigation = navigationEpoch.current, panelChoice = panelIntent.current;
    const snapshot = dataRef.current.assets.some(asset => asset.id === assetId) ? dataRef.current : await refresh(projectId);
    if (currentProject.current !== projectId || projectEpoch.current !== epoch || navigationEpoch.current !== navigation || panelIntent.current !== panelChoice || !isStillCurrent()) return false;
    const asset = snapshot?.assets.find(item => item.id === assetId);
    if (!asset || asset.projectId !== undefined && asset.projectId !== projectId) return false;
    // Reveal only changes the library filter/panel. Source selection and all
    // inspector drafts remain intact; selecting a result uses the normal guard.
    updateView('shared', { assetSearch: asset.name, assetFilter: 'all' }); setPanelOpen('assets', true); setMobilePanel('assets');
    return true;
  }
  async function selectProject(id, initial = false, fromHistory = false, reloadPreferences = false) {
    if (id === currentProject.current && !initial && !reloadPreferences && !loading && dataRef.current.project?.id === id) {
      if (!workspaceRef.current?.restored) lastProjectRef.current.rememberOpened(id, projectEpoch.current);
      return true;
    }
    const draftMessage = imageDraft.current ? `${agentDraft.current ? 'Agent 和图像工坊都有' : '图像工坊有'}未发送的草稿。切换项目会放弃草稿和属性面板中未保存的修改；已接受的任务可能继续。继续切换？` : agentDraft.current ? 'Agent 有未发送的草稿。切换项目会放弃该草稿和属性面板中未保存的修改；已发送的回复可能继续。继续切换？' : '当前面板有未保存的修改。放弃修改并打开另一个项目？';
    if (!initial && !await guardProjectNavigation(draftMessage, agentDraft.current || imageDraft.current)) return false;
    navigationEpoch.current++; const epoch = ++projectEpoch.current; ++requestCounter.current;
    lastProjectRef.current.invalidateNavigation(epoch);
    if (currentProject.current) void preferencesRef.current.flush({ projectId: currentProject.current, keepalive: true });
    currentProject.current = id;
    setPropertiesPage('inspector');
    setTaskState(tasksRef.current.getState(id));
    void tasksRef.current.load(id);
    viewReady.current = false;
    setPreferenceStatus({ phase: 'loading', pending: false });
    setPending(pendingForProject(id)); setShowProjects(false); setData(emptyData); dataRef.current = emptyData; setNodes([]); setLoading(true); dragging.current = false;
    setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false); setInspectorEpoch(value => value + 1); setRightDockTab(value => value === 'tasks' ? 'properties' : value); setShowExports(false); setComparisonId(null); setPreviewAsset(null); setRealConfirm(null); setToast(null); setMobilePanel('canvas');
    const url = new URL(window.location.href); url.searchParams.set('project', id);
    if (!fromHistory) window.history[initial ? 'replaceState' : 'pushState']({ projectId: id }, '', url);
    // Wait for authoritative preferences (or a safe local fallback) before the
    // project mounts and its initial viewport/selection effects can persist.
    try {
    const restored = await preferencesRef.current.load(id, { reload: reloadPreferences });
    if (!restored || !importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch) return false;
    viewRef.current = restored; setView(restored); viewReady.current = true;
    setZoom(Math.round((restored.canvas.viewport?.zoom || 1) * 100));
    setPreferenceStatus(preferencesRef.current.getStatus(id));
    const next = await refresh(id, false);
    if (!importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch) return false;
    setLoading(false);
    if (!next || next.project?.id !== id) return false;
    if (!initial && !reloadPreferences && !workspaceRef.current?.restored) lastProjectRef.current.rememberOpened(id, epoch);
    if (next && !viewRef.current.canvas.selectedId) { const first = [...next.shots].sort((a, b) => a.orderIndex - b.orderIndex)[0] || next.nodes.find(n => n.type !== 'text') || next.nodes[0]; if (first) updateView('canvas', { selectedId: first.id }, { passive: true }); }
    return true;
    } catch (e) {
      if (importSession.current.active && currentProject.current === id && projectEpoch.current === epoch) notify(readableError(e), 'error');
      return false;
    } finally {
      if (importSession.current.active && currentProject.current === id && projectEpoch.current === epoch) setLoading(false);
    }
  }
  async function reloadPreferences() {
    const captured = context();
    if (!await confirm('载入已保存视图会替换当前的工作区、选择和位置。继续？')) return;
    if (isCurrent(captured)) await selectProject(captured.projectId, false, true, true);
  }
  async function boot() {
    const ticket = bootGuard.current.begin();
    preferenceScope.current = null;
    try {
      migrateBrowserStorage();
      const observedWorkspace = await rpc('workspace.restore.inspect');
      if (!bootGuard.current.isCurrent(ticket)) return;
      const verifiedWorkspace = retainWorkspaceIdentity(workspaceRef.current, observedWorkspace);
      workspaceRef.current = verifiedWorkspace; setWorkspace(verifiedWorkspace);
      const [list, caps, locator] = await Promise.all([
        rpc('project.list'), verifiedWorkspace.restored ? [] : rpc('provider.list'),
        verifiedWorkspace.restored ? Promise.resolve(null) : lastProjectRef.current.discover(),
      ]);
      if (!bootGuard.current.isCurrent(ticket)) return;
      assertLastProjectBootIdentity(lastProjectRef.current.getState());
      locatorIdentity.current = retainLastProjectScope(locatorIdentity.current, locator?.workspaceScope ?? null);
      preferenceScope.current = locator?.workspaceScope ?? null;
      setProjects(list); setProviders(caps); setAuth(true); setOnline(true);
      const choice = chooseInitialProject(list, new URLSearchParams(window.location.search).get('project'), locator?.envelope ?? null);
      if (choice.projectId) {
        const accepted = await selectProject(choice.projectId, true);
        if (accepted && currentProject.current === choice.projectId && choice.notice) notify(choice.notice, 'error');
      } else { setData(emptyData); currentProject.current = null; if (choice.notice) notify(choice.notice, 'error'); }
    } catch (e) { if (bootGuard.current.isCurrent(ticket)) { if (e.code === 'UNAUTHORIZED') setAuth(false); else { setAuth('error'); notify(readableError(e), 'error'); } } }
  }
  useEffect(() => {
    bootGuard.current.activate(); lastProjectRef.current.activate(); void boot();
    return () => { bootGuard.current.deactivate(); lastProjectRef.current.dispose(); };
  }, []);
  useEffect(() => {
    const controller = preferencesRef.current;
    const locator = lastProjectRef.current;
    const flush = () => { void controller.flush({ keepalive: true }); if (!workspaceRef.current?.restored) { void locator.flush(); if (localDeliveryRef.current?.controller.hasUnsaved()) void localDeliveryRef.current.controller.flush(); if (shotTextRef.current?.hasUnpersisted()) void shotTextRef.current.flush(); if (clipDraftRef.current?.hasUnpersisted()) void clipDraftRef.current.flushForClose(); } };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    // An unprivileged lifecycle function: desktop main may await this fixed
    // function before closing; it exposes no Electron/IPC/native capability.
    const drain = async () => {
      const restored = Boolean(workspaceRef.current?.restored), clip = restored ? null : clipDraftRef.current, clipCapture = clip?.capture();
      const [, remembered, titleSaved, shotSaved, clipSaved] = await Promise.all([
        controller.flush({ keepalive: true }), restored ? true : locator.flush(),
        restored || !localDeliveryRef.current?.controller.hasUnsaved() ? true : localDeliveryRef.current.controller.flush(),
        restored || !shotTextRef.current?.hasUnpersisted() ? true : shotTextRef.current.flush(),
        clip ? clip.flushForClose() : true,
      ]);
      return !controller.hasUnsaved() && remembered && titleSaved && shotSaved && clipSaved && restored === Boolean(workspaceRef.current?.restored)
        && (restored || clip === clipDraftRef.current && (!clip || clip.isCurrent(clipCapture) && !clip.hasUnpersisted()));
    };
    globalThis.__mioonFlushWorkspacePreferences = drain;
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      if (globalThis.__mioonFlushWorkspacePreferences === drain) delete globalThis.__mioonFlushWorkspacePreferences;
      flush();
    };
  }, []);
  useEffect(() => {
    const onPop = async () => { const id = new URLSearchParams(window.location.search).get('project'); if (!id || id === currentProject.current) return; const accepted = await selectProject(id, false, true); if (!accepted) { const url = new URL(window.location.href); url.searchParams.set('project', currentProject.current); window.history.pushState({ projectId: currentProject.current }, '', url); } };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  });
  useEffect(() => { const warn = e => { if (!dirtyRef.current && !shotTextRef.current?.hasUnsaved() && !clipDraftRef.current?.hasUnsaved() && !timelineFormatRef.current?.controller.hasUnsaved() && !deliveryNameRef.current?.controller.hasUnsaved()) return; e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  useEffect(() => { if (showProjects) rpc('project.list').then(setProjects).catch(e => notify(readableError(e), 'error')); }, [showProjects]);
  useEffect(() => {
    if (!auth || !data.project?.id) return;
    const timer = setInterval(() => { if (!dragging.current && document.visibilityState === 'visible') refresh(); }, 2500);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [auth, data.project?.id, refresh]);
  async function run(key, operation, input, message, options = {}) {
    const invocationOptions = { ...options, canRevealTasks: captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) };
    if (isDurableEditOperation(operation) && !options.replay) return runDurable(key, operation, input, message, invocationOptions);
    return runSession(key, operation, input, message, invocationOptions);
  }
  async function runDurable(key, operation, input, message, { returnAfterNavigation = false, validateResponse, onFailure, errorMessage = readableError, canExecute, canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) } = {}) {
    const captured = context(), projectId = captured.projectId;
    if (isBusy(key, projectId)) return null;
    markBusy(projectId, key, true);
    let dispatched = false, rejected = false;
    const invalidateHistory = () => {
      if (!operation.startsWith('timeline.') || currentProject.current !== projectId) return;
      ++requestCounter.current;
      dataRef.current = { ...dataRef.current, timelineHistory: null };
      setData(current => current.project?.id === projectId ? { ...current, timelineHistory: null } : current);
    };
    try {
      const invocation = captured.workspace ? pinNewWorkspaceIntent({}, captured.workspace) : {};
      if (captured.workspace) assertWorkspaceOperation(captured.workspace, operation);
      if (input?.projectId !== projectId) throw Object.assign(new Error('项目已变化，已阻止旧面板提交。'), { code: 'MUTATION_PROJECT_MISMATCH' });
      if (pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(entry => entry.key === key ||
        (operation.startsWith('reference.') && isMutationOperation(entry.operation))))
        throw Object.assign(new Error('旧会话有请求待确认。请先在任务中心恢复原请求或明确转存，草稿仍保留。'), { code: 'MUTATION_PENDING' });
      const response = await tasksRef.current.submit({ projectId, operation, input, ...invocation }, { canExecute: () => {
        if (!isCurrent(captured) || canExecute?.() === false) return false;
        dispatched = true; invalidateHistory(); return true;
      } });
      invalidateHistory();
      if (response.task.status === 'not_applied') {
        rejected = true;
        await tasksRef.current.acknowledge(response.task);
        throw Object.assign(new Error('服务器已确认此请求未应用。草稿仍保留，请核对最新状态后重新编辑。'), { code: response.task.errorCode || 'TASK_NOT_APPLIED' });
      }
      if (response.task.status !== 'applied') {
        if (isCurrent(captured)) { notify('原请求已保存到任务中心，请明确恢复后继续编辑。', 'warning'); openTasks(canRevealTasks); }
        return null;
      }
      // Fresh saves may return their own validated ACK to their mounted editor.
      // Historical task recovery below only refreshes current project records.
      if (!Object.hasOwn(response, 'result')) throw Object.assign(new Error('未收到完整的编辑确认，请在任务中心核对原请求。'), { code: 'BACKEND_PROTOCOL_ERROR' });
      validateResponse?.(response.result);
      await tasksRef.current.acknowledge(response.task);
      if (currentProject.current === projectId) await refresh(projectId);
      if (!isCurrent(captured)) return returnAfterNavigation && currentProject.current === projectId ? response.result : null;
      if (message) notify(message);
      return response.result;
    } catch (error) {
      if (dispatched) invalidateHistory();
      onFailure?.(error, { dispatched, rejected });
      if (currentProject.current === projectId) {
        if (error.code === 'UNAUTHORIZED') setAuth(false);
        if (isCurrent(captured)) {
          notify(dispatched && !rejected ? '提交结果仍需确认。原请求已保留，请在任务中心恢复同一请求；不会自动重试。' : errorMessage(error), 'error');
          openTasks(canRevealTasks);
        }
        if (dispatched) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); }
  }
  async function recoverTask(task, acknowledgeOnly = false, canExecute = () => true) {
    const captured = context();
    if (!canExecute()) return;
    if (task.projectId !== captured.projectId || isBusy(`task:${task.id}`, task.projectId)) return;
    markBusy(task.projectId, `task:${task.id}`, true);
    try {
      const response = await tasksRef.current.recover(task, { canExecute: () => !acknowledgeOnly && isCurrent(captured) && canExecute() });
      if (!response) return;
      if (['applied', 'not_applied'].includes(response.task.status)) {
        if (response.task.status === 'applied' && currentProject.current === task.projectId) {
          await refresh(task.projectId);
          if (task.lane === 'subject:mutation') setSubjectRefresh(value => ({ ...value, [task.projectId]: (value[task.projectId] || 0) + 1 }));
        }
        if (!response.task.acknowledged) await tasksRef.current.acknowledge(response.task);
        if (currentProject.current === task.projectId) { timelineFormatRef.current?.controller.recovered(response.task); subtitlesRef.current?.controller.recovered(response.task); }
        if (isCurrent(captured) && canExecute()) notify(response.task.status === 'applied' ? '原请求已确认应用。已刷新当前项目，未替换面板草稿。' : '原请求已确认未应用，可以核对草稿后重新编辑。');
      } else if (isCurrent(captured) && canExecute()) notify('原请求结果仍待确认，恢复记录继续保留。', 'warning');
    } catch (error) { if (isCurrent(captured)) { if (error.code === 'UNAUTHORIZED') setAuth(false); if (canExecute()) notify(readableError(error), 'error'); } }
    finally { markBusy(task.projectId, `task:${task.id}`, false); }
  }
  async function adoptLegacyTask(entry) {
    const captured = context();
    if (entry.projectId !== captured.projectId || isBusy(entry.key, entry.projectId)) return;
    markBusy(entry.projectId, entry.key, true);
    try {
      const exact = prepareRequestReplay(entry);
      await tasksRef.current.adopt(exact);
      // Clear only the exact receipt acknowledged by adoption, never a newer
      // request that happens to occupy the same legacy UI lane.
      const latest = readPending(entry.projectId, entry.key, entry);
      if (!latest || latest.operation !== exact.operation || taskInputKey(latest.input) !== taskInputKey(exact.input))
        throw Object.assign(new Error('会话请求已变化，旧记录未清除。请核对任务中心。'), { code: 'MUTATION_REPLAY_MISMATCH' });
      clearPending(entry.projectId, entry.key, exact);
      if (currentProject.current === entry.projectId) setPending(pendingForProject(entry.projectId));
      if (isCurrent(captured)) notify('原编号与完整参数已转存到本地任务数据库。转存本身没有执行编辑，请明确核对并恢复原请求。');
    } catch (error) { if (isCurrent(captured)) notify(readableError(error), 'error'); }
    finally { markBusy(entry.projectId, entry.key, false); }
  }
  async function runSession(key, operation, input, message, { returnAfterNavigation = false, replay = false, validateResponse, onFailure, errorMessage = readableError, expectedSubjectReference, subjectRetry = false, expectedRetrySnapshot, pendingEntry, canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) } = {}) {
    const captured = context(), projectId = captured.projectId;
    if (operation === 'job.retry' && dataRef.current.jobs?.length) subjectRetry = subjectRetry || isSubjectRetryPending({ projectId, key, operation, input }, dataRef.current.jobs);
    const mutation = isMutationOperation(operation);
    const timeline = TIMELINE_MUTATION_OPERATIONS.includes(operation);
    const reference = REFERENCE_MUTATION_OPERATIONS.includes(operation);
    const requestBound = timeline || reference;
    if (!replay && mutation && shotTextRef.current?.blocksLegacy()) { notify('请先核对或保存镜头文字；其他编辑请求不会被文字确认清除。', 'warning'); return null; }
    if (isBusy(key, projectId) || (mutation && isBusy('canvas:mutation', projectId))) return null;
    markBusy(projectId, key, true);
    if (mutation) markBusy(projectId, 'canvas:mutation', true);
    const durable = mutation || requestBound || ['generation.submit', 'job.retry', 'export.create'].includes(operation);
    const timelineMutation = timeline && operation !== 'timeline.render';
    const invalidateHistory = () => {
      if (!timelineMutation || currentProject.current !== projectId) return;
      ++requestCounter.current;
      dataRef.current = { ...dataRef.current, timelineHistory: null };
      setData(current => current.project?.id === projectId ? { ...current, timelineHistory: null } : current);
    };
    let stored, dispatched = false;
    try {
      const invocation = captured.workspace ? assertWorkspaceIntent(replay ? pendingEntry || {} : pinNewWorkspaceIntent({}, captured.workspace), captured.workspace) : {};
      if (captured.workspace) assertWorkspaceOperation(captured.workspace, operation);
      if (requestBound && input?.projectId !== projectId)
        throw Object.assign(new Error('项目已变化，已阻止旧面板提交。请回到原项目的任务面板核对请求。'), { code: 'MUTATION_PROJECT_MISMATCH' });
      if (durable) {
        const entry = pendingEntry && replay ? pendingEntry : { projectId, key, operation, input, ...invocation, createdAt: new Date().toISOString(),
          ...((operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') || operation === 'job.retry' && subjectRetry) && expectedSubjectReference ? { expectedSubjectReference: structuredClone(expectedSubjectReference) } : {}),
          ...(operation === 'job.retry' && subjectRetry ? { subjectRetry: true, ...(expectedRetrySnapshot ? { expectedRetrySnapshot: structuredClone(expectedRetrySnapshot) } : {}) } : {}) };
        if (operation === 'job.retry' && replay && subjectRetry) {
          const original = readPending(projectId, key, entry);
          if (!original || original.operation !== operation || original.subjectRetry !== true || original.input?.jobId !== input.jobId || original.input?.requestId !== input.requestId || Object.keys(original.input).length !== Object.keys(input).length || Object.keys(original.input).some(field => original.input[field] !== input[field]))
            throw Object.assign(new Error('主体重试的原请求已变化或缺失，已阻止恢复；不会重新创建请求。'), { code: 'MUTATION_REPLAY_MISMATCH' });
        }
        if (operation === 'job.retry' && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key && (subjectRetry || isSubjectRetryPending(item, dataRef.current.jobs || []))))
          throw Object.assign(new Error('主体重试有原请求待确认，请先在任务中心核对同一请求。'), { code: 'MUTATION_PENDING' });
        if (operation === 'generation.submit' && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key && (Object.hasOwn(input, 'subjectVersionId') || Object.hasOwn(item.input ?? {}, 'subjectVersionId'))))
          throw Object.assign(new Error('主体生成有原请求待确认，请先在任务中心核对；不会提交新选择或自动重试原请求。'), { code: 'MUTATION_PENDING' });
        if (mutation && !replay) assertMutationOwner(entry, dataRef.current);
        // A new timeline or reference click must not silently replay an older
        // uncertain request. Only the task panel may recover its original input.
        if (requestBound && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key))
          throw Object.assign(new Error(`上一条${reference ? '首帧参考' : '时间线'}请求的结果尚未确认。原请求已保留，请先在任务面板恢复同一请求。`), { code: 'MUTATION_PENDING' });
        if (requestBound && replay) stored = prepareRequestReplay(entry);
        else stored = mutation ? prepareMutation(entry, { replay }) : prepareSubmission(entry, { replay });
        if (requestBound && stored.operation !== operation)
          throw Object.assign(new Error('原请求操作不一致，已阻止提交。请先核对任务面板中的原请求。'), { code: 'MUTATION_REPLAY_MISMATCH' });
        if (requestBound && stored.input.projectId !== projectId)
          throw Object.assign(new Error('原请求所属项目不一致，已阻止提交。请先核对原项目的任务记录。'), { code: 'MUTATION_PROJECT_MISMATCH' });
        input = stored.input; operation = stored.operation;
        if (operation === 'job.retry' && (stored.subjectRetry || stored.expectedSubjectReference || stored.expectedRetrySnapshot || dataRef.current.jobs?.length)) subjectRetry = subjectRetry || isSubjectRetryPending(stored, dataRef.current.jobs || []);
        if (currentProject.current === projectId) setPending(pendingForProject(projectId));
      }
      invalidateHistory();
      dispatched = true;
      const result = await rpc(operation, input, invocation);
      invalidateHistory();
      if (mutation) validateMutationResponse(stored, result);
      if (timeline && !isTimelineMutationResponse(operation, input, result)) throw Object.assign(new Error('未收到与原请求一致的时间线确认。'), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (reference && !isReferenceMutationResponse(operation, input, result)) throw Object.assign(new Error('未收到与原请求一致的首帧参考确认。'), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') && (!stored?.expectedSubjectReference || !isSubjectGenerationResponse(operation, input, result, { projectId, subjectReference: stored.expectedSubjectReference })))
        throw Object.assign(new Error('主体生成确认与原请求的固定图片不一致。原请求保留，请在任务中心核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'job.retry' && subjectRetry && (!stored.expectedSubjectReference || !stored.expectedRetrySnapshot || !isSubjectGenerationRetryResponse(input, result, { projectId, subjectReference: stored.expectedSubjectReference, snapshot: stored.expectedRetrySnapshot })))
        throw Object.assign(new Error('主体重试确认与原任务的固定快照不一致。原请求保留，请在任务中心核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });
      validateResponse?.(result);
      if (replay && operation === 'asset.range.set' && currentProject.current === projectId) {
        const assetId = stored.input.assetId;
        setSourceRangeRefresh(value => ({ ...value, [`${projectId}:${assetId}`]: (value[`${projectId}:${assetId}`] || 0) + 1 }));
      }
      if (durable) { clearPending(projectId, key, stored); if (currentProject.current === projectId) setPending(pendingForProject(projectId)); }
      if (currentProject.current === projectId) await refresh(projectId);
      // A still-mounted inspector may finish a save after its preview changes.
      // Returning its acknowledged record is safe; navigation effects are not.
      if (!isCurrent(captured)) return !replay && returnAfterNavigation && currentProject.current === projectId ? result : null;
      if (message) notify(message); return mutation && replay ? null : result;
    } catch (e) {
      if (dispatched) invalidateHistory();
      const rejected = operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') || operation === 'job.retry' && (subjectRetry || stored?.subjectRetry === true) ? false : mutation ? mutationNotApplied(e, stored) : requestBound
        ? Boolean(stored && hasRequestNotAppliedProof(e, stored.input, { operation })) : e.definitive;
      onFailure?.(e, { dispatched, rejected });
      if (durable && stored && rejected) { clearPending(projectId, key, stored); if (currentProject.current === projectId) setPending(pendingForProject(projectId)); }
      if (currentProject.current === projectId) {
        if (e.code === 'UNAUTHORIZED') setAuth(false);
        if (durable && stored && dispatched && !rejected) { notify('提交结果尚未确认。原请求已保留，请在任务面板恢复同一请求；不会自动重试或生成新的提交编号。', 'error'); if (isCurrent(captured)) openTasks(canRevealTasks); }
        else if (isCurrent(captured)) notify(operation === 'timeline.clip.replaceSource' ? clipReplacementErrorMessage(e) : errorMessage(e), 'error');
        if (e.code === 'MUTATION_PENDING' && isCurrent(captured)) openTasks(canRevealTasks);
        if (dispatched || !requestBound) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); if (mutation) markBusy(projectId, 'canvas:mutation', false); if (replay && operation === 'asset.disposition.set' && currentProject.current === projectId) setDispositionRefresh(value => ({ ...value, [projectId]: (value[projectId] || 0) + 1 })); }
  }
  // Picking a shot, node or clip means "show me its properties". The Tasks and Delivery pages are reference views
  // (Tasks even opens by itself after a generation), so they give way; Agent and Image keep following the selection.
  function leaveReferencePage() { setRightDockTab(value => value === 'tasks' || value === 'delivery' ? 'properties' : value); }
  async function inspect(id, nextTab = 'settings', versionId = null, { reveal = false } = {}) {
    if ((id !== selectedId || workspaceMode !== 'canvas') && !await guardNavigation('当前面板有未保存的修改。放弃修改并查看画板来源？')) return false;
    if (![...dataRef.current.shots, ...dataRef.current.nodes].some(record => record.id === id)) return false;
    navigationEpoch.current++;
    leaveReferencePage();
    updateView('canvas', { selectedId: id, inspectorTab: nextTab, highlightedVersionId: versionId });
    updateView('activeMode', 'canvas');
    if (reveal) { setPanelOpen('inspector', true, 'canvas'); if (geometry.narrow) setMobilePanel('inspector'); }
    return true;
  }
  function checkGeneration(shot, provider, model, inputMode, frozen = false, subjectReference) {
    if (generationUnavailableReason) { notify(generationUnavailableReason, 'warning'); return false; }
    if (!frozen && !workspaceRef.current?.restored && (!shotTextRef.current || shotTextRef.current.blocksLegacy(shot.id))) { notify('请先核对目标镜头的本地文字，保存或处理记录后再次明确点击生成。不会自动继续生成。', 'warning'); return false; }
    if (referenceWorkBlocked()) return false;
    const issue = generationInputIssue(shot, provider, model, dataRef.current.assets, inputMode, { frozen, subjectReference, ...(!frozen && inputMode === 'subject' ? { savedShot: dataRef.current.shots.find(item => item.id === shot.id), boundReference: Boolean(referenceForShot(dataRef.current.edges, shot.id)) } : {}) }) || providerAvailabilityIssue(provider);
    if (issue) { notify(issue, 'error'); return false; }
    if (dataRef.current.jobs.some(j => j.shotId === shot.id && j.status === 'submission_unknown')) { notify('此镜头存在状态未知的提交，服务商可能已经计费。请先核实任务状态，不要重复提交。', 'error'); openTasks(); return false; }
    return true;
  }
  const submitGeneration = async ({ shot, providerId, model, scenario, inputMode, retryJobId, subjectReference, expectedRetrySnapshot }) => {
    const canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false);
    const provider = providers.find(item => item.id === providerId);
    if (!checkGeneration(shot, provider, model, inputMode, Boolean(retryJobId), subjectReference)) return;
    if (retryJobId && shot.subjectReference) {
      if (!expectedRetrySnapshot || subjectVideoIdentity(expectedRetrySnapshot.subjectReference) !== subjectVideoIdentity(shot.subjectReference)) { notify('原主体任务快照缺失或变化，已阻止重试。请重新读取原任务。', 'warning'); return; }
      return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, '已基于原始快照创建重试任务', { subjectRetry: true, expectedSubjectReference: expectedRetrySnapshot.subjectReference, expectedRetrySnapshot });
    }
    if (retryJobId) return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, '已基于原始快照创建重试任务');
    const result = await run(`generate:${shot.id}`, 'generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: requestId(), providerId, ...(model ? { model } : {}), ...(providerId === 'mock' ? { parameters: { scenario } } : {}), ...(subjectReference ? { subjectVersionId: subjectReference.subjectVersionId } : {}) }, undefined, subjectReference ? { expectedSubjectReference: subjectReference } : {});
    if (result) { notify(result.status === 'submission_unknown' ? '提交结果待确认。请查看任务状态，不要重复提交。' : '生成任务已提交，完成后会保存为新版本。', result.status === 'submission_unknown' ? 'warning' : 'success'); openTasks(canRevealTasks); }
  };
  function generate(shot, options = generationOptionsRef.current[shot.id] || {}) {
    const { provider, model, scenario, inputMode } = generationSelection(providers, options, shot);
    const subjectReference = inputMode === 'subject' ? options.subjectReference : undefined;
    const currentOptions = generationOptionsRef.current[shot.id] || {};
    const currentSelection = generationSelection(providers, currentOptions, shot);
    if (inputMode === 'subject' && (shot.projectId !== currentProject.current || !dataRef.current.shots.some(current => current.id === shot.id && current.revision === shot.revision) || currentSelection.inputMode !== 'subject' || currentSelection.provider?.id !== provider?.id || currentSelection.model !== model || currentSelection.scenario !== scenario || subjectVideoIdentity(currentOptions.subjectReference) !== subjectVideoIdentity(subjectReference))) return;
    if (!checkGeneration(shot, provider, model, inputMode, false, subjectReference)) return;
    const args = { shot, providerId: provider.id, model, scenario, inputMode, ...(subjectReference ? { subjectReference: structuredClone(subjectReference) } : {}) };
    if (!provider.mock) reviewGeneration(args); else submitGeneration(args);
  }
  function retryGeneration(job, stillCurrent = () => true) {
    if (!stillCurrent()) return;
    const provider = providers.find(item => item.id === job.providerId);
    const shot = { ...job.snapshot, id: job.shotId };
    const inputMode = shot.subjectReference ? 'subject' : shot.referenceAssetIds?.length ? 'image' : 'text';
    if (!checkGeneration(shot, provider, job.model, inputMode, true)) return;
    const args = { shot, providerId: job.providerId, model: job.model, inputMode, retryJobId: job.id, ...(job.snapshot.subjectReference ? { expectedRetrySnapshot: structuredClone(job.snapshot) } : {}) };
    if (!provider.mock) reviewGeneration(args, stillCurrent); else submitGeneration(args);
  }
  function reviewGeneration(args, taskViewGuard) {
    const frozen = Boolean(args.retryJobId);
    const referenceOptions = { frozen, subjectReference: args.subjectReference };
    const review = { ...structuredClone(args), ...(taskViewGuard ? { taskViewGuard } : {}), ...(args.subjectReference || args.shot.subjectReference ? { subjectProviderIdentity: subjectVideoProfileIdentity(providers.find(provider => provider.id === args.providerId), args.model) } : {}), approvalContext: context(), approvalView: generationReviewScope.current,
      referenceIdentity: generationReferenceIdentity(args.shot, dataRef.current.assets, referenceOptions),
      // Keep reviewed thumbnail labels/metadata stable while the modal is open.
      referenceAssets: structuredClone(dataRef.current.assets.filter(asset => generationReferences(args.shot, referenceOptions).references.some(reference => reference.assetId === asset.id))) };
    realConfirmRef.current = review; setRealConfirm(review);
  }
  function confirmGeneration(args) {
    if (realConfirmRef.current !== args) return;
    realConfirmRef.current = null; setRealConfirm(null);
    const frozen = Boolean(args.retryJobId);
    const currentShot = dataRef.current.shots.find(shot => shot.id === args.shot.id);
    const selection = generationSelection(providers, generationOptionsRef.current[args.shot.id], currentShot || {});
    const currentJob = frozen ? dataRef.current.jobs.find(job => job.id === args.retryJobId) : null;
    const stale = Boolean(args.taskViewGuard && !args.taskViewGuard()) || !isCurrent(args.approvalContext) || args.approvalView !== generationReviewScope.current || !currentShot ||
      (!frozen && (currentShot.revision !== args.shot.revision || selection.provider?.id !== args.providerId || selection.model !== args.model || selection.inputMode !== args.inputMode || (args.subjectReference || selection.inputMode === 'subject') && subjectVideoIdentity(selection.inputMode === 'subject' ? generationOptionsRef.current[args.shot.id]?.subjectReference : null) !== subjectVideoIdentity(args.subjectReference))) ||
      (frozen && (!currentJob || JSON.stringify(currentJob.snapshot) !== JSON.stringify(Object.fromEntries(Object.entries(args.shot).filter(([key]) => key !== 'id'))))) ||
      (args.subjectProviderIdentity && subjectVideoProfileIdentity(providers.find(provider => provider.id === args.providerId), args.model) !== args.subjectProviderIdentity) ||
      generationReferenceIdentity(args.shot, dataRef.current.assets, { frozen, subjectReference: args.subjectReference }) !== args.referenceIdentity;
    if (stale) { notify('镜头、参考素材或当前工作区已变化，请重新检查固定主体图片或完整首尾帧后确认生成。', 'warning'); return; }
    submitGeneration(args);
  }
  async function createProject(name, description) {
    if (!await guardProjectNavigation('当前面板有未保存的修改。放弃修改并新建项目？')) return;
    const captured = context();
    const created = await run('project-create', 'project.create', { name, description });
    if (!created || !isCurrent(captured)) return;
    const list = await rpc('project.list'); if (!isCurrent(captured)) return;
    setProjects(list); setShowCreate(false); await selectProject(created.id); notify('项目已创建。导入素材，开始你的第一个镜头。');
  }
  async function addShot() {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation('当前面板有未保存的修改。放弃修改并创建镜头？')) return;
    const state = dataRef.current, count = state.shots.length;
    const shot = await run('shot-create', 'shot.create', { projectId: state.project.id, title: `镜头 ${String(count + 1).padStart(2, '0')}`, prompt: '', duration: 2, aspectRatio: '9:16', referenceAssetIds: [], position: { x: 350 + (count % 3) * 330, y: Math.floor(count / 3) * 430 + 80 } });
    if (shot && await inspect(shot.id)) revealCanvas(shot.id);
  }
  async function addStructure() {
    const owner = data.project?.id;
    if (!owner || owner !== currentProject.current || dataRef.current.project?.id !== owner || dataRef.current.shots.length || dataRef.current.nodes.length || isBusy('structure')) return;
    if (!await guardNavigation('当前面板有未保存的修改。放弃修改并创建镜头结构？')) return;
    if (owner !== currentProject.current || dataRef.current.project?.id !== owner || dataRef.current.shots.length || dataRef.current.nodes.length || isBusy('structure')) return;
    const captured = context(), state = dataRef.current, projectId = state.project.id;
    markBusy(projectId, 'structure', true);
    const base = state.shots.length, firstImage = state.assets.find(a => a.mimeType.startsWith('image/'));
    let done = 0;
    try {
      for (const [i, title] of ['建立场景', '展开故事', '留下余韵'].entries()) {
        if (!isCurrent(captured)) return;
        const created = await run('shot-create', 'shot.create', { projectId, title: `${String(base + i + 1).padStart(2, '0')} · ${title}`, prompt: '', referenceAssetIds: firstImage ? [firstImage.id] : [], duration: 2, aspectRatio: '9:16', position: { x: 100 + i * 340, y: 130 } });
        if (!created) { if (isCurrent(captured)) notify(`已停止创建结构，已确认 ${done}/3 个镜头。如有待确认请求，请在任务面板恢复；其余镜头不会自动创建。`, 'warning'); return; }
        done++;
      }
      const next = await refresh(projectId);
      if (isCurrent(captured) && next) { const first = next.shots.find(shot => shot.orderIndex === base); if (first && await inspect(first.id)) revealCanvas(); notify('三个镜头已准备好，逐个写下画面描述。'); }
    } catch (e) { if (isCurrent(captured)) notify(readableError(e), 'error'); await refresh(projectId); } finally { markBusy(projectId, 'structure', false); }
  }
  async function addNode(type, asset, dropPosition) {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation('当前面板有未保存的修改。放弃修改并添加到画板？')) return;
    const state = dataRef.current;
    if (type !== 'text' && !asset) { asset = state.assets.find(a => a.mimeType.startsWith(`${type}/`)); if (!asset) { notify(`请先导入${type === 'image' ? '图片' : type === 'audio' ? '音频' : '视频'}素材。`, 'warning'); fileInput.current?.click(); return; } }
    const saved = viewRef.current.canvas.viewport;
    const location = dropPosition || (workspaceMode === 'canvas' ? flow.screenToFlowPosition({ x: window.innerWidth * .43, y: window.innerHeight * .35 }) : { x: saved ? (300 - saved.x) / saved.zoom : 100, y: saved ? (200 - saved.y) / saved.zoom : 100 });
    const node = await run('node-create', 'node.create', { projectId: state.project.id, type, label: type === 'text' ? '创作笔记' : asset.name, ...(type === 'text' ? { text: '' } : { assetId: asset.id }), position: location });
    if (node && await inspect(node.id)) revealCanvas(node.id);
  }
  async function importFiles(files) {
    if (!importSession.current.active || !files?.length) return;
    const selection = ++importSession.current.selection;
    ++requestCounter.current; // Invalidate an older batch's pending refresh.
    if (!data.project) return setShowCreate(true);
    const projectId = data.project.id;
    if (projectId !== currentProject.current || dataRef.current.project?.id !== projectId) return;
    const batch = Array.from(files), inputElement = fileInput.current;
    if (isBusy('import')) {
      notify(importBusyFeedback(batch), 'warning');
      if (inputElement === fileInput.current && inputElement) inputElement.value = '';
      return;
    }
    const captured = context();
    const invocation = captured.workspace ? pinNewWorkspaceIntent({}, captured.workspace) : {};
    const ownsSelection = () => importSession.current.active && selection === importSession.current.selection && isCurrent(captured);
    markBusy(projectId, 'import', true);
    let done = 0, dispatched = false;
    try {
      for (const file of batch) {
        if (!ownsSelection()) return;
        dispatched = false;
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'].includes(file.type)) throw new Error('格式不支持。请使用 PNG、JPG、WEBP、MP4、WEBM、MP3、WAV 或 M4A。');
        if (file.size > 30 * 1024 * 1024) throw new Error('超过 30 MiB，请压缩后导入。');
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string' || !result.includes(',')) return reject(new Error('无法读取文件内容，请检查文件。'));
            resolve(result.slice(result.indexOf(',') + 1));
          };
          reader.onerror = () => reject(new Error('无法读取文件，请检查文件是否可访问。'));
          reader.onabort = () => reject(new Error('文件读取已中止。'));
          reader.readAsDataURL(file);
        });
        if (!ownsSelection()) return;
        const input = { projectId, name: file.name, mimeType: ({ 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4' }[file.type] || file.type), dataBase64: base64 };
        dispatched = true;
        if (captured.workspace) assertWorkspaceOperation(captured.workspace, 'asset.import');
        const asset = await rpc('asset.import', input, invocation);
        if (!importAcknowledged(asset, input)) throw new Error('未收到有效导入确认。');
        done++;
      }
      if (ownsSelection()) notify(importFeedback(batch, done));
    } catch (error) {
      const kind = !dispatched ? 'local' : error?.definitive === true && error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown';
      if (ownsSelection()) notify(importFeedback(batch, done, { kind, reason: kind === 'unknown' ? '' : readableError(error) }), 'error');
    } finally {
      try { if (ownsSelection()) await refresh(projectId); }
      finally {
        if (importSession.current.active) markBusy(projectId, 'import', false);
        else busyRef.current.delete(`${projectId}:import`);
        if (ownsSelection() && inputElement === fileInput.current && inputElement) inputElement.value = '';
      }
    }
  }
  function shotTextContext() {
    const projectId = currentProject.current;
    let legacyPending = true;
    try { legacyPending = pendingForProject(projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || REFERENCE_MUTATION_OPERATIONS.includes(entry.operation)); }
    catch { /* Unreadable legacy identity cannot authorize another save. */ }
    return {
      scope: `${projectId}:${projectEpoch.current}:${inspectorEpoch}`,
      restored: workspaceRef.current?.restored === true,
      connected: online && auth === true && !loading,
      busy: legacyPending || isBusy('canvas:mutation') || isBusy('reference:mutation') || tasksRef.current.blocked(projectId, 'reference:mutation'),
      executionEpoch: `${navigationEpoch.current}:${panelIntent.current}`,
    };
  }
  async function saveShot(shotId, expectedRevision, patch) {
    if (referenceWorkBlocked()) return null;
    return run(`save:${shotId}`, 'shot.update', { shotId, expectedRevision, patch }, '镜头已保存', { returnAfterNavigation: true });
  }
  async function saveNode(nodeId, expectedRevision, patch) { return run(`save:${nodeId}`, 'node.update', { nodeId, expectedRevision, patch }, '节点已保存', { returnAfterNavigation: true }); }
  async function savePosition(_, node) {
    const snapshot = dataRef.current;
    const record = snapshot.shots.find(s => s.id === node.id) || snapshot.nodes.find(n => n.id === node.id);
    if (record) await run(`position:${node.id}`, snapshot.shots.some(s => s.id === node.id) ? 'shot.update' : 'node.update', { [snapshot.shots.some(s => s.id === node.id) ? 'shotId' : 'nodeId']: record.id, expectedRevision: record.revision, patch: { position: node.position } });
    dragging.current = false;
  }
  function referenceWorkBlocked() {
    if (shotTextRef.current?.blocksLegacy()) { notify('镜头文字尚待保存或核对。请先处理右侧文字记录，再保存其他设置、连接或生成。', 'warning'); return true; }
    if (tasksRef.current.blocked(currentProject.current, 'reference:mutation')) { notify('首帧请求恢复状态尚未确认。请先在任务中心核对，再保存、连接或生成。', 'warning'); openTasks(); return true; }
    if (pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => isMutationOperation(entry.operation))) { notify('此项目有编辑请求待确认。草稿仍保留；请先在任务面板恢复原请求，再保存、连接或生成。', 'warning'); openTasks(); return true; }
    if (isBusy('reference:mutation')) { notify('首帧连接正在同步，请稍候。', 'warning'); return true; }
    if (hasPendingReference(pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }))) { notify('首帧连接的结果尚未确认。请先在任务面板恢复同一请求，再保存或生成。', 'warning'); openTasks(); return true; }
    return false;
  }
  async function attachReference(sourceNodeId, targetShotId) {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify('请先保存或放弃当前面板的修改，再连接首帧。你的输入仍保留。', 'warning'); return null; }
    const state = dataRef.current;
    const source = state.nodes.find(node => node.id === sourceNodeId);
    const shot = state.shots.find(item => item.id === targetShotId);
    const issue = referenceAttachIssue({ source, shot, assets: state.assets, edges: state.edges, projectId: state.project?.id });
    if (issue) { notify(issue, 'warning'); return null; }
    return run('reference:mutation', 'reference.attach', { projectId: state.project.id, sourceNodeId, targetShotId, expectedSourceRevision: source.revision, expectedShotRevision: shot.revision, requestId: requestId(), role: 'first_frame' }, '已连接首帧参考图。生成将使用这张图片。');
  }
  async function detachReference(edgeId) {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify('请先保存或放弃当前面板的修改，再断开首帧。你的输入仍保留。', 'warning'); return null; }
    const state = dataRef.current;
    const edge = state.edges.find(item => item.id === edgeId && isReferenceEdge(item));
    const shot = state.shots.find(item => item.id === edge?.target);
    if (!edge || !shot) { await refresh(); return null; }
    if (!await confirm(`断开「${shot.title}」的首帧参考连接？这会清除此连接设置的参考图，原始素材与图片节点会保留。`)) return null;
    if (currentProject.current !== state.project.id || referenceWorkBlocked()) return null;
    return run('reference:mutation', 'reference.detach', { projectId: state.project.id, edgeId, expectedShotRevision: shot.revision, requestId: requestId() }, '首帧连接已断开，原始素材与图片节点已保留。');
  }
  async function connect(connection) {
    if (connection.source === connection.target) return notify('请选择两个不同的节点。', 'warning');
    if (connection.sourceHandle === REFERENCE_SOURCE_HANDLE || connection.targetHandle === REFERENCE_TARGET_HANDLE) {
      if (connection.sourceHandle !== REFERENCE_SOURCE_HANDLE || connection.targetHandle !== REFERENCE_TARGET_HANDLE) return notify('请将图片的绿色首帧输出连接到镜头的绿色首帧输入。灰色端口仅用于视觉连线。', 'warning');
      return attachReference(connection.source, connection.target);
    }
    await run(`edge:${connection.source}:${connection.target}`, 'edge.create', { projectId: dataRef.current.project.id, source: connection.source, target: connection.target }, '已添加视觉连线，不会改变生成输入。');
  }
  function beforeDeleteEdges({ edges: removed }) {
    const selected = removed.filter(edge => edge.id === selectedEdgeId);
    if (selected.some(edge => isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id)))) notify('首帧参考需要在镜头设置中明确断开；选中连线后可打开目标镜头。', 'warning');
    return Promise.resolve({ nodes: [], edges: selected.filter(edge => !isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id))) });
  }
  async function selectVersion(shot, versionId) { return run(`version:${shot.id}`, 'version.select', { shotId: shot.id, versionId, expectedRevision: shot.revision }, '已更新当前选用版本'); }
  async function reorder(id, targetIndex) {
    const ordered = [...dataRef.current.shots].sort((a, b) => a.orderIndex - b.orderIndex); const from = ordered.findIndex(s => s.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ordered.length || from === targetIndex) return;
    ordered.splice(targetIndex, 0, ordered.splice(from, 1)[0]);
    await run('reorder', 'shot.reorder', { projectId: data.project.id, expectedRevision: dataRef.current.project.revision, shotIds: ordered.map(s => s.id) }, '分镜顺序已更新，画布位置保持独立');
  }
  function readTaskRevealContext() {
    return { active: importSession.current.active && viewReady.current && taskWorkspaceState.current?.connected === true,
      projectId: currentProject.current || '', projectEpoch: projectEpoch.current, navigationEpoch: navigationEpoch.current,
      panelIntent: panelIntent.current, workspaceScope: workspaceOriginScope(workspaceRef.current) };
  }
  function readTaskViewContext() {
    const current = readTaskRevealContext();
    return { ...current, active: current.active && taskWorkspaceState.current?.visible === true };
  }
  function captureTaskView() { return captureTaskWorkspaceIntent(readTaskViewContext); }
  function openTasks(canReveal = () => true) {
    if (!canReveal() || !currentProject.current || !viewReady.current) return false;
    setRightDockTab('tasks'); setPanelOpen('inspector', true); return true;
  }
  function inspectTaskJob(job, stillCurrent) {
    const attempt = ++taskShotAttempt.current;
    const target = { projectId: currentProject.current || '', jobId: job.id, shotId: job.shotId, tab: job.status === 'succeeded' ? 'versions' : 'settings' };
    return navigateTaskShot(target, {
      readContext: readTaskViewContext, isVisible: () => attempt === taskShotAttempt.current && stillCurrent(),
      hasTarget: selected => dataRef.current.project?.id === selected.projectId &&
        dataRef.current.jobs.some(item => item.id === selected.jobId && item.shotId === selected.shotId && item.projectId === selected.projectId) &&
        dataRef.current.shots.some(item => item.id === selected.shotId && item.projectId === selected.projectId),
      guard: canNavigate => guardNavigation('当前面板有未保存的修改。放弃修改并查看任务镜头？', false, canNavigate),
      reveal: selected => {
        navigationEpoch.current++;
        updateView('canvas', { selectedId: selected.shotId, inspectorTab: selected.tab, highlightedVersionId: null });
        updateView('activeMode', 'canvas'); setPropertiesPage('inspector'); setRightDockTab('properties');
        setPanelOpen('inspector', true, 'canvas');
      },
    });
  }
  function openExportHistory() { setShowExports(true); setRightDockTab('delivery'); setPanelOpen('inspector', true); }
  async function createExport() { const panelChoice = panelIntent.current, projectId = currentProject.current; const result = await run('export', 'export.create', { projectId: data.project.id, requestId: requestId() }); if (result) { if (panelChoice === panelIntent.current && projectId === currentProject.current) openExportHistory(); notify('导出任务已创建，将按分镜板顺序拼接选用版本。'); } }
  const timeline = data.timeline;
  const timelinePending = taskState.phase !== 'ready' || activeTasks.some(task => task.lane === 'timeline:mutation') || activePending.some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render');
  const timelineBusy = Boolean(busy['timeline:mutation'] || timelinePending);
  const assetUsageAttempt = useRef(0), assetUsageAvailability = useRef(null), assetUsageSnapshot = useRef(null);
  const assetUsageReady = online && auth === true && !loading && !timelineBusy && viewReady.current && data.project?.id === currentProject.current;
  assetUsageAvailability.current = { ready: assetUsageReady };
  const nextTimelineUsage = useMemo(() => deriveTimelineAssetUsage({ projectId: data.project?.id || '', assets: data.assets, timeline, ready: assetUsageReady }), [data.project?.id, data.assets, timeline, assetUsageReady]);
  const timelineUsage = retainTimelineAssetUsage(assetUsageSnapshot.current, nextTimelineUsage);
  assetUsageSnapshot.current = timelineUsage;
  function readAssetUsageNavigation() {
    const projectId = currentProject.current || '', snapshot = dataRef.current;
    return { active: importSession.current.active && viewReady.current, projectId, projectEpoch: projectEpoch.current,
      navigationEpoch: navigationEpoch.current, panelIntent: panelIntent.current, attempt: assetUsageAttempt.current, workspaceScope: workspaceOriginScope(workspaceRef.current),
      usage: deriveTimelineAssetUsage({ projectId, assets: snapshot.assets, timeline: snapshot.timeline,
        ready: assetUsageAvailability.current?.ready && snapshot.project?.id === projectId && !isBusy('timeline:mutation') }) };
  }
  async function locateAssetUse(use, isStillVisible = () => true) {
    assetUsageAttempt.current++;
    return locateTimelineAssetUse(use, { read: readAssetUsageNavigation, isVisible: isStillVisible,
      confirm: canDiscard => guardNavigation('当前面板有未保存修改。放弃修改并定位此素材的时间线片段？', false, canDiscard),
      reveal: target => {
        setPropertiesPage('inspector'); setRightDockTab('properties'); navigationEpoch.current++;
        updateView('editing', { selectedClipId: target.clipId, quickAssetId: null, playhead: target.startFrame, previewKind: 'source', timelineCollapsed: false });
        updateView('activeMode', 'editing'); setPanelOpen('inspector', true, 'editing'); setMobilePanel(geometry.narrow ? 'timeline' : 'canvas');
        const captured = context(), epoch = projectEpoch.current, panel = panelIntent.current, attempt = assetUsageAttempt.current;
        revealTimelineAssetUse(target.clipId,
          () => importSession.current.active && isCurrent(captured) && epoch === projectEpoch.current && panel === panelIntent.current && attempt === assetUsageAttempt.current
            && viewRef.current.activeMode === 'editing' && viewRef.current.editing.selectedClipId === target.clipId && matchesTimelineAssetUse(readAssetUsageNavigation().usage, target),
          () => document.querySelector('[data-testid="timeline-scroll"]'), callback => requestAnimationFrame(callback));
      } });
  }
  function timelineFormatContext() {
    const projectId = currentProject.current, snapshot = dataRef.current;
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: snapshot.project?.id === projectId ? projectId : null,
      projectRevision: snapshot.project?.revision, timelineId: snapshot.timeline?.id || null, timelineRevision: snapshot.timeline?.revision || 0,
      connected: online && auth === true && !loading,
      pending: !projectId || tasksRef.current.blocked(projectId) || pendingForProject(projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || entry.operation.startsWith('timeline.')) };
  }
  async function saveTimelineFormat(intent) {
    const live = timelineFormatContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || !live.connected || live.pending || !isDurableEditOperation('timeline.format.set')) return { status: 'rejected' };
    let failure, acknowledged;
    const result = await runDurable('timeline:mutation', 'timeline.format.set', intent.input, '时间线输出规格已保存。', {
      returnAfterNavigation: true, canExecute: () => intent.scope === timelineFormatContext().scope,
      validateResponse: value => { if (!timelineFormatAcknowledged(intent, value)) throw Object.assign(new Error('规格确认与本次请求不一致。'), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    return { status: tasksRef.current.blocked(intent.projectId) || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  }
  const timelineFormat = useTimelineFormat({ ...timelineFormatContext(), getContext: timelineFormatContext,
    visible: propertiesPage === 'format' && rightDockTab === 'properties' && panelVisible('inspector'),
    refreshKey: `${lastSync?.getTime() || 0}:${taskState.phase}:${taskState.items.map(task => `${task.id}:${task.revision}`).join(',')}`,
    read: (input, options) => rpc('timeline.format.get', input, options), submit: saveTimelineFormat, createRequestId: requestId,
    onUnauthorized: () => setAuth(false) });
  timelineFormatRef.current = timelineFormat;
  useEffect(() => { setFormatDirty(Boolean(timelineFormat.state?.dirty || timelineFormat.state?.submitting)); }, [timelineFormat.state?.dirty, timelineFormat.state?.submitting]);
  function openTimelineFormat() {
    setShowProjects(false); setPropertiesPage('format'); setRightDockTab('properties'); setPanelOpen('inspector', true);
  }
  function subtitleContext() {
    const projectId = currentProject.current, snapshot = dataRef.current;
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: snapshot.project?.id === projectId ? projectId : null, timeline: snapshot.timeline,
      connected: online && auth === true && !loading, pending: !projectId || isBusy('timeline:mutation') || tasksRef.current.blocked(projectId, 'timeline:mutation') || pendingForProject(projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      visible: workspaceMode === 'editing' && propertiesPage === 'subtitle' && rightDockTab === 'properties' && panelVisible('inspector') };
  }
  async function saveSubtitle(intent) {
    const live = subtitleContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || intent.timelineId !== live.timeline?.id || intent.input.expectedRevision !== live.timeline?.revision || !live.connected || live.pending || !live.visible || !isDurableEditOperation(intent.operation)) return { status: 'rejected' };
    let failure, acknowledged;
    const result = await runDurable('timeline:mutation', intent.operation, intent.input, '字幕已保存；请重新渲染以查看最新画面。', {
      returnAfterNavigation: true, canExecute: () => intent.scope === subtitleContext().scope && subtitlesRef.current?.controller.isVisible() && intent.selection === subtitlesRef.current?.controller.getState().selection,
      validateResponse: value => { if (!subtitleAcknowledged(intent, value)) throw Object.assign(new Error('字幕确认与原请求不一致。'), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    return { status: tasksRef.current.blocked(intent.projectId, 'timeline:mutation') || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  }
  const subtitles = useSubtitles({ ...subtitleContext(), getContext: subtitleContext, submit: saveSubtitle, createRequestId: requestId, onDirtyChange: setSubtitleDirty });
  subtitlesRef.current = subtitles;
  async function openSubtitle(cueId, frame = viewRef.current.editing.playhead) {
    const captured = context(), panelChoice = panelIntent.current, controller = subtitlesRef.current?.controller, selected = controller?.getState();
    if (!controller || viewRef.current.activeMode !== 'editing' || loading) return;
    const sameSelection = selected.draft && (cueId ? selected.cueId === cueId : !selected.cueId && Number(selected.draft.startFrame) === frame);
    if (!sameSelection && (selected.submitting || selected.uncertain)) { notify('请先在任务中心核对原字幕请求，草稿仍保留。', 'warning'); openTasks(); return; }
    if (!sameSelection && selected.dirty) {
      if (!await confirm('字幕有未保存修改。放弃此字幕草稿并选择另一条？')) return;
      if (!isCurrent(captured) || panelChoice !== panelIntent.current || controller.getState() !== selected) return;
      controller.discardDraft(selected.scope);
    }
    if (!isCurrent(captured) || panelChoice !== panelIntent.current) return;
    if (!sameSelection && !(cueId ? controller.select(cueId, selected.scope) : controller.begin(frame, selected.scope))) return;
    setPropertiesPage('subtitle'); setRightDockTab('properties'); setPanelOpen('inspector', true);
  }
  function clipReplacementContext() {
    const state = dataRef.current, editing = viewRef.current.editing;
    return { scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: state.project?.id === currentProject.current ? currentProject.current : null,
      timeline: state.timeline, clipId: editing.selectedClipId, assets: state.assets, versions: state.versions, shots: state.shots,
      dirty: dirtyRef.current, busy: isBusy('timeline:mutation'), pending: tasksRef.current.blocked(currentProject.current, 'timeline:mutation') || pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      connected: online && auth === true && !loading, visible: viewRef.current.activeMode === 'editing' && !editing.quickAssetId };
  }
  async function replaceTimelineClipSource(review) {
    // UI candidate metadata cannot authorize a mutation. Recheck the exact
    // reviewed owner, revision, content and draft against live App refs.
    const issue = clipReplacementReviewIssue(review, clipReplacementContext());
    if (issue) return { status: 'rejected', error: { code: 'REVISION_CONFLICT' } };
    let failure, acknowledged;
    const result = await mutateTimeline('timeline.clip.replaceSource', review.input, review.expectedRevision, {
      returnAfterNavigation: true, onFailure: (error, details) => { failure = { error, ...details }; }, errorMessage: clipReplacementErrorMessage,
      validateResponse: value => { if (!clipReplacementAcknowledged(review, value)) throw Object.assign(new Error('替换确认与本次核对不一致。'), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
    });
    // A failed refresh cannot erase an already validated mutation receipt.
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    const unresolved = tasksRef.current.blocked(review.projectId, 'timeline:mutation') || pendingForProject(review.projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:mutation');
    return { status: unresolved || (failure?.dispatched && !failure.rejected) ? 'unknown' : 'rejected', error: failure?.error };
  }
  function exportSettingsContext() {
    return { scope: `${currentProject.current}:${projectEpoch.current}`, enabled: Boolean(dataRef.current.project?.id === currentProject.current && online && auth === true && !loading && !isBusy('timeline:render:export') && !pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) };
  }
  const exportSettings = useExportSettings({ ...exportSettingsContext(), getContext: exportSettingsContext });
  function exportRangeContext() {
    const base = exportSettingsContext(), local = localDeliveryRef.current?.controller.getState();
    return { ...base, enabled: base.enabled && rightDockTab === 'delivery' && !showExports && panelVisible('inspector') && !(local?.scope === base.scope && (local.busy || local.pending)),
      projectId: dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id || null, revision: dataRef.current.timeline?.revision || null,
      durationFrames: dataRef.current.timeline?.durationFrames ?? null };
  }
  const exportRange = useExportRange({ ...exportRangeContext(), getContext: exportRangeContext });
  function deliveryNameContext() { return { ...exportSettingsContext(), projectId: dataRef.current.project?.id === currentProject.current ? currentProject.current : null }; }
  const deliveryName = useTimelineDeliveryName({ ...deliveryNameContext(), getContext: deliveryNameContext });
  deliveryNameRef.current = deliveryName;
  function localDeliveryContext() {
    const scope = `${currentProject.current}:${projectEpoch.current}`;
    return { scope, projectId: dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id || null, timelineRevision: dataRef.current.timeline?.revision || null,
      restored: Boolean(workspaceRef.current?.restored), connected: online && auth === true && !loading,
      visible: rightDockTab === 'delivery' && !showExports && panelVisible('inspector'), busy: isBusy('timeline:render:export'),
      executionEpoch: `${navigationEpoch.current}:${panelIntent.current}:${exportSettings.controller.getVersion(scope)}:${exportRange.controller.getVersion(scope)}`,
      deliveryName: deliveryName.controller.getName(scope), nameVersion: deliveryName.controller.getVersion(scope), dirty: deliveryName.controller.hasUnsaved(scope) };
  }
  const localDelivery = useLocalDelivery({ context: localDeliveryContext(), getContext: localDeliveryContext,
    isRenderInput: value => schemas['timeline.render'].safeParse(value).success,
    validateResponse: (input, value) => isTimelineMutationResponse('timeline.render', input, value),
    validateNotApplied: (input, code) => hasRequestNotAppliedProof({ code, status: 409, details: { mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: input.projectId, requestId: input.requestId } }, input, { operation: 'timeline.render' }),
    onRestore: (draft, captured) => deliveryNameRef.current?.controller.choose(draft.raw.deliveryName, captured.scope, captured.nameVersion) === true,
    onAccepted: async ({ intent }) => { if (currentProject.current === intent.input.projectId) await refresh(intent.input.projectId); } });
  localDeliveryRef.current = localDelivery;
  function exportCheckContext() {
    return { scope: `${currentProject.current}:${projectEpoch.current}`, projectId: dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id, revision: dataRef.current.timeline?.revision, connected: online && auth === true && !loading,
      exportSettings: exportSettings.controller.getSettings(`${currentProject.current}:${projectEpoch.current}`), settingsVersion: exportSettings.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      exportRange: exportRange.controller.getRange(`${currentProject.current}:${projectEpoch.current}`), rangeVersion: exportRange.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      deliveryName: deliveryName.controller.getName(`${currentProject.current}:${projectEpoch.current}`), deliveryNameVersion: deliveryName.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`) };
  }
  const exportCheckView = exportCheckContext();
  const exportPreflight = useExportPreflight({ ...exportCheckView, getContext: exportCheckContext, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), visible: rightDockTab === 'delivery' && !showExports && panelVisible('inspector'),
    read: (input, options) => rpc('timeline.export.preflight', input, options),
    readCapabilities: (input, options) => rpc('timeline.export.capabilities', input, options), onUnauthorized: () => setAuth(false) });
  const canOpenExport = Boolean(data.project && timeline?.id && !loading);
  const canCheckExport = Boolean(canOpenExport && Number.isSafeInteger(timeline.revision) && timeline.revision > 0 && online && auth === true && !deliveryName.error && !exportRange.error && (restored || !localDelivery.state.baselineConflict && !localDelivery.state.candidate));
  const pendingTimelineExport = activePending.some(entry => entry.key === 'timeline:render:export') || (!restored && localDelivery.state.pending);
  function exportSamplePeakContext() {
    const workspaceScope = workspaceOriginScope(workspaceRef.current);
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${viewRef.current.activeMode}`,
      connected: workspaceScope !== null && online && auth === true && !loading,
      visible: rightDockTab === 'delivery' && showExports && panelVisible('inspector'), restored: workspaceRef.current?.restored === true,
      exports: dataRef.current.exports, assets: dataRef.current.assets };
  }
  const exportSamplePeak = useExportSamplePeak({ context: exportSamplePeakContext(), getContext: exportSamplePeakContext,
    isRenderRecord: isTimelineRenderRecord, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input, options) => rpc('timeline.export.samplePeak', input, options), onUnauthorized: () => setAuth(false) });
  function checkTimelineExport(review) {
    const current = exportCheckContext();
    if (review && ['scope', 'projectId', 'timelineId', 'revision', 'settingsVersion', 'deliveryNameVersion', 'rangeVersion'].some(key => review[key] !== current[key])) return null;
    if (!workspaceRef.current?.restored && (localDeliveryRef.current?.controller.getState().baselineConflict || localDeliveryRef.current?.controller.getState().candidate)) return null;
    exportPreflight.controller.setContext(current);
    return exportPreflight.controller.check();
  }
  function openTimelineExport() {
    setShowExports(false); setRightDockTab('delivery'); setPanelOpen('inspector', true);
    exportPreflight.controller.setVisible(true);
    // Opening is passive. Only the explicit Check action runs capability/media work.
  }
  const historyState = timelineHistoryState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading });
  const splitState = timelineSplitState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : selectedClipId, playhead, mode: workspaceMode });
  async function splitTimelineClip() {
    if (currentProject.current !== dataRef.current.project?.id) return null;
    const latest = timelineSplitState({ projectId: currentProject.current, timeline: dataRef.current.timeline, history: dataRef.current.timelineHistory, busy: isBusy('timeline:mutation'), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : viewRef.current.editing.selectedClipId, playhead: viewRef.current.editing.playhead, mode: viewRef.current.activeMode });
    if (!latest.canSplit) return null;
    const result = await mutateTimeline('timeline.clip.split', { clipId: latest.clipId, atFrame: latest.atFrame });
    if (result) notify(`已在第 ${latest.atFrame} 帧分割为 ${latest.leftDuration} + ${latest.rightDuration} 帧，可一次撤销。`);
    return result;
  }
  function changeTimelineHistory(direction) {
    if (workspaceMode !== 'editing' || !['undo', 'redo'].includes(direction) || currentProject.current !== dataRef.current.project?.id) return null;
    const latest = timelineHistoryState({ projectId: currentProject.current, timeline: dataRef.current.timeline, history: dataRef.current.timelineHistory, busy: isBusy('timeline:mutation'), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading });
    if (!(direction === 'undo' ? latest.canUndo : latest.canRedo)) return null;
    return mutateTimeline(`timeline.${direction}`);
  }
  useEffect(() => {
    const onKeyDown = event => {
      if (viewRef.current.activeMode !== 'editing') return;
      const guards = { modalOpen: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) };
      if (timelineSplitActionForKey(event, guards)) {
        if (splitState.canSplit) { event.preventDefault(); splitTimelineClip(); }
        return;
      }
      const direction = timelineHistoryActionForKey(event, guards);
      if (!direction || !(direction === 'undo' ? historyState.canUndo : historyState.canRedo)) return;
      event.preventDefault();
      changeTimelineHistory(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  async function mutateTimeline(operation, input = {}, expectedRevision, options) {
    if (!dataRef.current.timeline) return null;
    if (tasksRef.current.blocked(currentProject.current, 'timeline:mutation') || timelinePending) { notify('上一条时间线操作的结果尚未确认。请先恢复同一请求，再继续编辑。', 'warning'); openTasks(); return null; }
    return run('timeline:mutation', operation, { projectId: currentProject.current, expectedRevision: expectedRevision ?? dataRef.current.timeline.revision, requestId: requestId(), ...input }, undefined, options);
  }
  async function selectClip(id, showPreview = true) {
    if ((id !== selectedClipId || quickAssetId || workspaceMode !== 'editing' || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation('当前面板有未保存修改。放弃修改并切换片段？')) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === id); if (!clip) return;
    setPropertiesPage('inspector');
    navigationEpoch.current++;
    leaveReferencePage();
    updateView('editing', { selectedClipId: id, quickAssetId: null, playhead: clip.startFrame, ...(showPreview ? { previewKind: 'source' } : {}) });
    updateView('activeMode', 'editing'); setMobilePanel('canvas');
  }
  async function addTimelineAsset(assetId, trackId, startFrame, dropSnapshot) {
    const panelChoice = panelIntent.current;
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (!await guardNavigation('当前面板有未保存修改。放弃修改并加入时间线？')) return;
    const state = dataRef.current, asset = state.assets.find(a => a.id === assetId), tl = state.timeline;
    if (!asset || !tl) return;
    const kind = assetKind(asset) === 'audio' ? 'audio' : 'video';
    const track = tl.tracks.find(t => t.id === trackId) || (!trackId && tl.tracks.find(t => t.kind === kind));
    if (!track || track.kind !== kind) { notify(`此素材需要${kind === 'audio' ? '音频' : '画面'}轨道。请拖到兼容轨道。`, 'warning'); return; }
    const length = assetTimelineDuration(asset);
    if (!length.known) { notify(length.note, 'warning'); return; }
    const durationFrames = dropSnapshot?.durationFrames ?? length.durationFrames;
    const start = startFrame ?? Math.max(0, ...tl.clips.filter(c => c.trackId === track.id).map(c => c.startFrame + c.durationFrames));
    const before = new Set(tl.clips.map(c => c.id));
    const result = await mutateTimeline('timeline.clip.add', { trackId: track.id, assetId, name: asset.name, startFrame: start, durationFrames, sourceInFrame: 0 }, dropSnapshot?.expectedRevision);
    if (result) {
      const revealAddedClip = panelIntent.current === panelChoice;
      const added = result.clips.find(c => !before.has(c.id));
      updateView('editing', { ...(added ? { selectedClipId: added.id, playhead: added.startFrame } : {}), quickAssetId: null, previewKind: 'source', ...(revealAddedClip ? { timelineCollapsed: false } : {}) });
      // The accepted clip remains saved. A newer panel choice wins over this
      // request's automatic workspace switch, without cancelling business work.
      if (revealAddedClip) { navigationEpoch.current++; updateView('activeMode', 'editing'); setMobilePanel('canvas'); }
      notify('固定素材片段已加入时间线。');
    }
  }
  async function returnToSource(assetId) {
    const source = sourceForAsset(dataRef.current, assetId); if (!source) return;
    if (source.shot) { if (await inspect(source.shot.id, 'versions', source.version.id, { reveal: true })) revealCanvas(source.shot.id); }
    else if (source.node) { if (await inspect(source.node.id, 'settings', null, { reveal: true })) revealCanvas(source.node.id); }
    else {
      if (!await guardNavigation('当前片段有未保存修改。放弃修改并返回来源素材？')) return;
      navigationEpoch.current++; updateView('activeMode', 'canvas');
      updateView('shared', { assetSearch: source.asset.name, assetFilter: 'all' }); setPanelOpen('assets', true, 'canvas'); setMobilePanel('assets'); setPreviewAsset(source.asset);
    }
  }
  async function moveTimelineClip(clipId, trackId, startFrame, dropSnapshot) {
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (clipDirty && !await guardNavigation('当前片段有未保存修改。放弃修改并移动片段？')) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === clipId);
    const track = dataRef.current.timeline?.tracks.find(t => t.id === trackId);
    const asset = dataRef.current.assets.find(a => a.id === clip?.assetId);
    if (!clip || !track) return;
    if (track.kind !== (assetKind(asset) === 'audio' ? 'audio' : 'video')) { notify('画面片段与音频片段只能移动到各自兼容的轨道。', 'warning'); return; }
    const result = await mutateTimeline('timeline.clip.update', { clipId, patch: { trackId, startFrame } }, dropSnapshot?.expectedRevision);
    if (result) { setSelectedClipId(clipId); setPlayhead(startFrame); }
  }
  function renderUncheckedTimeline(intent) { return renderTimeline('export', null, intent); }
  async function renderTimeline(purpose, binding, uncheckedIntent) {
    if (!dataRef.current.timeline?.clips.length) return;
    let exportInput;
    if (purpose === 'export') {
      exportPreflight.controller.setContext(exportCheckContext());
      if (isBusy('timeline:render:export')) return;
      // A saved receipt must be recovered explicitly from the task panel. A new
      // confirmation must never silently replay it or mint a second request.
      try {
        if (pendingForProject(currentProject.current, { strict: true, workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) {
          notify('已有导出请求结果待确认。请在任务面板恢复同一请求。', 'warning'); openTasks(); return;
        }
      } catch { notify('无法核对导出请求记录。请先在任务面板核实原请求。', 'error'); openTasks(); return; }
      if (!workspaceRef.current?.restored && !localDeliveryRef.current?.controller.canPrepare()) return;
      exportInput = uncheckedIntent ? exportPreflight.controller.takeUncheckedExportIntent(uncheckedIntent) : exportPreflight.controller.takeExportBinding(binding);
      if (!exportInput) return;
    }
    const deliveryPanelChoice = panelIntent.current, deliveryProjectId = currentProject.current, deliveryRangeVersion = exportCheckContext().rangeVersion;
    const deliveryCapture = purpose === 'export' ? deliveryNameRef.current?.controller.capture() : null;
    const input = { ...(exportInput || { projectId: currentProject.current, expectedRevision: dataRef.current.timeline.revision }), requestId: requestId(), purpose };
    const captured = context();
    const result = purpose === 'export' && !workspaceRef.current?.restored
      ? await localDeliveryRef.current.controller.submit(input, { canExecute: () => isCurrent(captured), nameCapture: deliveryCapture })
      : await run(`timeline:render:${purpose}`, 'timeline.render', input);
    if (result) { const matchingDelivery = !deliveryCapture || deliveryNameRef.current?.controller.acknowledge(deliveryCapture, result); if (purpose === 'preview') { updateView('activeMode', 'editing'); setPreviewKind('timeline'); } else if (matchingDelivery && deliveryPanelChoice === panelIntent.current && deliveryProjectId === currentProject.current && deliveryRangeVersion === exportCheckContext().rangeVersion) openExportHistory(); notify(purpose === 'preview' ? '时间线正在渲染；完成后会自动显示可播放的合成预览。' : '时间线导出已开始，使用当前编排的固定快照。'); }
  }
  async function previewSource(asset) {
    if (viewRef.current.activeMode === 'canvas') { setPreviewAsset(asset); return; }
    const owner = context();
    if ((viewRef.current.editing.quickAssetId !== asset.id || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation('当前面板有未保存修改。放弃修改并查看另一个源素材？')) return;
    if (!isCurrent(owner) || !dataRef.current.assets.some(item => item.id === asset.id && item.projectId === owner.projectId)) return;
    navigationEpoch.current++;
    setPropertiesPage('inspector');
    updateView('editing', { quickAssetId: asset.id, selectedClipId: null, previewKind: 'source' });
  }
  async function addSavedSourceRange(snapshot) {
    const captured = context(), panelChoice = panelIntent.current;
    if (!snapshot || snapshot.scope !== sourceRangeScope || snapshot.projectId !== captured.projectId || !sameSourceSnapshot(snapshot, sourceRanges.controller.snapshot())) return;
    const state = dataRef.current;
    const plan = sourceRangeAddPlan({ snapshot, asset: state.assets.find(asset => asset.id === snapshot.assetId), timeline: state.timeline,
      blocked: isBusy('timeline:mutation') || isBusy('canvas:mutation') || pendingForProject(captured.projectId, { workspace: captured.workspace, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || entry.operation.startsWith('timeline.')) });
    if (!plan.valid) { notify(plan.reason, 'warning'); return; }
    // Capture exact primitives before dispatch. Saving a different source range
    // later cannot change this request, its retry receipt, or existing clips.
    const result = await mutateTimeline('timeline.clip.add', { ...plan.input }, plan.expectedRevision);
    if (!result || !isCurrent(captured)) return;
    if (panelIntent.current === panelChoice) setPanelOpen('timeline', true, 'editing');
    notify('已保存范围已作为固定素材片段加入时间线。');
  }
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
  const staleClips = staleClipSources(timeline?.clips ?? [], data.shots, data.versions);
  const agentTimelineSelection = workspaceMode === 'editing' && propertiesPage === 'inspector' && !quickAssetId
    ? makeAgentTimelineClipSelection(timeline, selectedClipId, data.project?.id) : null;
  const agentTimelineGainSelection = workspaceMode === 'editing' && propertiesPage === 'inspector' && !quickAssetId
    ? makeAgentTimelineGainSelection(timeline, selectedClipId, data.project?.id, data.assets) : null;
  const gainBlockedReason = agentTimelineGainBlockedReason({ connected: online && auth === true && !loading, dirty: inspectorDirty || formatDirty,
    recoveredDraft: agentClipDraftBlocked || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate), pending: timelineBusy });
  const agentTimelineBlockedReason = !online || auth !== true || loading ? '请等待当前项目连接与数据加载完成。'
    : inspectorDirty ? '请先保存或放弃属性面板草稿，再审阅片段移动。草稿不会自动发送或清除。'
      : timelineBusy ? '有时间线操作正在处理或待确认，请先在任务中心核对。' : '';
  const chosenVersion = data.versions.find(v => v.id === chosenShot?.selectedVersionId);
  const sourceAsset = data.assets.find(a => a.id === (quickAssetId || chosenClip?.assetId));
  const clipSource = chosenClip && sourceForAsset(data, chosenClip.assetId);
  const rangeAsset = workspaceMode === 'editing' && quickAssetId ? sourceAsset : null;
  const rangeSelectionKey = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${quickAssetId || ''}:${inspectorEpoch}`;
  const rangeSelectionEpoch = useRef({ key: null, serial: 0 });
  if (rangeSelectionEpoch.current.key !== rangeSelectionKey) rangeSelectionEpoch.current = { key: rangeSelectionKey, serial: rangeSelectionEpoch.current.serial + 1 };
  const sourceRangeScope = `${rangeSelectionKey}:${rangeSelectionEpoch.current.serial}`;
  const sourceRanges = useSourceRange({ scope: sourceRangeScope, projectId: data.project?.id, asset: rangeAsset,
    read: input => rpc('asset.range.get', input),
    save: input => run(`source-range:${input.assetId}`, 'asset.range.set', input, '源范围已保存，已有片段保持独立。', { returnAfterNavigation: true }),
    refreshGeneration: sourceRangeRefresh[`${data.project?.id}:${rangeAsset?.id}`] || 0, onDirtyChange: setSourceDirty });
  const sourceRangeBlocked = !online || loading || Boolean(busy['canvas:mutation'] || timelineBusy || activePending.some(entry => isMutationOperation(entry.operation)));
  const frameExtraction = useFrameExtraction({ projectId: data.project?.id, sourceScope: sourceRangeScope, sourceAsset: rangeAsset, assets: data.assets,
    visible: workspaceMode === 'editing' && Boolean(quickAssetId && rangeAsset) && (panelVisible('canvas') || panelVisible('inspector') && rightDockTab === 'properties'),
    blocked: restored || sourceRangeBlocked || Object.values(busy).some(Boolean), rpc, createRequestId: requestId,
    onResult: projectId => { if (currentProject.current === projectId) void refresh(projectId); }, revealAsset: revealImageAsset });

  const dispositionScope = `${currentProject.current}:${projectEpoch.current}`;
  const dispositionBlocked = !online || loading || Boolean(busy['canvas:mutation'] || activePending.some(entry => isMutationOperation(entry.operation)));
  const dispositions = useAssetDispositions({ scope: dispositionScope, projectId: data.project?.id, assets: data.assets,
    read: input => rpc('asset.disposition.list', input),
    save: input => run(dispositionKey(input.assetId), 'asset.disposition.set', input, '素材标记已保存。', { returnAfterNavigation: true }),
    hasPending: projectId => pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(entry => isMutationOperation(entry.operation)),
    pendingState: activePending.some(entry => isMutationOperation(entry.operation)), blocked: dispositionBlocked, refreshGeneration: dispositionRefresh[data.project?.id] || 0 });
  const subjectScope = `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`;
  const subjectBlocked = !online || loading || tasksRef.current.blocked(currentProject.current, 'subject:mutation');
  const subjects = useSubjects({ scope: subjectScope, projectId: data.project?.id, assets: data.assets, shotIds: data.shots.map(shot => shot.id),
    read: (operation, input) => rpc(operation, input),
    save: (operation, input, options) => runDurable('subject:mutation', operation, input, '本地策划关联已保存，生成输入与已有结果保持独立。', { ...options, returnAfterNavigation: true }),
    hasPending: projectId => tasksRef.current.blocked(projectId, 'subject:mutation'), blocked: subjectBlocked,
    pendingState: taskState, refreshGeneration: subjectRefresh[data.project?.id] || 0, onDirtyChange: setSubjectDirty });
  subjectsRef.current = subjects;
  const librarySource = workspaceMode === 'editing' ? sourceAsset : previewAsset || data.assets.find(asset => asset.id === (chosenNode?.assetId || chosenVersion?.assetId || chosenShot?.referenceAssetIds?.[0]));
  const inUseAssetIds = new Set([...(timeline?.clips || []).map(clip => clip.assetId), ...data.nodes.map(node => node.assetId), ...data.shots.flatMap(shot => generationReferences(shot).references.map(reference => reference.assetId)), ...data.shots.map(shot => data.versions.find(version => version.id === shot.selectedVersionId)?.assetId)].filter(Boolean));

  const timelineJobs = [...data.exports].filter(e => e.mode === 'timeline').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const previewJob = timelineJobs.find(e => ['succeeded','completed','ready'].includes(e.status));
  const latestRender = timelineJobs.find(item => !data.restore?.heldExportIds.includes(item.id));
  const comparisonShot = data.shots.find(s => s.id === comparisonId);
  const jobs = useMemo(() => [...data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.jobs]);
  const activeCount = restored ? 0 : jobs.filter(activeJob).length;
  const taskCount = activeCount + activePending.length + activeTasks.length;
  const selectedCount = data.shots.filter(s => s.selectedVersionId).length;
  const orderedExports = [...data.exports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => {
    if (dragging.current) return;
    const next = [...data.nodes.map(record => ({ id: record.id, type: record.type, position: record.position, selected: record.id === selectedId, data: { record, asset: data.assets.find(a => a.id === record.assetId), canReference: isImageReferenceNode(record, data.assets, data.project?.id), referenceBusy, onInspect: (id, nextTab) => inspect(id, nextTab, null, { reveal: true }) } })), ...sortedShots.map((record, index) => ({ id: record.id, type: 'shot', position: record.position, selected: record.id === selectedId, data: { record, index, referenceConnection: referenceForShot(data.edges, record.id), referenceSourceLabel: data.nodes.find(node => node.id === referenceForShot(data.edges, record.id)?.source)?.label || data.assets.find(asset => asset.id === referenceForShot(data.edges, record.id)?.sourceAssetId)?.name || '图片节点', referenceBusy, asset: data.assets.find(a => a.id === record.referenceAssetIds?.[0]), version: data.versions.find(v => v.id === record.selectedVersionId), versionCount: data.versions.filter(v => v.shotId === record.id).length, job: jobs.find(j => j.shotId === record.id), busy: busy[`generate:${record.id}`], generationUnavailableReason, generationLabel: generationSelection(providers, generationOptions[record.id], record).provider?.name, onInspect: (id, nextTab) => inspect(id, nextTab, null, { reveal: true }), onGenerate: async shot => { if (!await inspect(shot.id)) return; if (shot.id === selectedId && inspectorDirty) { notify('请先在右侧保存镜头修改，再生成。', 'warning'); return; } generate(shot); } } }))];
    setNodes(next);
  }, [data, sortedShots, selectedId, jobs, busy, inspectorDirty, providers, generationOptions, referenceBusy, generationUnavailableReason]);
  const edges = useMemo(() => data.edges.map(edge => canvasEdge(edge, edge.id === selectedEdgeId)), [data.edges, selectedEdgeId]);
  const selectedEdge = data.edges.find(edge => edge.id === selectedEdgeId);
  const visibleAssets = data.assets.filter(a => (assetFilter === 'all' || a.mimeType?.startsWith(`${assetFilter}/`)) && a.name.toLowerCase().includes(assetSearch.toLowerCase()));
  if (auth === false) return <Login onLogin={boot} />;
  if (auth === null || auth === 'error') return <div className="boot-page"><div className="brand"><span className="brand-mark"><BrandMark /></span>Mioon</div>{auth === null ? <><span className="spinner" /><p>正在连接你的工作区…</p></> : <><h2>暂时无法连接工作台</h2><p>{toast?.message || '请确认服务器已启动。'}</p><Button variant="ghost" className="button primary" onClick={() => { setAuth(null); boot(); }}><Icon name="refresh" />重新连接</Button></>}</div>;
  return <main className={`workbench workbench-v2 dock-workbench ${geometry.narrow ? 'dock-narrow' : ''} mode-${workspaceMode} mobile-${mobilePanel} ${assetsCollapsed ? 'assets-collapsed' : ''} ${inspectorCollapsed ? 'inspector-collapsed' : ''} ${timelineCollapsed ? 'timeline-collapsed' : ''}`} data-testid="workbench" data-workspace-mode={workspaceMode} data-narrow={geometry.narrow ? 'true' : 'false'} style={geometry.style}>
    <Input ref={fileInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" multiple aria-label="导入本地素材" data-testid="asset-upload" onChange={e => importFiles(Array.from(e.target.files))} />
    <header className="topbar"><a className="brand" href={window.location.pathname} aria-label="Mioon 影像工作台"><span className="brand-mark"><BrandMark /></span>Mioon</a><span className="topbar-divider" /><DropdownMenu open={showProjects} onOpenChange={setShowProjects}><DropdownMenuTrigger render={<Button variant="ghost" className="project-trigger" data-testid="project-switcher" />}><Icon name="folder" size={16} /><span>{data.project?.name || '选择一个项目'}</span><Icon name="down" size={13} /></DropdownMenuTrigger><DropdownMenuContent align="start" className="workbench-project-menu"><DropdownMenuGroup><DropdownMenuLabel>你的项目</DropdownMenuLabel>{projects.map(p => <DropdownMenuItem key={p.id} onClick={() => selectProject(p.id)}><Icon name="folder" size={15} /><span>{p.name}</span>{p.id === data.project?.id && <Icon name="check" size={14} />}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem data-testid="timeline-format-open" disabled={!data.project || loading} onClick={openTimelineFormat}><Icon name="settings" size={15} />时间线输出规格</DropdownMenuItem><DropdownMenuItem className="new-project-menu" onClick={() => { setShowProjects(false); setShowCreate(true); }}><Icon name="plus" size={15} />新建项目</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Tabs value={workspaceMode} onValueChange={changeMode} className="topbar-workspace"><TabsList className="segmented workspace-tabs" aria-label="工作区模式"><TabsTrigger value="canvas" disabled={loading} data-testid="workspace-canvas">画板</TabsTrigger><TabsTrigger value="editing" disabled={loading} data-testid="workspace-editing">剪辑</TabsTrigger></TabsList></Tabs><TopbarSaveStatus online={online} syncing={Object.values(busy).some(Boolean)} dirty={inspectorDirty || formatDirty} lastSync={lastSync} preferenceStatus={preferenceStatus} onRetry={() => preferencesRef.current.flush({ projectId: currentProject.current })} onReload={reloadPreferences} /><LastProjectStatus state={lastProjectStatus || lastProjectRef.current.getState()} controller={lastProjectRef.current} restored={workspace?.restored === true} /><div className="topbar-actions"><WorkbenchTooltip content="Agent 文字对话"><Button variant="ghost" className="button quiet agent-settings-open" data-testid="agent-chat-open" aria-label="Agent 文字对话" disabled={!data.project || loading} onClick={() => { setRightDockTab('agent'); setAgentPage('chat'); setPanelOpen('inspector', true); }}><Icon name="sparkle" size={15} /><span>Agent</span></Button></WorkbenchTooltip><WorkbenchTooltip content="Agent 连接设置"><Button variant="ghost" className="button quiet agent-connection-open" data-testid="agent-settings-open" aria-label="Agent 连接设置" onClick={() => { setRightDockTab('agent'); setAgentPage('settings'); setPanelOpen('inspector', true); }}><Icon name="settings" size={14} /></Button></WorkbenchTooltip><PanelsMenu mode={workspaceMode} assetsCollapsed={assetsCollapsed} inspectorCollapsed={inspectorCollapsed} timelineCollapsed={timelineCollapsed} storyboardOpen={sequenceOpen} onPanel={setPanelOpen} onReset={resetPanelLayout} disabled={loading || !data.project} /><Button variant="ghost" className="button quiet guide-trigger" data-testid="region-guide-toggle" aria-expanded={showGuide} onClick={() => setShowGuide(!showGuide)}><Icon name="info" size={15} />区域说明</Button><Button variant="ghost" className={`button quiet ${activeCount ? 'jobs-active' : ''}`} data-testid="jobs-button" onClick={() => openTasks()}><Icon name="clock" size={16} /><span>任务</span>{taskCount > 0 && <span className="count-pill">{taskCount}</span>}{data.project && taskState.phase !== 'ready' && <span className="count-pill" aria-label="恢复记录尚未核对">…</span>}</Button><WorkbenchTooltip content="查看已保存的导出与预览"><Button variant="ghost" className="button quiet export-history" aria-label="查看导出记录" onClick={openExportHistory}><Icon name="layers" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`button ${timeline?.clips.length ? 'quiet' : 'primary'}`} data-testid="export-button" disabled={!data.shots.length || selectedCount !== data.shots.length || busy.export} title={selectedCount !== data.shots.length ? '请先为每个镜头生成并选用一个版本' : '按分镜板顺序导出成片'} onClick={createExport}><Icon name="download" size={16} /><span>导出分镜</span></Button><Button variant="ghost" className="button primary" data-testid="export-timeline" disabled={!canOpenExport} onClick={openTimelineExport}><Icon name="download" size={15} />导出时间线</Button><span className="avatar" title="私有工作区">M</span></div></header>
    {showGuide && <section className="region-guide" role="region" aria-label="区域说明" data-testid="region-guide"><header><strong>同一个项目，两种专注的工作方式</strong><Button variant="ghost" className="icon-button" aria-label="关闭区域说明" onClick={() => setShowGuide(false)}><Icon name="close" size={16} /></Button></header><div><p><b>画板</b>整理参考图、镜头和版本，在右侧调整生成参数。分镜顺序可按需展开。</p><p><b>剪辑</b>在大画面中检查素材或合成预览，用多轨时间线编排画面和声音。</p><p><b>共享素材库</b>原始素材与每个生成版本都可加入时间线。已有片段固定引用加入时的素材。</p><p><b>来回衔接</b>加入时间线后进入剪辑；返回来源可定位原镜头和版本。切换保留各自的视角和选择。</p></div><footer>重新生成或选用新版本，不会替换已有时间线片段。未保存修改会在离开面板前确认。</footer></section>}
    <div className="workspace-surface" ref={panelSurface} data-testid="workspace-surface">
    {assetsCollapsed && <PanelRecall name="assets" label="素材库" icon="folder" onClick={() => setPanelOpen('assets', true)} />}
    <PanelBoundary name="assets" visible={panelVisible('assets')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('assets')}>
    <AssetLibrary timelineUsage={timelineUsage} onLocateTimelineUse={locateAssetUse} subjects={subjects} subjectBlocked={subjectBlocked} onInspectShot={id => inspect(id, 'settings', null, { reveal: true })} onShowTasks={() => openTasks()} dispositions={dispositions} dispositionBlocked={dispositionBlocked} selectedAsset={librarySource} inUseAssetIds={inUseAssetIds} mode={workspaceMode} versions={data.versions} shots={data.shots} assets={data.assets} filter={assetFilter} onFilter={setAssetFilter} search={assetSearch} onSearch={setAssetSearch} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} onFiles={importFiles} onPreview={previewSource} onCanvas={addNode} onTimeline={addTimelineAsset} busy={{ ...busy, timeline: timelineBusy }} collapsed={assetsCollapsed} onCollapse={() => setAssetsCollapsed(true)} project={data.project} />
    {resizeHandle('assets', 'assetsWidth')}</PanelBoundary>
    <PanelBoundary name="canvas" visible={panelVisible('canvas')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus="[data-testid=mobile-panel-canvas]">
    <section className="canvas-area" aria-label={workspaceMode === 'canvas' ? '画板工作区' : '剪辑工作区'} data-testid="active-workspace">{workspaceMode === 'canvas' && <div className="canvas-heading"><div className="region-title"><h2>画板</h2></div><div className="canvas-tools"><Button variant="ghost" className="button small" data-testid="add-text-node" onClick={() => addNode('text')}><Icon name="text" size={14} /><span>文字</span></Button><Button variant="ghost" className="button small" data-testid="add-image-node" onClick={() => addNode('image')}><Icon name="image" size={14} /><span>图片</span></Button><Button variant="ghost" className="button small" data-testid="add-video-node" onClick={() => addNode('video')}><Icon name="film" size={14} /><span>视频</span></Button><Button variant="ghost" className="button small accent-outline" data-testid="add-shot" disabled={busy['shot-create']} onClick={addShot}><Icon name="plus" size={15} />添加镜头</Button></div></div>}
      <div className="main-stage">{loading ? <div className="canvas-loading" data-testid="workspace-loading"><span className="spinner" />正在打开项目…</div> : workspaceMode === 'canvas' ? <div className="flow-wrap" data-testid="canvas-drop-zone" onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={canvasDrop}><ReactFlow key={data.project?.id || 'empty'} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))} onNodeClick={(_, node) => inspect(node.id)} onNodeDoubleClick={(_, node) => { const record = dataRef.current.nodes.find(n => n.id === node.id); const shot = dataRef.current.shots.find(s => s.id === node.id); const version = dataRef.current.versions.find(v => v.id === shot?.selectedVersionId); const asset = dataRef.current.assets.find(a => a.id === (record?.assetId || version?.assetId || shot?.referenceAssetIds?.[0])); if (asset) previewSource(asset); }} onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={savePosition} onConnect={connect} onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)} onPaneClick={() => setSelectedEdgeId(null)} onEdgesDelete={deleted => { setSelectedEdgeId(null); deleted.filter(edge => !isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id))).forEach(edge => run(`delete-edge:${edge.id}`, 'edge.delete', { edgeId: edge.id })); }} onBeforeDelete={beforeDeleteEdges} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} onMoveEnd={(event, viewport) => { if (viewRef.current.activeMode === 'canvas' && data.project?.id === currentProject.current) updateView('canvas', { viewport }, { passive: !event }); }} defaultViewport={view.canvas.viewport || { x: 0, y: 0, zoom: 1 }} onInit={instance => { const captured = context(), saved = viewRef.current.canvas.viewport; requestAnimationFrame(() => { if (isCurrent(captured) && viewRef.current.activeMode === 'canvas') { if (saved) instance.setViewport(saved); else instance.fitView({ padding: canvasFitPadding(.16), minZoom: .65, maxZoom: 1 }); } }); }} fitView={!view.canvas.viewport} fitViewOptions={{ padding: 0.16, minZoom: .65, maxZoom: 1 }} minZoom={0.2} maxZoom={1.75} snapToGrid snapGrid={[12, 12]} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']} colorMode="dark"><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#34363b" />{miniMap && <MiniMap nodeColor={n => n.type === 'shot' ? '#b6c783' : '#6c7180'} maskColor="rgba(12,13,15,.8)" pannable zoomable />}</ReactFlow>
      <div className="canvas-connection-legend" data-testid="connection-legend"><span><i className="reference-swatch" />首帧参考 · 参与生成</span><span><i className="visual-swatch" />视觉连线 · 仅整理思路</span></div>
      {selectedEdge && <div className="selected-edge-note" data-testid="selected-edge-note">{isReferenceEdge(selectedEdge) ? <><Icon name="link" size={13} /><span>首帧参考连接</span><Button variant="ghost" size="sm" onClick={() => inspect(selectedEdge.target)}>查看 / 断开</Button></> : <><span>视觉连线不参与生成</span><span className="muted">Delete 删除</span></>}</div>}
      {!data.project && !loading && <div className="canvas-empty"><div className="empty-composition"><div className="empty-mini-card"><Icon name="text" size={19} /><span>一个想法</span></div><span className="empty-connector" /><div className="empty-main-card"><Icon name="film" size={39} /><span>无限可能</span></div><span className="empty-connector" /><div className="empty-mini-card"><Icon name="sparkle" size={19} /><span>一部作品</span></div></div><div className="eyebrow">MAKE ROOM FOR YOUR NEXT STORY</div><h1>下一部作品，从这里开始。</h1><p>把素材、灵感和镜头，放到同一张画布上。</p><Button variant="ghost" className="button primary" data-testid="empty-create-project" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} />创建第一个项目</Button></div>}
      {data.project && !nodes.length && !loading && <div className="canvas-empty"><div className="empty-canvas-symbol"><Icon name="film" size={35} /><span className="small-plus">+</span></div><div className="eyebrow">A BLANK CANVAS, A NEW PERSPECTIVE</div><h1>给故事一个开场。</h1><p>从单个镜头开始，或先搭好三幕的故事结构。</p><div className="empty-actions"><Button variant="ghost" className="button primary" onClick={addShot}><Icon name="plus" size={16} />创建镜头</Button><Button variant="ghost" className="button" data-testid="create-three-shots" disabled={busy.structure} onClick={addStructure}><Icon name="layers" size={16} />创建三镜头结构</Button></div></div>}
      {loading && <div className="canvas-loading"><span className="spinner" />正在打开项目…</div>}
      <div className="canvas-controls"><WorkbenchTooltip content="缩小画布"><Button variant="ghost" className="icon-button" aria-label="缩小" onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16} /></Button></WorkbenchTooltip><span>{zoom}%</span><WorkbenchTooltip content="放大画布"><Button variant="ghost" className="icon-button" aria-label="放大" onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16} /></Button></WorkbenchTooltip><i /><WorkbenchTooltip content="适应画布 · 保留节点位置"><Button variant="ghost" className="icon-button" aria-label="适应画布" data-testid="fit-canvas" onClick={() => flow.fitView({ padding: canvasFitPadding(0.18), duration: 350, maxZoom: 1 })}><Icon name="zoom" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`icon-button ${miniMap ? 'active' : ''}`} aria-label="显示缩略地图" aria-pressed={miniMap} onClick={() => setMiniMap(!miniMap)}><Icon name="grid" size={16} /></Button></div><div className="canvas-hint"><Icon name="link" size={12} />双击媒体放大查看 · 拖动画布平移</div>
      </div> : <div className="preview-tab-panel">{restored && <p className="helper muted" role="status">恢复分支可预览源素材；新抽帧暂不可用。</p>}<Preview key={data.project?.id || 'empty'} visible={panelVisible('canvas')} kind={previewKind} onKind={kind => { navigationEpoch.current++; setPreviewKind(kind); }} asset={sourceAsset} clip={quickAssetId ? null : chosenClip} timeline={timeline} job={previewJob} pendingJob={latestRender} playhead={playhead} onSeek={setPlayhead} sourceScope={sourceRangeScope} sourcePosition={sourceRanges.state?.position ?? 0} sourceSeek={sourceRanges.state?.seek} onSourcePosition={(frame, scope) => sourceRanges.controller.position(frame, scope)} onCaptureFrame={frameExtraction.controller.capture} captureBusy={frameCaptureBusy(frameExtraction.state)} onRender={renderTimeline} busy={Boolean(busy['timeline:render:preview'])} onCanvas={() => changeMode('canvas')} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} canSeed={Boolean(sortedShots.length && selectedCount === sortedShots.length)} seedBusy={timelineBusy} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} /></div>}</div>
    {workspaceMode === 'canvas' && <Collapsible open={sequenceOpen} onOpenChange={setSequenceOpen} className={`storyboard ${sequenceOpen ? '' : 'sequence-collapsed'}`} render={<section aria-label="分镜顺序" />}><header><div><Icon name="film" size={16} /><h2>分镜 · 故事顺序</h2><span className="storyboard-summary">{sortedShots.length} 个镜头<span>·</span>{sortedShots.reduce((sum, s) => sum + Number(data.versions.find(v => v.id === s.selectedVersionId)?.snapshot?.duration || s.duration), 0)} 秒</span></div><span className="order-hint"><Icon name="grip" size={13} />拖动排序 · 独立于时间线</span><Button variant="ghost" className="text-button" onClick={addShot}><Icon name="plus" size={14} />添加</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={sequenceOpen ? '收起分镜' : '展开分镜'} />}><Icon name={sequenceOpen ? 'minus' : 'plus'} size={14} /></CollapsibleTrigger></header><CollapsibleContent keepMounted className="storyboard-track" data-testid="storyboard">{sortedShots.map((shot, index) => { const v = data.versions.find(v => v.id === shot.selectedVersionId); const a = data.assets.find(a => a.id === shot.referenceAssetIds?.[0]); return <div key={shot.id} className={`storyboard-shot ${selectedId === shot.id ? 'selected' : ''} ${sequenceDrag === shot.id ? 'dragging' : ''}`} data-testid={`storyboard-shot-${shot.id}`} draggable={!busy.reorder} onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', shot.id); if (v?.assetId) e.dataTransfer.setData(ASSET_DRAG, v.assetId); e.dataTransfer.effectAllowed = 'copyMove'; setSequenceDrag(shot.id); }} onDragEnd={() => setSequenceDrag(null)} onDragOver={e => { if (sequenceDrag) e.preventDefault(); }} onDrop={e => { if (sequenceDrag) { e.preventDefault(); reorder(sequenceDrag, index); setSequenceDrag(null); } }}><Button variant="ghost" className="storyboard-preview" onClick={async () => { if (!await inspect(shot.id)) return; flow.fitView({ nodes: [{ id: shot.id }], padding: canvasFitPadding(.1), duration: 250, maxZoom: 1 }); }} aria-label={`选择分镜 ${index + 1} ${shot.title}`}><Media version={v} asset={a} /><span className="storyboard-index">{String(index + 1).padStart(2, '0')}</span><span className="storyboard-duration">{v?.snapshot?.duration || shot.duration}s</span>{v && <span className="storyboard-version">V{v.number}</span>}</Button><div className="storyboard-shot-meta"><span title={shot.title}>{shot.title}</span><div><Button variant="ghost" aria-label={`将 ${shot.title} 前移`} disabled={index === 0 || busy.reorder} onClick={() => reorder(shot.id, index - 1)}><Icon name="left" size={11} /></Button><Button variant="ghost" aria-label={`将 ${shot.title} 后移`} disabled={index === sortedShots.length - 1 || busy.reorder} onClick={() => reorder(shot.id, index + 1)}><Icon name="arrow" size={11} /></Button></div></div></div>; })}{!sortedShots.length ? <div className="storyboard-empty"><Icon name="film" size={22} /><span>镜头会出现在这里。画布负责探索，分镜板负责叙事。</span></div> : <Button variant="ghost" className="storyboard-add" aria-label="添加下一个镜头" onClick={addShot}><Icon name="plus" size={22} /><span>下一幕</span></Button>}</CollapsibleContent></Collapsible>}
    </section></PanelBoundary>
    {inspectorCollapsed && <PanelRecall name="inspector" label={rightDockTab === 'agent' ? 'Agent' : rightDockTab === 'image' ? '图像' : rightDockTab === 'delivery' ? '交付检查' : rightDockTab === 'tasks' ? '任务' : '属性'} icon="settings" onClick={() => setPanelOpen('inspector', true)} />}
    <PanelBoundary name="inspector" visible={panelVisible('inspector')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('inspector')}>
    <Collapsible open={!inspectorCollapsed} onOpenChange={open => setInspectorCollapsed(!open)} className={`inspector-region ${inspectorCollapsed ? 'panel-collapsed' : ''}`} render={<section aria-label="属性、Agent、图像、交付检查与任务" />}><header className="inspector-region-heading"><Tabs value={rightDockTab} onValueChange={value => { if (['properties', 'agent', 'image', 'delivery', 'tasks'].includes(value)) { markPanelIntent(); setRightDockTab(value); } }} className="right-dock-tabs"><TabsList aria-label="右侧工作区" className="segmented"><TabsTrigger id="right-dock-properties-tab" value="properties" data-testid="right-dock-tab-properties" aria-controls="right-dock-properties">属性</TabsTrigger><TabsTrigger id="right-dock-agent-tab" value="agent" data-testid="right-dock-tab-agent" aria-controls="right-dock-agent"><Icon name="sparkle" size={12} />Agent</TabsTrigger><TabsTrigger id="right-dock-image-tab" value="image" data-testid="right-dock-tab-image" aria-controls="right-dock-image">图像</TabsTrigger><TabsTrigger id="right-dock-delivery-tab" value="delivery" data-testid="right-dock-tab-delivery" aria-controls="right-dock-delivery">交付检查</TabsTrigger><TabsTrigger id="right-dock-tasks-tab" value="tasks" data-testid="right-dock-tab-tasks" aria-controls="right-dock-tasks">任务</TabsTrigger></TabsList></Tabs><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label="收起右侧面板" title="收起右侧面板" data-testid="toggle-inspector" />}><Icon name="minus" size={16} /></CollapsibleTrigger></header><RestoredWorkspace workspace={workspace} /><CollapsibleContent keepMounted className="inspector-region-content"><AgentDockPane id="right-dock-properties" labelledBy="right-dock-properties-tab" visible={rightDockTab === 'properties'} fallbackFocus="[data-testid=right-dock-tab-agent]"><AgentDockPane id="properties-inspector-pane" visible={propertiesPage === 'inspector' || propertiesPage === 'subtitle' && workspaceMode === 'canvas'} fallbackFocus="[data-testid=timeline-format-back]">{workspaceMode === 'canvas' ? <div className="inspector-container">
    <Inspector shotTextContext={{ ...shotTextContext(), getCurrent: shotTextContext }} onShotTextController={registerShotText} onShotTextAccepted={({ response }) => { if (currentProject.current === response.projectId) void refresh(response.projectId); }} generationUnavailableReason={generationUnavailableReason} actionScopeKey={`${rightDockTab}:${propertiesPage}`} subjects={subjects} subjectBlocked={subjectBlocked} key={`${data.project?.id}:${selectedId || 'empty'}:${inspectorEpoch}`} highlightedVersionId={highlightedVersionId} shot={chosenShot} node={chosenNode} project={data.project} assets={data.assets} versions={data.versions} jobs={jobs} providers={providers} generationOptions={generationOptions[selectedId]} onGenerationOptionsChange={updateGenerationOptions} tab={tab} setTab={setTab} busy={busy} onSave={saveShot} onNodeSave={saveNode} onGenerate={generate} onSelectVersion={selectVersion} onCompare={setComparisonId} onOpenJobs={() => openTasks()} onDirtyChange={setShotDirty} shots={sortedShots} nodes={data.nodes} edges={data.edges} referenceBusy={referenceBusy} referencePending={referencePending} onAttachReference={attachReference} onDetachReference={detachReference} onInspect={(id, nextTab) => inspect(id, nextTab, null, { reveal: true })} onAddVersion={assetId => addTimelineAsset(assetId)} />
    </div> : quickAssetId && sourceAsset ? <SourceRangeInspector asset={sourceAsset} state={sourceRanges.state} controller={sourceRanges.controller} timeline={timeline} blocked={sourceRangeBlocked} onAdd={addSavedSourceRange}>{restored ? <RestoredUnavailable title="抽帧任务保留，执行暂不可用" /> : <FrameExtractionPanel controller={frameExtraction.controller} />}</SourceRangeInspector> : chosenClip ? <TimelineInspector key={`${data.project?.id}:${chosenClip.id}:${inspectorEpoch}`} onReturnToSource={clipSource ? () => returnToSource(chosenClip.assetId) : undefined} sourceDescription={clipSource?.version && chosenClip.versionId === clipSource.version.id ? `${clipSource.shot.title} · V${clipSource.version.number}` : clipSource?.asset.name} replacementContext={clipReplacementContext()} staleSource={staleClips.get(chosenClip.id)} onReplaceSource={replaceTimelineClipSource} onOpenRequests={() => openTasks()} clip={chosenClip} timeline={timeline} asset={data.assets.find(a => a.id === chosenClip.assetId)} draftContext={{ scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: currentProject.current, restored }} draftConnected={online && auth === true && !loading} onDraftController={registerClipDraft} onReviewBlockedChange={setAgentClipDraftBlocked} onSave={(clipId, patch, revision, draftOptions) => mutateTimeline('timeline.clip.update', { clipId, patch }, revision, { returnAfterNavigation: true, canExecute: draftOptions?.canExecute })} onRemove={async clipId => { const result = await mutateTimeline('timeline.clip.remove', { clipId }); if (result) setSelectedClipId(null); }} onDirtyChange={setClipDirty} busy={timelineBusy} onPreview={() => { setQuickAssetId(null); setPreviewKind('source'); }} /> : <aside className="inspector" data-testid="editing-inspector-empty"><header className="inspector-heading"><Icon name="layers" /><span>片段属性</span></header><div className="inspector-empty"><h3>选择时间线片段</h3><p>在这里调整起止帧、源入点、画面位置和音量。</p></div></aside>}</AgentDockPane><AgentDockPane id="properties-subtitle-pane" visible={propertiesPage === 'subtitle' && workspaceMode === 'editing'} fallbackFocus="[data-testid=right-dock-tab-properties]"><SubtitleInspector state={subtitles.state} controller={subtitles.controller} renderJob={previewJob} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane><AgentDockPane id="properties-format-pane" visible={propertiesPage === 'format'} fallbackFocus="[data-testid=right-dock-tab-properties]"><TimelineFormatPanel state={timelineFormat.state} controller={timelineFormat.controller} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane>{restored ? <RestoredUnavailable title="恢复分支不能再次创建备份" backup /> : <WorkspaceBackupPanel scope={`${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} getScope={() => `${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} connected={online && auth === true && !loading} read={(input, options) => rpc('workspace.backup.inspect', input, options)} onUnauthorized={() => setAuth(false)} />}</AgentDockPane><AgentDockPane id="right-dock-agent" labelledBy="right-dock-agent-tab" visible={rightDockTab === 'agent'} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title="Agent 历史保留，执行暂不可用" /> : <AgentWorkspace projectId={data.project?.id} projectName={data.project?.name} selectedShot={chosenShot ? { id: chosenShot.id, revision: chosenShot.revision, title: chosenShot.title, prompt: chosenShot.prompt || '' } : null} selectedTimelineClip={agentTimelineSelection} timelineEditBlockedReason={agentTimelineBlockedReason} selectedTimelineGainClip={agentTimelineGainSelection} timelineGainBlockedReason={gainBlockedReason} onApplied={projectId => { if (currentProject.current === projectId) void refresh(projectId); }} page={agentPage} onPage={setAgentPage} onCollapse={() => setPanelOpen('inspector', false)} onDraftChange={onAgentDraftChange} />}</AgentDockPane><AgentDockPane id="right-dock-image" labelledBy="right-dock-image-tab" visible={rightDockTab === 'image'} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title="图像与 Comfy 历史保留，执行暂不可用" /> : <ImageGeneration key={data.project?.id || 'no-project'} projectId={data.project?.id} projectName={data.project?.name} projectAssets={data.assets} onDirtyChange={onImageDraftChange} onGenerated={projectId => { if (currentProject.current === projectId) void refresh(projectId); }} onRevealAsset={revealImageAsset} />}</AgentDockPane><AgentDockPane id="right-dock-delivery" labelledBy="right-dock-delivery-tab" visible={rightDockTab === 'delivery'} fallbackFocus="[data-testid=right-dock-tab-properties]"><DeliveryWorkspace page={showExports ? 'history' : 'compose'} onPage={page => { markPanelIntent(); setShowExports(page === 'history'); }}><AgentDockPane id="delivery-compose-pane" labelledBy="delivery-compose-tab" visible={!showExports} fallbackFocus="[data-testid=delivery-page-history]"><TimelineExportPreflight recovery={<DeliveryDraftRecovery state={localDelivery.state} controller={localDelivery.controller} disabled={!online || auth !== true || loading} />} state={exportPreflight.state} timeline={timeline} deliveryName={deliveryName.value} deliveryNameError={deliveryName.error} deliveryNameDisabled={!deliveryNameContext().enabled} onDeliveryNameChange={value => { if (deliveryName.controller.choose(value, deliveryName.scope, deliveryName.version)) exportPreflight.controller.setContext(exportCheckContext()); }} rangeDraft={exportRange.draft} exportRange={exportRange.value} rangeError={exportRange.error} rangeDisabled={!exportRangeContext().enabled} onRangeChange={draft => { if (exportRange.controller.chooseRange(draft, exportRange.scope, exportRange.version)) exportPreflight.controller.setContext(exportCheckContext()); }} exportSettings={exportSettings.value} settingsDisabled={!exportSettingsContext().enabled} onSettingsChange={value => { if (exportSettings.controller.choose(value, exportSettings.scope, exportSettings.version)) exportPreflight.controller.setContext(exportCheckContext()); }} projectName={data.project?.name} canCheck={canCheckExport} exportBusy={Boolean(busy['timeline:render:export']) || localDelivery.state.busy} pendingExport={pendingTimelineExport} dirty={inspectorDirty || formatDirty} onCheck={() => checkTimelineExport(exportCheckView)} onExport={binding => renderTimeline('export', binding)} onUncheckedExport={renderUncheckedTimeline} /></AgentDockPane><AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible={showExports} fallbackFocus="[data-testid=delivery-page-compose]"><ExportHistoryList samplePeak={exportSamplePeak} heldExportIds={data.restore?.heldExportIds} orderedExports={orderedExports} projectName={data.project?.name} timelineRevision={timeline?.revision} /></AgentDockPane></DeliveryWorkspace></AgentDockPane><AgentDockPane id="right-dock-tasks" labelledBy="right-dock-tasks-tab" visible={rightDockTab === 'tasks'} fallbackFocus="[data-testid=right-dock-tab-properties]"><TaskCenter taskViewScope={taskViewScope} captureView={captureTaskView} workspace={workspace} activeCount={activeCount} pending={pending} busy={busy} jobs={jobs} data={data} reconcileIds={reconcileIds} setReconcileIds={setReconcileIds} run={run} retryGeneration={retryGeneration} onInspectJob={inspectTaskJob} context={context} confirm={confirm} isCurrent={isCurrent} tasks={taskState} onRecover={recoverTask} onReload={() => tasksRef.current.load(currentProject.current)} onAdopt={adoptLegacyTask} /></AgentDockPane></CollapsibleContent></Collapsible>
    {resizeHandle('inspector', 'inspectorWidth')}</PanelBoundary>
    {workspaceMode === 'editing' && data.project && !loading && <><PanelBoundary name="timeline" visible={panelVisible('timeline')} scope={`${currentProject.current}:editing`} fallbackFocus={panelFallback('timeline')}>{resizeHandle('timeline', 'timelineHeight')}<Timeline staleClips={staleClips} waveformReadOnly={restored} workspaceOrigin={workspace?.workspaceOrigin} key={data.project.id} viewState={view.editing} onViewStateChange={(patch, options) => { if (data.project?.id === currentProject.current && viewRef.current.activeMode === 'editing') updateView('editing', patch, options); }} timeline={timeline} historyState={historyState} onHistory={changeTimelineHistory} splitState={splitState} onSplit={splitTimelineClip} assets={data.assets} selectedClipId={propertiesPage === 'subtitle' ? null : selectedClipId} selectedCueId={propertiesPage === 'subtitle' ? subtitles.state?.cueId : null} onSelectSubtitle={cueId => openSubtitle(cueId)} onAddSubtitle={frame => openSubtitle(null, frame)} subtitleBlocked={!subtitles.state?.connected} onSelectClip={selectClip} onAddAsset={addTimelineAsset} onMoveClip={moveTimelineClip} onTrackAdd={kind => mutateTimeline('timeline.track.add', { kind })} onTrackUpdate={(trackId, patch) => mutateTimeline('timeline.track.update', { trackId, patch })} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} onRender={renderTimeline} onSeek={setPlayhead} playhead={playhead} visible={panelVisible('timeline')} collapsed={timelineCollapsed} onCollapse={() => setPanelOpen('timeline', false)} busy={timelineBusy} canSeed={Boolean(sortedShots.length && selectedCount === sortedShots.length)} renderJob={latestRender} /></PanelBoundary>{timelineCollapsed && <PanelRecall name="timeline" label="时间线" icon="layers" onClick={() => setPanelOpen('timeline', true)} />}</>}
    </div>
    <nav className="mobile-nav" aria-label="移动工作区导航">{[['assets', 'folder', '素材'], ['canvas', workspaceMode === 'canvas' ? 'grid' : 'play', workspaceMode === 'canvas' ? '画板' : '预览'], ['inspector', rightDockTab === 'agent' ? 'sparkle' : rightDockTab === 'image' ? 'image' : rightDockTab === 'tasks' ? 'clock' : 'settings', rightDockTab === 'agent' ? 'Agent' : rightDockTab === 'image' ? '图像' : rightDockTab === 'delivery' ? '交付检查' : rightDockTab === 'tasks' ? '任务' : '属性'], ...(workspaceMode === 'editing' ? [['timeline', 'layers', '时间线']] : [])].map(([id, icon, label]) => <Button variant="ghost" className={mobilePanel === id ? 'active' : ''} key={id} data-testid={`mobile-panel-${id}`} aria-pressed={mobilePanel === id} onClick={() => mobileNavigate(id)}><Icon name={icon} size={17} />{label}</Button>)}</nav>
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'success' ? 'check' : 'info'} size={17} /><span>{toast.message}</span><Button variant="ghost" className="icon-button small" aria-label="关闭提示" onClick={() => setToast(null)}><Icon name="close" size={15} /></Button></div>}
    {showCreate && <CreateProject onClose={() => { navigationEpoch.current++; setShowCreate(false); }} onCreate={createProject} busy={busy['project-create']} />}
    {comparisonShot && <Comparison shot={comparisonShot} versions={data.versions} onClose={() => setComparisonId(null)} onSelect={selectVersion} busy={busy[`version:${comparisonShot.id}`]} />}
    {previewAsset && <Modal title={previewAsset.name} subtitle={`${previewAsset.mimeType} · ${(previewAsset.sizeBytes / 1024 / 1024).toFixed(2)} MB`} onClose={() => setPreviewAsset(null)} wide><div className="asset-preview-large"><Media asset={previewAsset} controls /></div><div className="modal-footer"><Button variant="ghost" className="button primary" onClick={() => { addNode(assetKind(previewAsset), previewAsset); setPreviewAsset(null); }}><Icon name="plus" size={16} />添加到画布</Button></div></Modal>}
    {realConfirm && <Modal title="确认提交真实生成" subtitle="此操作会调用外部生成服务，可能产生费用。" onClose={() => { realConfirmRef.current = null; setRealConfirm(null); }}><div className="modal-form"><div className="confirmation-summary"><strong>{providers.find(p => p.id === realConfirm.providerId)?.name || realConfirm.providerId}</strong>{realConfirm.retryJobId && <p>重试明确失败的任务：使用原任务的固定镜头快照。</p>}<span>{realConfirm.model} · {inputModeLabel(realConfirm.inputMode)} · {realConfirm.shot.duration} 秒 · {realConfirm.shot.aspectRatio}</span><p>将发送此镜头的提示词、参数与 {generationReferences(realConfirm.shot, { frozen: Boolean(realConfirm.retryJobId), subjectReference: realConfirm.subjectReference }).references.length} 张参考图。费用由服务商按你的账户计费；工作台不保证远端任务可以取消。</p>{(realConfirm.subjectReference || realConfirm.shot.subjectReference) ? <><SubjectVideoSummary reference={realConfirm.subjectReference || realConfirm.shot.subjectReference} assets={realConfirm.referenceAssets} latestSubject={subjects?.state?.subjects[(realConfirm.subjectReference || realConfirm.shot.subjectReference).subjectVersion.subjectId]} /><p className="subject-warning" data-testid="paid-subject-face-warning">{realConfirm.providerId === 'ark' ? ARK_SUBJECT_WARNING : MOCK_SUBJECT_WARNING}</p><p className="muted">将发送上方固定版本的原图；提示词保持原样，不会自动注入主体名称或身份指令。</p></> : <VideoFrameSummary shot={realConfirm.shot} assets={realConfirm.referenceAssets} frozen={Boolean(realConfirm.retryJobId)} />}<p className="muted">此处不提供价格或预算承诺。请先确认服务商计费、账户额度与服务器侧已授权的调用上限。</p><p className="muted">提交状态不明确时，系统会停止重试，防止重复计费。</p></div><Button variant="ghost" className="button primary full" data-testid="confirm-live-generation" onClick={() => confirmGeneration(realConfirm)}>确认发送并生成</Button></div></Modal>}
  </main>;
}
