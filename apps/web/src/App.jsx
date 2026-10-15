import { savedClipLoudnessFields } from './timeline-clip-loudness-context.ts';
import './version-comparison.css';
import VersionComparison from './VersionComparison.tsx';
import { comparisonCurrent } from './version-comparison-state.ts';
import { WorkspaceVisibilityProvider } from './workspace-visibility.jsx';
import { preflightErrorMessage, preflightIssueMessage, exportCapabilityMessage } from './export-preflight-state.js';
import ExportPreview from './ExportPreview.tsx';
import { isExportPreviewRange, suggestedExportPreviewRange, exportPreviewContextKey, exportPreviewResult } from './export-preview-state.ts';
import ComfyImageSettings from './ComfyImageSettings.jsx';
import ImageSettings from './ImageSettings.jsx';
import AgentSettings from './AgentSettings.jsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import ProjectHomeConnections from './ProjectHomeConnections.tsx';
import { providerDisplayName } from './creation-i18n.ts';
import { message as msg, renderMessage as renderCoreMessage } from '../../../packages/i18n/src/index.ts';
import LanguageControl from './LanguageControl.tsx';
import WebSettingsCenter from './WebSettingsCenter.tsx';
import { hasOpenWorkbenchModal } from './workbench-modal-state.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import './timeline-audio-preview.css';
import {useTimelineAudioPreview,timelineAudioPreviewSourceIdentity,timelineAudioPreviewPosition,seekTimelineAudioPreview} from './use-timeline-audio-preview.ts';
import { createEditorWindowInputs } from './editor-window-inputs.ts';
import { combineNativeEntryClose } from './native-entry-close.ts';
import { createNativeProjectLocation } from './native-project-location.ts';
import NativeLocatorStatus from './NativeLocatorStatus.tsx';
import { createNativeAudioPreviewAdmission } from './native-audio-preview-adapter.ts';
import { useEditorSettingsScope } from './editor-settings-scope.ts';
import { editorInitialSelection, useEditorWindowStatus, openNativeSettings, revealNativeProjects } from './editor-native-window.ts';
import EditorWindowOpening from './EditorWindowOpening.tsx';
import { useExportRange } from './export-range-state.ts';
import RestoredWorkspace, { RestoredUnavailable } from './RestoredWorkspace.jsx';
import { deriveTimelineAssetUsage, retainTimelineAssetUsage } from './timeline-asset-usage.ts';
import { locateTimelineAssetUse, matchesTimelineAssetUse, revealTimelineAssetUse } from './timeline-asset-navigation.ts';
import { pinNewWorkspaceIntent, assertWorkspaceIntent, workspaceIntentDisposition, workspaceOriginScope, retainWorkspaceIdentity } from './workspace-origin.js';
import { assertWorkspaceOperation, validateProjectWorkspace, RESTORE_DISABLED_MESSAGE } from './restored-workspace.js';
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
import { schemas, TIMELINE_EXPORT_DEFAULT_SETTINGS, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, isTimelineRenderRecord, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, isSubjectGenerationResponse, isSubjectGenerationRetryResponse } from '@mioon/contracts';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, useReactFlow } from '@xyflow/react';
import { measuredFitPadding } from './canvas-fit.ts';
import { staleClipSources } from './timeline-source-freshness.ts';
import Icon from './icons.jsx';
import ProjectHome from './ProjectHome.tsx';
import './project-home.css';
import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { readNativeLegacyClose } from './native-close-legacy.ts';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, hasProjectResponseOriginMismatch, projectOpenFailureKind } from './project-open-state.ts';
import Inspector from './Inspector.jsx';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoIdentity, subjectVideoProfileIdentity, ARK_SUBJECT_WARNING_MESSAGE, MOCK_SUBJECT_WARNING_MESSAGE } from './subject-video.js';
import { VideoFrameSummary } from './VideoFrameControls.jsx';
import TaskCenter from './TaskCenter.jsx';
import { captureTaskWorkspaceIntent, navigateTaskShot } from './task-workspace-intent.ts';
import { createEditTaskController } from './edit-task-controller.js';
import { isDurableEditOperation, taskInputKey } from './edit-task-client.js';
import AgentWorkspace, { AgentDockPane } from './AgentWorkspace.jsx';
import { makeAgentTimelineClipSelection, makeAgentTimelineGainSelection, agentTimelineGainBlockedReason, agentTimelineGainBlockedDescriptor } from './agent-timeline-context.js';
import ImageGeneration from './ImageGeneration.jsx';
import AssetLibrary from './AssetLibrary.jsx';
import { useSubjects } from './use-subjects.js';
import { useAssetAnnotations } from './use-asset-annotations.ts';
import { annotationKey, annotationError } from './asset-annotation-state.ts';
import { useAssetDispositions } from './use-asset-dispositions.js';
import { dispositionKey } from './asset-disposition-state.js';
import ExportHistoryList from './ExportHistoryList.jsx';
import DeliveryWorkspace from './DeliveryWorkspace.tsx';
import TimelineExportPreflight from './TimelineExportPreflight.jsx';
import { useExportPreflight } from './use-export-preflight.js';
import { useExportSamplePeak } from './use-export-sample-peak.ts';
import { useExportLoudness } from './use-export-loudness.ts';
import { useTimelineMixLoudness } from './use-timeline-mix-loudness.ts';
import TimelineMixLoudness from './TimelineMixLoudness.tsx';
import TimelineLoudnessApply from './TimelineLoudnessApply.tsx';
import { useTimelineLoudnessApply } from './use-timeline-loudness-apply.ts';
import { timelineLoudnessApplyRecoveryScope } from './timeline-loudness-apply-state.ts';
import { submitTimelineLoudnessApply } from './timeline-loudness-apply-submit.ts';
import { timelineMixLoudnessViewState } from './timeline-mix-loudness-state.ts';
import { useExportSettings } from './use-export-settings.js';
import { useTimelineDeliveryName } from './export-delivery-state.ts';
import { useLocalDelivery } from './local-delivery-state.ts';
import DeliveryDraftRecovery from './DeliveryDraftRecovery.tsx';
import Timeline, { ASSET_DRAG, assetKind, dragAsset } from './Timeline.jsx';
import TimelineInspector from './TimelineInspector.jsx';
import { canEditTimelineAudioRole, isWorkspaceRestoreInspection } from '@mioon/contracts';
import { observeClipAudioRoleCapability } from './clip-audio-role-state.ts';
import SubtitleInspector from './SubtitleInspector.jsx';
import { useSubtitles } from './use-subtitles.js';
import { subtitleAcknowledged } from './subtitle-state.js';
import TimelineFormatPanel from './TimelineFormatPanel.jsx';
import WorkspaceBackupPanel from './WorkspaceBackupPanel.jsx';
import { useTimelineFormat } from './use-timeline-format.js';
import { timelineFormatAcknowledged } from './timeline-format-state.js';
import { clipReplacementAcknowledged, clipReplacementErrorDescriptor, clipReplacementReviewIssue } from './clip-source-replacement.js';
import Preview from './Preview.jsx';
import SourceRangeInspector from './SourceRangeInspector.jsx';
import FrameExtractionPanel from './FrameExtractionPanel.jsx';
import { useFrameExtraction } from './use-frame-extraction.js';
import { frameCaptureBusy } from './frame-extraction.js';
import { useSourceRange } from './use-source-range.js';
import { sourceRangeAddPlan, sameSourceSnapshot } from './source-range-state.js';
import { Media, nodeTypes } from './Nodes.jsx';
import { rpc, requestId, activeJob, assetUrl, versionUrl } from './api.js';
import { importAcknowledged, importBusyFeedback, importFeedback, renderImportFeedback } from './import-feedback.js';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel, inputModeDescriptor, generationInputIssueDescriptor, providerAvailabilityDescriptor, generationReferences, generationReferenceIdentity } from './generation-settings.js';
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
import { REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, isReferenceEdge, referenceForShot, isReferenceOperation, hasPendingReference, isImageReferenceNode, referenceAttachIssueDescriptor, canvasEdge } from './reference-connections.js';

const emptyData = { project: null, assets: [], shots: [], nodes: [], edges: [], jobs: [], versions: [], exports: [], timeline: null, timelineHistory: null };
const emptyBusy = Object.freeze({});
// Canvas fits leave room for the docks, heading and storyboard that float over the full-bleed pane.
const canvasFitPadding = fallback => measuredFitPadding(document.querySelector('[data-testid="canvas-drop-zone"]'), fallback);
function localizedError(displayMessage) { return Object.assign(new Error(renderCoreMessage('zh-Hans', displayMessage)), { displayMessage }); }
function readableError(error) {
  if (error?.displayMessage) return error.displayMessage;
  if (error?.code === 'CONFLICT' || error?.code === 'REVISION_CONFLICT') return msg('shell.error.conflict');
  if (['CLIP_OVERLAP', 'TIMELINE_OVERLAP', 'OVERLAP'].includes(error?.code)) return msg('shell.error.overlap');
  if (error?.code === 'UNAUTHORIZED') return msg('shell.error.unauthorized');
  if (error?.code === 'STORAGE_MIGRATION_BLOCKED') return msg('shell.error.storageMigration');
  if (['WORKSPACE_ORIGIN_UNVERIFIED', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'].includes(error?.code)) return msg('tasks.unverifiedWorkspace');
  if (error?.code === 'RESTORED_RECORD_HELD') return msg('tasks.heldReason');
  if (error?.code === 'RESTORE_WORKSPACE_ORIGIN_MISMATCH') return msg('shell.error.workspaceChanged');
  if (error?.code === 'WORKSPACE_INTENT_ALREADY_PINNED') return msg('shell.error.workspacePinned');
  if (error?.code === 'RESTORE_OPERATION_UNAVAILABLE') return msg('recovery.restored.disabledReason');
  if (error?.code === 'RESTORE_BACKUP_UNAVAILABLE') return msg('recovery.restored.backupReason');
  if (error?.code === 'LAST_PROJECT_SCOPE_MISMATCH') return msg('shell.error.lastProjectScope');
  return msg('shell.error.incomplete');
}
function Login({ onLogin }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setLoading(true); setError('');
    try {
      const result = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!result.ok) throw localizedError(msg('shell.login.invalidToken'));
      setToken(''); await onLogin();
    } catch (err) { setError(readableError(err)); } finally { setLoading(false); }
  }
  return <div className="login-page"><div className="login-atmosphere" /><div className="login-visual"><div className="brand large"><span className="brand-mark"><Icon name="film" size={23} /></span>Mioon</div><div className="login-headline"><div className="eyebrow">{t('shell.login.eyebrow')}</div><h1>{t('shell.login.headline')}</h1><p>{t('shell.login.description')}</p></div><div className="login-footnote"><span className="status-dot green" />{t('shell.login.footnote')}</div></div><div className="login-form-wrap"><LanguageControl /><form className="login-form" onSubmit={submit}><span className="login-icon"><Icon name="lock" size={23} /></span><h2>{t('shell.login.title')}</h2><p>{t('shell.login.hint')}</p><Label className="field-label" htmlFor="access-token">{t('shell.login.token')}</Label><Input id="access-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder={t('shell.login.placeholder')} required autoFocus />{error && <div className="notice error" role="alert">{renderMessage(error)}</div>}<Button variant="ghost" className="button primary full" type="submit" disabled={loading || !token}>{loading ? <span className="spinner" /> : <Icon name="arrow" size={16} />}{t('shell.login.enter')}</Button><div className="login-security"><Icon name="lock" size={13} />{t('shell.login.secrets')}</div></form></div></div>;
}
function Modal({ title, subtitle, children, onClose, wide = false }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={`modal ${wide ? 'wide' : ''}`} showCloseButton={false}><header className="modal-header"><div><DialogTitle>{title}</DialogTitle><DialogDescription className={subtitle ? '' : 'sr-only'}>{subtitle || title}</DialogDescription></div><DialogClose render={<Button variant="ghost" className="icon-button" aria-label={t('shell.closeDialog')} />}><Icon name="close" /></DialogClose></header>{children}</DialogContent></Dialog>;
}
function CreateProject({ onClose, onCreate, busy }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  return <Modal title={t('projects.newStory')} subtitle={t('projects.newStoryHint')} onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onCreate(name.trim(), description.trim()); }}><Label className="field-label" htmlFor="project-name">{t('projects.name')}</Label><Input id="project-name" data-testid="project-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('projects.namePlaceholder')} maxLength={150} required autoFocus /><Label className="field-label" htmlFor="project-description">{t('projects.direction')}<span className="optional">{t('shell.optional')}</span></Label><Textarea id="project-description" rows={3} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('projects.directionPlaceholder')} /><Button variant="ghost" className="button primary full" data-testid="create-project-submit" disabled={!name.trim() || busy} type="submit"><Icon name="plus" size={16} />{t('projects.create')}</Button></form></Modal>;
}

export function SettingsConnectionForms({ selected, page, visible, registry, onSelect, onPage, general, connectionsAvailable = true, beforeClose, onClose }) { const { t } = useI18n(); return <ProjectHomeConnections selected={selected} page={page} connectionsAvailable={connectionsAvailable} onSelect={onSelect} onPage={onPage} general={general} panes={{
  agent: <AgentDockPane visible={visible && connectionsAvailable && page === 'agent'}><SettingsNavigationSlot registry={registry} slot="home:agent">{report => <AgentSettings closeLabel={t('common.closeSettings')} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  official: <AgentDockPane visible={visible && connectionsAvailable && page === 'official'}><SettingsNavigationSlot registry={registry} slot="home:official">{report => <ImageSettings active={visible && connectionsAvailable && page === 'official'} contextKey="native-settings" closeLabel={t('common.closeSettings')} slot="official" onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  custom: <AgentDockPane visible={visible && connectionsAvailable && page === 'custom'}><SettingsNavigationSlot registry={registry} slot="home:custom">{report => <ImageSettings active={visible && connectionsAvailable && page === 'custom'} contextKey="native-settings" closeLabel={t('common.closeSettings')} slot="custom" onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  comfy: <AgentDockPane visible={visible && connectionsAvailable && page === 'comfy'}><SettingsNavigationSlot registry={registry} slot="home:comfy">{report => <ComfyImageSettings active={visible && connectionsAvailable && page === 'comfy'} contextKey="native-settings" closeLabel={t('common.closeSettings')} onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
}} />; }

export default function App({ nativeWindow = null, nativeProjectEntry = null } = {}) {
  const { locale, t, renderMessage, formatDate, formatNumber } = useI18n();
  const confirm = useConfirmation();
  const nativeSettingsScope = useEditorSettingsScope(nativeWindow);
  const [nativeProjectLocation] = useState(() => nativeWindow ? createNativeProjectLocation(window, nativeWindow.context.initialProjectId) : null);
  const [nativeAudioAdmission] = useState(() => nativeWindow ? createNativeAudioPreviewAdmission(window.__mioonNativeAudioPreview ?? null) : null);
  const [auth, setAuth] = useState(null);
  const [data, setData] = useState(emptyData);
  const [workspace, setWorkspace] = useState(null);
  const workspaceRef = useRef(null);
  const [audioRoleCapability, setAudioRoleCapability] = useState('loading');
  const audioRoleEditable = audioRoleCapability === 'editable';
  const audioRoleProbe = useRef(null);
  const audioRoleProbeEpoch = useRef(0);
  const restored = workspace?.restored === true;
  const generationUnavailableReason = restored ? RESTORE_DISABLED_MESSAGE : '';
  const dataRef = useRef(data); dataRef.current = data;
  const [projects, setProjects] = useState([]);
  const [providers, setProviders] = useState([]);
  const [generationOptions, setGenerationOptions] = useState({});
  const generationOptionsRef = useRef(generationOptions); generationOptionsRef.current = generationOptions;
  const updateGenerationOptions = useCallback((shotId, options) => { if (shotId) { const next = { ...generationOptionsRef.current, [shotId]: options }; generationOptionsRef.current = next; setGenerationOptions(next); } }, []);
  const [loading, setLoading] = useState(false);
  const [projectOpening, setProjectOpening] = useState({ phase: 'home', projectId: null, error: '' });
  const openedProject = useRef(null);
  const projectCreateFlight = useRef(null);
  const [homePage, setHomePage] = useState('projects');
  const [webSettingsRequest, setWebSettingsRequest] = useState(null);
  const webSettingsRequestRef = useRef(null);
  const [webSettingsOpen, setWebSettingsOpen] = useState(false);
  const [projectListStatus, setProjectListStatus] = useState({ busy: false, error: '' });
  const projectListSerial = useRef(0);
  const nativeCloseRegistry = useRef(null);
  if (!nativeCloseRegistry.current) nativeCloseRegistry.current = createNativeCloseRegistry();
  const settingsNavigation = useRef(null);
  if (!settingsNavigation.current) settingsNavigation.current = createSettingsNavigationRegistry();
  const [busyByProject, setBusyByProject] = useState({});
  const busyRef = useRef(new Set());
  const editorInputs = useRef(null);
  if (!editorInputs.current) editorInputs.current = createEditorWindowInputs();
  const exportSettingsRef = useRef(null), exportRangeRef = useRef(null);
  const [toast, setToast] = useState(null);

  const [showProjects, setShowProjects] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [rightDockTab, setRightDockTab] = useState('properties');
  const [propertiesPage, setPropertiesPage] = useState('inspector');
  const [subtitleDirty, setSubtitleDirty] = useState(false);
  const subtitlesRef = useRef(null);
  const [formatDirty, setFormatDirty] = useState(false);
  const timelineFormatRef = useRef(null);
  const timelineLoudnessApplyRef = useRef(null);
  const deliveryNameRef = useRef(null);
  const localDeliveryRef = useRef(null);
  const clipDraftRef = useRef(null);
  const [agentClipDraftBlocked, setAgentClipDraftBlocked] = useState(true);
  const shotTextRef = useRef(null), shotCloseRef = useRef(null);
  const registerShotText = useCallback((controller, readLocalClose) => {
    const owner = { controller, readLocalClose };
    shotTextRef.current = controller; shotCloseRef.current = owner;
    return () => { if (shotCloseRef.current === owner) { shotCloseRef.current = null; if (shotTextRef.current === controller) shotTextRef.current = null; } };
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
  const [comparisonId, updateComparisonId] = useState(null);
  const comparisonIdRef = useRef(null);
  const [previewAsset, updatePreviewAsset] = useState(null);
  const previewAssetRef = useRef(null), clipLoudnessEpoch = useRef(0);
  const setPreviewAsset = value => { previewAssetRef.current = value; clipLoudnessEpoch.current++; updatePreviewAsset(value); };
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
  const [annotationRefresh, setAnnotationRefresh] = useState({});
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
    if (next.activeMode !== previous.activeMode || ['selectedClipId', 'quickAssetId', 'previewKind'].some(key => next.editing[key] !== previous.editing[key])) clipLoudnessEpoch.current++;
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
  function projectSessionReady() { return canPublishProjectOpen(openedProject.current, { active: importSession.current.active, currentProjectId: currentProject.current, epoch: projectEpoch.current, workspaceScope: workspaceOriginScope(workspaceRef.current) || '', preferencesReady: viewReady.current, dataProjectId: dataRef.current.project?.id || null, loading: false }); }
  const workbenchReady = auth === true && projectSessionReady() && !loading;
  useEditorWindowStatus(nativeWindow, currentProject.current, projectOpening.phase, workbenchReady);
  const panelSurface = useRef(null), panelIntent = useRef(0), taskWorkspaceState = useRef(null), taskShotAttempt = useRef(0);
  const [panelChange, setPanelChange] = useState(0);
  const panelScope = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${panelChange}`;
  const geometry = usePanelGeometry(panelSurface, modeLayout, workspaceMode, panelScope, auth === true && workbenchReady);
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
  taskWorkspaceState.current = { visible: workbenchReady && rightDockTab === 'tasks' && panelVisible('inspector'), connected: workbenchReady && online && auth === true && !loading };
  const taskViewScope = JSON.stringify([currentProject.current, projectEpoch.current, navigationEpoch.current, panelIntent.current, workspaceMode, rightDockTab, panelVisible('inspector'), workspaceOriginScope(workspaceRef.current)]);
  const isBusy = (key, projectId = currentProject.current) => busyRef.current.has(`${projectId || 'none'}:${key}`);
  function markBusy(projectId, key, value) {
    const scope = projectId || 'none';
    editorInputs.current.changed();
    if (value) busyRef.current.add(`${scope}:${key}`); else busyRef.current.delete(`${scope}:${key}`);
    setBusyByProject(all => ({ ...all, [scope]: { ...all[scope], [key]: value } }));
  }
  async function guardNavigation(message = msg('shell.confirm.switchWorkspace'), additionalDirty = false, canDiscard = () => true) {
    if (nativeWindow && !editorWindowCanNavigate()) return false;
    if (nativeWindow) { const originalCanDiscard = canDiscard; canDiscard = () => originalCanDiscard() && editorWindowCanNavigate(); }
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
  async function guardProjectNavigation(message, additionalDirty = false, canLeaveSettings = () => true) {
    if (nativeWindow && !editorWindowCanNavigate()) return false;
    const retainedCurrent = () => !nativeWindow || editorWindowCanNavigate();
    const controller = timelineFormatRef.current?.controller, delivery = deliveryNameRef.current?.controller, deliveryCapture = delivery?.capture();
    const formatDraft = controller?.getState?.();
    const localDeliveryController = localDeliveryRef.current?.controller, localDeliveryCapture = localDeliveryController?.capture();
    const canDiscard = () => retainedCurrent() && canLeaveSettings() && !(controller && (controller !== timelineFormatRef.current?.controller || controller.getState?.() !== formatDraft))
      && !(delivery && (delivery !== deliveryNameRef.current?.controller || deliveryCapture && ['scope', 'projectId', 'value', 'version'].some(field => delivery.getState()[field] !== deliveryCapture[field])))
      && !(localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.isCurrent(localDeliveryCapture)));
    if (!await guardNavigation(message, additionalDirty || controller?.hasUnsaved() || delivery?.hasUnsaved(), canDiscard) || !canDiscard()) return false;
    if (localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.abandonCurrentInput(localDeliveryCapture))) return false;
    if (delivery && (delivery !== deliveryNameRef.current?.controller || !delivery.discardDraft(deliveryCapture))) return false;
    controller?.discardDraft();
    return true;
  }
  async function prepareSettingsDeparture() {
    const captured = context(), lifetime = importSession.current.selection, ticket = settingsNavigation.current.capture();
    if (!settingsNavigation.current.canLeave(ticket)) { notify(msg('shell.settingsBusyRetained'), 'warning'); return null; }
    if (settingsNavigation.current.needsConfirmation(ticket) && !await confirm(msg('shell.confirm.leaveConnections'))) return null;
    return importSession.current.active && importSession.current.selection === lifetime && isCurrent(captured) && settingsNavigation.current.canLeave(ticket) ? ticket : null;
  }
  function openGlobalSettings(page = 'general') {
    if (restored && page !== 'general') { notify(msg('shell.restoredNoConnections'), 'warning'); return Promise.resolve(false); }
    if (nativeWindow) return nativeSettingsScope.open(page === 'general' ? 'agent' : page);
    webSettingsRequestRef.current?.resolve?.(false);
    return new Promise(resolve => { const request = { page, resolve }; webSettingsRequestRef.current = request; setWebSettingsRequest(request); });
  }
  async function changeHomePage(page) {
    if (loading || projectCreateFlight.current || isBusy('project-create') || !['projects', 'settings'].includes(page)) return;
    if (page === 'settings') { openGlobalSettings(); return; }
    if (page === homePage) return;
    if (page !== 'settings' && !await prepareSettingsDeparture()) return;
    setHomePage(page);
  }
  async function refreshHomeProjects() {
    const serial = ++projectListSerial.current, scope = workspaceOriginScope(workspaceRef.current);
    setProjectListStatus({ busy: true, error: '' });
    try {
      const list = await rpc('project.list');
      if (!importSession.current.active || serial !== projectListSerial.current || scope !== workspaceOriginScope(workspaceRef.current)) return;
      setProjects(list); setProjectListStatus({ busy: false, error: '' });
    } catch (error) {
      if (!importSession.current.active || serial !== projectListSerial.current || scope !== workspaceOriginScope(workspaceRef.current)) return;
      if (projectOpenFailureKind(error) === 'auth') setAuth(false);
      setProjectListStatus({ busy: false, error: readableError(error) });
    }
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
  const refresh = useCallback(async (projectId = currentProject.current, quiet = true, { opening = false } = {}) => {
    if (!projectId || currentProject.current !== projectId || !opening && !projectSessionReady()) return null;
    const call = ++requestCounter.current, epoch = projectEpoch.current, capturedWorkspace = workspaceRef.current;
    try {
      const [next, caps] = await Promise.all([rpc('project.get', { projectId }), capturedWorkspace?.restored ? [] : rpc('provider.list')]);
      if (!importSession.current.active || currentProject.current !== projectId || epoch !== projectEpoch.current || call !== requestCounter.current || workspaceOriginScope(capturedWorkspace) !== workspaceOriginScope(workspaceRef.current)) return null;
      if (capturedWorkspace?.restored && hasProjectResponseOriginMismatch(next, capturedWorkspace.workspaceOrigin)) throw Object.assign(localizedError(msg('shell.error.restoreIdentity')), { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH' });
      validateProjectWorkspace(next, capturedWorkspace);
      if (!projectResponseMatches(next, projectId)) throw Object.assign(localizedError(msg('shell.error.projectIdentity')), { code: 'BACKEND_PROTOCOL_ERROR' });
      reconcilePending(projectId, next, { workspace: capturedWorkspace });
      dataRef.current = { ...emptyData, ...next }; setData(dataRef.current); setProviders(caps); setLastSync(new Date()); setOnline(true); setPending(pendingForProject(projectId));
      const reconciled = reconcileWorkspaceState(viewRef.current, next);
      if (viewReady.current && JSON.stringify(reconciled) !== JSON.stringify(viewRef.current)) { viewRef.current = reconciled; setView(reconciled); preferencesRef.current.update(projectId, reconciled, { immediate: true }); }
      return next;
    } catch (e) {
      if (importSession.current.active && currentProject.current === projectId && epoch === projectEpoch.current && call === requestCounter.current && workspaceOriginScope(capturedWorkspace) === workspaceOriginScope(workspaceRef.current)) { if (e.code === 'UNAUTHORIZED') setAuth(false); setOnline(false); if (!quiet) notify(readableError(e), 'error'); }
      if (opening) throw e;
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
    if (nativeWindow && id !== nativeWindow.context.initialProjectId) return nativeProjectEntry?.open(id) ?? false;
    const selection = context(), lifetime = importSession.current.selection, settingsTicket = await prepareSettingsDeparture();
    if (!settingsTicket || !importSession.current.active || importSession.current.selection !== lifetime || !isCurrent(selection)) return false;
    const settingsCurrent = () => importSession.current.active && importSession.current.selection === lifetime && isCurrent(selection) && settingsNavigation.current.canLeave(settingsTicket);
    if (id === currentProject.current && !initial && !reloadPreferences && !loading && projectSessionReady()) {
      if (!nativeWindow && !workspaceRef.current?.restored) lastProjectRef.current.rememberOpened(id, projectEpoch.current);
      return true;
    }
    const draftMessage = imageDraft.current ? msg(agentDraft.current ? 'shell.confirm.unsentBoth' : 'shell.confirm.unsentImage') : agentDraft.current ? msg('shell.confirm.unsentAgent') : msg('shell.confirm.switchProject');
    if (!initial && !await guardProjectNavigation(draftMessage, agentDraft.current || imageDraft.current, settingsCurrent)) return false;
    if (!settingsCurrent()) return false;
    navigationEpoch.current++; const epoch = ++projectEpoch.current; ++requestCounter.current;
    lastProjectRef.current.invalidateNavigation(epoch);
    const attempt = projectOpenAttempt(id, epoch, workspaceOriginScope(workspaceRef.current));
    openedProject.current = null;
    setProjectOpening({ phase: 'opening', projectId: id, error: '' }); setHomePage('projects');
    if (currentProject.current) void preferencesRef.current.flush({ projectId: currentProject.current, keepalive: true });
    currentProject.current = id;
    setPropertiesPage('inspector');
    setTaskState(tasksRef.current.getState(id));
    viewReady.current = false;
    setPreferenceStatus({ phase: 'loading', pending: false });
    setPending(pendingForProject(id)); setShowProjects(false); setData(emptyData); dataRef.current = emptyData; setNodes([]); setLoading(true); dragging.current = false;
    setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false); setInspectorEpoch(value => value + 1); setRightDockTab(value => value === 'tasks' ? 'properties' : value); setShowExports(false); setComparisonId(null); setPreviewAsset(null); setRealConfirm(null); setToast(null); setMobilePanel('canvas');
    const url = new URL(window.location.href); url.searchParams.set('project', id);
    if (!nativeWindow && !fromHistory) window.history[initial ? 'replaceState' : 'pushState']({ projectId: id }, '', url);
    // Wait for authoritative preferences (or a safe local fallback) before the
    // project mounts and its initial viewport/selection effects can persist.
    try {
    const restored = await preferencesRef.current.load(id, { reload: reloadPreferences });
    if (!importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch || workspaceOriginScope(workspaceRef.current) !== attempt.workspaceScope) return false;
    if (!restored) throw Object.assign(localizedError(msg('shell.error.viewNotReady')), { code: 'PROJECT_VIEW_UNAVAILABLE' });
    const preferenceError = preferencesRef.current.getStatus(id)?.error;
    if (preferenceError && projectOpenFailureKind(preferenceError) !== 'project') throw preferenceError;
    viewRef.current = restored; setView(restored); viewReady.current = true;
    setZoom(Math.round((restored.canvas.viewport?.zoom || 1) * 100));
    setPreferenceStatus(preferencesRef.current.getStatus(id));
    const next = await refresh(id, false, { opening: true });
    if (!importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch || workspaceOriginScope(workspaceRef.current) !== attempt.workspaceScope) return false;
    setLoading(false);
    if (!projectResponseMatches(next, id) || !canPublishProjectOpen(attempt, { active: importSession.current.active, currentProjectId: currentProject.current, epoch: projectEpoch.current, workspaceScope: workspaceOriginScope(workspaceRef.current), preferencesReady: viewReady.current, dataProjectId: next?.project?.id || null, loading: false })) throw Object.assign(localizedError(msg('shell.error.selectionNotReady')), { code: 'BACKEND_PROTOCOL_ERROR' });
    openedProject.current = attempt; setProjectOpening({ phase: 'ready', projectId: id, error: '' });
    void tasksRef.current.load(id);
    if (!nativeWindow && !initial && !reloadPreferences && !workspaceRef.current?.restored) lastProjectRef.current.rememberOpened(id, epoch);
    if (next && !viewRef.current.canvas.selectedId) { const first = [...next.shots].sort((a, b) => a.orderIndex - b.orderIndex)[0] || next.nodes.find(n => n.type !== 'text') || next.nodes[0]; if (first) updateView('canvas', { selectedId: first.id }, { passive: true }); }
    return true;
    } catch (e) {
      if (importSession.current.active && currentProject.current === id && projectEpoch.current === epoch && workspaceOriginScope(workspaceRef.current) === attempt.workspaceScope) {
        openedProject.current = null; viewReady.current = false;
        setProjectOpening({ phase: 'error', projectId: id, error: readableError(e) });
        const kind = projectOpenFailureKind(e);
        if (kind === 'auth') setAuth(false);
        else if (kind === 'identity') { setAuth('error'); notify(readableError(e), 'error'); }
      }
      return false;
    } finally {
      if (importSession.current.active && currentProject.current === id && projectEpoch.current === epoch && workspaceOriginScope(workspaceRef.current) === attempt.workspaceScope) setLoading(false);
    }
  }
  async function reloadPreferences() {
    const captured = context();
    if (!await confirm(msg('shell.confirm.loadSavedView'))) return;
    if (isCurrent(captured)) await selectProject(captured.projectId, false, true, true);
  }
  async function boot() {
    const ticket = bootGuard.current.begin();
    preferenceScope.current = null;
    audioRoleProbe.current?.();
    const roleEpoch = ++audioRoleProbeEpoch.current;
    setAudioRoleCapability('loading');
    try {
      migrateBrowserStorage();
      const observedWorkspace = await rpc('workspace.restore.inspect');
      if (!bootGuard.current.isCurrent(ticket)) return;
      const verifiedWorkspace = retainWorkspaceIdentity(workspaceRef.current, observedWorkspace);
      workspaceRef.current = verifiedWorkspace; setWorkspace(verifiedWorkspace);
      audioRoleProbe.current = observeClipAudioRoleCapability(verifiedWorkspace, signal => rpc('workspace.restore.inspect', { includeAudioRoleCapability: true }, { signal }), isWorkspaceRestoreInspection, canEditTimelineAudioRole,
        () => audioRoleProbeEpoch.current === roleEpoch && importSession.current.active && workspaceRef.current === verifiedWorkspace, setAudioRoleCapability);
      const [list, caps, locator] = await Promise.all([
        rpc('project.list'), verifiedWorkspace.restored ? [] : rpc('provider.list'),
        verifiedWorkspace.restored ? Promise.resolve(null) : lastProjectRef.current.discover(),
      ]);
      if (!bootGuard.current.isCurrent(ticket)) return;
      assertLastProjectBootIdentity(lastProjectRef.current.getState());
      locatorIdentity.current = retainLastProjectScope(locatorIdentity.current, locator?.workspaceScope ?? null);
      preferenceScope.current = locator?.workspaceScope ?? null;
      setProjects(list); setProviders(caps); setAuth(true); setOnline(true);
      const choice = editorInitialSelection(nativeWindow, chooseInitialProject(list, new URLSearchParams(window.location.search).get('project'), locator?.envelope ?? null));
      if (choice.projectId) {
        const accepted = await selectProject(choice.projectId, true);
        if (accepted && currentProject.current === choice.projectId && choice.notice) notify(choice.notice, 'error');
      } else { setData(emptyData); dataRef.current = emptyData; currentProject.current = null; openedProject.current = null; viewReady.current = false; setProjectOpening({ phase: 'home', projectId: null, error: '' }); if (choice.notice) notify(choice.notice, 'error'); }
    } catch (e) { if (bootGuard.current.isCurrent(ticket)) { if (e.code === 'UNAUTHORIZED') setAuth(false); else { setAuth('error'); notify(readableError(e), 'error'); } } }
  }
  useEffect(() => {
    bootGuard.current.activate(); lastProjectRef.current.activate(); void boot();
    return () => { bootGuard.current.deactivate(); audioRoleProbeEpoch.current++; audioRoleProbe.current?.(); lastProjectRef.current.dispose(); };
  }, []);
  useEffect(() => {
    const controller = preferencesRef.current;
    const locator = lastProjectRef.current;
    const flush = event => { if (window.__mioonNativeCloseAdmission?.suppressLifecycleFlush?.(event) === true) return; void controller.flush({ keepalive: true }); if (!workspaceRef.current?.restored) { if (!nativeWindow) void locator.flush(); if (localDeliveryRef.current?.controller.hasUnsaved()) void localDeliveryRef.current.controller.flush(); if (shotTextRef.current?.hasUnpersisted()) void shotTextRef.current.flush(); if (clipDraftRef.current?.hasUnpersisted()) void clipDraftRef.current.flushForClose(); } };
    const onHidden = event => { if (document.visibilityState === 'hidden') flush(event); };
    // An unprivileged lifecycle function: desktop main may await this fixed
    // function before closing; it exposes no Electron/IPC/native capability.
    const drain = async () => {
      const restored = Boolean(workspaceRef.current?.restored), clip = restored ? null : clipDraftRef.current, clipCapture = clip?.capture();
      const [, remembered, titleSaved, shotSaved, clipSaved] = await Promise.all([
        controller.flush({ keepalive: true }), restored || nativeWindow ? true : locator.flush(),
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
    const onPop = async () => { if (nativeProjectLocation) { nativeProjectLocation.restore(); return; } const id = new URLSearchParams(window.location.search).get('project'); if (!id || id === currentProject.current) return; const accepted = await selectProject(id, false, true); if (!accepted) { const url = new URL(window.location.href); url.searchParams.set('project', currentProject.current); window.history.pushState({ projectId: currentProject.current }, '', url); } };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  });
  function readEditorWindowInputs(navigation = false) {
    return editorInputs.current.read({ clip: clipDraftRef.current, shot: shotTextRef.current, delivery: localDeliveryRef.current?.controller,
      busy: busyRef.current, navigation, settings: exportSettingsRef.current, range: exportRangeRef.current, defaultSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS });
  }
  function editorWindowCanNavigate() {
    const snapshot = readEditorWindowInputs(true);
    if (!snapshot.busy && !snapshot.unknown) return true;
    notify(msg('shell.pendingKeepWindow'), 'warning');
    return false;
  }
  useEffect(() => installNativeCloseAdmission(window, {
    registry: nativeCloseRegistry.current, settings: settingsNavigation.current,
    ...(nativeWindow ? { readAdditionalSnapshot: () => combineNativeEntryClose(readEditorWindowInputs(false), nativeProjectEntry?.readCloseSnapshot()), onObservationPause: value => nativeSettingsScope?.pauseObservation(value) } : {}),
    readScope: () => JSON.stringify([importSession.current.active, currentProject.current, projectEpoch.current, navigationEpoch.current, workspaceOriginScope(workspaceRef.current)]),
    readDocumentURL: () => window.location.href,
    readLegacySnapshot: () => readNativeLegacyClose({ inspectorDirty: dirtyRef.current,
      shot: shotTextRef.current, shotLocal: shotCloseRef.current?.controller === shotTextRef.current ? shotCloseRef.current?.readLocalClose : null,
      clip: clipDraftRef.current, format: timelineFormatRef.current?.controller,
      delivery: deliveryNameRef.current?.controller, subtitle: subtitlesRef.current?.controller, subject: subjectsRef.current?.controller }),
  }), []);
  useEffect(() => { if (showProjects) rpc('project.list').then(setProjects).catch(e => notify(readableError(e), 'error')); }, [showProjects]);
  useEffect(() => {
    if (!auth || !workbenchReady || !data.project?.id) return;
    const timer = setInterval(() => { if (!dragging.current && document.visibilityState === 'visible') refresh(); }, 2500);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [auth, workbenchReady, data.project?.id, refresh]);
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
      if (input?.projectId !== projectId) throw Object.assign(localizedError(msg('shell.error.projectChanged')), { code: 'MUTATION_PROJECT_MISMATCH' });
      if (pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(entry => entry.key === key ||
        (operation.startsWith('reference.') && isMutationOperation(entry.operation))))
        throw Object.assign(localizedError(msg('shell.error.previousSessionPending')), { code: 'MUTATION_PENDING' });
      const response = await tasksRef.current.submit({ projectId, operation, input, ...invocation }, { canExecute: preparedTask => {
        if (!isCurrent(captured) || canExecute?.(preparedTask) === false) return false;
        dispatched = true; invalidateHistory(); return true;
      } });
      invalidateHistory();
      if (response.task.status === 'not_applied') {
        rejected = true;
        await tasksRef.current.acknowledge(response.task);
        throw Object.assign(localizedError(msg('shell.error.notApplied')), { code: response.task.errorCode || 'TASK_NOT_APPLIED' });
      }
      if (response.task.status !== 'applied') {
        if (isCurrent(captured)) { notify(msg('shell.requestSaved'), 'warning'); openTasks(canRevealTasks); }
        return null;
      }
      // Fresh saves may return their own validated ACK to their mounted editor.
      // Historical task recovery below only refreshes current project records.
      if (!Object.hasOwn(response, 'result')) throw Object.assign(localizedError(msg('shell.error.editAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
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
          notify(dispatched && !rejected ? msg('shell.editOutcomeUnknown') : errorMessage(error), 'error');
          openTasks(canRevealTasks);
        }
        if (dispatched) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); }
  }
  async function recoverTask(task, acknowledgeOnly = false, canExecute = () => true) {
    const captured = context(), loudnessRecoveryScope = task.operation === 'timeline.loudness.apply' ? readTimelineLoudnessRecoveryScope() : null;
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
        const acknowledgedTask = response.task.acknowledged ? response.task : (await tasksRef.current.acknowledge(response.task))?.task;
        if (task.operation === 'timeline.loudness.apply') timelineLoudnessApplyRef.current?.controller.recovered(acknowledgedTask, loudnessRecoveryScope);
        if (currentProject.current === task.projectId) { timelineFormatRef.current?.controller.recovered(response.task); subtitlesRef.current?.controller.recovered(response.task); }
        if (isCurrent(captured) && canExecute()) notify(response.task.status === 'applied' ? msg('shell.requestApplied') : msg('shell.requestNotApplied'));
      } else if (isCurrent(captured) && canExecute()) notify(msg('shell.requestStillUnknown'), 'warning');
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
        throw Object.assign(localizedError(msg('shell.error.sessionChanged')), { code: 'MUTATION_REPLAY_MISMATCH' });
      clearPending(entry.projectId, entry.key, exact);
      if (currentProject.current === entry.projectId) setPending(pendingForProject(entry.projectId));
      if (isCurrent(captured)) notify(msg('shell.requestTransferred'));
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
    if (!replay && mutation && shotTextRef.current?.blocksLegacy()) { notify(msg('shell.shotTextFirst'), 'warning'); return null; }
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
        throw Object.assign(localizedError(msg('shell.error.oldPanelRequest')), { code: 'MUTATION_PROJECT_MISMATCH' });
      if (durable) {
        const entry = pendingEntry && replay ? pendingEntry : { projectId, key, operation, input, ...invocation, createdAt: new Date().toISOString(),
          ...((operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') || operation === 'job.retry' && subjectRetry) && expectedSubjectReference ? { expectedSubjectReference: structuredClone(expectedSubjectReference) } : {}),
          ...(operation === 'job.retry' && subjectRetry ? { subjectRetry: true, ...(expectedRetrySnapshot ? { expectedRetrySnapshot: structuredClone(expectedRetrySnapshot) } : {}) } : {}) };
        if (operation === 'job.retry' && replay && subjectRetry) {
          const original = readPending(projectId, key, entry);
          if (!original || original.operation !== operation || original.subjectRetry !== true || original.input?.jobId !== input.jobId || original.input?.requestId !== input.requestId || Object.keys(original.input).length !== Object.keys(input).length || Object.keys(original.input).some(field => original.input[field] !== input[field]))
            throw Object.assign(localizedError(msg('shell.error.subjectRetryChanged')), { code: 'MUTATION_REPLAY_MISMATCH' });
        }
        if (operation === 'job.retry' && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key && (subjectRetry || isSubjectRetryPending(item, dataRef.current.jobs || []))))
          throw Object.assign(localizedError(msg('shell.error.subjectRetryPending')), { code: 'MUTATION_PENDING' });
        if (operation === 'generation.submit' && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key && (Object.hasOwn(input, 'subjectVersionId') || Object.hasOwn(item.input ?? {}, 'subjectVersionId'))))
          throw Object.assign(localizedError(msg('shell.error.subjectGenerationPending')), { code: 'MUTATION_PENDING' });
        if (mutation && !replay) assertMutationOwner(entry, dataRef.current);
        // A new timeline or reference click must not silently replay an older
        // uncertain request. Only the task panel may recover its original input.
        if (requestBound && !replay && pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(item => item.key === key))
          throw Object.assign(localizedError(msg(reference ? 'shell.error.referenceRequestPending' : 'shell.error.timelineRequestPending')), { code: 'MUTATION_PENDING' });
        if (requestBound && replay) stored = prepareRequestReplay(entry);
        else stored = mutation ? prepareMutation(entry, { replay }) : prepareSubmission(entry, { replay });
        if (requestBound && stored.operation !== operation)
          throw Object.assign(localizedError(msg('shell.error.operationMismatch')), { code: 'MUTATION_REPLAY_MISMATCH' });
        if (requestBound && stored.input.projectId !== projectId)
          throw Object.assign(localizedError(msg('shell.error.ownerMismatch')), { code: 'MUTATION_PROJECT_MISMATCH' });
        input = stored.input; operation = stored.operation;
        if (operation === 'job.retry' && (stored.subjectRetry || stored.expectedSubjectReference || stored.expectedRetrySnapshot || dataRef.current.jobs?.length)) subjectRetry = subjectRetry || isSubjectRetryPending(stored, dataRef.current.jobs || []);
        if (currentProject.current === projectId) setPending(pendingForProject(projectId));
      }
      invalidateHistory();
      dispatched = true;
      const result = await rpc(operation, input, invocation);
      invalidateHistory();
      if (mutation) validateMutationResponse(stored, result);
      if (timeline && !isTimelineMutationResponse(operation, input, result)) throw Object.assign(localizedError(msg('shell.error.timelineAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (reference && !isReferenceMutationResponse(operation, input, result)) throw Object.assign(localizedError(msg('shell.error.referenceAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') && (!stored?.expectedSubjectReference || !isSubjectGenerationResponse(operation, input, result, { projectId, subjectReference: stored.expectedSubjectReference })))
        throw Object.assign(localizedError(msg('shell.error.subjectAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'job.retry' && subjectRetry && (!stored.expectedSubjectReference || !stored.expectedRetrySnapshot || !isSubjectGenerationRetryResponse(input, result, { projectId, subjectReference: stored.expectedSubjectReference, snapshot: stored.expectedRetrySnapshot })))
        throw Object.assign(localizedError(msg('shell.error.retryAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
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
        if (durable && stored && dispatched && !rejected) { notify(msg('shell.submissionUnknown'), 'error'); if (isCurrent(captured)) openTasks(canRevealTasks); }
        else if (isCurrent(captured)) notify(operation === 'timeline.clip.replaceSource' ? clipReplacementErrorDescriptor(e) : errorMessage(e), 'error');
        if (e.code === 'MUTATION_PENDING' && isCurrent(captured)) openTasks(canRevealTasks);
        if (dispatched || !requestBound) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); if (mutation) markBusy(projectId, 'canvas:mutation', false); if (replay && operation === 'asset.annotation.set' && currentProject.current === projectId) setAnnotationRefresh(value => ({ ...value, [projectId]: (value[projectId] || 0) + 1 })); if (replay && operation === 'asset.disposition.set' && currentProject.current === projectId) setDispositionRefresh(value => ({ ...value, [projectId]: (value[projectId] || 0) + 1 })); }
  }
  // Picking a shot, node or clip means "show me its properties". The Tasks and Delivery pages are reference views
  // (Tasks even opens by itself after a generation), so they give way; Agent and Image keep following the selection.
  function leaveReferencePage() { setRightDockTab(value => value === 'tasks' || value === 'delivery' ? 'properties' : value); }
  async function inspect(id, nextTab = 'settings', versionId = null, { reveal = false } = {}) {
    const captured = context(), panelChoice = panelIntent.current, timelineId = dataRef.current.timeline?.id, timelineRevision = dataRef.current.timeline?.revision;
    const canDiscard = () => isCurrent(captured) && panelChoice === panelIntent.current && timelineId === dataRef.current.timeline?.id && timelineRevision === dataRef.current.timeline?.revision && [...dataRef.current.shots, ...dataRef.current.nodes].some(record => record.id === id);
    if ((id !== selectedId || workspaceMode !== 'canvas') && !await guardNavigation(msg('shell.confirm.viewCanvasSource'), false, canDiscard)) return false;
    if (!canDiscard()) return false;
    setPropertiesPage('inspector');
    navigationEpoch.current++;
    leaveReferencePage();
    updateView('canvas', { selectedId: id, inspectorTab: nextTab, highlightedVersionId: versionId });
    updateView('activeMode', 'canvas');
    if (reveal) { setPanelOpen('inspector', true, 'canvas'); if (geometry.narrow) setMobilePanel('inspector'); }
    return true;
  }
  function checkGeneration(shot, provider, model, inputMode, frozen = false, subjectReference) {
    if (generationUnavailableReason) { notify(generationUnavailableReason, 'warning'); return false; }
    if (!frozen && !workspaceRef.current?.restored && (!shotTextRef.current || shotTextRef.current.blocksLegacy(shot.id))) { notify(msg('shell.generationCheckText'), 'warning'); return false; }
    if (referenceWorkBlocked()) return false;
    const issue = generationInputIssueDescriptor(shot, provider, model, dataRef.current.assets, inputMode, { frozen, subjectReference, ...(!frozen && inputMode === 'subject' ? { savedShot: dataRef.current.shots.find(item => item.id === shot.id), boundReference: Boolean(referenceForShot(dataRef.current.edges, shot.id)) } : {}) }) || providerAvailabilityDescriptor(provider);
    if (issue) { notify(issue, 'error'); return false; }
    if (dataRef.current.jobs.some(j => j.shotId === shot.id && j.status === 'submission_unknown')) { notify(msg('shell.generationBillingUnknown'), 'error'); openTasks(); return false; }
    return true;
  }
  const submitGeneration = async ({ shot, providerId, model, scenario, inputMode, retryJobId, subjectReference, expectedRetrySnapshot }) => {
    const canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false);
    const provider = providers.find(item => item.id === providerId);
    if (!checkGeneration(shot, provider, model, inputMode, Boolean(retryJobId), subjectReference)) return;
    if (retryJobId && shot.subjectReference) {
      if (!expectedRetrySnapshot || subjectVideoIdentity(expectedRetrySnapshot.subjectReference) !== subjectVideoIdentity(shot.subjectReference)) { notify(msg('shell.error.retrySnapshotChanged'), 'warning'); return; }
      return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, msg('shell.retryCreated'), { subjectRetry: true, expectedSubjectReference: expectedRetrySnapshot.subjectReference, expectedRetrySnapshot });
    }
    if (retryJobId) return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, msg('shell.retryCreated'));
    const result = await run(`generate:${shot.id}`, 'generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: requestId(), providerId, ...(model ? { model } : {}), ...(providerId === 'mock' ? { parameters: { scenario } } : {}), ...(subjectReference ? { subjectVersionId: subjectReference.subjectVersionId } : {}) }, undefined, subjectReference ? { expectedSubjectReference: subjectReference } : {});
    if (result) { notify(result.status === 'submission_unknown' ? msg('shell.generationUnconfirmed') : msg('shell.generationSubmitted'), result.status === 'submission_unknown' ? 'warning' : 'success'); openTasks(canRevealTasks); }
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
    if (stale) { notify(msg('shell.generationInputsChanged'), 'warning'); return; }
    submitGeneration(args);
  }
  async function createProject(name, description) {
    if (nativeWindow) { void nativeProjectEntry?.show('new'); return false; }
    if (projectCreateFlight.current) return false;
    if (nativeWindow && !editorInputs.current.canCreateProject()) { notify(msg('projects.previousCreateKeep'), 'warning'); return false; }
    const flight = {}; projectCreateFlight.current = flight;
    let nativeCreate = null;
    const captured = context(), lifetime = importSession.current.selection;
    const alive = () => importSession.current.active && importSession.current.selection === lifetime;
    const current = () => alive() && isCurrent(captured);
    markBusy(captured.projectId, 'project-create-flow', true);
    try {
      const settingsTicket = await prepareSettingsDeparture();
      const settingsCurrent = () => current() && settingsTicket && settingsNavigation.current.canLeave(settingsTicket);
      if (!settingsCurrent() || !await guardProjectNavigation(msg('shell.confirm.createProject'), false, settingsCurrent) || !settingsCurrent()) return false;
      if (nativeWindow) { nativeCreate = editorInputs.current.beginProjectCreate(captured.projectId); if (!nativeCreate) return false; }
      const created = await run('project-create', 'project.create', { name, description }, ...(nativeCreate ? [undefined, {
        validateResponse: result => editorInputs.current.validateProjectCreate(nativeCreate, result, name, description),
        onFailure: (_error, outcome) => editorInputs.current.failProjectCreate(nativeCreate, outcome),
      }] : []));
      if (!created || !current()) return false;
      try {
        const list = await rpc('project.list'); if (!current()) return false;
        setProjects(list); setShowCreate(false);
        const accepted = await selectProject(created.id);
        if (accepted && alive() && currentProject.current === created.id) notify(msg('projects.createdImportHint'));
        return accepted;
      } catch (error) {
        if (current()) {
          if (projectOpenFailureKind(error) === 'auth') setAuth(false);
          setProjectListStatus({ busy: false, error: msg('projects.maybeCreated') }); notify(readableError(error), 'error');
        }
        return false;
      }
    } finally {
      if (nativeCreate) editorInputs.current.finishProjectCreate(nativeCreate);
      if (projectCreateFlight.current === flight) projectCreateFlight.current = null;
      if (alive()) markBusy(captured.projectId, 'project-create-flow', false);
    }
  }
  async function addShot() {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation(msg('shell.confirm.createShot'))) return;
    const state = dataRef.current, count = state.shots.length;
    const shot = await run('shot-create', 'shot.create', { projectId: state.project.id, title: t('projects.default.shot', { number: String(count + 1).padStart(2, '0') }), prompt: '', duration: 2, aspectRatio: '9:16', referenceAssetIds: [], position: { x: 350 + (count % 3) * 330, y: Math.floor(count / 3) * 430 + 80 } });
    if (shot && await inspect(shot.id)) revealCanvas(shot.id);
  }
  async function addStructure() {
    const owner = data.project?.id;
    if (!owner || owner !== currentProject.current || dataRef.current.project?.id !== owner || dataRef.current.shots.length || dataRef.current.nodes.length || isBusy('structure')) return;
    if (!await guardNavigation(msg('shell.confirm.createStructure'))) return;
    if (owner !== currentProject.current || dataRef.current.project?.id !== owner || dataRef.current.shots.length || dataRef.current.nodes.length || isBusy('structure')) return;
    const captured = context(), state = dataRef.current, projectId = state.project.id;
    markBusy(projectId, 'structure', true);
    const base = state.shots.length, firstImage = state.assets.find(a => a.mimeType.startsWith('image/'));
    let done = 0;
    try {
      for (const [i, title] of [t('projects.default.establish'), t('projects.default.develop'), t('projects.default.resolve')].entries()) {
        if (!isCurrent(captured)) return;
        const created = await run('shot-create', 'shot.create', { projectId, title: `${String(base + i + 1).padStart(2, '0')} · ${title}`, prompt: '', referenceAssetIds: firstImage ? [firstImage.id] : [], duration: 2, aspectRatio: '9:16', position: { x: 100 + i * 340, y: 130 } });
        if (!created) { if (isCurrent(captured)) notify(msg('projects.structureStopped', { count: done }), 'warning'); return; }
        done++;
      }
      const next = await refresh(projectId);
      if (isCurrent(captured) && next) { const first = next.shots.find(shot => shot.orderIndex === base); if (first && await inspect(first.id)) revealCanvas(); notify(msg('projects.structureReady')); }
    } catch (e) { if (isCurrent(captured)) notify(readableError(e), 'error'); await refresh(projectId); } finally { markBusy(projectId, 'structure', false); }
  }
  async function addNode(type, asset, dropPosition) {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation(msg('shell.confirm.addCanvas'))) return;
    const state = dataRef.current;
    if (type !== 'text' && !asset) { asset = state.assets.find(a => a.mimeType.startsWith(`${type}/`)); if (!asset) { notify(msg(type === 'image' ? 'assets.importImageFirst' : type === 'audio' ? 'assets.importAudioFirst' : 'assets.importVideoFirst'), 'warning'); fileInput.current?.click(); return; } }
    const saved = viewRef.current.canvas.viewport;
    const location = dropPosition || (workspaceMode === 'canvas' ? flow.screenToFlowPosition({ x: window.innerWidth * .43, y: window.innerHeight * .35 }) : { x: saved ? (300 - saved.x) / saved.zoom : 100, y: saved ? (200 - saved.y) / saved.zoom : 100 });
    const node = await run('node-create', 'node.create', { projectId: state.project.id, type, label: type === 'text' ? t('projects.default.note') : asset.name, ...(type === 'text' ? { text: '' } : { assetId: asset.id }), position: location });
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
    let done = 0, dispatched = false, nativeImport = null;
    try {
      for (const file of batch) {
        if (!ownsSelection()) return;
        dispatched = false;
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'].includes(file.type)) throw localizedError(msg('assets.unsupportedImport'));
        if (file.size > 30 * 1024 * 1024) throw localizedError(msg('assets.importTooLarge'));
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string' || !result.includes(',')) return reject(localizedError(msg('shell.error.fileContent')));
            resolve(result.slice(result.indexOf(',') + 1));
          };
          reader.onerror = () => reject(localizedError(msg('shell.error.fileAccess')));
          reader.onabort = () => reject(localizedError(msg('shell.error.fileAborted')));
          reader.readAsDataURL(file);
        });
        if (!ownsSelection()) return;
        const input = { projectId, name: file.name, mimeType: ({ 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4' }[file.type] || file.type), dataBase64: base64 };
        dispatched = true;
        if (captured.workspace) assertWorkspaceOperation(captured.workspace, 'asset.import');
        if (nativeWindow) nativeImport = editorInputs.current.beginImport(projectId);
        const asset = await rpc('asset.import', input, invocation);
        if (!importAcknowledged(asset, input)) throw localizedError(msg('shell.error.importAcknowledgement'));
        editorInputs.current.finishImport(nativeImport, false); nativeImport = null;
        done++;
      }
      if (ownsSelection()) notify(importFeedback(batch, done));
    } catch (error) {
      const kind = !dispatched ? 'local' : error?.definitive === true && error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown';
      editorInputs.current.finishImport(nativeImport, kind === 'unknown'); nativeImport = null;
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
      connected: workbenchReady && online && auth === true && !loading,
      busy: legacyPending || isBusy('canvas:mutation') || isBusy('reference:mutation') || tasksRef.current.blocked(projectId, 'reference:mutation'),
      executionEpoch: `${navigationEpoch.current}:${panelIntent.current}`,
    };
  }
  async function saveShot(shotId, expectedRevision, patch) {
    if (referenceWorkBlocked()) return null;
    return run(`save:${shotId}`, 'shot.update', { shotId, expectedRevision, patch }, msg('projects.shotSaved'), { returnAfterNavigation: true });
  }
  async function saveNode(nodeId, expectedRevision, patch) { return run(`save:${nodeId}`, 'node.update', { nodeId, expectedRevision, patch }, msg('projects.nodeSaved'), { returnAfterNavigation: true }); }
  async function savePosition(_, node) {
    const snapshot = dataRef.current;
    const record = snapshot.shots.find(s => s.id === node.id) || snapshot.nodes.find(n => n.id === node.id);
    if (record) await run(`position:${node.id}`, snapshot.shots.some(s => s.id === node.id) ? 'shot.update' : 'node.update', { [snapshot.shots.some(s => s.id === node.id) ? 'shotId' : 'nodeId']: record.id, expectedRevision: record.revision, patch: { position: node.position } });
    dragging.current = false;
  }
  function referenceWorkBlocked() {
    if (shotTextRef.current?.blocksLegacy()) { notify(msg('shell.shotTextPending'), 'warning'); return true; }
    if (tasksRef.current.blocked(currentProject.current, 'reference:mutation')) { notify(msg('shell.referenceRecoveryPending'), 'warning'); openTasks(); return true; }
    if (pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => isMutationOperation(entry.operation))) { notify(msg('shell.projectEditPending'), 'warning'); openTasks(); return true; }
    if (isBusy('reference:mutation')) { notify(msg('shell.referenceSyncing'), 'warning'); return true; }
    if (hasPendingReference(pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }))) { notify(msg('shell.referencePending'), 'warning'); openTasks(); return true; }
    return false;
  }
  async function attachReference(sourceNodeId, targetShotId) {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify(msg('shell.referenceSaveBeforeConnect'), 'warning'); return null; }
    const state = dataRef.current;
    const source = state.nodes.find(node => node.id === sourceNodeId);
    const shot = state.shots.find(item => item.id === targetShotId);
    const issue = referenceAttachIssueDescriptor({ source, shot, assets: state.assets, edges: state.edges, projectId: state.project?.id });
    if (issue) { notify(issue, 'warning'); return null; }
    return run('reference:mutation', 'reference.attach', { projectId: state.project.id, sourceNodeId, targetShotId, expectedSourceRevision: source.revision, expectedShotRevision: shot.revision, requestId: requestId(), role: 'first_frame' }, msg('shell.referenceConnected'));
  }
  async function detachReference(edgeId) {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify(msg('shell.referenceSaveBeforeDisconnect'), 'warning'); return null; }
    const state = dataRef.current;
    const edge = state.edges.find(item => item.id === edgeId && isReferenceEdge(item));
    const shot = state.shots.find(item => item.id === edge?.target);
    if (!edge || !shot) { await refresh(); return null; }
    if (!await confirm(msg('shell.confirm.disconnectReference', { name: shot.title }))) return null;
    if (currentProject.current !== state.project.id || referenceWorkBlocked()) return null;
    return run('reference:mutation', 'reference.detach', { projectId: state.project.id, edgeId, expectedShotRevision: shot.revision, requestId: requestId() }, msg('shell.referenceDisconnected'));
  }
  async function connect(connection) {
    if (connection.source === connection.target) return notify(msg('shell.differentNodes'), 'warning');
    if (connection.sourceHandle === REFERENCE_SOURCE_HANDLE || connection.targetHandle === REFERENCE_TARGET_HANDLE) {
      if (connection.sourceHandle !== REFERENCE_SOURCE_HANDLE || connection.targetHandle !== REFERENCE_TARGET_HANDLE) return notify(msg('shell.referencePortHint'), 'warning');
      return attachReference(connection.source, connection.target);
    }
    await run(`edge:${connection.source}:${connection.target}`, 'edge.create', { projectId: dataRef.current.project.id, source: connection.source, target: connection.target }, msg('shell.visualLinkAdded'));
  }
  function beforeDeleteEdges({ edges: removed }) {
    const selected = removed.filter(edge => edge.id === selectedEdgeId);
    if (selected.some(edge => isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id)))) notify(msg('shell.referenceDisconnectHint'), 'warning');
    return Promise.resolve({ nodes: [], edges: selected.filter(edge => !isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id))) });
  }
  async function selectVersion(shot, versionId) { return run(`version:${shot.id}`, 'version.select', { shotId: shot.id, versionId, expectedRevision: shot.revision }, msg('projects.versionUpdated')); }
  async function reorder(id, targetIndex) {
    const ordered = [...dataRef.current.shots].sort((a, b) => a.orderIndex - b.orderIndex); const from = ordered.findIndex(s => s.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ordered.length || from === targetIndex) return;
    ordered.splice(targetIndex, 0, ordered.splice(from, 1)[0]);
    await run('reorder', 'shot.reorder', { projectId: data.project.id, expectedRevision: dataRef.current.project.revision, shotIds: ordered.map(s => s.id) }, msg('projects.storyboardReordered'));
  }
  function readTaskRevealContext() {
    return { active: importSession.current.active && projectSessionReady() && viewReady.current && taskWorkspaceState.current?.connected === true,
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
      guard: canNavigate => guardNavigation(msg('shell.confirm.viewTaskShot'), false, canNavigate),
      reveal: selected => {
        navigationEpoch.current++;
        updateView('canvas', { selectedId: selected.shotId, inspectorTab: selected.tab, highlightedVersionId: null });
        updateView('activeMode', 'canvas'); setPropertiesPage('inspector'); setRightDockTab('properties');
        setPanelOpen('inspector', true, 'canvas');
      },
    });
  }
  function openExportHistory() { setShowExports(true); setRightDockTab('delivery'); setPanelOpen('inspector', true); }
  async function createExport() { const panelChoice = panelIntent.current, projectId = currentProject.current; const result = await run('export', 'export.create', { projectId: data.project.id, requestId: requestId() }); if (result) { if (panelChoice === panelIntent.current && projectId === currentProject.current) openExportHistory(); notify(msg('shell.storyboardExportCreated')); } }
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
    return { active: importSession.current.active && projectSessionReady() && viewReady.current, projectId, projectEpoch: projectEpoch.current,
      navigationEpoch: navigationEpoch.current, panelIntent: panelIntent.current, attempt: assetUsageAttempt.current, workspaceScope: workspaceOriginScope(workspaceRef.current),
      usage: deriveTimelineAssetUsage({ projectId, assets: snapshot.assets, timeline: snapshot.timeline,
        ready: assetUsageAvailability.current?.ready && snapshot.project?.id === projectId && !isBusy('timeline:mutation') }) };
  }
  async function locateAssetUse(use, isStillVisible = () => true) {
    assetUsageAttempt.current++;
    return locateTimelineAssetUse(use, { read: readAssetUsageNavigation, isVisible: isStillVisible,
      confirm: canDiscard => guardNavigation(msg('shell.confirm.locateClip'), false, canDiscard),
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
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: projectSessionReady() && snapshot.project?.id === projectId ? projectId : null,
      projectRevision: snapshot.project?.revision, timelineId: snapshot.timeline?.id || null, timelineRevision: snapshot.timeline?.revision || 0,
      connected: workbenchReady && online && auth === true && !loading,
      pending: !projectId || tasksRef.current.blocked(projectId) || pendingForProject(projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || entry.operation.startsWith('timeline.')) };
  }
  async function saveTimelineFormat(intent) {
    const live = timelineFormatContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || !live.connected || live.pending || !isDurableEditOperation('timeline.format.set')) return { status: 'rejected' };
    let failure, acknowledged;
    const result = await runDurable('timeline:mutation', 'timeline.format.set', intent.input, msg('shell.timelineFormatSaved'), {
      returnAfterNavigation: true, canExecute: () => intent.scope === timelineFormatContext().scope,
      validateResponse: value => { if (!timelineFormatAcknowledged(intent, value)) throw Object.assign(localizedError(msg('shell.error.formatAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    return { status: tasksRef.current.blocked(intent.projectId) || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  }
  const timelineFormat = useTimelineFormat({ ...timelineFormatContext(), getContext: timelineFormatContext,
    visible: workbenchReady && propertiesPage === 'format' && rightDockTab === 'properties' && panelVisible('inspector'),
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
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: projectSessionReady() && snapshot.project?.id === projectId ? projectId : null, timeline: snapshot.timeline,
      connected: workbenchReady && online && auth === true && !loading, pending: !projectId || isBusy('timeline:mutation') || tasksRef.current.blocked(projectId, 'timeline:mutation') || pendingForProject(projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      visible: workbenchReady && workspaceMode === 'editing' && propertiesPage === 'subtitle' && rightDockTab === 'properties' && panelVisible('inspector') };
  }
  async function saveSubtitle(intent) {
    const live = subtitleContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || intent.timelineId !== live.timeline?.id || intent.input.expectedRevision !== live.timeline?.revision || !live.connected || live.pending || !live.visible || !isDurableEditOperation(intent.operation)) return { status: 'rejected' };
    let failure, acknowledged;
    const result = await runDurable('timeline:mutation', intent.operation, intent.input, msg('shell.subtitleSaved'), {
      returnAfterNavigation: true, canExecute: () => intent.scope === subtitleContext().scope && subtitlesRef.current?.controller.isVisible() && intent.selection === subtitlesRef.current?.controller.getState().selection,
      validateResponse: value => { if (!subtitleAcknowledged(intent, value)) throw Object.assign(localizedError(msg('shell.error.subtitleAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
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
    if (!sameSelection && (selected.submitting || selected.uncertain)) { notify(msg('shell.subtitlePending'), 'warning'); openTasks(); return; }
    if (!sameSelection && selected.dirty) {
      if (!await confirm(msg('shell.confirm.changeSubtitle'))) return;
      if (!isCurrent(captured) || panelChoice !== panelIntent.current || controller.getState() !== selected) return;
      controller.discardDraft(selected.scope);
    }
    if (!isCurrent(captured) || panelChoice !== panelIntent.current) return;
    if (!sameSelection && !(cueId ? controller.select(cueId, selected.scope) : controller.begin(frame, selected.scope))) return;
    setPropertiesPage('subtitle'); setRightDockTab('properties'); setPanelOpen('inspector', true);
  }
  function clipReplacementContext() {
    const state = dataRef.current, editing = viewRef.current.editing;
    return { scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: projectSessionReady() && state.project?.id === currentProject.current ? currentProject.current : null,
      timeline: state.timeline, clipId: editing.selectedClipId, assets: state.assets, versions: state.versions, shots: state.shots,
      dirty: dirtyRef.current, busy: isBusy('timeline:mutation'), pending: tasksRef.current.blocked(currentProject.current, 'timeline:mutation') || pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      connected: workbenchReady && online && auth === true && !loading, visible: projectSessionReady() && viewRef.current.activeMode === 'editing' && !editing.quickAssetId };
  }
  async function replaceTimelineClipSource(review) {
    // UI candidate metadata cannot authorize a mutation. Recheck the exact
    // reviewed owner, revision, content and draft against live App refs.
    const issue = clipReplacementReviewIssue(review, clipReplacementContext());
    if (issue) return { status: 'rejected', error: { code: 'REVISION_CONFLICT' } };
    let failure, acknowledged;
    const result = await mutateTimeline('timeline.clip.replaceSource', review.input, review.expectedRevision, {
      returnAfterNavigation: true, onFailure: (error, details) => { failure = { error, ...details }; }, errorMessage: clipReplacementErrorDescriptor,
      validateResponse: value => { if (!clipReplacementAcknowledged(review, value)) throw Object.assign(localizedError(msg('shell.error.replacementAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
    });
    // A failed refresh cannot erase an already validated mutation receipt.
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    const unresolved = tasksRef.current.blocked(review.projectId, 'timeline:mutation') || pendingForProject(review.projectId, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:mutation');
    return { status: unresolved || (failure?.dispatched && !failure.rejected) ? 'unknown' : 'rejected', error: failure?.error };
  }
  function exportSettingsContext() {
    return { scope: `${currentProject.current}:${projectEpoch.current}`, enabled: Boolean(projectSessionReady() && dataRef.current.project?.id === currentProject.current && online && auth === true && !loading && !isBusy('timeline:render:export') && !pendingForProject(currentProject.current, { workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) };
  }
  const exportSettings = useExportSettings({ ...exportSettingsContext(), getContext: exportSettingsContext });
  exportSettingsRef.current = exportSettings.controller;
  function exportRangeContext() {
    const base = exportSettingsContext(), local = localDeliveryRef.current?.controller.getState();
    return { ...base, enabled: base.enabled && rightDockTab === 'delivery' && !showExports && panelVisible('inspector') && !(local?.scope === base.scope && (local.busy || local.pending)),
      projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id || null, revision: dataRef.current.timeline?.revision || null,
      durationFrames: dataRef.current.timeline?.durationFrames ?? null };
  }
  const exportRange = useExportRange({ ...exportRangeContext(), getContext: exportRangeContext });
  exportRangeRef.current = exportRange.controller;
  function deliveryNameContext() { return { ...exportSettingsContext(), projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null }; }
  const deliveryName = useTimelineDeliveryName({ ...deliveryNameContext(), getContext: deliveryNameContext });
  deliveryNameRef.current = deliveryName;
  function localDeliveryContext() {
    const scope = `${currentProject.current}:${projectEpoch.current}`;
    return { scope, projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id || null, timelineRevision: dataRef.current.timeline?.revision || null,
      restored: Boolean(workspaceRef.current?.restored), connected: workbenchReady && online && auth === true && !loading,
      visible: workbenchReady && rightDockTab === 'delivery' && !showExports && panelVisible('inspector'), busy: isBusy('timeline:render:export'),
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
    return { scope: `${currentProject.current}:${projectEpoch.current}`, projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current.timeline?.id, revision: dataRef.current.timeline?.revision, connected: workbenchReady && online && auth === true && !loading,
      exportSettings: exportSettings.controller.getSettings(`${currentProject.current}:${projectEpoch.current}`), settingsVersion: exportSettings.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      exportRange: exportRange.controller.getRange(`${currentProject.current}:${projectEpoch.current}`), rangeVersion: exportRange.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      deliveryName: deliveryName.controller.getName(`${currentProject.current}:${projectEpoch.current}`), deliveryNameVersion: deliveryName.controller.getVersion(`${currentProject.current}:${projectEpoch.current}`) };
  }
  const exportCheckView = exportCheckContext();
  const exportPreflight = useExportPreflight({ ...exportCheckView, getContext: exportCheckContext, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), visible: workbenchReady && rightDockTab === 'delivery' && !showExports && panelVisible('inspector'),
    read: (input, options) => rpc('timeline.export.preflight', input, options),
    readCapabilities: (input, options) => rpc('timeline.export.capabilities', input, options), onUnauthorized: () => setAuth(false) });
  const canOpenExport = Boolean(data.project && timeline?.id && !loading);
  const canCheckExport = Boolean(canOpenExport && Number.isSafeInteger(timeline.revision) && timeline.revision > 0 && online && auth === true && !deliveryName.error && !exportRange.error && (restored || !localDelivery.state.baselineConflict && !localDelivery.state.candidate));
  const pendingTimelineExport = activePending.some(entry => entry.key === 'timeline:render:export') || (!restored && localDelivery.state.pending);
  const [exportPreviewAttempt, setExportPreviewAttempt] = useState(null);
  const [sampleRangeDraft, setSampleRangeDraft] = useState(null);
  function sampleExportContext() {
    const base = exportCheckContext(), draft = sampleRangeDraft?.scope === base.scope ? sampleRangeDraft : null;
    const range = draft && /^\d+$/.test(draft.startText) && /^\d+$/.test(draft.endText) ? { startFrame: Number(draft.startText), endFrame: Number(draft.endText) } : null;
    return { ...base, exportRange: isExportPreviewRange(range, dataRef.current.timeline?.durationFrames) ? range : null, rangeVersion: draft?.version || 0 };
  }
  function sampleExportContextKey() { return exportPreviewContextKey({ ...sampleExportContext(), scope: `${exportCheckContext().scope}:${workspaceOriginScope(workspaceRef.current)}` }, dataRef.current.timeline, dataRef.current.assets); }
  function chooseSampleExportRange(draft) {
    if (!exportRangeContext().enabled || localDelivery.state.busy || pendingTimelineExport) return;
    setSampleRangeDraft(previous => ({ ...draft, scope: exportCheckContext().scope, version: (previous?.version || 0) + 1 }));
  }
  function selectSampleExportRange() {
    const range = suggestedExportPreviewRange(dataRef.current.timeline?.durationFrames, viewRef.current.editing.playhead, exportRange.value);
    if (range) chooseSampleExportRange({ startText: String(range.startFrame), endText: String(range.endFrame) });
  }
  const sampleExportView = sampleExportContext();
  const sampleExportPreflight = useExportPreflight({ ...sampleExportView, getContext: sampleExportContext, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), visible: workbenchReady && rightDockTab === 'delivery' && !showExports && panelVisible('inspector'),
    read: (input, options) => rpc('timeline.export.preflight', input, options),
    readCapabilities: (input, options) => rpc('timeline.export.capabilities', input, options), onUnauthorized: () => setAuth(false) });
  function clipLoudnessContext() {
    const saved = dataRef.current.timeline, workspaceScope = workspaceOriginScope(workspaceRef.current), editing = viewRef.current.editing;
    return { ...savedClipLoudnessFields(saved, dataRef.current.assets, editing.selectedClipId),
      scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${clipLoudnessEpoch.current}:${inspectorEpoch}`,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current.assets),
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && viewRef.current.activeMode === 'editing' && !editing.quickAssetId && rightDockTab === 'properties' && propertiesPage === 'inspector' && panelVisible('inspector') && !previewAssetRef.current && !comparisonIdRef.current && !webSettingsOpen,
      restored: workspaceRef.current?.restored === true,
      hasUnsavedDrafts: inspectorDirty || formatDirty || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate || subtitlesRef.current?.controller.hasUnsaved() || timelineFormatRef.current?.controller.hasUnsaved()),
      pending: timelineBusy || isBusy('timeline:mutation') };
  }
  function timelineMixLoudnessContext() {
    const workspaceScope = workspaceOriginScope(workspaceRef.current), saved = dataRef.current.timeline;
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: saved?.id || null, revision: saved?.revision || null, durationFrames: saved?.durationFrames || 0,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current.assets),
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${viewRef.current.activeMode}`,
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && rightDockTab === 'delivery' && !showExports && panelVisible('inspector'),
      restored: workspaceRef.current?.restored === true,
      hasUnsavedDrafts: clipDirty || subtitleDirty || formatDirty || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate || subtitlesRef.current?.controller.hasUnsaved() || timelineFormatRef.current?.controller.hasUnsaved()),
      pending: timelineBusy || isBusy('timeline:mutation') };
  }
  const timelineMixLoudness = useTimelineMixLoudness({ context: timelineMixLoudnessContext(), getContext: timelineMixLoudnessContext,
    getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input, options) => rpc('timeline.loudness.prepare', input, options), onUnauthorized: () => setAuth(false) });
  const nativePreviewPause = useRef(null), exportPreviewPause = useRef(null), comparisonPreviewPause = useRef(null);
  const registerComparisonPreviewPause = useCallback(pause => { comparisonPreviewPause.current = pause; return () => { if (comparisonPreviewPause.current === pause) comparisonPreviewPause.current = null; }; }, []);
  function setComparisonId(id) {
    if (id && (!projectSessionReady() || dataRef.current.project?.id !== currentProject.current ||
      dataRef.current.shots.filter(shot => shot.id === id && shot.projectId === currentProject.current).length !== 1)) return;
    clipLoudnessEpoch.current++;
    comparisonIdRef.current = id;
    comparisonPreviewPause.current?.();
    if (id) { audioPreview.controller.revoke(); nativePreviewPause.current?.(); exportPreviewPause.current?.(); }
    updateComparisonId(id);
  }
  function comparisonContext() {
    const state = dataRef.current, workspaceScope = workspaceOriginScope(workspaceRef.current);
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: currentProject.current, workspaceOrigin: workspaceScope,
      connected: projectSessionReady() && state.project?.id === currentProject.current && online && auth === true && !loading,
      visible: Boolean(comparisonIdRef.current && workbenchReady && !webSettingsOpen), restored: workspaceRef.current?.restored === true,
      shot: state.shots.find(shot => shot.id === comparisonIdRef.current) || null, versions: state.versions, assets: state.assets };
  }
  function useComparedVersion(binding) {
    const current = comparisonContext();
    if (!comparisonCurrent(binding, current) || isBusy(`version:${binding.shotId}`)) return;
    return selectVersion(current.shot, binding.versionId);
  }
  function beforeMainPreviewPlay() {
    if (comparisonIdRef.current) { nativePreviewPause.current?.(); return; }
    comparisonPreviewPause.current?.(); exportPreviewPause.current?.();
  }
  function beforeExportPreviewPlay() {
    if (comparisonIdRef.current) { exportPreviewPause.current?.(); return; }
    comparisonPreviewPause.current?.(); audioPreview.controller.revoke(); nativePreviewPause.current?.();
  }
  function beforeTimelineAudioPlay() {
    if (comparisonIdRef.current) { audioPreview.controller.revoke(); return; }
    comparisonPreviewPause.current?.(); exportPreviewPause.current?.(); nativePreviewPause.current?.();
  }
  const registerExportPreviewPause = useCallback(pause => { exportPreviewPause.current = pause; return () => { if (exportPreviewPause.current === pause) exportPreviewPause.current = null; }; }, []);
  const registerNativePreviewPause = useCallback(pause => { nativePreviewPause.current = pause; return () => { if (nativePreviewPause.current === pause) nativePreviewPause.current = null; }; }, []);
  function soundAuditionContext() {
    const workspaceScope = workspaceOriginScope(workspaceRef.current), saved = dataRef.current.timeline, editing = viewRef.current.editing;
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      executionScope: `${navigationEpoch.current}:${viewRef.current.activeMode}:${editing.previewKind}:${editing.selectedClipId}:${editing.quickAssetId}`,
      projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: saved?.id || null, revision: saved?.revision || null, durationFrames: saved?.durationFrames || 0,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current.assets),
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && workspaceMode === 'editing' && previewKind === 'timeline' && panelVisible('canvas') && !previewAsset && !comparisonIdRef.current,
      restored: workspaceRef.current?.restored === true, hasUnsavedDrafts: clipDirty || subtitleDirty || formatDirty || Boolean(clipDraftRef.current?.getState().candidate) };
  }
  const audioPreview = useTimelineAudioPreview({ ...(nativeAudioAdmission ? { nativeAdmission: nativeAudioAdmission } : {}), context: soundAuditionContext(), getContext: soundAuditionContext,
    readPlan: (input, options) => rpc('timeline.audioPreview.plan', input, options),
    readContinuousPlan: (input, options) => rpc('timeline.audioPreview.continuousPlan', input, options),
    getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), onUnauthorized: () => setAuth(false),
    onExplicitPosition: setPlayhead, onBeforePlay: beforeTimelineAudioPlay });
  function readTimelineLoudnessRecoveryScope() {
    return timelineLoudnessApplyRecoveryScope(lastProjectRef.current.getState().identityBlocked ? null : preferenceScope.current, workspaceOriginScope(workspaceRef.current));
  }
  const timelineLoudnessApply = useTimelineLoudnessApply({
    nativeCloseRegistry: nativeCloseRegistry.current,
    getRecoveryScope: readTimelineLoudnessRecoveryScope,
    getObservation: () => timelineMixLoudnessViewState(timelineMixLoudness.controller.getState(), timelineMixLoudnessContext()),
    confirm, createRequestId: requestId,
    submit: (intent, canExecute) => submitTimelineLoudnessApply(intent, canExecute, {
      mutate: mutateTimeline, isDurable: isDurableEditOperation,
      isPending: projectId => tasksRef.current.blocked(projectId, 'timeline:mutation'), acknowledged: isTimelineMutationResponse,
    }),
  });
  timelineLoudnessApplyRef.current = timelineLoudnessApply;
  const effectivePlayhead = timelineAudioPreviewPosition(audioPreview, playhead);
  const seekTimelineSound = frame => seekTimelineAudioPreview(audioPreview, frame, setPlayhead);
  function exportSamplePeakContext() {
    const workspaceScope = workspaceOriginScope(workspaceRef.current);
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current.project?.id === currentProject.current ? currentProject.current : null,
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${viewRef.current.activeMode}`,
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && rightDockTab === 'delivery' && showExports && panelVisible('inspector'), restored: workspaceRef.current?.restored === true,
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
  const exportLoudness = useExportLoudness({ context: exportSamplePeakContext(), getContext: exportSamplePeakContext,
    isRenderRecord: isTimelineRenderRecord, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input, options) => rpc('timeline.export.loudness', input, options), onUnauthorized: () => setAuth(false) });
  function openTimelineExport() {
    setShowExports(false); setRightDockTab('delivery'); setPanelOpen('inspector', true);
    exportPreflight.controller.setVisible(true);
    // Opening is passive. Only the explicit Check action runs capability/media work.
  }
  const historyState = timelineHistoryState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading });
  const splitState = timelineSplitState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : selectedClipId, playhead: effectivePlayhead, mode: workspaceMode });
  async function splitTimelineClip() {
    if (currentProject.current !== dataRef.current.project?.id) return null;
    const latest = timelineSplitState({ projectId: currentProject.current, timeline: dataRef.current.timeline, history: dataRef.current.timelineHistory, busy: isBusy('timeline:mutation'), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : viewRef.current.editing.selectedClipId, playhead: timelineAudioPreviewPosition(audioPreview, viewRef.current.editing.playhead), mode: viewRef.current.activeMode });
    if (!latest.canSplit) return null;
    audioPreview.controller.revoke();
    const result = await mutateTimeline('timeline.clip.split', { clipId: latest.clipId, atFrame: latest.atFrame });
    if (result) notify(msg('shell.clipSplit', { frame: latest.atFrame, left: latest.leftDuration, right: latest.rightDuration }));
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
      const guards = { modalOpen: hasOpenWorkbenchModal(document) };
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
    if (tasksRef.current.blocked(currentProject.current, 'timeline:mutation') || timelinePending) { notify(msg('shell.timelinePending'), 'warning'); openTasks(); return null; }
    return run('timeline:mutation', operation, { projectId: currentProject.current, expectedRevision: expectedRevision ?? dataRef.current.timeline.revision, requestId: requestId(), ...input }, undefined, options);
  }
  async function selectClip(id, showPreview = true) {
    const captured = context(), panelChoice = panelIntent.current, timelineId = dataRef.current.timeline?.id, timelineRevision = dataRef.current.timeline?.revision;
    const canDiscard = () => isCurrent(captured) && panelChoice === panelIntent.current && timelineId === dataRef.current.timeline?.id && timelineRevision === dataRef.current.timeline?.revision && dataRef.current.timeline?.clips.some(clip => clip.id === id);
    if ((id !== selectedClipId || quickAssetId || workspaceMode !== 'editing' || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation(msg('shell.confirm.changeClip'), false, canDiscard)) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === id); if (!canDiscard() || !clip) return;
    setPropertiesPage('inspector');
    navigationEpoch.current++;
    leaveReferencePage();
    updateView('editing', { selectedClipId: id, quickAssetId: null, playhead: clip.startFrame, ...(showPreview ? { previewKind: 'source' } : {}) });
    updateView('activeMode', 'editing'); setMobilePanel('canvas');
  }
  async function addTimelineAsset(assetId, trackId, startFrame, dropSnapshot) {
    const panelChoice = panelIntent.current;
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (!await guardNavigation(msg('shell.confirm.addTimeline'))) return;
    const state = dataRef.current, asset = state.assets.find(a => a.id === assetId), tl = state.timeline;
    if (!asset || !tl) return;
    const kind = assetKind(asset) === 'audio' ? 'audio' : 'video';
    const track = tl.tracks.find(t => t.id === trackId) || (!trackId && tl.tracks.find(t => t.kind === kind));
    if (!track || track.kind !== kind) { notify(msg(kind === 'audio' ? 'shell.needsAudioTrack' : 'shell.needsVideoTrack'), 'warning'); return; }
    const length = assetTimelineDuration(asset);
    if (!length.known) { notify(length.noteMessage, 'warning'); return; }
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
      notify(msg('shell.clipAdded'));
    }
  }
  async function returnToSource(assetId) {
    const source = sourceForAsset(dataRef.current, assetId); if (!source) return;
    if (source.shot) { if (await inspect(source.shot.id, 'versions', source.version.id, { reveal: true })) revealCanvas(source.shot.id); }
    else if (source.node) { if (await inspect(source.node.id, 'settings', null, { reveal: true })) revealCanvas(source.node.id); }
    else {
      if (!await guardNavigation(msg('shell.confirm.returnSource'))) return;
      navigationEpoch.current++; updateView('activeMode', 'canvas');
      updateView('shared', { assetSearch: source.asset.name, assetFilter: 'all' }); setPanelOpen('assets', true, 'canvas'); setMobilePanel('assets'); setPreviewAsset(source.asset);
    }
  }
  async function moveTimelineClip(clipId, trackId, startFrame, dropSnapshot) {
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (clipDirty && !await guardNavigation(msg('shell.confirm.moveClip'))) return;
    const clip = dataRef.current.timeline?.clips.find(c => c.id === clipId);
    const track = dataRef.current.timeline?.tracks.find(t => t.id === trackId);
    const asset = dataRef.current.assets.find(a => a.id === clip?.assetId);
    if (!clip || !track) return;
    if (track.kind !== (assetKind(asset) === 'audio' ? 'audio' : 'video')) { notify(msg('shell.compatibleTracks'), 'warning'); return; }
    const result = await mutateTimeline('timeline.clip.update', { clipId, patch: { trackId, startFrame } }, dropSnapshot?.expectedRevision);
    if (result) { setSelectedClipId(clipId); setPlayhead(startFrame); }
  }
  function renderUncheckedTimeline(intent) { return renderTimeline('export', null, intent); }
  async function renderTimeline(purpose, binding, uncheckedIntent, sample = false) {
    if (!dataRef.current.timeline?.clips.length) return;
    if (sample && (purpose !== 'export' || uncheckedIntent || dirtyRef.current || timelineFormatRef.current?.controller.hasUnsaved() || !isExportPreviewRange(sampleExportContext().exportRange, dataRef.current.timeline.durationFrames))) return;
    let exportInput;
    if (purpose === 'export') {
      const selectedPreflight = sample ? sampleExportPreflight : exportPreflight;
      selectedPreflight.controller.setContext(sample ? sampleExportContext() : exportCheckContext());
      if (isBusy('timeline:render:export')) return;
      // A saved receipt must be recovered explicitly from the task panel. A new
      // confirmation must never silently replay it or mint a second request.
      try {
        if (pendingForProject(currentProject.current, { strict: true, workspace: workspaceRef.current, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) {
          notify(msg('shell.exportPending'), 'warning'); openTasks(); return;
        }
      } catch { notify(msg('shell.exportRecordUnavailable'), 'error'); openTasks(); return; }
      if (!workspaceRef.current?.restored && !localDeliveryRef.current?.controller.canPrepare()) return;
      exportInput = uncheckedIntent ? selectedPreflight.controller.takeUncheckedExportIntent(uncheckedIntent) : selectedPreflight.controller.takeExportBinding(binding);
      if (!exportInput) return;
    }
    const deliveryPanelChoice = panelIntent.current, deliveryProjectId = currentProject.current, deliveryRangeVersion = exportCheckContext().rangeVersion;
    const deliveryCapture = purpose === 'export' ? deliveryNameRef.current?.controller.capture() : null;
    const input = { ...(exportInput || { projectId: currentProject.current, expectedRevision: dataRef.current.timeline.revision }), requestId: requestId(), purpose };
    const captured = context();
    const sampleContextKey = sample ? sampleExportContextKey() : null;
    if (sample) setExportPreviewAttempt({ scope: exportCheckContext().scope, timelineId: dataRef.current.timeline.id, contextKey: sampleContextKey, input: structuredClone(input), submitting: true, exportId: null, receipt: null });
    const result = purpose === 'export' && !workspaceRef.current?.restored
      ? await localDeliveryRef.current.controller.submit(input, { canExecute: () => isCurrent(captured) && (!sample || sampleContextKey === sampleExportContextKey()), nameCapture: deliveryCapture })
      : await run(`timeline:render:${purpose}`, 'timeline.render', input);
    if (sample) setExportPreviewAttempt(previous => previous?.input.requestId === input.requestId ? { ...previous, submitting: false, ...(result && isTimelineRenderRecord(result, input) ? { exportId: result.id, receipt: result } : {}) } : previous);
    if (result) { const matchingDelivery = !deliveryCapture || deliveryNameRef.current?.controller.acknowledge(deliveryCapture, result); if (purpose === 'preview') { updateView('activeMode', 'editing'); setPreviewKind('timeline'); } else if (!sample && matchingDelivery && deliveryPanelChoice === panelIntent.current && deliveryProjectId === currentProject.current && deliveryRangeVersion === exportCheckContext().rangeVersion) openExportHistory(); notify(purpose === 'preview' ? msg('shell.previewRendering') : msg('shell.timelineExportStarted')); }
  }
  async function previewSource(asset) {
    if (viewRef.current.activeMode === 'canvas') { setPreviewAsset(asset); return; }
    const owner = context();
    if ((viewRef.current.editing.quickAssetId !== asset.id || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation(msg('shell.confirm.changeSource'))) return;
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
    if (!plan.valid) { notify(plan.reasonMessage, 'warning'); return; }
    // Capture exact primitives before dispatch. Saving a different source range
    // later cannot change this request, its retry receipt, or existing clips.
    const result = await mutateTimeline('timeline.clip.add', { ...plan.input }, plan.expectedRevision);
    if (!result || !isCurrent(captured)) return;
    if (panelIntent.current === panelChoice) setPanelOpen('timeline', true, 'editing');
    notify(msg('shell.savedRangeAdded'));
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
  const gainBlockContext = { connected: workbenchReady && online && auth === true && !loading, dirty: inspectorDirty || formatDirty,
    recoveredDraft: agentClipDraftBlocked || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate), pending: timelineBusy };
  const gainBlockedReason = agentTimelineGainBlockedReason(gainBlockContext);
  const gainBlockedDescriptor = agentTimelineGainBlockedDescriptor(gainBlockContext);
  const agentTimelineBlockedDescriptor = !online || auth !== true || loading ? msg('shell.waitProjectLoad')
    : inspectorDirty ? msg('shell.saveBeforeMoveReview')
      : timelineBusy ? msg('shell.timelineBusy') : '';
  const agentTimelineBlockedReason = renderCoreMessage('zh-Hans', agentTimelineBlockedDescriptor);
  const chosenVersion = data.versions.find(v => v.id === chosenShot?.selectedVersionId);
  const sourceAsset = data.assets.find(a => a.id === (quickAssetId || chosenClip?.assetId));
  const clipSource = chosenClip && sourceForAsset(data, chosenClip.assetId);
  const rangeAsset = workspaceMode === 'editing' && quickAssetId ? sourceAsset : null;
  const rangeSelectionKey = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${quickAssetId || ''}:${inspectorEpoch}`;
  const rangeSelectionEpoch = useRef({ key: null, serial: 0 });
  if (rangeSelectionEpoch.current.key !== rangeSelectionKey) rangeSelectionEpoch.current = { key: rangeSelectionKey, serial: rangeSelectionEpoch.current.serial + 1 };
  const sourceRangeScope = `${rangeSelectionKey}:${rangeSelectionEpoch.current.serial}`;
  const sourceRanges = useSourceRange({ scope: sourceRangeScope, projectId: workbenchReady ? data.project?.id : null, asset: rangeAsset,
    read: input => rpc('asset.range.get', input),
    save: input => run(`source-range:${input.assetId}`, 'asset.range.set', input, msg('shell.sourceRangeSaved'), { returnAfterNavigation: true }),
    refreshGeneration: sourceRangeRefresh[`${data.project?.id}:${rangeAsset?.id}`] || 0, onDirtyChange: setSourceDirty });
  const sourceRangeBlocked = !online || loading || Boolean(busy['canvas:mutation'] || timelineBusy || activePending.some(entry => isMutationOperation(entry.operation)));
  const frameExtraction = useFrameExtraction({ projectId: workbenchReady ? data.project?.id : null, sourceScope: sourceRangeScope, sourceAsset: rangeAsset, assets: data.assets,
    visible: workbenchReady && workspaceMode === 'editing' && Boolean(quickAssetId && rangeAsset) && (panelVisible('canvas') || panelVisible('inspector') && rightDockTab === 'properties'),
    blocked: restored || sourceRangeBlocked || Object.values(busy).some(Boolean), rpc, createRequestId: requestId,
    onResult: projectId => { if (currentProject.current === projectId) void refresh(projectId); }, revealAsset: revealImageAsset });

  const dispositionScope = `${currentProject.current}:${projectEpoch.current}`;
  const dispositionBlocked = !online || loading || Boolean(busy['canvas:mutation'] || activePending.some(entry => isMutationOperation(entry.operation)));
  const dispositions = useAssetDispositions({ scope: dispositionScope, projectId: workbenchReady ? data.project?.id : null, assets: data.assets,
    read: input => rpc('asset.disposition.list', input),
    save: input => run(dispositionKey(input.assetId), 'asset.disposition.set', input, msg('shell.assetMarkSaved'), { returnAfterNavigation: true }),
    hasPending: projectId => pendingForProject(projectId, { strict: true, workspace: context().workspace || { restored: false }, activeOnly: true }).some(entry => isMutationOperation(entry.operation)),
    pendingState: activePending.some(entry => isMutationOperation(entry.operation)), blocked: dispositionBlocked, refreshGeneration: dispositionRefresh[data.project?.id] || 0 });
  const annotationScope = `${workspaceOriginScope(workspace)}:${currentProject.current}:${projectEpoch.current}`;
  const annotationBlocked = restored || !online || auth !== true || loading || dispositionBlocked;
  const annotations = useAssetAnnotations({ scope: annotationScope, ownerScope: JSON.stringify([workspaceOriginScope(workspace), currentProject.current]), projectId: workbenchReady ? data.project?.id : null, assets: data.assets,
    read: input => rpc('asset.annotation.list', input),
    save: async input => { let failure; const result = await run(annotationKey(input.assetId), 'asset.annotation.set', input, msg('annotations.savedToast'), { returnAfterNavigation: true, errorMessage: annotationError, onFailure: (error, outcome) => { failure = { error, ...outcome }; } }); return { result, failure }; },
    canSave: () => !annotationBlocked,
    hasPending: (projectId, assetId, ownerScope) => { const [origin] = JSON.parse(ownerScope); const ownerWorkspace = origin === 'normal' ? { restored: false } : typeof origin === 'string' && origin.startsWith('restored:') ? { restored: true, workspaceOrigin: origin.slice(9) } : null; return pendingForProject(projectId, { strict: true, workspace: ownerWorkspace, activeOnly: true }).some(entry => isMutationOperation(entry.operation) && (!assetId || entry.operation === 'asset.annotation.set' && entry.input.assetId === assetId)); },
    pendingAssetIds: (projectId, ownerScope) => { const [origin] = JSON.parse(ownerScope); const ownerWorkspace = origin === 'normal' ? { restored: false } : typeof origin === 'string' && origin.startsWith('restored:') ? { restored: true, workspaceOrigin: origin.slice(9) } : null; return pendingForProject(projectId, { strict: true, workspace: ownerWorkspace, activeOnly: true }).filter(entry => entry.operation === 'asset.annotation.set').map(entry => entry.input.assetId); },
    pendingState: activePending, refreshGeneration: annotationRefresh[data.project?.id] || 0, registry: nativeCloseRegistry.current });
  const subjectScope = `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`;
  const subjectBlocked = !online || loading || tasksRef.current.blocked(currentProject.current, 'subject:mutation');
  const subjects = useSubjects({ scope: subjectScope, projectId: workbenchReady ? data.project?.id : null, assets: data.assets, shotIds: data.shots.map(shot => shot.id),
    read: (operation, input) => rpc(operation, input),
    save: (operation, input, options) => runDurable('subject:mutation', operation, input, msg('shell.planningLinkSaved'), { ...options, returnAfterNavigation: true }),
    hasPending: projectId => tasksRef.current.blocked(projectId, 'subject:mutation'), blocked: subjectBlocked,
    pendingState: taskState, refreshGeneration: subjectRefresh[data.project?.id] || 0, onDirtyChange: setSubjectDirty });
  subjectsRef.current = subjects;
  const librarySource = workspaceMode === 'editing' ? sourceAsset : previewAsset || data.assets.find(asset => asset.id === (chosenNode?.assetId || chosenVersion?.assetId || chosenShot?.referenceAssetIds?.[0]));
  const inUseAssetIds = new Set([...(timeline?.clips || []).map(clip => clip.assetId), ...data.nodes.map(node => node.assetId), ...data.shots.flatMap(shot => generationReferences(shot).references.map(reference => reference.assetId)), ...data.shots.map(shot => data.versions.find(version => version.id === shot.selectedVersionId)?.assetId)].filter(Boolean));

  const timelineJobs = [...data.exports].filter(e => e.mode === 'timeline').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const previewJob = timelineJobs.find(e => !e.snapshot?.exportRange && ['succeeded','completed','ready'].includes(e.status));
  const latestRender = timelineJobs.find(item => !data.restore?.heldExportIds.includes(item.id));
  const jobs = useMemo(() => [...data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.jobs]);
  const activeCount = restored ? 0 : jobs.filter(activeJob).length;
  const taskCount = activeCount + activePending.length + activeTasks.length;
  const selectedCount = data.shots.filter(s => s.selectedVersionId).length;
  const orderedExports = [...data.exports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => {
    if (dragging.current) return;
    const next = [...data.nodes.map(record => ({ id: record.id, type: record.type, position: record.position, selected: record.id === selectedId, data: { record, asset: data.assets.find(a => a.id === record.assetId), canReference: isImageReferenceNode(record, data.assets, data.project?.id), referenceBusy, onInspect: (id, nextTab) => inspect(id, nextTab, null, { reveal: true }) } })), ...sortedShots.map((record, index) => ({ id: record.id, type: 'shot', position: record.position, selected: record.id === selectedId, data: { record, index, referenceConnection: referenceForShot(data.edges, record.id), referenceSourceLabel: data.nodes.find(node => node.id === referenceForShot(data.edges, record.id)?.source)?.label || data.assets.find(asset => asset.id === referenceForShot(data.edges, record.id)?.sourceAssetId)?.name || msg('assets.imageNode'), referenceBusy, asset: data.assets.find(a => a.id === record.referenceAssetIds?.[0]), version: data.versions.find(v => v.id === record.selectedVersionId), versionCount: data.versions.filter(v => v.shotId === record.id).length, job: jobs.find(j => j.shotId === record.id), busy: busy[`generate:${record.id}`], generationUnavailableReason, generationProvider: generationSelection(providers, generationOptions[record.id], record).provider, onInspect: (id, nextTab) => inspect(id, nextTab, null, { reveal: true }), onGenerate: async shot => { if (!await inspect(shot.id)) return; if (shot.id === selectedId && inspectorDirty) { notify(msg('shell.saveShotBeforeGenerate'), 'warning'); return; } generate(shot); } } }))];
    setNodes(next);
  }, [data, sortedShots, selectedId, jobs, busy, inspectorDirty, providers, generationOptions, referenceBusy, generationUnavailableReason]);
  const edges = useMemo(() => data.edges.map(edge => canvasEdge(edge, edge.id === selectedEdgeId, locale)), [data.edges, selectedEdgeId, locale]);
  const selectedEdge = data.edges.find(edge => edge.id === selectedEdgeId);
  const visibleAssets = data.assets.filter(a => (assetFilter === 'all' || a.mimeType?.startsWith(`${assetFilter}/`)) && a.name.toLowerCase().includes(assetSearch.toLowerCase()));
  if (auth === false) return <Login onLogin={boot} />;
  if (auth === null || auth === 'error') return <div className="boot-page"><LanguageControl /><div className="brand"><span className="brand-mark"><Icon name="film" /></span>Mioon</div>{auth === null ? <><span className="spinner" /><p>{t('shell.connecting')}</p></> : <><h2>{t('shell.connectFailed')}</h2><p>{toast?.message ? renderImportFeedback(locale, toast.message) : t('shell.checkServer')}</p><Button variant="ghost" className="button primary" onClick={() => { setAuth(null); boot(); }}><Icon name="refresh" />{t('shell.reconnect')}</Button></>}</div>;
  if (nativeWindow && !workbenchReady) return <EditorWindowOpening error={projectOpening.error} onRetry={() => { void selectProject(currentProject.current || nativeWindow.context.initialProjectId, false, true); }} onProjects={() => { void nativeProjectEntry?.show('open'); }} />;
  const webSettingsCenter = nativeWindow ? null : <WebSettingsCenter key="global-settings-center" request={webSettingsRequest} registry={settingsNavigation.current} onOpenChange={setWebSettingsOpen} connectionsAvailable={!restored} renderSettings={props => <SettingsConnectionForms {...props} />} />;
  if (!workbenchReady) return <>{webSettingsCenter}<ProjectHome projects={projects} phase={projectOpening.phase === 'error' ? 'error' : loading || projectOpening.phase === 'opening' ? 'opening' : 'home'} openingName={projects.find(item => item.id === projectOpening.projectId)?.name || t('projects.project')} error={projectOpening.error} notice={toast?.message} busy={Boolean(busy['project-create'] || busy['project-create-flow'])} listBusy={projectListStatus.busy} listError={projectListStatus.error} page={homePage} onPage={changeHomePage} onOpen={id => { void selectProject(id); }} onRetry={() => { if (projectOpening.projectId) void selectProject(projectOpening.projectId, false, true); }} onRefresh={refreshHomeProjects} onCreate={createProject} status={<><LastProjectStatus state={lastProjectStatus || lastProjectRef.current.getState()} controller={lastProjectRef.current} restored={restored} />{restored && <RestoredUnavailable title={t('shell.restoredScope')} />}</>} settings={null} /></>;
  return <>{webSettingsCenter}<main className={`workbench workbench-v2 dock-workbench ${geometry.narrow ? 'dock-narrow' : ''} mode-${workspaceMode} mobile-${mobilePanel} ${assetsCollapsed ? 'assets-collapsed' : ''} ${inspectorCollapsed ? 'inspector-collapsed' : ''} ${timelineCollapsed ? 'timeline-collapsed' : ''}`} data-testid="workbench" data-workspace-mode={workspaceMode} data-narrow={geometry.narrow ? 'true' : 'false'} style={geometry.style}>
    <WorkspaceVisibilityProvider visible={!comparisonId}>
    <Input ref={fileInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" multiple aria-label={t('assets.importLocal')} data-testid="asset-upload" onChange={e => importFiles(Array.from(e.target.files))} />
    <header className="topbar"><a className="brand" href={window.location.pathname} onClick={nativeWindow ? event => { event.preventDefault(); void nativeProjectEntry?.show('open'); } : undefined} aria-label={t('shell.title')}><span className="brand-mark"><Icon name="film" size={19} /></span><span className="brand-name">Mioon</span></a><span className="topbar-divider" /><DropdownMenu open={showProjects} onOpenChange={setShowProjects}><DropdownMenuTrigger render={<Button variant="ghost" className="project-trigger" data-testid="project-switcher" />}><Icon name="folder" size={16} /><span>{data.project?.name || t('projects.choose')}</span><Icon name="down" size={13} /></DropdownMenuTrigger><DropdownMenuContent align="start" className="workbench-project-menu"><DropdownMenuGroup><DropdownMenuLabel>{t('projects.yourProjects')}</DropdownMenuLabel>{projects.map(p => <DropdownMenuItem key={p.id} onClick={() => nativeWindow ? nativeProjectEntry?.open(p.id) : selectProject(p.id)}><Icon name="folder" size={15} /><span>{p.name}</span>{p.id === data.project?.id && <Icon name="check" size={14} />}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuSeparator />{nativeWindow && <DropdownMenuItem onClick={() => { setShowProjects(false); void nativeProjectEntry?.show('open'); }}><Icon name="folder" size={15} />{t('projects.openWorkspace')}</DropdownMenuItem>}<DropdownMenuItem data-testid="timeline-format-open" disabled={!data.project || loading} onClick={openTimelineFormat}><Icon name="settings" size={15} />{t('shell.timelineOutput')}</DropdownMenuItem><DropdownMenuItem className="new-project-menu" onClick={() => { setShowProjects(false); if (nativeWindow) { void nativeProjectEntry?.show('new'); return; } setShowCreate(true); }}><Icon name="plus" size={15} />{t('projects.createNew')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Tabs value={workspaceMode} onValueChange={changeMode} className="topbar-workspace"><TabsList className="segmented workspace-tabs" aria-label={t('shell.workspaceMode')} tabIndex={!data.project && !loading && workspaceMode === 'canvas' ? 0 : undefined} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined}><TabsTrigger value="canvas" disabled={loading || !data.project} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined} data-testid="workspace-canvas">{t('shell.canvas')}</TabsTrigger><TabsTrigger value="editing" disabled={loading || !data.project} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined} data-testid="workspace-editing">{t('shell.editing')}</TabsTrigger></TabsList></Tabs><details className="topbar-status" data-testid="topbar-status"><summary aria-label={t('shell.statusDetails')} title={t('shell.statusDetails')}><span className={`status-dot ${!online || ['error', 'conflict'].includes(preferenceStatus.phase) ? 'red' : inspectorDirty || formatDirty || annotations.state?.dirtyCount || preferenceStatus.pending ? 'orange' : 'green'}`} /><span className="topbar-status-label">{t('shell.status')}</span><Icon name="down" size={12} /></summary><div className="topbar-status-content"><TopbarSaveStatus online={online} syncing={Object.values(busy).some(Boolean)} dirty={inspectorDirty || formatDirty || Boolean(annotations.state?.dirtyCount)} lastSync={lastSync} preferenceStatus={preferenceStatus} onRetry={() => preferencesRef.current.flush({ projectId: currentProject.current })} onReload={reloadPreferences} /><>{nativeWindow ? <NativeLocatorStatus context={nativeWindow.context} bridge={nativeWindow.bridge} /> : <LastProjectStatus state={lastProjectStatus || lastProjectRef.current.getState()} controller={lastProjectRef.current} restored={workspace?.restored === true} />}</></div></details><div className="topbar-actions">
      <Button type="button" variant="ghost" className="button quiet" data-testid="global-settings-open" onClick={() => openGlobalSettings()}><Icon name="settings" size={15} />{t('settings.title')}</Button>
      <PanelsMenu mode={workspaceMode} assetsCollapsed={assetsCollapsed} inspectorCollapsed={inspectorCollapsed} timelineCollapsed={timelineCollapsed} storyboardOpen={sequenceOpen} onPanel={setPanelOpen} onReset={resetPanelLayout} disabled={loading || !data.project} />
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="button quiet workbench-actions-trigger" data-testid="workbench-actions" />}><Icon name="grid" size={15} /><span>{t('shell.actions')}</span>{taskCount > 0 && <span className="count-pill">{taskCount}</span>}<Icon name="down" size={13} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="workbench-actions-menu">
          <DropdownMenuGroup><DropdownMenuLabel>{t('shell.actions')}</DropdownMenuLabel>
            <DropdownMenuItem data-testid="agent-chat-open" disabled={!data.project || loading} onClick={() => { setRightDockTab('agent'); setAgentPage('chat'); setPanelOpen('inspector', true); }}><Icon name="sparkle" size={15} />{t('shell.agentChat')}</DropdownMenuItem>
            <DropdownMenuItem data-testid="agent-settings-open" onClick={() => openGlobalSettings('agent')}><Icon name="settings" size={14} />{t('shell.agentConnections')}</DropdownMenuItem>
            <DropdownMenuItem data-testid="region-guide-toggle" aria-expanded={showGuide} onClick={() => setShowGuide(!showGuide)}><Icon name="info" size={15} />{t('shell.regionGuide')}</DropdownMenuItem>
            <DropdownMenuItem data-testid="jobs-button" onClick={() => openTasks()}><Icon name="clock" size={16} />{t('shell.tasks')}{taskCount > 0 && <span className="count-pill">{taskCount}</span>}{data.project && taskState.phase !== 'ready' && <span className="count-pill" aria-label={t('shell.recoveryUnchecked')}>…</span>}</DropdownMenuItem>
          </DropdownMenuGroup><DropdownMenuSeparator />
          <DropdownMenuGroup><DropdownMenuLabel>{t('shell.exportTimeline')}</DropdownMenuLabel>
            <DropdownMenuItem data-testid="export-history" onClick={openExportHistory}><Icon name="layers" size={16} />{t('shell.viewExports')}</DropdownMenuItem>
            <DropdownMenuItem data-testid="export-button" disabled={!data.shots.length || selectedCount !== data.shots.length || busy.export} title={selectedCount !== data.shots.length ? t('shell.generateAllShots') : t('shell.exportStoryboardHint')} onClick={createExport}><Icon name="download" size={16} />{t('shell.exportStoryboard')}</DropdownMenuItem>
            <DropdownMenuItem data-testid="export-timeline" disabled={!canOpenExport} onClick={openTimelineExport}><Icon name="download" size={15} />{t('shell.exportTimeline')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div></header>
    {showGuide && <section className="region-guide" role="region" aria-label={t('shell.regionGuide')} data-testid="region-guide"><header><strong>{t('shell.guideTitle')}</strong><Button variant="ghost" className="icon-button" aria-label={t('shell.closeGuide')} onClick={() => setShowGuide(false)}><Icon name="close" size={16} /></Button></header><div><p><b>{t('shell.canvas')}</b>{t('shell.guideCanvas')}</p><p><b>{t('shell.editing')}</b>{t('shell.guideEditing')}</p><p><b>{t('shell.sharedAssets')}</b>{t('shell.guideAssets')}</p><p><b>{t('shell.guideTransitionTitle')}</b>{t('shell.guideTransition')}</p></div><footer>{t('shell.guideVersions')}</footer></section>}
    <div className="workspace-surface" ref={panelSurface} data-testid="workspace-surface">
    {assetsCollapsed && <PanelRecall name="assets" label={t('assets.library')} icon="folder" onClick={() => setPanelOpen('assets', true)} />}
    <PanelBoundary name="assets" visible={panelVisible('assets')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('assets')}>
    <AssetLibrary annotations={annotations} annotationBlocked={annotationBlocked} restored={restored} confirm={confirm} timelineUsage={timelineUsage} onLocateTimelineUse={locateAssetUse} subjects={subjects} subjectBlocked={subjectBlocked} onInspectShot={id => inspect(id, 'settings', null, { reveal: true })} onShowTasks={() => openTasks()} dispositions={dispositions} dispositionBlocked={dispositionBlocked} selectedAsset={librarySource} inUseAssetIds={inUseAssetIds} mode={workspaceMode} versions={data.versions} shots={data.shots} assets={data.assets} filter={assetFilter} onFilter={setAssetFilter} search={assetSearch} onSearch={setAssetSearch} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} onFiles={importFiles} onPreview={previewSource} onCanvas={addNode} onTimeline={addTimelineAsset} busy={{ ...busy, timeline: timelineBusy }} collapsed={assetsCollapsed} onCollapse={() => setAssetsCollapsed(true)} project={data.project} />
    {resizeHandle('assets', 'assetsWidth')}</PanelBoundary>
    <PanelBoundary name="canvas" visible={panelVisible('canvas')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus="[data-testid=mobile-panel-canvas]">
    <section className="canvas-area" aria-label={workspaceMode === 'canvas' ? t('shell.canvasWorkspace') : t('shell.editingWorkspace')} data-testid="active-workspace">{workspaceMode === 'canvas' && <div className="canvas-heading"><div className="region-title"><h2>{t('shell.canvas')}</h2></div><div className="canvas-tools"><Button variant="ghost" className="button small" data-testid="add-text-node" onClick={() => addNode('text')}><Icon name="text" size={14} /><span>{t('shell.text')}</span></Button><Button variant="ghost" className="button small" data-testid="add-image-node" onClick={() => addNode('image')}><Icon name="image" size={14} /><span>{t('assets.image')}</span></Button><Button variant="ghost" className="button small" data-testid="add-video-node" onClick={() => addNode('video')}><Icon name="film" size={14} /><span>{t('assets.video')}</span></Button><Button variant="ghost" className="button small accent-outline" data-testid="add-shot" disabled={busy['shot-create']} onClick={addShot}><Icon name="plus" size={15} />{t('projects.addShot')}</Button></div></div>}
      <div className="main-stage">{loading ? <div className="canvas-loading" data-testid="workspace-loading"><span className="spinner" />{t('projects.opening')}</div> : workspaceMode === 'canvas' ? <div className="flow-wrap" data-testid="canvas-drop-zone" onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={canvasDrop}><ReactFlow key={data.project?.id || 'empty'} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))} onNodeClick={(_, node) => inspect(node.id)} onNodeDoubleClick={(_, node) => { const record = dataRef.current.nodes.find(n => n.id === node.id); const shot = dataRef.current.shots.find(s => s.id === node.id); const version = dataRef.current.versions.find(v => v.id === shot?.selectedVersionId); const asset = dataRef.current.assets.find(a => a.id === (record?.assetId || version?.assetId || shot?.referenceAssetIds?.[0])); if (asset) previewSource(asset); }} onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={savePosition} onConnect={connect} onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)} onPaneClick={() => setSelectedEdgeId(null)} onEdgesDelete={deleted => { setSelectedEdgeId(null); deleted.filter(edge => !isReferenceEdge(dataRef.current.edges.find(item => item.id === edge.id))).forEach(edge => run(`delete-edge:${edge.id}`, 'edge.delete', { edgeId: edge.id })); }} onBeforeDelete={beforeDeleteEdges} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} onMoveEnd={(event, viewport) => { if (viewRef.current.activeMode === 'canvas' && data.project?.id === currentProject.current) updateView('canvas', { viewport }, { passive: !event }); }} defaultViewport={view.canvas.viewport || { x: 0, y: 0, zoom: 1 }} onInit={instance => { const captured = context(), saved = viewRef.current.canvas.viewport; requestAnimationFrame(() => { if (isCurrent(captured) && viewRef.current.activeMode === 'canvas') { if (saved) instance.setViewport(saved); else instance.fitView({ padding: canvasFitPadding(.16), minZoom: .65, maxZoom: 1 }); } }); }} fitView={!view.canvas.viewport} fitViewOptions={{ padding: 0.16, minZoom: .65, maxZoom: 1 }} minZoom={0.2} maxZoom={1.75} snapToGrid snapGrid={[12, 12]} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']} colorMode="dark"><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#34363b" />{miniMap && <MiniMap nodeColor={n => n.type === 'shot' ? '#b6c783' : '#6c7180'} maskColor="rgba(12,13,15,.8)" pannable zoomable />}</ReactFlow>
      <div className="canvas-connection-legend" data-testid="connection-legend"><span><i className="reference-swatch" />{t('shell.referenceParticipates')}</span><span><i className="visual-swatch" />{t('shell.visualLinkOnly')}</span></div>
      {selectedEdge && <div className="selected-edge-note" data-testid="selected-edge-note">{isReferenceEdge(selectedEdge) ? <><Icon name="link" size={13} /><span>{t('shell.referenceLink')}</span><Button variant="ghost" size="sm" onClick={() => inspect(selectedEdge.target)}>{t('shell.viewDisconnect')}</Button></> : <><span>{t('shell.visualLinkNoGeneration')}</span><span className="muted">{t('shell.deleteKey')}</span></>}</div>}
      {!data.project && !loading && <div className="canvas-empty"><div className="empty-composition"><div className="empty-mini-card"><Icon name="text" size={19} /><span>{t('shell.emptyIdea')}</span></div><span className="empty-connector" /><div className="empty-main-card"><Icon name="film" size={39} /><span>{t('shell.emptyPossibilities')}</span></div><span className="empty-connector" /><div className="empty-mini-card"><Icon name="sparkle" size={19} /><span>{t('shell.emptyFilm')}</span></div></div><div className="eyebrow">{t('shell.emptyEyebrow')}</div><h1>{t('shell.emptyTitle')}</h1><p id="workspace-mode-help">{t('shell.emptyCreateHint')}</p><Button variant="ghost" className="button primary" data-testid="empty-create-project" aria-describedby="workspace-mode-help" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} />{t('projects.createFirst')}</Button></div>}
      {data.project && !nodes.length && !loading && <div className="canvas-empty"><div className="empty-canvas-symbol"><Icon name="film" size={35} /><span className="small-plus">+</span></div><div className="eyebrow">{t('shell.blankEyebrow')}</div><h1>{t('projects.shotEmptyTitle')}</h1><p>{t('projects.shotEmptyHint')}</p><div className="empty-actions"><Button variant="ghost" className="button primary" onClick={addShot}><Icon name="plus" size={16} />{t('projects.createShot')}</Button><Button variant="ghost" className="button" data-testid="create-three-shots" disabled={busy.structure} onClick={addStructure}><Icon name="layers" size={16} />{t('projects.createStructure')}</Button></div></div>}
      {loading && <div className="canvas-loading"><span className="spinner" />{t('projects.opening')}</div>}
      <div className="canvas-controls"><WorkbenchTooltip content={t('shell.zoomOutCanvas')}><Button variant="ghost" className="icon-button" aria-label={t('shell.zoomOut')} onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16} /></Button></WorkbenchTooltip><span>{zoom}%</span><WorkbenchTooltip content={t('shell.zoomInCanvas')}><Button variant="ghost" className="icon-button" aria-label={t('shell.zoomIn')} onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16} /></Button></WorkbenchTooltip><i /><WorkbenchTooltip content={t('shell.fitCanvasHint')}><Button variant="ghost" className="icon-button" aria-label={t('shell.fitCanvas')} data-testid="fit-canvas" onClick={() => flow.fitView({ padding: canvasFitPadding(0.18), duration: 350, maxZoom: 1 })}><Icon name="zoom" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`icon-button ${miniMap ? 'active' : ''}`} aria-label={t('shell.showMinimap')} aria-pressed={miniMap} onClick={() => setMiniMap(!miniMap)}><Icon name="grid" size={16} /></Button></div><div className="canvas-hint"><Icon name="link" size={12} />{t('shell.canvasInteractionHint')}</div>
      </div> : <div className="preview-tab-panel">{restored && <p className="helper muted" role="status">{t('shell.restoredFrameUnavailable')}</p>}<Preview onBeforePlay={beforeMainPreviewPlay} audioPreview={audioPreview} onRegisterMediaPause={registerNativePreviewPause} key={data.project?.id || 'empty'} visible={panelVisible('canvas')} kind={previewKind} onKind={kind => { navigationEpoch.current++; setPreviewKind(kind); }} asset={sourceAsset} clip={quickAssetId ? null : chosenClip} timeline={timeline} job={previewJob} pendingJob={latestRender} playhead={playhead} onSeek={setPlayhead} sourceScope={sourceRangeScope} sourcePosition={sourceRanges.state?.position ?? 0} sourceSeek={sourceRanges.state?.seek} onSourcePosition={(frame, scope) => sourceRanges.controller.position(frame, scope)} onCaptureFrame={frameExtraction.controller.capture} captureBusy={frameCaptureBusy(frameExtraction.state)} onRender={renderTimeline} busy={Boolean(busy['timeline:render:preview'])} onCanvas={() => changeMode('canvas')} onImport={() => data.project ? fileInput.current?.click() : setShowCreate(true)} canSeed={Boolean(sortedShots.length && selectedCount === sortedShots.length)} seedBusy={timelineBusy} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} /></div>}</div>
    {workspaceMode === 'canvas' && <Collapsible open={sequenceOpen} onOpenChange={setSequenceOpen} className={`storyboard ${sequenceOpen ? '' : 'sequence-collapsed'}`} render={<section aria-label={t('storyboard.order')} />}><header><div><Icon name="film" size={16} /><h2>{t('storyboard.title')}</h2><span className="storyboard-summary">{t('storyboard.summary', { count: sortedShots.length, seconds: formatNumber(sortedShots.reduce((sum, s) => sum + Number(data.versions.find(v => v.id === s.selectedVersionId)?.snapshot?.duration || s.duration), 0)) })}</span></div><span className="order-hint"><Icon name="grip" size={13} />{t('storyboard.dragHint')}</span><Button variant="ghost" className="text-button" onClick={addShot}><Icon name="plus" size={14} />{t('shell.add')}</Button><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={sequenceOpen ? t('storyboard.collapse') : t('storyboard.expand')} />}><Icon name={sequenceOpen ? 'minus' : 'plus'} size={14} /></CollapsibleTrigger></header><CollapsibleContent keepMounted className="storyboard-track" data-testid="storyboard">{sortedShots.map((shot, index) => { const v = data.versions.find(v => v.id === shot.selectedVersionId); const a = data.assets.find(a => a.id === shot.referenceAssetIds?.[0]); return <div key={shot.id} className={`storyboard-shot ${selectedId === shot.id ? 'selected' : ''} ${sequenceDrag === shot.id ? 'dragging' : ''}`} data-testid={`storyboard-shot-${shot.id}`} draggable={!busy.reorder} onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', shot.id); if (v?.assetId) e.dataTransfer.setData(ASSET_DRAG, v.assetId); e.dataTransfer.effectAllowed = 'copyMove'; setSequenceDrag(shot.id); }} onDragEnd={() => setSequenceDrag(null)} onDragOver={e => { if (sequenceDrag) e.preventDefault(); }} onDrop={e => { if (sequenceDrag) { e.preventDefault(); reorder(sequenceDrag, index); setSequenceDrag(null); } }}><Button variant="ghost" className="storyboard-preview" onClick={async () => { if (!await inspect(shot.id)) return; flow.fitView({ nodes: [{ id: shot.id }], padding: canvasFitPadding(.1), duration: 250, maxZoom: 1 }); }} aria-label={t('storyboard.select', { name: `${index + 1} ${shot.title}` })}><Media version={v} asset={a} /><span className="storyboard-index">{String(index + 1).padStart(2, '0')}</span><span className="storyboard-duration">{v?.snapshot?.duration || shot.duration}s</span>{v && <span className="storyboard-version">V{v.number}</span>}</Button><div className="storyboard-shot-meta"><span title={shot.title}>{shot.title}</span><div><Button variant="ghost" aria-label={t('storyboard.moveEarlier', { name: shot.title })} disabled={index === 0 || busy.reorder} onClick={() => reorder(shot.id, index - 1)}><Icon name="left" size={11} /></Button><Button variant="ghost" aria-label={t('storyboard.moveLater', { name: shot.title })} disabled={index === sortedShots.length - 1 || busy.reorder} onClick={() => reorder(shot.id, index + 1)}><Icon name="arrow" size={11} /></Button></div></div></div>; })}{!sortedShots.length ? <div className="storyboard-empty"><Icon name="film" size={22} /><span>{t('storyboard.empty')}</span></div> : <Button variant="ghost" className="storyboard-add" aria-label={t('storyboard.addNext')} onClick={addShot}><Icon name="plus" size={22} /><span>{t('storyboard.nextAct')}</span></Button>}</CollapsibleContent></Collapsible>}
    </section></PanelBoundary>
    {inspectorCollapsed && <PanelRecall name="inspector" label={rightDockTab === 'agent' ? 'Agent' : rightDockTab === 'image' ? t('shell.images') : rightDockTab === 'delivery' ? t('shell.deliveryChecks') : rightDockTab === 'tasks' ? t('shell.tasks') : t('shell.properties')} icon="settings" onClick={() => setPanelOpen('inspector', true)} />}
    <PanelBoundary name="inspector" visible={panelVisible('inspector')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('inspector')}>
    <Collapsible open={!inspectorCollapsed} onOpenChange={open => setInspectorCollapsed(!open)} className={`inspector-region ${inspectorCollapsed ? 'panel-collapsed' : ''}`} render={<section aria-label={t('shell.inspectorTabs')} />}><header className="inspector-region-heading"><Tabs value={rightDockTab} onValueChange={value => { if (['properties', 'agent', 'image', 'delivery', 'tasks'].includes(value)) { markPanelIntent(); setRightDockTab(value); } }} className="right-dock-tabs"><TabsList aria-label={t('shell.rightWorkspace')} className="segmented"><TabsTrigger id="right-dock-properties-tab" value="properties" data-testid="right-dock-tab-properties" aria-controls="right-dock-properties">{t('shell.properties')}</TabsTrigger><TabsTrigger id="right-dock-agent-tab" value="agent" data-testid="right-dock-tab-agent" aria-controls="right-dock-agent"><Icon name="sparkle" size={12} />{t('shell.agentLabel')}</TabsTrigger><TabsTrigger id="right-dock-image-tab" value="image" data-testid="right-dock-tab-image" aria-controls="right-dock-image">{t('shell.images')}</TabsTrigger><TabsTrigger id="right-dock-delivery-tab" value="delivery" data-testid="right-dock-tab-delivery" aria-controls="right-dock-delivery">{t('shell.deliveryChecks')}</TabsTrigger><TabsTrigger id="right-dock-tasks-tab" value="tasks" data-testid="right-dock-tab-tasks" aria-controls="right-dock-tasks">{t('shell.tasks')}</TabsTrigger></TabsList></Tabs><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={t('shell.collapseInspector')} title={t('shell.collapseInspector')} data-testid="toggle-inspector" />}><Icon name="minus" size={16} /></CollapsibleTrigger></header><RestoredWorkspace workspace={workspace} /><CollapsibleContent keepMounted className="inspector-region-content"><AgentDockPane id="right-dock-properties" labelledBy="right-dock-properties-tab" visible={rightDockTab === 'properties'} fallbackFocus="[data-testid=right-dock-tab-agent]"><AgentDockPane id="properties-inspector-pane" visible={propertiesPage === 'inspector' || propertiesPage === 'subtitle' && workspaceMode === 'canvas'} fallbackFocus="[data-testid=timeline-format-back]">{workspaceMode === 'canvas' ? <div className="inspector-container">
    <Inspector shotTextContext={{ ...shotTextContext(), getCurrent: shotTextContext }} onShotTextController={registerShotText} onShotTextAccepted={({ response }) => { if (currentProject.current === response.projectId) void refresh(response.projectId); }} generationUnavailableReason={generationUnavailableReason} actionScopeKey={`${rightDockTab}:${propertiesPage}`} subjects={subjects} subjectBlocked={subjectBlocked} key={`${data.project?.id}:${selectedId || 'empty'}:${inspectorEpoch}`} highlightedVersionId={highlightedVersionId} shot={chosenShot} node={chosenNode} project={data.project} assets={data.assets} versions={data.versions} jobs={jobs} providers={providers} generationOptions={generationOptions[selectedId]} onGenerationOptionsChange={updateGenerationOptions} tab={tab} setTab={setTab} busy={busy} onSave={saveShot} onNodeSave={saveNode} onGenerate={generate} onSelectVersion={selectVersion} onCompare={setComparisonId} onOpenJobs={() => openTasks()} onDirtyChange={setShotDirty} shots={sortedShots} nodes={data.nodes} edges={data.edges} referenceBusy={referenceBusy} referencePending={referencePending} onAttachReference={attachReference} onDetachReference={detachReference} onInspect={(id, nextTab) => inspect(id, nextTab, null, { reveal: true })} onAddVersion={assetId => addTimelineAsset(assetId)} />
    </div> : quickAssetId && sourceAsset ? <SourceRangeInspector asset={sourceAsset} state={sourceRanges.state} controller={sourceRanges.controller} timeline={timeline} blocked={sourceRangeBlocked} onAdd={addSavedSourceRange}>{restored ? <RestoredUnavailable title={t('shell.restoredFramesRetained')} /> : <FrameExtractionPanel controller={frameExtraction.controller} />}</SourceRangeInspector> : chosenClip ? <TimelineInspector key={`${data.project?.id}:${chosenClip.id}:${inspectorEpoch}`} loudnessContext={clipLoudnessContext} loudnessInvocation={() => pinNewWorkspaceIntent({}, workspaceRef.current)} onLoudnessUnauthorized={() => setAuth(false)} onReturnToSource={clipSource ? () => returnToSource(chosenClip.assetId) : undefined} sourceDescription={clipSource?.version && chosenClip.versionId === clipSource.version.id ? `${clipSource.shot.title} · V${clipSource.version.number}` : clipSource?.asset.name} replacementContext={clipReplacementContext()} staleSource={staleClips.get(chosenClip.id)} onReplaceSource={replaceTimelineClipSource} onOpenRequests={() => openTasks()} clip={chosenClip} timeline={timeline} asset={data.assets.find(a => a.id === chosenClip.assetId)} draftContext={{ scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: currentProject.current, restored, audioRoleEditable, audioRoleCapability }} draftConnected={online && auth === true && !loading} onDraftController={registerClipDraft} onReviewBlockedChange={setAgentClipDraftBlocked} onSave={(clipId, patch, revision, draftOptions) => mutateTimeline('timeline.clip.update', { clipId, patch }, revision, { returnAfterNavigation: true, canExecute: draftOptions?.canExecute })} onRemove={async clipId => { const result = await mutateTimeline('timeline.clip.remove', { clipId }); if (result) setSelectedClipId(null); }} onDirtyChange={setClipDirty} busy={timelineBusy} onPreview={() => { setQuickAssetId(null); setPreviewKind('source'); }} /> : <aside className="inspector" data-testid="editing-inspector-empty"><header className="inspector-heading"><Icon name="layers" /><span>{t('shell.clipProperties')}</span></header><div className="inspector-empty"><h3>{t('shell.selectTimelineClip')}</h3><p>{t('shell.clipPropertiesHint')}</p></div></aside>}</AgentDockPane><AgentDockPane id="properties-subtitle-pane" visible={propertiesPage === 'subtitle' && workspaceMode === 'editing'} fallbackFocus="[data-testid=right-dock-tab-properties]"><SubtitleInspector state={subtitles.state} controller={subtitles.controller} renderJob={previewJob} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane><AgentDockPane id="properties-format-pane" visible={propertiesPage === 'format'} fallbackFocus="[data-testid=right-dock-tab-properties]"><TimelineFormatPanel state={timelineFormat.state} controller={timelineFormat.controller} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane>{restored ? <RestoredUnavailable title={t('shell.restoredNoBackup')} backup /> : <WorkspaceBackupPanel scope={`${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} getScope={() => `${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} connected={online && auth === true && !loading} read={(input, options) => rpc('workspace.backup.inspect', input, options)} onUnauthorized={() => setAuth(false)} />}</AgentDockPane><AgentDockPane id="right-dock-agent" labelledBy="right-dock-agent-tab" visible={rightDockTab === 'agent'} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title={t('shell.restoredAgentHistory')} /> : <AgentWorkspace onOpenSettings={openGlobalSettings} settingsOverlayOpen={webSettingsOpen} nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry.current} navigationRegistry={settingsNavigation.current} projectId={data.project?.id} projectName={data.project?.name} selectedShot={chosenShot ? { id: chosenShot.id, revision: chosenShot.revision, title: chosenShot.title, prompt: chosenShot.prompt || '' } : null} selectedTimelineClip={agentTimelineSelection} timelineEditBlockedReason={agentTimelineBlockedReason} timelineEditBlockedDescriptor={agentTimelineBlockedDescriptor} selectedTimelineGainClip={agentTimelineGainSelection} timelineGainBlockedReason={gainBlockedReason} timelineGainBlockedDescriptor={gainBlockedDescriptor} onApplied={projectId => { if (currentProject.current === projectId) void refresh(projectId); }} page={agentPage} onPage={setAgentPage} onCollapse={() => setPanelOpen('inspector', false)} onDraftChange={onAgentDraftChange} />}</AgentDockPane><AgentDockPane id="right-dock-image" labelledBy="right-dock-image-tab" visible={rightDockTab === 'image'} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title={t('shell.restoredImageHistory')} /> : <ImageGeneration onOpenSettings={openGlobalSettings} settingsOverlayOpen={webSettingsOpen} nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry.current} navigationRegistry={settingsNavigation.current} key={data.project?.id || 'no-project'} projectId={data.project?.id} projectName={data.project?.name} projectAssets={data.assets} onDirtyChange={onImageDraftChange} onGenerated={projectId => { if (currentProject.current === projectId) void refresh(projectId); }} onRevealAsset={revealImageAsset} />}</AgentDockPane><AgentDockPane id="right-dock-delivery" labelledBy="right-dock-delivery-tab" visible={rightDockTab === 'delivery'} fallbackFocus="[data-testid=right-dock-tab-properties]"><DeliveryWorkspace page={showExports ? 'history' : 'compose'} onPage={page => { markPanelIntent(); setShowExports(page === 'history'); }}><AgentDockPane id="delivery-compose-pane" labelledBy="delivery-compose-tab" visible={!showExports} fallbackFocus="[data-testid=delivery-page-history]"><TimelineExportPreflight preview={<ExportPreview
      result={exportPreviewResult(exportPreviewAttempt, data.exports, { scope: exportCheckView.scope, contextKey: sampleExportContextKey(), connected: exportCheckView.connected, isRenderRecord: isTimelineRenderRecord, heldExportIds: data.restore?.heldExportIds })}
      visible={!comparisonId && workbenchReady && rightDockTab === 'delivery' && !showExports && panelVisible('inspector')}
      canSelect={exportRangeContext().enabled && !localDelivery.state.busy && !pendingTimelineExport}
      canGenerate={Boolean(sampleExportPreflight.state?.binding && ['ready', 'incomplete'].includes(sampleExportPreflight.state.phase) && !sampleExportPreflight.state.attempted && !busy['timeline:render:export'] && !localDelivery.state.busy && !pendingTimelineExport && !dirtyRef.current && !formatDirty && isExportPreviewRange(sampleExportView.exportRange, timeline?.durationFrames))}
      rangeDraft={sampleRangeDraft?.scope === exportCheckView.scope ? sampleRangeDraft : null} onRangeChange={chooseSampleExportRange}
      preflightState={sampleExportPreflight.state} canCheck={Boolean(canOpenExport && Number.isSafeInteger(timeline?.revision) && timeline.revision > 0 && online && auth === true && !deliveryName.error && (restored || !localDelivery.state.baselineConflict && !localDelivery.state.candidate) && sampleExportView.exportRange && !localDelivery.state.busy && !pendingTimelineExport)}
      checkDetails={<>
        {sampleExportPreflight.state?.error && <p className="notice error" role="alert">{preflightErrorMessage({ code: sampleExportPreflight.state.errorCode }, locale)}</p>}
        {sampleExportPreflight.state?.capabilityPhase && <p className="export-preflight-note">{exportCapabilityMessage(sampleExportPreflight.state.capabilityPhase, locale)}</p>}
        {sampleExportPreflight.state?.report?.issues?.map((issue, index) => <p className="notice warning" key={index}>{preflightIssueMessage(issue, locale)}</p>)}
        {sampleExportPreflight.state?.phase === 'incomplete' && <p className="notice warning">{t('export.preflight.incompleteWarning')}</p>}
      </>}
      onCheck={() => { sampleExportPreflight.controller.setContext(sampleExportContext()); sampleExportPreflight.controller.check(); }}
      onSelect={selectSampleExportRange} onGenerate={() => renderTimeline('export', sampleExportPreflight.state?.binding, undefined, true)}
      onRegisterMediaPause={registerExportPreviewPause} onBeforePlay={beforeExportPreviewPlay}
    />} recovery={<><DeliveryDraftRecovery state={localDelivery.state} controller={localDelivery.controller} disabled={!online || auth !== true || loading} /><TimelineMixLoudness loudness={timelineMixLoudness} onRevokeApply={() => timelineLoudnessApply.controller.revoke()} apply={<TimelineLoudnessApply apply={timelineLoudnessApply} observation={timelineMixLoudness.state} onOpenTasks={() => openTasks()} />} /></>} state={exportPreflight.state} timeline={timeline} deliveryName={deliveryName.value} deliveryNameError={deliveryName.error} deliveryNameDisabled={!deliveryNameContext().enabled} onDeliveryNameChange={value => { if (deliveryName.controller.choose(value, deliveryName.scope, deliveryName.version)) exportPreflight.controller.setContext(exportCheckContext()); }} rangeDraft={exportRange.draft} exportRange={exportRange.value} rangeError={exportRange.error} rangeDisabled={!exportRangeContext().enabled} onRangeChange={draft => { if (exportRange.controller.chooseRange(draft, exportRange.scope, exportRange.version)) exportPreflight.controller.setContext(exportCheckContext()); }} exportSettings={exportSettings.value} settingsDisabled={!exportSettingsContext().enabled} onSettingsChange={value => { if (exportSettings.controller.choose(value, exportSettings.scope, exportSettings.version)) exportPreflight.controller.setContext(exportCheckContext()); }} projectName={data.project?.name} canCheck={canCheckExport} exportBusy={Boolean(busy['timeline:render:export']) || localDelivery.state.busy} pendingExport={pendingTimelineExport} dirty={inspectorDirty || formatDirty} onCheck={() => checkTimelineExport(exportCheckView)} onExport={binding => renderTimeline('export', binding)} onUncheckedExport={renderUncheckedTimeline} /></AgentDockPane><AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible={showExports} fallbackFocus="[data-testid=delivery-page-compose]"><ExportHistoryList samplePeak={exportSamplePeak} loudness={exportLoudness} heldExportIds={data.restore?.heldExportIds} orderedExports={orderedExports} projectName={data.project?.name} timelineRevision={timeline?.revision} /></AgentDockPane></DeliveryWorkspace></AgentDockPane><AgentDockPane id="right-dock-tasks" labelledBy="right-dock-tasks-tab" visible={rightDockTab === 'tasks'} fallbackFocus="[data-testid=right-dock-tab-properties]"><TaskCenter taskViewScope={taskViewScope} captureView={captureTaskView} workspace={workspace} activeCount={activeCount} pending={pending} busy={busy} jobs={jobs} data={data} reconcileIds={reconcileIds} setReconcileIds={setReconcileIds} run={run} retryGeneration={retryGeneration} onInspectJob={inspectTaskJob} context={context} confirm={confirm} isCurrent={isCurrent} tasks={taskState} onRecover={recoverTask} onReload={() => tasksRef.current.load(currentProject.current)} onAdopt={adoptLegacyTask} /></AgentDockPane></CollapsibleContent></Collapsible>
    {resizeHandle('inspector', 'inspectorWidth')}</PanelBoundary>
    {workspaceMode === 'editing' && data.project && !loading && <><PanelBoundary name="timeline" visible={panelVisible('timeline')} scope={`${currentProject.current}:editing`} fallbackFocus={panelFallback('timeline')}>{resizeHandle('timeline', 'timelineHeight')}<Timeline staleClips={staleClips} waveformReadOnly={restored} workspaceOrigin={workspace?.workspaceOrigin} key={data.project.id} viewState={view.editing} onViewStateChange={(patch, options) => { if (data.project?.id === currentProject.current && viewRef.current.activeMode === 'editing') updateView('editing', patch, options); }} timeline={timeline} historyState={historyState} onHistory={changeTimelineHistory} splitState={splitState} onSplit={splitTimelineClip} assets={data.assets} selectedClipId={propertiesPage === 'subtitle' ? null : selectedClipId} selectedCueId={propertiesPage === 'subtitle' ? subtitles.state?.cueId : null} onSelectSubtitle={cueId => openSubtitle(cueId)} onAddSubtitle={frame => openSubtitle(null, frame)} subtitleBlocked={!subtitles.state?.connected} onSelectClip={selectClip} onAddAsset={addTimelineAsset} onMoveClip={moveTimelineClip} onTrackAdd={kind => mutateTimeline('timeline.track.add', { kind })} onTrackUpdate={(trackId, patch) => mutateTimeline('timeline.track.update', { trackId, patch })} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} onRender={renderTimeline} onSeek={seekTimelineSound} playhead={effectivePlayhead} visible={panelVisible('timeline')} collapsed={timelineCollapsed} onCollapse={() => setPanelOpen('timeline', false)} busy={timelineBusy} canSeed={Boolean(sortedShots.length && selectedCount === sortedShots.length)} renderJob={latestRender} /></PanelBoundary>{timelineCollapsed && <PanelRecall name="timeline" label={t('shell.timeline')} icon="layers" onClick={() => setPanelOpen('timeline', true)} />}</>}
    </div>
    <nav className="mobile-nav" aria-label={t('shell.mobileNavigation')}>{[['assets', 'folder', t('assets.assets')], ['canvas', workspaceMode === 'canvas' ? 'grid' : 'play', workspaceMode === 'canvas' ? t('shell.canvas') : t('shell.preview')], ['inspector', rightDockTab === 'agent' ? 'sparkle' : rightDockTab === 'image' ? 'image' : rightDockTab === 'tasks' ? 'clock' : 'settings', rightDockTab === 'agent' ? 'Agent' : rightDockTab === 'image' ? t('shell.images') : rightDockTab === 'delivery' ? t('shell.deliveryChecks') : rightDockTab === 'tasks' ? t('shell.tasks') : t('shell.properties')], ...(workspaceMode === 'editing' ? [['timeline', 'layers', t('shell.timeline')]] : [])].map(([id, icon, label]) => <Button variant="ghost" className={mobilePanel === id ? 'active' : ''} key={id} data-testid={`mobile-panel-${id}`} aria-pressed={mobilePanel === id} onClick={() => mobileNavigate(id)}><Icon name={icon} size={17} />{label}</Button>)}</nav>
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'success' ? 'check' : 'info'} size={17} /><span>{renderImportFeedback(locale, toast.message)}</span><Button variant="ghost" className="icon-button small" aria-label={t('shell.dismissNotice')} onClick={() => setToast(null)}><Icon name="close" size={15} /></Button></div>}
    {!nativeWindow && showCreate && <CreateProject onClose={() => { navigationEpoch.current++; setShowCreate(false); }} onCreate={createProject} busy={busy['project-create'] || busy['project-create-flow']} />}
    {previewAsset && <Modal title={previewAsset.name} subtitle={`${previewAsset.mimeType} · ${formatNumber(previewAsset.sizeBytes / 1024 / 1024, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`} onClose={() => setPreviewAsset(null)} wide><div className="asset-preview-large"><Media asset={previewAsset} controls /></div><div className="modal-footer"><Button variant="ghost" className="button primary" onClick={() => { addNode(assetKind(previewAsset), previewAsset); setPreviewAsset(null); }}><Icon name="plus" size={16} />{t('assets.addCanvas')}</Button></div></Modal>}
    {realConfirm && <Modal title={t('shell.generationConfirmTitle')} subtitle={t('shell.generationCosts')} onClose={() => { realConfirmRef.current = null; setRealConfirm(null); }}><div className="modal-form"><div className="confirmation-summary"><strong>{providerDisplayName(providers.find(p => p.id === realConfirm.providerId) || { id: realConfirm.providerId }, t)}</strong>{realConfirm.retryJobId && <p>{t('shell.generationRetryScope')}</p>}<span>{t('shell.generationReviewParameters', { model: realConfirm.model, mode: renderMessage(inputModeDescriptor(realConfirm.inputMode)), seconds: realConfirm.shot.duration, ratio: realConfirm.shot.aspectRatio })}</span><p>{t('shell.generationDataScope', { count: generationReferences(realConfirm.shot, { frozen: Boolean(realConfirm.retryJobId), subjectReference: realConfirm.subjectReference }).references.length })}</p>{(realConfirm.subjectReference || realConfirm.shot.subjectReference) ? <><SubjectVideoSummary reference={realConfirm.subjectReference || realConfirm.shot.subjectReference} assets={realConfirm.referenceAssets} latestSubject={subjects?.state?.subjects[(realConfirm.subjectReference || realConfirm.shot.subjectReference).subjectVersion.subjectId]} /><p className="subject-warning" data-testid="paid-subject-face-warning">{renderMessage(realConfirm.providerId === 'ark' ? ARK_SUBJECT_WARNING_MESSAGE : MOCK_SUBJECT_WARNING_MESSAGE)}</p><p className="muted">{t('shell.generationSubjectScope')}</p></> : <VideoFrameSummary shot={realConfirm.shot} assets={realConfirm.referenceAssets} frozen={Boolean(realConfirm.retryJobId)} />}<p className="muted">{t('shell.generationBudgetScope')}</p><p className="muted">{t('shell.generationUnknownNoRetry')}</p></div><Button variant="ghost" className="button primary full" data-testid="confirm-live-generation" onClick={() => confirmGeneration(realConfirm)}>{t('shell.generationConfirmSend')}</Button></div></Modal>}
    </WorkspaceVisibilityProvider>
    {comparisonId && <VersionComparison key={`${data.project?.id}:${projectEpoch.current}:${comparisonId}`} context={comparisonContext()} getContext={comparisonContext}
      onClose={() => setComparisonId(null)} onUse={useComparedVersion} busy={Boolean(busy[`version:${comparisonId}`])}
      onRegisterMediaPause={registerComparisonPreviewPause} onBeforePlay={() => { audioPreview.controller.revoke(); nativePreviewPause.current?.(); exportPreviewPause.current?.(); }} />}
  </main></>;
}
