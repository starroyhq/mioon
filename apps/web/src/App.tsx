import {WorkbenchIcon} from '@mioon/ui/components/workbench-icons';
import {touchesLockedTrack} from './timeline-track-locks.ts';
import {useExportActivity} from './use-export-activity.ts';
import {useTaskDispositions} from './task-disposition-client.ts';
import TaskPopover from './TaskPopover.tsx';
import Login from './LoginScreen.tsx';
import CanvasToolbar from './CanvasToolbar.tsx';
import CanvasEmptyState from './CanvasEmptyState.tsx';
import StoryboardStrip from './StoryboardStrip.tsx';
import SettingsWorkspace from './SettingsWorkspace.tsx';
import SettingsVideoTools from './SettingsVideoTools.tsx';
import SettingsAppearance, { UiPreferencesNotice } from './SettingsAppearance.tsx';
import { useUiPreferences } from './UiPreferencesProvider.tsx';
import { WorkbenchTopbar, WorkbenchInspectorTabs } from './WorkbenchShell.tsx';
import { WorkbenchButton, WorkbenchDialogContent } from '@mioon/ui/components/workbench-controls';
import { savedClipLoudnessFields } from './timeline-clip-loudness-context.ts';
import './version-comparison.css';
import VersionComparison from './VersionComparison.tsx';
import { comparisonCurrent } from './version-comparison-state.ts';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { preflightErrorMessage, preflightIssueMessage, exportCapabilityMessage } from './export-preflight-state.ts';
import ExportPreview from './ExportPreview.tsx';
import { isExportPreviewRange, suggestedExportPreviewRange, exportPreviewContextKey, exportPreviewResult } from './export-preview-state.ts';
import ComfyImageSettings from './ComfyImageSettings.tsx';
import ImageSettings from './ImageSettings.tsx';
import AgentSettings from './AgentSettings.tsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import ProjectHomeConnections from './ProjectHomeConnections.tsx';
import { providerDisplayName, jobStatusDescriptor, statusDescriptor } from './creation-i18n.ts';
import { message as msg, renderMessage as renderCoreMessage, type DisplayMessage } from '../../../packages/i18n/src/index.ts';
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
import RestoredWorkspace, { RestoredUnavailable } from './RestoredWorkspace.tsx';
import { deriveTimelineAssetUsage, retainTimelineAssetUsage } from './timeline-asset-usage.ts';
import { locateTimelineAssetUse, matchesTimelineAssetUse, revealTimelineAssetUse } from './timeline-asset-navigation.ts';
import { pinNewWorkspaceIntent, assertWorkspaceIntent, workspaceIntentDisposition, workspaceOriginScope, retainWorkspaceIdentity } from './workspace-origin.ts';
import { assertWorkspaceOperation, validateProjectWorkspace, RESTORE_DISABLED_MESSAGE } from './restored-workspace.ts';
import { Badge } from '@mioon/ui/components/badge';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@mioon/ui/components/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@mioon/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { WorkbenchTooltip } from './WorkspaceControls.tsx';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {SubjectReference} from '@mioon/contracts';
import type {NativeAudioPreviewBridge} from '@mioon/contracts/native-audio-preview';
import type {ClipInspectorSnapshot, ClipInspectorRetention} from './clip-inspector-retention.ts';
import type {ReplacementReview} from './clip-source-replacement.ts';
import type {ExportRangeDraft, ExportRangeContext} from './export-range-state.ts';
import type {DeliveryNameContext, DeliveryNameState} from './export-delivery-state.ts';
import {createTimelineDeliveryNameController} from './export-delivery-state.ts';
import type {LocalDeliveryContext, LocalDeliveryController, LocalDeliveryState} from './local-delivery-state.ts';
import type {SubtitleContext, SubtitleIntent, SubtitleState} from './subtitle-state.ts';
import {createSubtitleController} from './subtitle-state.ts';
import type {TimelineFormatContext, TimelineFormatIntent, TimelineFormatState} from './timeline-format-state.ts';
import {createTimelineFormatController} from './timeline-format-state.ts';
import type {TimelineClipLoudnessContext} from './timeline-clip-loudness-state.ts';
import type {TimelineMixLoudnessContext, TimelineMixLoudnessController, TimelineMixLoudnessState} from './timeline-mix-loudness-state.ts';
import type {SubtitleTimeline} from './subtitle-state.ts';
import type {TimelineAudioPreviewContext} from './use-timeline-audio-preview.ts';
import type {ComparisonBinding, ComparisonContext} from './version-comparison-state.ts';
import type {TaskWorkspaceContext} from './task-workspace-intent.ts';
import type {GenerationAsset, GenerationProvider, GenerationShot} from './generation-settings.ts';
import type {LastProjectController} from './last-project-state.ts';
import type {SettingsNavigationRegistry} from './settings-navigation-state.ts';
import type {HomeConnectionSlot} from './ProjectHomeConnections.tsx';
import type {SettingsPage} from './settings-window-state.ts';
import type {NativeCloseRegistry} from './native-close-state.ts';
import type {ProjectOpenAttempt} from './project-open-state.ts';
import type {ImageEditIntent} from './image-edit-intent.ts';
import type {EditorWindowBinding} from './editor-native-window.ts';
import type {PendingData, PendingEntry} from './submissions.ts';
import type {ProjectWindowSettingsSlot} from './desktop-window-client.ts';
import type {FitPadding} from './canvas-fit.ts';
import type {FitViewOptions} from '@xyflow/react';
import type {NativeEntryCloseSnapshot} from './native-entry-close.ts';
import type {SubjectState} from './subject-state.ts';
import {createSubjectController} from './subject-state.ts';
import type {TimelineLoudnessApplyController} from './timeline-loudness-apply-state.ts';
import { schemas as productionSchemas, TIMELINE_EXPORT_DEFAULT_SETTINGS, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse as productionTimelineMutationResponse, isTimelineRenderRecord as productionTimelineRenderRecord, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, isSubjectGenerationResponse, isSubjectGenerationRetryResponse } from '@mioon/contracts';
import { readOpacityCandidateApplication } from './opacity-candidate-application.ts';
import OpacityRestoredNotice from './OpacityRestoredNotice.tsx';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, useReactFlow, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react';
import { measuredFitPadding } from './canvas-fit.ts';
import { chooseCanvasPosition } from './canvas-position.ts';
import { staleClipSources } from './timeline-source-freshness.ts';
import Icon from './icons.tsx';
import BrandMark from './BrandMark.tsx';
import ProjectHome from './ProjectHomeScreen.tsx';
import './project-home.css';
import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { readNativeLegacyClose } from './native-close-legacy.ts';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, hasProjectResponseOriginMismatch, projectOpenFailureKind } from './project-open-state.ts';
import Inspector from './Inspector.tsx';
import SubjectVideoSummary from './SubjectVideoSummary.tsx';
import { subjectVideoIdentity, subjectVideoProfileIdentity, ARK_SUBJECT_WARNING_MESSAGE, MOCK_SUBJECT_WARNING_MESSAGE } from './subject-video.ts';
import { VideoFrameSummary } from './VideoFrameControls.tsx';
import TaskCenter from './TaskCenter.tsx';
import { captureTaskWorkspaceIntent, navigateTaskShot } from './task-workspace-intent.ts';
import { createEditTaskController } from './edit-task-controller.ts';
import { isDurableEditOperation, taskInputKey } from './edit-task-client.ts';
import AgentWorkspace, { AgentDockPane } from './AgentWorkspace.tsx';
import { makeAgentTimelineClipSelection, makeAgentTimelineGainSelection, agentTimelineGainBlockedReason, agentTimelineGainBlockedDescriptor } from './agent-timeline-context.ts';
import ImageGeneration from './ImageGeneration.tsx';
import { captureImageEditIntent, imageEditIntentSource } from './image-edit-intent.ts';
import AssetLibrary from './AssetLibrary.tsx';
import CompactPanelRail from './CompactPanelRail.tsx';
import { useSubjects } from './use-subjects.ts';
import { useAssetAnnotations } from './use-asset-annotations.ts';
import { annotationKey, annotationError } from './asset-annotation-state.ts';
import { useAssetDispositions } from './use-asset-dispositions.ts';
import { dispositionKey } from './asset-disposition-state.ts';
import ExportHistoryList from './ExportHistoryList.tsx';
import DeliveryWorkspace from './DeliveryWorkspace.tsx';
import TimelineExportPreflight from './TimelineExportPreflight.tsx';
import { useExportPreflight } from './use-export-preflight.ts';
import { useExportSamplePeak } from './use-export-sample-peak.ts';
import { useExportLoudness } from './use-export-loudness.ts';
import { useTimelineMixLoudness } from './use-timeline-mix-loudness.ts';
import TimelineMixLoudness from './TimelineMixLoudness.tsx';
import TimelineLoudnessApply from './TimelineLoudnessApply.tsx';
import { useTimelineLoudnessApply } from './use-timeline-loudness-apply.ts';
import { timelineLoudnessApplyRecoveryScope } from './timeline-loudness-apply-state.ts';
import { submitTimelineLoudnessApply } from './timeline-loudness-apply-submit.ts';
import { timelineMixLoudnessViewState } from './timeline-mix-loudness-state.ts';
import { useExportSettings } from './use-export-settings.ts';
import { useTimelineDeliveryName } from './export-delivery-state.ts';
import { useLocalDelivery } from './local-delivery-state.ts';
import DeliveryDraftRecovery from './DeliveryDraftRecovery.tsx';
import Timeline, { ASSET_DRAG, assetKind, dragAsset } from './Timeline.tsx';
import TimelineInspector from './TimelineInspector.tsx';
import { retainClipInspector, retainClipWorkbench } from './clip-inspector-retention.ts';
import { canEditTimelineAudioRole, canEditTimelineVolumeEnvelope, isWorkspaceRestoreInspection } from '@mioon/contracts';
import { observeClipAudioRoleCapability } from './clip-audio-role-state.ts';
import { observeClipVolumeEnvelopeCapability } from './clip-volume-envelope-capability.ts';
import SubtitleInspector from './SubtitleInspector.tsx';
import { useSubtitles } from './use-subtitles.ts';
import { subtitleAcknowledged } from './subtitle-state.ts';
import TimelineFormatPanel from './TimelineFormatPanel.tsx';
import WorkspaceBackupPanel from './WorkspaceBackupPanel.tsx';
import { useTimelineFormat } from './use-timeline-format.ts';
import { timelineFormatAcknowledged } from './timeline-format-state.ts';
import { clipReplacementAcknowledged, clipReplacementErrorDescriptor, clipReplacementReviewIssue } from './clip-source-replacement.ts';
import Preview from './Preview.tsx';
import SourceRangeInspector from './SourceRangeInspector.tsx';
import FrameExtractionPanel from './FrameExtractionPanel.tsx';
import { useFrameExtraction } from './use-frame-extraction.ts';
import { frameCaptureBusy } from './frame-extraction.ts';
import { useSourceRange } from './use-source-range.ts';
import { sourceRangeAddPlan, sameSourceSnapshot } from './source-range-state.ts';
import { Media, nodeTypes } from './Nodes.tsx';
import { rpc as productionRpc, requestId, activeJob, assetUrl, versionUrl } from './api.ts';
import { importAcknowledged, importBusyFeedback, importFeedback, renderImportFeedback } from './import-feedback.ts';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel, inputModeDescriptor, generationInputIssueDescriptor, providerAvailabilityDescriptor, generationReferences, generationReferenceIdentity } from './generation-settings.ts';
import { pendingForProject, prepareSubmission, prepareRequestReplay, readPending, clearPending, reconcilePending, isSubjectRetryPending } from './submissions.ts';
import { isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse } from './mutation-submissions.ts';
import { defaultWorkspaceState, reconcileWorkspaceState, sourceForAsset } from './workspace-state.ts';
import { createWorkspacePreferences } from './workspace-preferences.ts';
import { createLastProjectController } from './last-project-state.ts';
import LastProjectStatus from './LastProjectStatus.tsx';
import TopbarSaveStatus from './TopbarSaveStatus.tsx';
import { chooseInitialProject, retainLastProjectScope, createProjectBootGuard, assertLastProjectBootIdentity } from './last-project-navigation.ts';
import { migrateBrowserStorage } from './storage-migration.ts';
import { timelineHistoryState } from './timeline-history.ts';
import { timelineHistoryActionForKey, timelineSplitActionForKey } from './timeline-keyboard.ts';
import { timelineSplitState } from './timeline-split.ts';
import { assetTimelineDuration } from './timeline-snapping.ts';
import { defaultWorkspaceLayout } from './workspace-layout.ts';
import { PanelBoundary, PanelRecall, PanelResizeHandle, usePanelGeometry } from './WorkspacePanels.tsx';
import { REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, isReferenceEdge, referenceForShot, isReferenceOperation, hasPendingReference, isImageReferenceNode, referenceAttachIssueDescriptor, canvasEdge } from './reference-connections.ts';


// Local view/state types. Runtime values stay untyped where the legacy modules
// that own them are still being migrated; these interfaces describe exactly the
// fields this shell reads and writes.
export type WorkspaceMode = 'canvas' | 'editing';
export type AuthState = true | false | 'error' | null;
export type CapabilityStatus = string;
export type ToastTone = 'success' | 'warning' | 'error';
export interface AppProject {id: string; name: string; description?: string; revision: number; createdAt?: string; updatedAt?: string; [key: string]: unknown}
export interface AppAsset extends GenerationAsset {id: string; name: string; mimeType: string; sizeBytes: number}
export interface AppShot extends GenerationShot {
  id: string; projectId: string; title: string; orderIndex: number; revision: number;
  subjectReference?: SubjectReference | null;
  [key: string]: unknown;
}
export interface AppNode {
  id: string; projectId?: string; type: string; label?: string; text?: string; assetId?: string | null;
  position: {x: number; y: number}; revision?: number; [key: string]: unknown;
}
export interface AppEdge {
  id: string; projectId?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null;
  kind?: string; role?: string; sourceAssetId?: string; createdAt?: string; [key: string]: unknown;
}
export interface AppJob {
  id: string; projectId: string; shotId?: string; status: string; providerId?: string; model?: string;
  progress?: number; versionId?: string | null; snapshot?: Record<string, unknown> | null; allowedActions?: string[];
  error?: {code?: string; message?: string} | null; createdAt?: string; updatedAt?: string; [key: string]: unknown;
}
export interface AppVersion {
  id: string; projectId: string; shotId: string; number: number; assetId?: string; sha256?: string; url?: string;
  isMock?: boolean; snapshot?: Record<string, unknown>; createdAt?: string; [key: string]: unknown;
}
export interface AppExport {
  id: string; projectId?: string; mode?: string; status: string; progress?: number; createdAt: string;
  snapshot?: {exportRange?: unknown; deliveryName?: unknown; [key: string]: unknown} | null; [key: string]: unknown;
}
export interface AppTimelineClip {
  id: string; trackId: string; assetId: string; name: string; startFrame: number; durationFrames: number;
  sourceInFrame: number; rect: {x: number; y: number; width: number; height: number}; gain: number;
  fadeInFrames?: number; fadeOutFrames?: number; colour?: unknown; audioRole?: unknown; volumeEnvelope?: unknown;
  versionId?: string; shotId?: string; jobId?: string; [key: string]: unknown;
}
export interface AppTimelineTrack {id: string; name: string; kind: 'video' | 'audio'; orderIndex: number; hidden: boolean; muted: boolean; [key: string]: unknown}
export interface AppTimelineCue {id: string; text?: string; startFrame: number; durationFrames: number; [key: string]: unknown}
export interface AppTimeline {
  id: string; projectId: string; revision: number; fps: number; width: number; height: number;
  tracks: AppTimelineTrack[]; clips: AppTimelineClip[]; durationFrames: number; createdAt: string; updatedAt: string;
  subtitles?: {cues: AppTimelineCue[]; [key: string]: unknown} | null; [key: string]: unknown;
}
export interface AppRestore {heldExportIds: string[]; [key: string]: unknown}
export interface AppData {
  project: AppProject | null;
  assets: AppAsset[];
  shots: AppShot[];
  nodes: AppNode[];
  edges: AppEdge[];
  jobs: AppJob[];
  versions: AppVersion[];
  exports: AppExport[];
  timeline: AppTimeline | null;
  timelineHistory: AppTimelineHistory | null;
  restore?: AppRestore | null;
}
export interface AppTimelineHistory {[key: string]: unknown}
export interface CanvasViewState {
  selectedId: string | null; selectedEdgeId: string | null; inspectorTab: string;
  storyboardOpen: boolean; miniMap: boolean; highlightedVersionId: string | null;
  viewport: {x: number; y: number; zoom: number} | null;
  [key: string]: unknown;
}
export interface EditingViewState {
  selectedClipId: string | null; quickAssetId: string | null; previewKind: string; playhead: number;
  timelineCollapsed: boolean; [key: string]: unknown;
}
export interface SharedViewState {assetFilter: string; assetSearch: string; [key: string]: unknown}
export interface LayoutModeState {assetsWidth: number; inspectorWidth: number; timelineHeight: number; assetsCollapsed: boolean; inspectorCollapsed: boolean; [key: string]: unknown}
export type ViewState = ReturnType<typeof import('./workspace-state.ts').normalizeWorkspaceState>;
export interface WorkspaceState {restored?: boolean; workspaceOrigin?: string | null; workspaceScope?: string | null; channel?: string; root?: string; [key: string]: unknown}
export type ProviderRecord = GenerationProvider;
export interface ToastState {message: AppMessage; type: ToastTone; time: number}
export interface ProjectOpening {phase: 'home' | 'opening' | 'ready' | 'error'; projectId: string | null; error: AppMessage}
export interface ProjectListStatus {busy: boolean; error: AppMessage}
export interface PreferenceStatus {phase: string; pending: boolean; error?: unknown}
export interface WebSettingsRequest {page: SettingsPage; resolve: (value: boolean) => void}
export interface TaskItem {id: string; projectId: string; lane: string; operation: string; status: string; revision: number; [key: string]: unknown}
export interface TaskState {phase: string; items: TaskItem[]; uncertain: unknown[]; busy: unknown[]; error: unknown; heldIds?: string[]; [key: string]: unknown}
export interface GenerationOptionState {
  providerId?: string; model?: string; scenario?: string; inputMode?: string;
  subjectReference?: AppSubjectReference | null; [key: string]: unknown;
}
export type AppSubjectReference = SubjectReference;
export interface GenerationReviewArgs {
  shot: AppShot; providerId: string; model?: string; scenario?: string; inputMode?: string;
  retryJobId?: string; subjectReference?: AppSubjectReference | null; expectedRetrySnapshot?: unknown;
  taskViewGuard?: () => boolean; referenceAssets?: AppAsset[]; referenceIdentity?: unknown; subjectProviderIdentity?: unknown;
  approvalContext?: unknown; approvalView?: unknown; [key: string]: unknown;
}
export interface ReviewOutcome {dispatched: boolean; rejected: boolean}
export interface RunOptions {
  replay?: boolean; returnAfterNavigation?: boolean; validateResponse?: (value: unknown) => void;
  onFailure?: (error: unknown, outcome: ReviewOutcome) => void; errorMessage?: (error: unknown) => AppMessage;
  expectedSubjectReference?: unknown; subjectRetry?: boolean; expectedRetrySnapshot?: unknown; pendingEntry?: PendingEntry;
  canExecute?: (preparedTask: unknown) => boolean; canRevealTasks?: () => boolean; [key: string]: unknown;
}

export type SubtitlesRuntime = {state: SubtitleState | null; controller: ReturnType<typeof createSubtitleController>};
export type TimelineFormatRuntime = {state: TimelineFormatState | null; controller: ReturnType<typeof createTimelineFormatController>};
export type DeliveryNameRuntime = {scope: string; value: string; version: number; dirty: boolean; error: string; controller: ReturnType<typeof createTimelineDeliveryNameController>};
export type ExportSettingsRuntime = {scope: string; version: number; value: unknown; controller: ReturnType<typeof import('./export-settings-state.ts').createExportSettingsController>};
export type ExportRangeRuntime = {value: unknown; draft: ExportRangeDraft | null; error: AppMessage; scope: string | null; version: number; controller: ReturnType<typeof import('./export-range-state.ts').createExportRangeController>};
export type SourceRangeRuntime = {state: import('./source-range-state.ts').SourceRangeState; controller: ReturnType<typeof import('./source-range-state.ts').createSourceRangeController>};
export type FrameExtractionRuntime = {state: import('./frame-extraction.ts').FrameExtractionState; controller: ReturnType<typeof import('./frame-extraction.ts').createFrameExtractionController>};
export type DispositionsRuntime = {state: Record<string, unknown> | null; controller: ReturnType<typeof import('./asset-disposition-state.ts').createAssetDispositionController>};
export type AnnotationsRuntime = {state: import('./asset-annotation-state.ts').AnnotationState | null; controller: ReturnType<typeof import('./asset-annotation-state.ts').createAssetAnnotationController>};
export type TimelineMixLoudnessRuntime = {state: TimelineMixLoudnessState; controller: TimelineMixLoudnessController};
export type ExportPreflightHookState = {report?: {issues?: {code?: string; severity?: string; message?: string}[]}; error?: unknown; errorCode?: string; capabilityPhase?: string; phase?: string; binding?: unknown; attempted?: boolean; connected?: boolean} | null;
export type ExportPreflightRuntime = {state: ExportPreflightHookState; controller: ReturnType<typeof import('./export-preflight-state.ts').createExportPreflightController>};
export type ExportSamplePeakRuntime = {state: unknown; controller: unknown};
export type LocalDeliveryRuntime = {state: LocalDeliveryState; controller: LocalDeliveryController};
export type TimelineLoudnessApplyRuntime = {state: unknown; controller: TimelineLoudnessApplyController};
export type SubjectsRuntime = {state: SubjectState | null; controller: ReturnType<typeof createSubjectController>};
export type ClipDraftController = ReturnType<typeof import('./clip-draft-state.ts').createClipDraftController>;
export type ShotTextController = ReturnType<typeof import('./local-shot-text-state.ts').createLocalShotTextController>;
export interface CapturedContext {projectId: string | null; epoch: number; workspace: WorkspaceState | null}
export type AppMessage = DisplayMessage | string;
export type TaskRevealContext = TaskWorkspaceContext;
export type TaskViewContext = TaskWorkspaceContext;
export interface AssetDropSnapshot {projectId?: string | null; durationFrames?: number; expectedRevision?: number; [key: string]: unknown}
export type {ComparisonBinding};
export type SourceRangeSnapshot = import('./source-range-state.ts').SourceRangeSnapshot;
export type TimelineMutationOptions = RunOptions;
export type DraftRangeInput = ExportRangeDraft & {scope?: string; version?: number};
export interface StringPatch {[key: string]: unknown}
export type {TimelineFormatIntent};
export type {SubtitleIntent};
export type ClipReplacementReview = ReplacementReview;
export interface MediaPause {(): void}
export type NativeWindowLike = EditorWindowBinding;
export interface NativeProjectEntryLike {
  open(projectId: string): Promise<boolean> | boolean; show(mode: string): Promise<unknown> | unknown;
  readCloseSnapshot(): unknown; [key: string]: unknown;
}
export interface AppProps {
  nativeWindow?: NativeWindowLike | null;
  nativeProjectEntry?: NativeProjectEntryLike | null;
  opacityApplication?: unknown;
}
export interface ModalProps {title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; onClose: () => void; wide?: boolean}
export interface CreateProjectProps {onClose: () => void; onCreate: (name: string, description: string, timelinePresetId?: string) => unknown; busy?: boolean}
export interface SettingsConnectionFormsProps {
  selected: HomeConnectionSlot; page: SettingsPage; visible: boolean; registry: SettingsNavigationRegistry;
  onSelect: (slot: HomeConnectionSlot) => void; onPage: (page: SettingsPage) => void; general: React.ReactNode;
  connectionsAvailable?: boolean; beforeClose?: () => unknown; onClose?: () => void;
}
declare global {
  interface Window {
    __mioonNativeAudioPreview?: unknown;
    __mioonUiPreferences?: {reload?: () => Promise<void> | void; markOpened?: (projectId: string) => Promise<void> | void; [key: string]: unknown};
    __mioonNativeCloseAdmission?: {suppressLifecycleFlush?: (event: Event) => boolean; [key: string]: unknown};
  }
  var __mioonFlushWorkspacePreferences: (() => Promise<boolean>) | undefined;
}

const emptyData: AppData = { project: null, assets: [], shots: [], nodes: [], edges: [], jobs: [], versions: [], exports: [], timeline: null, timelineHistory: null };
const emptyBusy: Readonly<Record<string, boolean>> = Object.freeze({});
// These web logic modules are still inferred from untyped implementation
// signatures; keep the call sites precise without changing their runtime shape.
const flowFitPadding = (value: FitPadding): FitViewOptions['padding'] => value as unknown as FitViewOptions['padding'];
// Canvas fits leave room for the docks, heading and storyboard that float over the full-bleed pane.
const canvasFitPadding = (fallback: number): FitPadding => measuredFitPadding(document.querySelector('[data-testid="canvas-drop-zone"]'), fallback) as FitPadding;
function localizedError(displayMessage: AppMessage | null | undefined): Error & {displayMessage: AppMessage} {
  const message: AppMessage = displayMessage ?? '';
  return Object.assign(new Error(renderCoreMessage('zh-Hans', message)), { displayMessage: message });
}
function readableError(error: unknown): AppMessage {
  const failure = error as {displayMessage?: unknown; code?: unknown} | null | undefined;
  if (failure?.displayMessage) return failure.displayMessage as AppMessage;
  if (failure?.code === 'CONFLICT' || failure?.code === 'REVISION_CONFLICT') return msg('shell.error.conflict');
  if (['CLIP_OVERLAP', 'TIMELINE_OVERLAP', 'OVERLAP'].includes(failure?.code as string)) return msg('shell.error.overlap');
  if (failure?.code === 'UNAUTHORIZED') return msg('shell.error.unauthorized');
  if (failure?.code === 'STORAGE_MIGRATION_BLOCKED') return msg('shell.error.storageMigration');
  if (['WORKSPACE_ORIGIN_UNVERIFIED', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'].includes(failure?.code as string)) return msg('tasks.unverifiedWorkspace');
  if (failure?.code === 'RESTORED_RECORD_HELD') return msg('tasks.heldReason');
  if (failure?.code === 'RESTORE_WORKSPACE_ORIGIN_MISMATCH') return msg('shell.error.workspaceChanged');
  if (failure?.code === 'WORKSPACE_INTENT_ALREADY_PINNED') return msg('shell.error.workspacePinned');
  if (failure?.code === 'RESTORE_OPERATION_UNAVAILABLE') return msg('recovery.restored.disabledReason');
  if (failure?.code === 'RESTORE_BACKUP_UNAVAILABLE') return msg('recovery.restored.backupReason');
  if (failure?.code === 'LAST_PROJECT_SCOPE_MISMATCH') return msg('shell.error.lastProjectScope');
  return msg('shell.error.incomplete');
}
function Modal({ title, subtitle, children, onClose, wide = false }: ModalProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={`modal ${wide ? 'wide' : ''}`} showCloseButton={false}><header className="modal-header"><div><DialogTitle>{title}</DialogTitle><DialogDescription className={subtitle ? '' : 'sr-only'}>{subtitle || title}</DialogDescription></div><DialogClose render={<Button variant="ghost" className="icon-button" aria-label={t('shell.closeDialog')} />}><Icon name="close" /></DialogClose></header>{children}</DialogContent></Dialog>;
}
function CreateProject({ onClose, onCreate, busy }: CreateProjectProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  return <Modal title={t('projects.newStory')} subtitle={t('projects.newStoryHint')} onClose={onClose}><form className="modal-form" onSubmit={e => { e.preventDefault(); onCreate(name.trim(), description.trim()); }}><Label className="field-label" htmlFor="project-name">{t('projects.name')}</Label><Input id="project-name" data-testid="project-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('projects.namePlaceholder')} maxLength={150} required autoFocus /><Label className="field-label" htmlFor="project-description">{t('projects.direction')}<span className="optional">{t('shell.optional')}</span></Label><Textarea id="project-description" rows={3} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('projects.directionPlaceholder')} /><Button variant="ghost" className="button primary full" data-testid="create-project-submit" disabled={!name.trim() || busy} type="submit"><Icon name="plus" size={16} />{t('projects.create')}</Button></form></Modal>;
}

export function SettingsConnectionForms({ selected, page, visible, registry, onSelect, onPage, general, connectionsAvailable = true, beforeClose, onClose }: SettingsConnectionFormsProps) { const { t } = useI18n(); return <ProjectHomeConnections active={visible} workspace={<SettingsWorkspace active={visible && page === 'workspace'}><WorkspaceVisibilityProvider visible={visible && page === 'workspace'}><WorkspaceBackupPanel embedded scope="settings:workspace" getScope={() => 'settings:workspace'} connected={connectionsAvailable && visible && page === 'workspace'} read={(input: unknown, options: unknown) => productionRpc('workspace.backup.inspect', input as never, options as never)} /></WorkspaceVisibilityProvider></SettingsWorkspace>} videoTools={<SettingsNavigationSlot registry={registry} slot="home:video-tools">{report => <SettingsVideoTools active={visible && page === 'video-tools'} onNavigationStateChange={report} />}</SettingsNavigationSlot>} selected={selected} page={page} connectionsAvailable={connectionsAvailable} onSelect={onSelect} onPage={onPage} general={<>{general}<SettingsNavigationSlot registry={registry} slot="home:appearance">{report => <SettingsAppearance active={visible && page === 'general'} onNavigationStateChange={report} />}</SettingsNavigationSlot></>} panes={{
  agent: <AgentDockPane visible={visible && connectionsAvailable && page === 'agent'}><SettingsNavigationSlot registry={registry} slot="home:agent">{report => <AgentSettings closeLabel={t('common.closeSettings')} beforeClose={beforeClose as unknown as () => void} onClose={onClose as unknown as () => void} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  official: <AgentDockPane visible={visible && connectionsAvailable && page === 'official'}><SettingsNavigationSlot registry={registry} slot="home:official">{report => <ImageSettings active={visible && connectionsAvailable && page === 'official'} contextKey="native-settings" closeLabel={t('common.closeSettings')} slot="official" onSelectSlot={onSelect as unknown as () => void} onRequestSelectSlot={onSelect as unknown as () => void} beforeClose={beforeClose as unknown as () => void} onClose={onClose as unknown as () => void} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  custom: <AgentDockPane visible={visible && connectionsAvailable && page === 'custom'}><SettingsNavigationSlot registry={registry} slot="home:custom">{report => <ImageSettings active={visible && connectionsAvailable && page === 'custom'} contextKey="native-settings" closeLabel={t('common.closeSettings')} slot="custom" onSelectSlot={onSelect as unknown as () => void} onRequestSelectSlot={onSelect as unknown as () => void} beforeClose={beforeClose as unknown as () => void} onClose={onClose as unknown as () => void} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  comfy: <AgentDockPane visible={visible && connectionsAvailable && page === 'comfy'}><SettingsNavigationSlot registry={registry} slot="home:comfy">{report => <ComfyImageSettings client={undefined as never} active={visible && connectionsAvailable && page === 'comfy'} contextKey="native-settings" closeLabel={t('common.closeSettings')} onSelectSlot={onSelect as unknown as () => void} onRequestSelectSlot={onSelect as unknown as () => void} beforeClose={beforeClose as unknown as () => void} onClose={onClose as unknown as () => void} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
}} />; }

export default function App({ nativeWindow = null, nativeProjectEntry = null, opacityApplication = null }: AppProps = {}) {
  // This capability comes only from the isolated build entry. Server payloads,
  // URL parameters and copied profile metadata cannot select candidate codecs.
  const requestedApplication = readOpacityCandidateApplication(opacityApplication);
  const applicationOwner = useRef(requestedApplication);
  const application = applicationOwner.current;
  if (application !== requestedApplication) throw new TypeError('Application entry cannot change while mounted.');
  const rpc = application?.rpc ?? productionRpc;
  const schemas = application?.schemas ?? productionSchemas;
  const isTimelineMutationResponse = application?.isTimelineMutationResponse ?? productionTimelineMutationResponse;
  const isTimelineRenderRecord = application?.isTimelineRenderRecord ?? productionTimelineRenderRecord;
  const { locale, t, renderMessage, formatDate, formatNumber } = useI18n();
  const { resolvedTheme } = useUiPreferences();
  const isWorkspaceInspection = application?.isWorkspaceInspection ?? isWorkspaceRestoreInspection;
  const confirm = useConfirmation();
  const nativeSettingsScope = useEditorSettingsScope(nativeWindow);
  const [nativeProjectLocation] = useState(() => nativeWindow ? createNativeProjectLocation(window, nativeWindow.context.initialProjectId as string) : null);
  const [nativeAudioAdmission] = useState(() => nativeWindow ? createNativeAudioPreviewAdmission((window.__mioonNativeAudioPreview ?? null) as NativeAudioPreviewBridge | null) : null);
  const [auth, setAuth] = useState<AuthState>(null);
  useEffect(() => { if (auth === true) void window.__mioonUiPreferences?.reload?.(); }, [auth]);
  const [data, setData] = useState(emptyData);
  const [trackLocks,setTrackLocks]=useState<Record<string,readonly string[]>>({});
  const trackLocksRef=useRef(trackLocks);trackLocksRef.current=trackLocks;
  const lockedTrackIds=new Set(trackLocks[data.project?.id||'']||[]);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const workspaceRef = useRef<WorkspaceState | null>(null);
  const [audioRoleCapability, setAudioRoleCapability] = useState<CapabilityStatus>('loading');
  const audioRoleEditable = audioRoleCapability === 'editable';
  const audioRoleProbe = useRef<((() => void) | null)>(null);
  const audioRoleProbeEpoch = useRef(0);
  const restored = workspace?.restored === true;
  const opacityRestored = Boolean(application?.isRestoredWorkspace(workspace));
  const generationUnavailableReason = restored ? RESTORE_DISABLED_MESSAGE : '';
  const dataRef = useRef(data); dataRef.current = data;
  const [projects, setProjects] = useState<AppProject[]>([]);
  const [providers, setProviders] = useState<GenerationProvider[]>([]);
  const [generationOptions, setGenerationOptions] = useState<Record<string, GenerationOptionState>>({});
  const generationOptionsRef = useRef<Record<string, GenerationOptionState>>(generationOptions); generationOptionsRef.current = generationOptions;
  const updateGenerationOptions = useCallback((shotId: string | null, options: GenerationOptionState) => { if (shotId) { const next = { ...generationOptionsRef.current, [shotId]: options }; generationOptionsRef.current = next; setGenerationOptions(next); } }, []);
  const [loading, setLoading] = useState(false);
  const [projectOpening, setProjectOpening] = useState<ProjectOpening>({ phase: 'home', projectId: null, error: '' });
  const openedProject = useRef<unknown>(null);
  const projectCreateFlight = useRef<Record<string, unknown> | null>(null);
  const [homePage, setHomePage] = useState<string>('projects');
  const [webSettingsRequest, setWebSettingsRequest] = useState<WebSettingsRequest | null>(null);
  const webSettingsRequestRef = useRef<WebSettingsRequest | null>(null);
  const [webSettingsOpen, setWebSettingsOpen] = useState(false);
  const [projectListStatus, setProjectListStatus] = useState<ProjectListStatus>({ busy: false, error: '' });
  const projectListSerial = useRef(0);
  const nativeCloseRegistry = useRef<ReturnType<typeof createNativeCloseRegistry> | null>(null);
  if (!nativeCloseRegistry.current) nativeCloseRegistry.current = createNativeCloseRegistry();
  const settingsNavigation = useRef<ReturnType<typeof createSettingsNavigationRegistry> | null>(null);
  if (!settingsNavigation.current) settingsNavigation.current = createSettingsNavigationRegistry();
  const [busyByProject, setBusyByProject] = useState<Record<string, Record<string, boolean>>>({});
  const busyRef = useRef(new Set<string>());
  const editorInputs = useRef<ReturnType<typeof createEditorWindowInputs> | null>(null);
  if (!editorInputs.current) editorInputs.current = createEditorWindowInputs();
  const exportSettingsRef = useRef<{getState(): unknown} | null>(null), exportRangeRef = useRef<{getState(): unknown} | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [showProjects, setShowProjects] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showProjectChooser, setShowProjectChooser] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryAttempt, setDeliveryAttempt] = useState<{projectId: string; id: string} | null>(null);
  const [deliveryReviewVersion, setDeliveryReviewVersion] = useState(0);
  const [showImage, setShowImage] = useState(false);
  const [panelOverlay, setPanelOverlay] = useState<string | null>(null);
  const [rightDockTab, setRightDockTabState] = useState('properties');
  const setRightDockTab = (value: string | ((previous: string) => string)) => { if (!clipDraftRef.current?.hasPendingComposition()) setRightDockTabState(value); };
  const [propertiesPage, setPropertiesPageState] = useState('inspector');
  const setPropertiesPage = (value: string | ((previous: string) => string)) => { if (!clipDraftRef.current?.hasPendingComposition()) setPropertiesPageState(value); };
  const [subtitleDirty, setSubtitleDirty] = useState(false);
  const subtitlesRef = useRef<SubtitlesRuntime | null>(null);
  const [formatDirty, setFormatDirty] = useState(false);
  const timelineFormatRef = useRef<TimelineFormatRuntime | null>(null);
  const timelineLoudnessApplyRef = useRef<TimelineLoudnessApplyRuntime | null>(null);
  const deliveryNameRef = useRef<DeliveryNameRuntime | null>(null);
  const localDeliveryRef = useRef<LocalDeliveryRuntime | null>(null);
  const clipDraftRef = useRef<ClipDraftController | null>(null);
  const [clipCompositionPending, setClipCompositionPending] = useState(false);
  const clipInspectorRetention = useRef<ClipInspectorRetention>({ snapshot: null, retained: false });
  const clipConnectionBlocked = useRef(false);
  const [agentClipDraftBlocked, setAgentClipDraftBlocked] = useState(true);
  const shotTextRef = useRef<ShotTextController | null>(null), shotCloseRef = useRef<{controller: ShotTextController; readLocalClose: unknown} | null>(null);
  const registerShotText = useCallback((controller: ShotTextController, readLocalClose: unknown) => {
    const owner = { controller, readLocalClose };
    shotTextRef.current = controller; shotCloseRef.current = owner;
    return () => { if (shotCloseRef.current === owner) { shotCloseRef.current = null; if (shotTextRef.current === controller) shotTextRef.current = null; } };
  }, []);
  const registerClipDraft = useCallback((controller: ClipDraftController) => {
    clipDraftRef.current = controller;
    return () => { if (clipDraftRef.current === controller) clipDraftRef.current = null; };
  }, []);
  const [agentPage, setAgentPage] = useState<string>('chat');
  const agentDraft = useRef(false);
  const onAgentDraftChange = useCallback((value: boolean) => { agentDraft.current = value; }, []);
  const imageDraft = useRef(false);
  const [imageEditIntent, updateImageEditIntent] = useState<unknown>(null), imageEditIntentRef = useRef<unknown>(null);
  const setImageEditIntent = (intent: unknown) => { imageEditIntentRef.current = intent; updateImageEditIntent(intent); };
  const onImageDraftChange = useCallback((value: boolean) => { imageDraft.current = value; }, []);
  const [showExports, setShowExports] = useState(false);
  const [comparisonId, updateComparisonId] = useState<string | null>(null);
  const comparisonIdRef = useRef<string | null>(null);
  const [previewAsset, updatePreviewAsset] = useState<AppAsset | null>(null);
  const previewAssetRef = useRef<AppAsset | null>(null), canvasAssetSelectionRef = useRef<{id: string; projectId: string | null; epoch: number} | null>(null), clipLoudnessEpoch = useRef(0);
  const setPreviewAsset = (value: AppAsset | null) => { previewAssetRef.current = value; if (value) canvasAssetSelectionRef.current = { id: value.id, projectId: currentProject.current, epoch: projectEpoch.current }; clipLoudnessEpoch.current++; updatePreviewAsset(value); };
  const [realConfirm, setRealConfirm] = useState<GenerationReviewArgs | null>(null);
  const realConfirmRef = useRef<GenerationReviewArgs | null>(null);
  const generationReviewScope = useRef<{key?: string} | null>(null);
  realConfirmRef.current = realConfirm;
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [shotDirty, setShotDirty] = useState(false);
  const [clipDirty, setClipDirty] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [subjectDirty, setSubjectDirty] = useState(false);
  const [subjectRefresh, setSubjectRefresh] = useState<Record<string, number>>({});
  const subjectsRef = useRef<SubjectsRuntime | null>(null);
  const [sourceRangeRefresh, setSourceRangeRefresh] = useState<Record<string, number>>({});
  const [dispositionRefresh, setDispositionRefresh] = useState<Record<string, number>>({});
  const [annotationRefresh, setAnnotationRefresh] = useState<Record<string, number>>({});
  const inspectorDirty = shotDirty || clipDirty || sourceDirty || subjectDirty || subtitleDirty;
  const dirtyRef = useRef<boolean>(inspectorDirty); dirtyRef.current = inspectorDirty;

  const [showGuide, setShowGuide] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [online, setOnline] = useState(true);
  const [volumeEnvelopeObservation, setVolumeEnvelopeObservation] = useState<{epoch: number; status: string}>({ epoch: 0, status: 'loading' });
  const volumeEnvelopeProbeEpoch = useRef(0), volumeEnvelopeConnection = useRef<{workspace: WorkspaceState | null; online: boolean; auth: AuthState} | null>(null);
  if (!volumeEnvelopeConnection.current || volumeEnvelopeConnection.current.workspace !== workspace || volumeEnvelopeConnection.current.online !== online || volumeEnvelopeConnection.current.auth !== auth) {
    volumeEnvelopeConnection.current = { workspace, online, auth };
    volumeEnvelopeProbeEpoch.current++;
  }
  const volumeEnvelopeCapability = volumeEnvelopeObservation.epoch === volumeEnvelopeProbeEpoch.current ? volumeEnvelopeObservation.status : online && auth === true ? 'loading' : 'unavailable';
  const volumeEnvelopeEditable = volumeEnvelopeCapability === 'editable';
  clipConnectionBlocked.current = !online || auth !== true || clipInspectorRetention.current.retained;
  const [zoom, setZoom] = useState(100);

  const [mobilePanel, setMobilePanel] = useState('canvas');
  const [sequenceDrag, setSequenceDrag] = useState<unknown>(null);

  const [pending, setPending] = useState<PendingEntry[]>([]);

  const [reconcileIds, setReconcileIds] = useState<Record<string, unknown>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importSession = useRef<{active: boolean; selection: number}>({ active: true, selection: 0 });
  useEffect(() => {
    importSession.current.active = true;
    return () => { importSession.current.active = false; importSession.current.selection++; requestCounter.current++; };
  }, []);
  const currentProject = useRef<string | null>(null);
  const [taskState, setTaskState] = useState<TaskState>({ phase: 'idle', items: [], uncertain: [], busy: [], error: null });
  const tasksRef = useRef<ReturnType<typeof createEditTaskController> | null>(null);
  if (!tasksRef.current) tasksRef.current = createEditTaskController({ ...(application ? { client: application.taskClient } : {}), getWorkspace: () => workspaceRef.current as {restored: boolean}, onChange: ((projectId: string, snapshot: never) => {
    if (currentProject.current === projectId) setTaskState(snapshot as unknown as TaskState);
  }) as unknown as () => void } as unknown as Parameters<typeof createEditTaskController>[0]);
  const navigationEpoch = useRef(0);
  const [, setNavigationPresentation] = useState(0);
  const projectEpoch = useRef(0);
  const preferenceScope = useRef<string | null>(null);
  const locatorIdentity = useRef<unknown>(null);
  const bootGuard = useRef<ReturnType<typeof createProjectBootGuard> | null>(null);
  if (!bootGuard.current) bootGuard.current = createProjectBootGuard(() => projectEpoch.current);
  const [lastProjectStatus, setLastProjectStatus] = useState<unknown>(null);
  const lastProjectRef = useRef<ReturnType<typeof createLastProjectController> | null>(null);
  if (!lastProjectRef.current) lastProjectRef.current = createLastProjectController({
    getEpoch: () => projectEpoch.current, onChange: setLastProjectStatus,
  });
  const [inspectorEpoch, setInspectorEpoch] = useState(0);
  const [view, setView] = useState<ViewState>(() => defaultWorkspaceState() as unknown as ViewState);
  const viewRef = useRef<ViewState>(view); viewRef.current = view;
  const viewReady = useRef(false);
  const [preferenceStatus, setPreferenceStatus] = useState<PreferenceStatus>({ phase: 'loading', pending: false });
  const preferencesRef = useRef<ReturnType<typeof createWorkspacePreferences> | null>(null);
  if (!preferencesRef.current) preferencesRef.current = createWorkspacePreferences({
    getWorkspace: (() => workspaceRef.current) as unknown as () => {restored: boolean}, getStorageScope: (() => lastProjectRef.current!.getState().identityBlocked ? null : preferenceScope.current) as unknown as () => undefined,
    onStatus: ((projectId: string, status: PreferenceStatus) => { if (currentProject.current === projectId) setPreferenceStatus(status); }) as unknown as () => void
  });
  const busy = busyByProject[currentProject.current || 'none'] || emptyBusy;
  const activePending = pending.filter(entry => !workspaceIntentDisposition(entry, workspace).held);
  const activeTasks = taskState.items.filter(task => !taskState.heldIds?.includes(task.id));
  const referencePending = hasPendingReference(activePending as never[]) || activeTasks.some(task => task.lane === 'reference:mutation');
  const referenceBusy = Boolean(busy['reference:mutation'] || referencePending || taskState.phase !== 'ready');
  const updateView = useCallback((section: string, patch: unknown, { passive = false }: {passive?: boolean} = {}) => {
    if (!viewReady.current || dataRef.current!.project?.id !== currentProject.current) return;
    const previous = viewRef.current;
    if (clipDraftRef.current?.hasPendingComposition() && (section === 'activeMode' || section === 'editing')) return;
    const currentSection = (previous as unknown as Record<string, unknown>)[section] as Record<string, unknown>;
    const value = typeof patch === 'function' ? (patch as (value: unknown) => unknown)(currentSection) : patch as Record<string, unknown>;
    const next = (section === 'activeMode' ? { ...previous, activeMode: value as WorkspaceMode } : { ...previous, [section]: { ...currentSection, ...(value as Record<string, unknown>) } }) as unknown as ViewState;
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    if (next.activeMode !== previous.activeMode || ['selectedClipId', 'quickAssetId', 'previewKind'].some(key => (next.editing as unknown as Record<string, unknown>)[key] !== (previous.editing as unknown as Record<string, unknown>)[key])) clipLoudnessEpoch.current++;
    viewRef.current = next; setView(next);
    if (currentProject.current && !application?.isRestoredWorkspace(workspaceRef.current)) {
      const frequent = ['viewport', 'playhead', 'pixelsPerSecond', 'scrollLeft', 'scrollTop', 'assetSearch'];
      const immediate = section === 'activeMode' || Object.keys(value as Record<string, unknown>).some(key => !frequent.includes(key));
      preferencesRef.current!.update(currentProject.current!, next, { immediate, ...(!passive && workspaceRef.current?.restored ? pinNewWorkspaceIntent({}, workspaceRef.current) : {}) });
    }
  }, []);
  const field = (section: 'canvas' | 'editing' | 'shared', key: string) => {
    const owner = currentProject.current, ownerEpoch = projectEpoch.current;
    return (value: unknown) => { if (owner === currentProject.current && ownerEpoch === projectEpoch.current) updateView(section, (previous: ViewState) => ({ [key]: typeof value === 'function' ? (value as (current: unknown) => unknown)((previous[section] as unknown as Record<string, unknown>)[key]) : value })); };
  };
  const { selectedId, selectedEdgeId, inspectorTab: tab, storyboardOpen: sequenceOpen, miniMap, highlightedVersionId } = view.canvas;
  const { selectedClipId, quickAssetId, previewKind, playhead, timelineCollapsed } = view.editing;
  const { assetFilter, assetSearch } = view.shared;
  const [libraryTab, setLibraryTab] = useState<'assets' | 'subjects'>('assets');
  const workspaceMode = view.activeMode as WorkspaceMode;
  const modeLayout = (view.layout as unknown as Record<string, LayoutModeState>)[workspaceMode];
  function projectSessionReady() { return canPublishProjectOpen(openedProject.current as ProjectOpenAttempt | null, { active: importSession.current.active, currentProjectId: currentProject.current, epoch: projectEpoch.current, workspaceScope: workspaceOriginScope(workspaceRef.current) || '', preferencesReady: viewReady.current, dataProjectId: dataRef.current!.project?.id || null, loading: false }); }
  const workbenchReady = auth === true && projectSessionReady() && !loading;
  useEditorWindowStatus(nativeWindow, currentProject.current, projectOpening.phase, workbenchReady);
  const panelSurface = useRef<HTMLDivElement | null>(null), panelIntent = useRef(0), taskWorkspaceState = useRef<{visible: boolean; connected: boolean} | null>(null), taskShotAttempt = useRef(0);
  const [panelChange, setPanelChange] = useState(0);
  const panelScope = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${panelChange}`;
  const geometry = usePanelGeometry(panelSurface, modeLayout, workspaceMode, panelScope, auth === true && workbenchReady, `${currentProject.current}:${projectEpoch.current}:${workspaceMode}`);
  const { assetsCollapsed, inspectorCollapsed } = geometry.effective;
  const markPanelIntent = () => { panelIntent.current++; setPanelChange(value => value + 1); };
  const layoutOwner = currentProject.current, layoutOwnerEpoch = projectEpoch.current;
  function updateModeLayout(mode: WorkspaceMode, patch: Record<string, unknown>) {
    if (layoutOwner !== currentProject.current || layoutOwnerEpoch !== projectEpoch.current) return;
    updateView('layout', (previous: ViewState['layout']) => ({ [mode]: { ...previous[mode], ...patch } }));
  }
  function setPanelOpen(name: string, open: boolean, mode: WorkspaceMode = viewRef.current!.activeMode as WorkspaceMode) {
    if (clipDraftRef.current?.hasPendingComposition() || layoutOwner !== currentProject.current || layoutOwnerEpoch !== projectEpoch.current) return;
    markPanelIntent(); setPanelOverlay(null);
    if (name === 'timeline') updateView('editing', { timelineCollapsed: !open });
    else if (name === 'storyboard') updateView('canvas', { storyboardOpen: open });
    else if (geometry.compact && mode === viewRef.current!.activeMode) geometry.pinPanel(name, open);
    else updateModeLayout(mode, { [name === 'assets' ? 'assetsCollapsed' : 'inspectorCollapsed']: !open });
    if (geometry.narrow && mode === viewRef.current!.activeMode && name !== 'storyboard') {
      if (open) setMobilePanel(name); else if (mobilePanel === name) setMobilePanel('canvas');
    }
  }
  function resetPanelLayout() {
    if (clipDraftRef.current?.hasPendingComposition()) return;
    markPanelIntent(); setPanelOverlay(null); geometry.resetPins(); updateView('layout', { [workspaceMode]: (defaultWorkspaceLayout() as unknown as Record<string, LayoutModeState>)[workspaceMode] });
    if (workspaceMode === 'canvas') updateView('canvas', { storyboardOpen: false });
    else updateView('editing', { timelineCollapsed: false });
    setMobilePanel('canvas');
  }
  function resizePanel(field: string, value: number) { markPanelIntent(); updateModeLayout(workspaceMode as WorkspaceMode, { [field]: value }); }
  function togglePanelOverlay(name: string) { if (clipDraftRef.current?.hasPendingComposition()) return; markPanelIntent(); setPanelOverlay(value => value === name ? null : name); }
  function showCompactLibrary(next: 'assets' | 'subjects') {
    if (clipDraftRef.current?.hasPendingComposition() || next === 'subjects' && application) return;
    markPanelIntent(); setLibraryTab(next); setPanelOverlay('assets');
  }
  function showCompactInspector(next: 'properties' | 'versions' | 'agent') {
    if (clipDraftRef.current?.hasPendingComposition() || next === 'agent' && application) return;
    markPanelIntent();
    if (next === 'agent') { setRightDockTab('agent'); setAgentPage('chat'); }
    else { setRightDockTab('properties'); if (workspaceMode === 'canvas') setTab(next === 'versions' ? 'versions' : 'settings'); }
    setPanelOverlay('inspector');
  }
  useEffect(() => { setPanelOverlay(null); }, [workspaceMode, data.project?.id, geometry.compact, geometry.narrow]);
  const panelVisible = (name: string): boolean => name === panelOverlay || (name === 'canvas' ? !geometry.narrow || mobilePanel === 'canvas' : !(name === 'assets' ? assetsCollapsed : name === 'inspector' ? inspectorCollapsed : timelineCollapsed) && (!geometry.narrow || mobilePanel === name));
  const timelineContainerVisible = panelVisible('timeline') || !geometry.narrow && timelineCollapsed;
  function toggleTimelinePanel() {
    if (workspaceMode !== 'editing' || viewRef.current!.activeMode !== 'editing') return;
    setPanelOpen('timeline', Boolean(viewRef.current!.editing.timelineCollapsed), 'editing');
  }
  function mobileNavigate(name: string) { if (clipDraftRef.current?.hasPendingComposition()) return; if (name === 'canvas') { markPanelIntent(); setMobilePanel('canvas'); } else setPanelOpen(name, true); }
  const panelFallback = (name: string) => geometry.narrow ? `[data-testid=mobile-panel-${name}]` : `[data-testid=reopen-${name}]`;
  const resizeHandle = (name: string, field: 'assetsWidth' | 'inspectorWidth' | 'timelineHeight') => <PanelResizeHandle name={name} field={field} value={geometry.effective[field]} max={geometry.maxima[field]} scope={`${panelScope}:${geometry.size.width}:${geometry.size.height}`} enabled={!geometry.narrow && (name !== 'timeline' || !timelineCollapsed) && panelOverlay !== name && panelVisible(name) && !loading} onPreview={geometry.preview} onCommit={resizePanel} />;
  const setSelectedId = field('canvas', 'selectedId'), setSelectedEdgeId = field('canvas', 'selectedEdgeId'), setTab = field('canvas', 'inspectorTab'), setSequenceOpen = field('canvas', 'storyboardOpen'), setMiniMap = field('canvas', 'miniMap');
  const setSelectedClipId = field('editing', 'selectedClipId'), setQuickAssetId = field('editing', 'quickAssetId'), setPreviewKind = field('editing', 'previewKind'), setPlayhead = field('editing', 'playhead'), setTimelineCollapsed = field('editing', 'timelineCollapsed');
  const setAssetFilter = field('shared', 'assetFilter'), setAssetSearch = field('shared', 'assetSearch');
  const setAssetsCollapsed = (value: boolean) => setPanelOpen('assets', !value), setInspectorCollapsed = (value: boolean) => setPanelOpen('inspector', !value);
  const generationReviewKey = `${workspaceMode}:${selectedId}:${tab}:${rightDockTab}:${propertiesPage}:${JSON.stringify(generationOptions)}`;
  if (generationReviewScope.current?.key !== generationReviewKey) generationReviewScope.current = { key: generationReviewKey };
  const context = (): CapturedContext => ({ projectId: currentProject.current, epoch: navigationEpoch.current, workspace: workspaceRef.current });
  const isCurrent = (captured: CapturedContext): boolean => captured.projectId === currentProject.current && captured.epoch === navigationEpoch.current && workspaceOriginScope(captured.workspace) === workspaceOriginScope(workspaceRef.current);
  taskWorkspaceState.current = { visible: workbenchReady && showTasks, connected: workbenchReady && online && auth === true && !loading };
  const taskViewScope = JSON.stringify([currentProject.current, projectEpoch.current, navigationEpoch.current, panelIntent.current, workspaceMode, showTasks, workspaceOriginScope(workspaceRef.current)]);
  const isBusy = (key: string, projectId: string | null = currentProject.current) => busyRef.current.has(`${projectId || 'none'}:${key}`);
  function markBusy(projectId: string | null, key: string, value: boolean) {
    const scope = projectId || 'none';
    editorInputs.current!.changed();
    if (value) busyRef.current.add(`${scope}:${key}`); else busyRef.current.delete(`${scope}:${key}`);
    setBusyByProject(all => ({ ...all, [scope]: { ...all[scope], [key]: value } }));
  }
  async function guardNavigation(message: AppMessage = msg('shell.confirm.switchWorkspace'), additionalDirty = false, canDiscard: () => boolean = () => true): Promise<boolean> {
    if (clipDraftRef.current?.hasPendingComposition()) return false;
    if (nativeWindow && !editorWindowCanNavigate()) return false;
    if (nativeWindow) { const originalCanDiscard = canDiscard; canDiscard = () => originalCanDiscard() && editorWindowCanNavigate(); }
    const captured = context(), subtitleController = subtitlesRef.current?.controller, subtitleDraft = subtitleController?.getState(), subtitleUnsaved = subtitleController?.hasUnsaved();
    const clipController = clipDraftRef.current, clipCapture = clipController?.capture(), clipUnsaved = clipController?.hasUnsaved();
    const shotController = shotTextRef.current, shotCapture = shotController?.capture(), shotUnsaved = shotController?.hasUnsaved();
    if ((dirtyRef.current || subtitleUnsaved || clipUnsaved || shotUnsaved || additionalDirty) && !await confirm(message)) return false;
    if (clipDraftRef.current?.hasPendingComposition() || !isCurrent(captured) || !canDiscard() || shotController && (shotController !== shotTextRef.current || !shotController.isCurrent(shotCapture!)) || subtitleController && (subtitleController !== subtitlesRef.current?.controller || subtitleController.getState() !== subtitleDraft) || clipController && (clipController !== clipDraftRef.current || !clipController.isCurrent(clipCapture!))) return false;
    if (clipUnsaved && !await clipController!.discard(clipCapture!, canDiscard)) return false;
    if (clipDraftRef.current?.hasPendingComposition() || !isCurrent(captured) || !canDiscard() || shotController && (shotController !== shotTextRef.current || !shotController.isCurrent(shotCapture!)) || clipController && clipController !== clipDraftRef.current || subtitleController && (subtitleController !== subtitlesRef.current?.controller || subtitleController.getState() !== subtitleDraft)) return false;
    if (shotController && !shotController.abandonCurrentInput(shotCapture)) return false;
    if (dirtyRef.current || subtitleUnsaved || clipUnsaved || shotUnsaved) { subtitleController?.discardDraft(); subjectsRef.current?.controller.discardDrafts(subjectsRef.current!.state?.scope); dirtyRef.current = false; setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false); setInspectorEpoch(value => value + 1); }
    return true;
  }
  async function guardProjectNavigation(message: AppMessage, additionalDirty = false, canLeaveSettings: () => boolean = () => true): Promise<boolean> {
    if (clipDraftRef.current?.hasPendingComposition()) return false;
    if (nativeWindow && !editorWindowCanNavigate()) return false;
    const retainedCurrent = () => !nativeWindow || editorWindowCanNavigate();
    const controller = timelineFormatRef.current?.controller, delivery = deliveryNameRef.current?.controller, deliveryCapture = delivery?.capture();
    const formatDraft = controller?.getState?.();
    const localDeliveryController = localDeliveryRef.current?.controller, localDeliveryCapture = localDeliveryController?.capture();
    const canDiscard = () => retainedCurrent() && canLeaveSettings() && !(controller && (controller !== timelineFormatRef.current?.controller || controller.getState?.() !== formatDraft))
      && !(delivery && (delivery !== deliveryNameRef.current?.controller || deliveryCapture && ['scope', 'projectId', 'value', 'version'].some(field => (delivery.getState() as unknown as Record<string, unknown>)[field] !== (deliveryCapture as unknown as Record<string, unknown>)[field])))
      && !(localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.isCurrent(localDeliveryCapture!)));
    if (!await guardNavigation(message, additionalDirty || controller?.hasUnsaved() || delivery?.hasUnsaved(), canDiscard) || !canDiscard()) return false;
    if (localDeliveryController && (localDeliveryController !== localDeliveryRef.current?.controller || !localDeliveryController.abandonCurrentInput(localDeliveryCapture))) return false;
    if (delivery && (delivery !== deliveryNameRef.current?.controller || !delivery.discardDraft(deliveryCapture))) return false;
    controller?.discardDraft();
    return true;
  }
  async function prepareSettingsDeparture(): Promise<unknown> {
    const captured = context(), lifetime = importSession.current.selection, ticket = settingsNavigation.current!.capture();
    if (!settingsNavigation.current!.canLeave(ticket as Parameters<NonNullable<typeof settingsNavigation.current>['canLeave']>[0])) { notify(msg('shell.settingsBusyRetained'), 'warning'); return null; }
    if (settingsNavigation.current!.needsConfirmation(ticket) && !await confirm(msg('shell.confirm.leaveConnections'))) return null;
    return importSession.current.active && importSession.current.selection === lifetime && isCurrent(captured) && settingsNavigation.current!.canLeave(ticket as Parameters<NonNullable<typeof settingsNavigation.current>['canLeave']>[0]) ? ticket : null;
  }
  function openGlobalSettings(page = 'general'): Promise<boolean> {
    if (restored && page !== 'general') { notify(msg('shell.restoredNoConnections'), 'warning'); return Promise.resolve(false); }
    if (nativeWindow) return nativeSettingsScope!.open((page === 'general' ? 'agent' : page) as ProjectWindowSettingsSlot);
    webSettingsRequestRef.current?.resolve?.(false);
    return new Promise(resolve => { const request = { page: page as SettingsPage, resolve }; webSettingsRequestRef.current = request; setWebSettingsRequest(request); });
  }
  async function changeHomePage(page: string): Promise<void> {
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
      setProjects(list as AppProject[]); setProjectListStatus({ busy: false, error: '' });
    } catch (error) {
      if (!importSession.current.active || serial !== projectListSerial.current || scope !== workspaceOriginScope(workspaceRef.current)) return;
      if (projectOpenFailureKind(error) === 'auth') setAuth(false);
      setProjectListStatus({ busy: false, error: readableError(error) });
    }
  }
  async function changeMode(mode: WorkspaceMode): Promise<void> {
    if (application || !viewReady.current || loading || !['canvas', 'editing'].includes(mode) || mode === viewRef.current!.activeMode) return;
    if (!await guardNavigation()) return;
    navigationEpoch.current++; dragging.current = false;
    updateView('activeMode', mode); setMobilePanel('canvas');
    setPreviewAsset(null); setComparisonId(null);
  }
  function revealCanvas(id?: string | null): void {
    const captured = context();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isCurrent(captured) && viewRef.current!.activeMode === 'canvas') flow.fitView({ ...(id ? { nodes: [{ id }] } : {}), padding: flowFitPadding(canvasFitPadding(.25)), duration: 0, minZoom: .65, maxZoom: 1 });
    }));
  }

  const requestCounter = useRef(0);
  const dragging = useRef(false);
  const flow = useReactFlow();
  const notify = useCallback((message: AppMessage, type: ToastTone = 'success') => setToast({ message, type, time: Date.now() }), []);
  useEffect(() => { if (toast && toast.type !== 'error') { const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); } }, [toast]);
  const refresh = useCallback(async (projectId: string | null = currentProject.current, quiet = true, { opening = false }: {opening?: boolean} = {}) => {
    if (!projectId || currentProject.current !== projectId || !opening && !projectSessionReady()) return null;
    const call = ++requestCounter.current, epoch = projectEpoch.current, capturedWorkspace = workspaceRef.current;
    try {
      const [nextRaw, caps] = await Promise.all([rpc('project.get', { projectId }), capturedWorkspace?.restored ? [] : rpc('provider.list')]);
      const next = nextRaw as AppData | null;
      if (!importSession.current.active || currentProject.current !== projectId || epoch !== projectEpoch.current || call !== requestCounter.current || workspaceOriginScope(capturedWorkspace) !== workspaceOriginScope(workspaceRef.current)) return null;
      if (capturedWorkspace?.restored && hasProjectResponseOriginMismatch(next, capturedWorkspace.workspaceOrigin as string)) throw Object.assign(localizedError(msg('shell.error.restoreIdentity')), { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH' });
      validateProjectWorkspace(next as never, capturedWorkspace);
      if (!projectResponseMatches(next as never, projectId)) throw Object.assign(localizedError(msg('shell.error.projectIdentity')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (application && !application.validateProjectSnapshot(next, projectId)) throw Object.assign(localizedError(msg('shell.error.projectIdentity')), { code: 'BACKEND_PROTOCOL_ERROR' });
      reconcilePending(projectId, next as unknown as PendingData, { workspace: capturedWorkspace as never });
      dataRef.current = { ...emptyData, ...(next as AppData) }; setData(dataRef.current); setProviders(caps as GenerationProvider[]); setLastSync(new Date()); setOnline(true); setPending(pendingForProject(projectId as string));
      const retainClipSelection = clipDraftRef.current?.hasPendingComposition() || clipDraftRef.current?.hasUnsaved();
      const reconciled = retainClipSelection ? viewRef.current : reconcileWorkspaceState(viewRef.current, next);
      if (viewReady.current && JSON.stringify(reconciled) !== JSON.stringify(viewRef.current)) { viewRef.current = reconciled as ViewState; setView(reconciled as ViewState); if (!application?.isRestoredWorkspace(capturedWorkspace)) preferencesRef.current!.update(projectId!, reconciled as ViewState, { immediate: true }); }
      return next;
    } catch (e) {
      if (importSession.current.active && currentProject.current === projectId && epoch === projectEpoch.current && call === requestCounter.current && workspaceOriginScope(capturedWorkspace) === workspaceOriginScope(workspaceRef.current)) { if ((e as {code?: string}).code === 'UNAUTHORIZED') setAuth(false); setOnline(false); if (!quiet) notify(readableError(e), 'error'); }
      if (opening) throw e;
      return null;
    }
  }, [notify]);
  async function revealImageAsset(assetId: string, projectId: string, isStillCurrent: () => boolean = () => true): Promise<boolean> {
    if (currentProject.current !== projectId || !isStillCurrent()) return false;
    const epoch = projectEpoch.current, navigation = navigationEpoch.current, panelChoice = panelIntent.current;
    const snapshot = dataRef.current!.assets.some(asset => asset.id === assetId) ? dataRef.current : await refresh(projectId);
    if (currentProject.current !== projectId || projectEpoch.current !== epoch || navigationEpoch.current !== navigation || panelIntent.current !== panelChoice || !isStillCurrent()) return false;
    const asset = (snapshot as AppData | null)?.assets.find((item: AppAsset) => item.id === assetId);
    if (!asset || asset.projectId !== undefined && asset.projectId !== projectId) return false;
    // Reveal only changes the library filter/panel. Source selection and all
    // inspector drafts remain intact; selecting a result uses the normal guard.
    updateView('shared', { assetSearch: asset.name, assetFilter: 'all' }); setPanelOpen('assets', true); setMobilePanel('assets');
    return true;
  }
  async function selectProject(id: string, initial = false, fromHistory = false, reloadPreferences = false): Promise<boolean> {
    if (nativeWindow && id !== nativeWindow.context.initialProjectId) return nativeProjectEntry?.open(id) ?? false;
    const selection = context(), lifetime = importSession.current.selection, settingsTicket = await prepareSettingsDeparture();
    if (!settingsTicket || !importSession.current.active || importSession.current.selection !== lifetime || !isCurrent(selection)) return false;
    const settingsCurrent = () => importSession.current.active && importSession.current.selection === lifetime && isCurrent(selection) && settingsNavigation.current!.canLeave(settingsTicket as Parameters<NonNullable<typeof settingsNavigation.current>['canLeave']>[0]);
    if (id === currentProject.current && !initial && !reloadPreferences && !loading && projectSessionReady()) {
      if (!nativeWindow && !workspaceRef.current?.restored) lastProjectRef.current!.rememberOpened(id, projectEpoch.current);
      return true;
    }
    const draftMessage = imageDraft.current ? msg(agentDraft.current ? 'shell.confirm.unsentBoth' : 'shell.confirm.unsentImage') : agentDraft.current ? msg('shell.confirm.unsentAgent') : msg('shell.confirm.switchProject');
    if (!initial && !await guardProjectNavigation(draftMessage, agentDraft.current || imageDraft.current, settingsCurrent)) return false;
    if (!settingsCurrent()) return false;
    navigationEpoch.current++; const epoch = ++projectEpoch.current; ++requestCounter.current;
    lastProjectRef.current!.invalidateNavigation(epoch);
    const attempt = projectOpenAttempt(id, epoch, (workspaceOriginScope(workspaceRef.current) ?? '') as string);
    openedProject.current = null;
    setProjectOpening({ phase: 'opening', projectId: id, error: '' }); setHomePage('projects');
    if (currentProject.current) void preferencesRef.current!.flush({ projectId: currentProject.current, keepalive: true } as unknown as {keepalive?: boolean});
    currentProject.current = id;
    setPropertiesPage('inspector');
    setTaskState(tasksRef.current!.getState(id) as never);
    viewReady.current = false;
    setPreferenceStatus({ phase: 'loading', pending: false });
    setPending(pendingForProject(id)); setShowProjects(false); setData(emptyData); dataRef.current = emptyData; setNodes([]); setLoading(true); dragging.current = false;
    setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false); setInspectorEpoch(value => value + 1); setRightDockTab(value => value === 'tasks' ? 'properties' : value); setPanelOverlay(null); setSelectedTaskId(undefined); setShowTasks(false); setShowDelivery(false); setShowImage(false); setShowProjectChooser(false); setShowExports(false); setComparisonId(null); setPreviewAsset(null); setRealConfirm(null); setToast(null); setMobilePanel('canvas');
    const url = new URL(window.location.href); url.searchParams.set('project', id);
    if (!nativeWindow && !fromHistory) window.history[initial ? 'replaceState' : 'pushState']({ projectId: id }, '', url);
    // Wait for authoritative preferences (or a safe local fallback) before the
    // project mounts and its initial viewport/selection effects can persist.
    try {
    const restored = await preferencesRef.current!.load(id, { reload: reloadPreferences });
    if (!importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch || workspaceOriginScope(workspaceRef.current) !== attempt.workspaceScope) return false;
    if (!restored) throw Object.assign(localizedError(msg('shell.error.viewNotReady')), { code: 'PROJECT_VIEW_UNAVAILABLE' });
    const preferenceError = preferencesRef.current!.getStatus(id)?.error;
    if (preferenceError && projectOpenFailureKind(preferenceError) !== 'project') throw preferenceError;
    const editorView = application ? { ...restored, activeMode: 'editing' } : restored;
    viewRef.current = editorView as unknown as ViewState; setView(editorView as unknown as ViewState); viewReady.current = true;
    setZoom(Math.round((restored.canvas.viewport?.zoom || 1) * 100));
    setPreferenceStatus(preferencesRef.current!.getStatus(id) as PreferenceStatus);
    const next = await refresh(id, false, { opening: true }) as AppData | null;
    if (!importSession.current.active || currentProject.current !== id || projectEpoch.current !== epoch || workspaceOriginScope(workspaceRef.current) !== attempt.workspaceScope) return false;
    setLoading(false);
    if (!projectResponseMatches(next, id) || !canPublishProjectOpen(attempt, { active: importSession.current.active, currentProjectId: currentProject.current, epoch: projectEpoch.current, workspaceScope: workspaceOriginScope(workspaceRef.current) as string, preferencesReady: viewReady.current, dataProjectId: next?.project?.id || null, loading: false })) throw Object.assign(localizedError(msg('shell.error.selectionNotReady')), { code: 'BACKEND_PROTOCOL_ERROR' });
    openedProject.current = attempt; setProjectOpening({ phase: 'ready', projectId: id, error: '' });
    if (!workspaceRef.current?.restored) void window.__mioonUiPreferences?.markOpened?.(id);
    void tasksRef.current!.load(id);
    if (!nativeWindow && !initial && !reloadPreferences && !workspaceRef.current?.restored) lastProjectRef.current!.rememberOpened(id, epoch);
    if (next && !viewRef.current!.canvas.selectedId) { const first = [...next.shots].sort((a, b) => a.orderIndex - b.orderIndex)[0] || next.nodes.find((n: AppNode) => n.type !== 'text') || next.nodes[0]; if (first) updateView('canvas', { selectedId: first.id }, { passive: true }); }
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
  async function showProjectHome(fromHistory = false): Promise<boolean> {
    if (nativeWindow) { await nativeProjectEntry?.show('open'); return false; }
    if (loading || projectCreateFlight.current || clipDraftRef.current?.hasPendingComposition()) return false;
    const captured = context(), lifetime = importSession.current.selection, ticket = await prepareSettingsDeparture();
    const current = () => Boolean(ticket && importSession.current.active && importSession.current.selection === lifetime && isCurrent(captured) && settingsNavigation.current!.canLeave(ticket as Parameters<NonNullable<typeof settingsNavigation.current>['canLeave']>[0]));
    if (!current()) return false;
    const message = imageDraft.current ? msg(agentDraft.current ? 'shell.confirm.unsentBoth' : 'shell.confirm.unsentImage') : agentDraft.current ? msg('shell.confirm.unsentAgent') : msg('shell.confirm.switchProject');
    if (!await guardProjectNavigation(message, agentDraft.current || imageDraft.current, current) || !current()) return false;
    navigationEpoch.current++; const epoch = ++projectEpoch.current; requestCounter.current++; lastProjectRef.current!.invalidateNavigation(epoch);
    if (currentProject.current) void preferencesRef.current!.flush({ projectId: currentProject.current, keepalive: true } as unknown as {keepalive?: boolean});
    currentProject.current = null; openedProject.current = null; viewReady.current = false;
    dataRef.current = emptyData; setData(emptyData); setNodes([]); setLoading(false); dragging.current = false;
    setProjectOpening({ phase: 'home', projectId: null, error: '' }); setHomePage('projects');
    setShotDirty(false); setClipDirty(false); setSourceDirty(false); setSubjectDirty(false); setSubtitleDirty(false);
    setShowProjects(false); setPanelOverlay(null); setSelectedTaskId(undefined); setShowTasks(false); setShowDelivery(false); setShowImage(false); setShowProjectChooser(false); setShowExports(false); setComparisonId(null); setPreviewAsset(null); setRealConfirm(null); setToast(null);
    const url = new URL(window.location.href); url.searchParams.delete('project');
    if (!fromHistory) window.history.pushState({ projectId: null }, '', url);
    void refreshHomeProjects();
    return true;
  }
  async function reloadPreferences(): Promise<void> {
    const captured = context();
    if (!await confirm(msg('shell.confirm.loadSavedView'))) return;
    if (isCurrent(captured)) await selectProject(captured.projectId as string, false, true, true);
  }
  // Optional feature discovery has its own connection epoch. Project selection
  // must not cancel it, and legacy servers must not delay ordinary boot/editing.
  useEffect(() => {
    const epoch = volumeEnvelopeProbeEpoch.current;
    const publish = (status: string) => setVolumeEnvelopeObservation({ epoch, status });
    publish(online && auth === true ? 'loading' : 'unavailable');
    if (!online || auth !== true || !workspace || clipInspectorRetention.current.retained) return;
    return observeClipVolumeEnvelopeCapability(workspace,
      signal => rpc('workspace.restore.inspect', { includeVolumeEnvelopeCapability: true }, { signal }),
      isWorkspaceInspection, canEditTimelineVolumeEnvelope,
      () => volumeEnvelopeProbeEpoch.current === epoch && workspaceRef.current === workspace && !clipInspectorRetention.current.retained,
      publish);
  }, [workspace, online, auth]);
  async function boot(): Promise<void> {
    if (clipDraftRef.current?.hasPendingComposition() || clipDraftRef.current?.hasUnsaved()) return;
    const ticket = bootGuard.current!.begin();
    preferenceScope.current = null;
    audioRoleProbe.current?.();
    const roleEpoch = ++audioRoleProbeEpoch.current;
    setAudioRoleCapability('loading');
    try {
      migrateBrowserStorage();
      const observedWorkspace = await rpc('workspace.restore.inspect');
      if (!bootGuard.current!.isCurrent(ticket)) return;
      const verifiedWorkspace = retainWorkspaceIdentity(workspaceRef.current, observedWorkspace);
      // Never adopt/reconnect an authority while original input is retained.
      if (clipDraftRef.current?.hasPendingComposition() || clipDraftRef.current?.hasUnsaved()) return;
      workspaceRef.current = verifiedWorkspace as unknown as WorkspaceState; setWorkspace(verifiedWorkspace as unknown as WorkspaceState);
      audioRoleProbe.current = observeClipAudioRoleCapability(verifiedWorkspace, signal => rpc('workspace.restore.inspect', { includeAudioRoleCapability: true }, { signal }), isWorkspaceInspection, canEditTimelineAudioRole,
        () => audioRoleProbeEpoch.current === roleEpoch && importSession.current.active && workspaceRef.current === verifiedWorkspace, setAudioRoleCapability);
      const [list, caps, locator] = await Promise.all([
        rpc('project.list'), verifiedWorkspace.restored ? [] : rpc('provider.list'),
        verifiedWorkspace.restored ? Promise.resolve(null) : lastProjectRef.current!.discover(),
      ]);
      if (!bootGuard.current!.isCurrent(ticket)) return;
      if (clipDraftRef.current?.hasPendingComposition() || clipDraftRef.current?.hasUnsaved()) return;
      assertLastProjectBootIdentity(lastProjectRef.current!.getState());
      locatorIdentity.current = retainLastProjectScope(locatorIdentity.current as string | null, locator?.workspaceScope ?? null);
      preferenceScope.current = locator?.workspaceScope ?? null;
      setProjects(list as AppProject[]); setProviders(caps as GenerationProvider[]); setAuth(true); setOnline(true);
      const choice = editorInitialSelection(nativeWindow, chooseInitialProject(list as never, new URLSearchParams(window.location.search).get('project'), locator?.envelope ?? null));
      if (choice.projectId) {
        const accepted = await selectProject(choice.projectId, true);
        if (accepted && currentProject.current === choice.projectId && choice.notice) notify(choice.notice, 'error');
      } else { setData(emptyData); dataRef.current = emptyData; currentProject.current = null; openedProject.current = null; viewReady.current = false; setProjectOpening({ phase: 'home', projectId: null, error: '' }); if (choice.notice) notify(choice.notice, 'error'); }
    } catch (e) { if (bootGuard.current!.isCurrent(ticket)) { if ((e as {code?: string}).code === 'UNAUTHORIZED') setAuth(false); else { setAuth('error'); notify(readableError(e), 'error'); } } }
  }
  useEffect(() => {
    bootGuard.current!.activate(); lastProjectRef.current!.activate(); void boot();
    return () => { bootGuard.current!.deactivate(); audioRoleProbeEpoch.current++; audioRoleProbe.current?.(); lastProjectRef.current!.dispose(); };
  }, []);
  useEffect(() => {
    const controller = preferencesRef.current!;
    const locator = lastProjectRef.current!;
    const flush = (event?: Event) => {
      const clip = clipDraftRef.current!;
      if (clip?.hasPendingComposition()) { if (event?.type === 'beforeunload') { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; } return; }
      if (window.__mioonNativeCloseAdmission?.suppressLifecycleFlush?.(event as Event) === true) return;
      void controller.flush({ keepalive: true });
      const restored = Boolean(workspaceRef.current?.restored);
      const restoredOwner = restored && clip?.supportsRestoredPersistence();
      const restoredClip = restoredOwner && typeof workspaceRef.current?.workspaceOrigin === 'string' && clip!.supportsRestoredPersistence(workspaceRef.current!.workspaceOrigin);
      if (restoredOwner && clip!.hasUnpersisted() && event?.type === 'beforeunload') { event.preventDefault(); (event as BeforeUnloadEvent).returnValue = ''; }
      if (!restored) { if (!nativeWindow) void locator.flush(); if (localDeliveryRef.current?.controller.hasUnsaved()) void localDeliveryRef.current!.controller.flush(); if (shotTextRef.current?.hasUnpersisted()) void shotTextRef.current!.flush(); }
      // Lifecycle events offer only a best-effort flush. beforeunload still
      // blocks unconfirmed43 input; pagehide cannot guarantee its durability.
      if ((!restored || restoredClip) && clip?.hasUnpersisted()) void clip!.flushForClose();
    };
    const onHidden = (event: Event) => { if (document.visibilityState === 'hidden') flush(event); };
    // An unprivileged lifecycle function: desktop main may await this fixed
    // function before closing; it exposes no Electron/IPC/native capability.
    const drain = async () => {
      if (clipDraftRef.current?.hasPendingComposition()) return false;
      const restored = Boolean(workspaceRef.current?.restored), workspaceOrigin = workspaceRef.current?.workspaceOrigin;
      const clipOwner = clipDraftRef.current;
      if (restored && clipOwner?.supportsRestoredPersistence() && (typeof workspaceOrigin !== 'string' || !clipOwner.supportsRestoredPersistence(workspaceOrigin))) return false;
      const clip = !restored || clipOwner?.supportsRestoredPersistence(workspaceOrigin as string | undefined) ? clipOwner : null, clipCapture = clip?.capture();
      const [, remembered, titleSaved, shotSaved, clipSaved] = await Promise.all([
        controller.flush({ keepalive: true }), restored || nativeWindow ? true : locator.flush(),
        restored || !localDeliveryRef.current?.controller.hasUnsaved() ? true : localDeliveryRef.current!.controller.flush(),
        restored || !shotTextRef.current?.hasUnpersisted() ? true : shotTextRef.current!.flush(),
        clip ? clip.flushForClose() : true,
      ]);
      return !clipDraftRef.current?.hasPendingComposition() && !controller!.hasUnsaved() && remembered && titleSaved && shotSaved && clipSaved && restored === Boolean(workspaceRef.current?.restored) && workspaceOrigin === workspaceRef.current?.workspaceOrigin
        && clipOwner === clipDraftRef.current && (!clip || clip.isCurrent(clipCapture) && !clip!.hasUnpersisted());
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
    const onPop = async () => { if (nativeProjectLocation) { nativeProjectLocation.restore(); return; } const id = new URLSearchParams(window.location.search).get('project'); if (id === currentProject.current) return; const accepted = id ? await selectProject(id, false, true) : await showProjectHome(true); if (!accepted) { const url = new URL(window.location.href); url.searchParams.set('project', currentProject.current as string); window.history.pushState({ projectId: currentProject.current }, '', url); } };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  });
  function readEditorWindowInputs(navigation = false): unknown {
    return editorInputs.current!.read({ clip: clipDraftRef.current, shot: shotTextRef.current, delivery: localDeliveryRef.current?.controller,
      busy: busyRef.current, navigation, settings: exportSettingsRef.current, range: exportRangeRef.current, defaultSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS });
  }
  function editorWindowCanNavigate(): boolean {
    const snapshot = readEditorWindowInputs(true) as {busy?: unknown; unknown?: unknown};
    if (!snapshot.busy && !snapshot.unknown) return true;
    notify(msg('shell.pendingKeepWindow'), 'warning');
    return false;
  }
  useEffect(() => installNativeCloseAdmission(window as unknown as Parameters<typeof installNativeCloseAdmission>[0], {
    registry: nativeCloseRegistry.current, settings: settingsNavigation.current,
    ...(nativeWindow ? { readAdditionalSnapshot: () => combineNativeEntryClose(readEditorWindowInputs(false) as NativeEntryCloseSnapshot, nativeProjectEntry?.readCloseSnapshot() as NativeEntryCloseSnapshot), onObservationPause: (value: boolean) => nativeSettingsScope?.pauseObservation(value) } : {}),
    readScope: () => JSON.stringify([importSession.current.active, currentProject.current, projectEpoch.current, navigationEpoch.current, workspaceOriginScope(workspaceRef.current)]),
    readDocumentURL: () => window.location.href,
    readLegacySnapshot: () => readNativeLegacyClose({ inspectorDirty: dirtyRef.current,
      shot: shotTextRef.current, shotLocal: shotCloseRef.current?.controller === shotTextRef.current ? shotCloseRef.current?.readLocalClose as (() => import('./native-close-legacy.ts').NativeShotLocalCloseSnapshot) | null : null,
      clip: clipDraftRef.current, format: timelineFormatRef.current?.controller,
      delivery: deliveryNameRef.current?.controller, subtitle: subtitlesRef.current?.controller, subject: subjectsRef.current?.controller }),
  } as unknown as Parameters<typeof installNativeCloseAdmission>[1]), []);
  useEffect(() => { if (showProjects) rpc('project.list').then(list => setProjects(list as AppProject[])).catch(e => notify(readableError(e), 'error')); }, [showProjects]);
  useEffect(() => {
    if (!auth || !workbenchReady || !data.project?.id) return;
    const timer = setInterval(() => { if (!dragging.current && document.visibilityState === 'visible') refresh(); }, 2500);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [auth, workbenchReady, data.project?.id, refresh]);
  async function run(key: string, operation: string, input: Record<string, unknown>, message?: AppMessage, options: RunOptions = {}): Promise<unknown> {
    if (clipConnectionBlocked.current) return null;
    const invocationOptions = { ...options, canRevealTasks: captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) };
    if (isDurableEditOperation(operation) && !options.replay) return runDurable(key, operation, input, message, invocationOptions);
    return runSession(key, operation, input, message, invocationOptions);
  }
  async function runDurable(key: string, operation: string, input: Record<string, unknown>, message?: AppMessage, { returnAfterNavigation = false, validateResponse, onFailure, errorMessage = readableError, canExecute, canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) }: RunOptions = {}): Promise<unknown> {
    if (clipConnectionBlocked.current) return null;
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
      if (pendingForProject(projectId as string, { strict: true, workspace: (context().workspace || { restored: false }) as never, activeOnly: true }).some(entry => entry.key === key ||
        (operation.startsWith('reference.') && isMutationOperation(entry.operation))))
        throw Object.assign(localizedError(msg('shell.error.previousSessionPending')), { code: 'MUTATION_PENDING' });
      const response = await tasksRef.current!.submit({ projectId: projectId as string, operation, input, ...invocation } as never, { canExecute: ((preparedTask: unknown) => {
        if (clipConnectionBlocked.current || !isCurrent(captured) || canExecute?.(preparedTask) === false) return false;
        dispatched = true; invalidateHistory(); return true;
      }) as unknown as never });
      invalidateHistory();
      if (response.task.status === 'not_applied') {
        rejected = true;
        await tasksRef.current!.acknowledge(response.task);
        const code = response.task.errorCode || 'TASK_NOT_APPLIED', reason = readableError({ code }) as DisplayMessage;
        throw Object.assign(localizedError(reason.key === 'shell.error.incomplete' ? msg('shell.error.notApplied') : reason), { code });
      }
      if (response.task.status !== 'applied') {
        if (isCurrent(captured)) { notify(msg('shell.requestSaved'), 'warning'); openTasks(canRevealTasks); }
        return null;
      }
      // Fresh saves may return their own validated ACK to their mounted editor.
      // Historical task recovery below only refreshes current project records.
      if (!Object.hasOwn(response, 'result')) throw Object.assign(localizedError(msg('shell.error.editAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      validateResponse?.(response.result);
      await tasksRef.current!.acknowledge(response.task);
      if (currentProject.current === projectId) await refresh(projectId);
      if (!isCurrent(captured)) return returnAfterNavigation && currentProject.current === projectId ? response.result : null;
      if (message) notify(message as AppMessage);
      return response.result;
    } catch (error) {
      if (dispatched) invalidateHistory();
      onFailure?.(error, { dispatched, rejected });
      if (currentProject.current === projectId) {
        if ((error as {code?: string}).code === 'UNAUTHORIZED') setAuth(false);
        if (isCurrent(captured)) {
          notify(dispatched && !rejected ? msg('shell.editOutcomeUnknown') : errorMessage(error), 'error');
          openTasks(canRevealTasks);
        }
        if (dispatched) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); }
  }
  async function recoverTask(task: TaskItem, acknowledgeOnly = false, canExecute: () => boolean = () => true): Promise<unknown> {
    if (clipConnectionBlocked.current) return null;
    const captured = context(), loudnessRecoveryScope = task.operation === 'timeline.loudness.apply' ? readTimelineLoudnessRecoveryScope() : null;
    if (!canExecute()) return;
    if (task.projectId !== captured.projectId || isBusy(`task:${task.id}`, task.projectId)) return;
    markBusy(task.projectId, `task:${task.id}`, true);
    try {
      const response = await tasksRef.current!.recover(task as never as never, { canExecute: (() => !clipConnectionBlocked.current && !acknowledgeOnly && isCurrent(captured) && canExecute()) as unknown as never });
      if (!response || clipConnectionBlocked.current) return;
      if (['applied', 'not_applied'].includes(response.task.status)) {
        if (response.task.status === 'applied' && currentProject.current === task.projectId) {
          await refresh(task.projectId);
          if (task.lane === 'subject:mutation') setSubjectRefresh(value => ({ ...value, [task.projectId as string]: (value[task.projectId as string] || 0) + 1 }));
        }
        const acknowledgedTask = (response.task.acknowledged ? response.task : (await tasksRef.current!.acknowledge(response.task))?.task) as unknown as never;
        if (task.operation === 'timeline.loudness.apply') timelineLoudnessApplyRef.current?.controller.recovered((acknowledgedTask as unknown as string | null), loudnessRecoveryScope as string | null);
        if (currentProject.current === task.projectId) { timelineFormatRef.current?.controller.recovered(response.task); subtitlesRef.current?.controller.recovered(response.task); }
        if (isCurrent(captured) && canExecute()) notify(response.task.status === 'applied' ? msg('shell.requestApplied') : msg('shell.requestNotApplied'));
      } else if (isCurrent(captured) && canExecute()) notify(msg('shell.requestStillUnknown'), 'warning');
    } catch (error) { if (isCurrent(captured)) { if ((error as {code?: string}).code === 'UNAUTHORIZED') setAuth(false); if (canExecute()) notify(readableError(error), 'error'); } }
    finally { markBusy(task.projectId, `task:${task.id}`, false); }
  }
  async function adoptLegacyTask(entry: PendingEntry): Promise<unknown> {
    if (clipConnectionBlocked.current) return null;
    const captured = context();
    if (entry.projectId !== captured.projectId || isBusy(entry.key, entry.projectId)) return;
    markBusy(entry.projectId, entry.key, true);
    try {
      const exact = prepareRequestReplay(entry);
      await tasksRef.current!.adopt(exact);
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
  async function runSession(key: string, operation: string, input: Record<string, unknown>, message?: AppMessage, { returnAfterNavigation = false, replay = false, validateResponse, onFailure, errorMessage = readableError, expectedSubjectReference, subjectRetry = false, expectedRetrySnapshot, pendingEntry, canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false) }: RunOptions = {}): Promise<unknown> {
    if (clipConnectionBlocked.current) return null;
    const captured = context(), projectId = captured.projectId;
    if (operation === 'job.retry' && dataRef.current!.jobs?.length) subjectRetry = subjectRetry || isSubjectRetryPending({ projectId: projectId as string, key, operation, input } as never, dataRef.current!.jobs);
    const mutation = isMutationOperation(operation);
    const timeline = TIMELINE_MUTATION_OPERATIONS.includes(operation);
    const reference = (REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(operation);
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
          const original = readPending(projectId as string, key, entry);
          if (!original || original.operation !== operation || original.subjectRetry !== true || original.input?.jobId !== input.jobId || original.input?.requestId !== input.requestId || Object.keys(original.input).length !== Object.keys(input).length || Object.keys(original.input).some(field => original.input[field] !== input[field]))
            throw Object.assign(localizedError(msg('shell.error.subjectRetryChanged')), { code: 'MUTATION_REPLAY_MISMATCH' });
        }
        if (operation === 'job.retry' && !replay && pendingForProject(projectId as string, { strict: true, workspace: (context().workspace || { restored: false }) as never, activeOnly: true }).some(item => item.key === key && (subjectRetry || isSubjectRetryPending(item, dataRef.current!.jobs || []))))
          throw Object.assign(localizedError(msg('shell.error.subjectRetryPending')), { code: 'MUTATION_PENDING' });
        if (operation === 'generation.submit' && !replay && pendingForProject(projectId as string, { strict: true, workspace: (context().workspace || { restored: false }) as never, activeOnly: true }).some(item => item.key === key && (Object.hasOwn(input, 'subjectVersionId') || Object.hasOwn(item.input ?? {}, 'subjectVersionId'))))
          throw Object.assign(localizedError(msg('shell.error.subjectGenerationPending')), { code: 'MUTATION_PENDING' });
        if (mutation && !replay) assertMutationOwner(entry as never, dataRef.current as never);
        // A new timeline or reference click must not silently replay an older
        // uncertain request. Only the task panel may recover its original input.
        if (requestBound && !replay && pendingForProject(projectId as string, { strict: true, workspace: (context().workspace || { restored: false }) as never, activeOnly: true }).some(item => item.key === key))
          throw Object.assign(localizedError(msg(reference ? 'shell.error.referenceRequestPending' : 'shell.error.timelineRequestPending')), { code: 'MUTATION_PENDING' });
        if (requestBound && replay) stored = prepareRequestReplay(entry as PendingEntry);
        else stored = (mutation ? prepareMutation(entry as never, { replay }) : prepareSubmission(entry as PendingEntry, { replay })) as PendingEntry;
        if (requestBound && stored.operation !== operation)
          throw Object.assign(localizedError(msg('shell.error.operationMismatch')), { code: 'MUTATION_REPLAY_MISMATCH' });
        if (requestBound && stored.input.projectId !== projectId)
          throw Object.assign(localizedError(msg('shell.error.ownerMismatch')), { code: 'MUTATION_PROJECT_MISMATCH' });
        input = stored.input; operation = stored.operation;
        if (operation === 'job.retry' && (stored!.subjectRetry || stored!.expectedSubjectReference || stored!.expectedRetrySnapshot || dataRef.current!.jobs?.length)) subjectRetry = subjectRetry || isSubjectRetryPending(stored, dataRef.current!.jobs || []);
        if (currentProject.current === projectId) setPending(pendingForProject(projectId as string));
      }
      invalidateHistory();
      dispatched = true;
      const result = await rpc(operation, input, invocation as never);
      invalidateHistory();
      if (mutation) validateMutationResponse(stored as never, result);
      if (timeline && !isTimelineMutationResponse(operation, input, result)) throw Object.assign(localizedError(msg('shell.error.timelineAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (reference && !isReferenceMutationResponse(operation, input, result)) throw Object.assign(localizedError(msg('shell.error.referenceAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') && (!stored?.expectedSubjectReference || !isSubjectGenerationResponse(operation, input, result, { projectId: projectId as string, subjectReference: stored!.expectedSubjectReference })))
        throw Object.assign(localizedError(msg('shell.error.subjectAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      if (operation === 'job.retry' && subjectRetry && (!stored!.expectedSubjectReference || !stored!.expectedRetrySnapshot || !isSubjectGenerationRetryResponse(input, result, { projectId: projectId as string, subjectReference: stored!.expectedSubjectReference, snapshot: stored!.expectedRetrySnapshot })))
        throw Object.assign(localizedError(msg('shell.error.retryAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' });
      validateResponse?.(result);
      if (replay && operation === 'asset.range.set' && currentProject.current === projectId) {
        const assetId = stored!.input.assetId;
        setSourceRangeRefresh(value => ({ ...value, [`${projectId}:${assetId}`]: (value[`${projectId}:${assetId}`] || 0) + 1 }));
      }
      if (durable) { clearPending(projectId as string, key, stored!); if (currentProject.current === projectId) setPending(pendingForProject(projectId as string)); }
      if (currentProject.current === projectId) await refresh(projectId);
      // A still-mounted inspector may finish a save after its preview changes.
      // Returning its acknowledged record is safe; navigation effects are not.
      if (!isCurrent(captured)) return !replay && returnAfterNavigation && currentProject.current === projectId ? result : null;
      if (message) notify(message as AppMessage); return mutation && replay ? null : result;
    } catch (e) {
      if (dispatched) invalidateHistory();
      const rejected = operation === 'generation.submit' && Object.hasOwn(input, 'subjectVersionId') || operation === 'job.retry' && (subjectRetry || stored?.subjectRetry === true) ? false : mutation ? mutationNotApplied(e, stored) : requestBound
        ? Boolean(stored && hasRequestNotAppliedProof(e, stored.input, { operation })) : (e as {definitive?: unknown}).definitive;
      onFailure?.(e, { dispatched, rejected: rejected as boolean });
      if (durable && stored && rejected) { clearPending(projectId as string, key, stored!); if (currentProject.current === projectId) setPending(pendingForProject(projectId as string)); }
      if (currentProject.current === projectId) {
        if ((e as {code?: string}).code === 'UNAUTHORIZED') setAuth(false);
        if (durable && stored && dispatched && !rejected) { notify(msg('shell.submissionUnknown'), 'error'); if (isCurrent(captured)) openTasks(canRevealTasks); }
        else if (isCurrent(captured)) notify(operation === 'timeline.clip.replaceSource' ? clipReplacementErrorDescriptor(e) : errorMessage(e), 'error');
        if ((e as {code?: string}).code === 'MUTATION_PENDING' && isCurrent(captured)) openTasks(canRevealTasks);
        if (dispatched || !requestBound) await refresh(projectId);
      }
      return null;
    } finally { markBusy(projectId, key, false); if (mutation) markBusy(projectId, 'canvas:mutation', false); if (replay && operation === 'asset.annotation.set' && currentProject.current === projectId) setAnnotationRefresh(value => ({ ...value, [projectId as string]: (value[projectId as string] || 0) + 1 })); if (replay && operation === 'asset.disposition.set' && currentProject.current === projectId) setDispositionRefresh(value => ({ ...value, [projectId as string]: (value[projectId as string] || 0) + 1 })); }
  }
  // Picking a shot, node or clip means "show me its properties". The Tasks and Delivery pages are reference views
  // (Tasks even opens by itself after a generation), so they give way; Agent and Image keep following the selection.
  function leaveReferencePage() { setShowTasks(false); setShowDelivery(false); }
  async function inspect(id: string | null, nextTab = 'settings', versionId: string | null = null, { reveal = false }: {reveal?: boolean} = {}): Promise<boolean> {
    const captured = context(), panelChoice = panelIntent.current, timelineId = dataRef.current!.timeline?.id, timelineRevision = dataRef.current!.timeline?.revision;
    const canDiscard = (): boolean => Boolean(isCurrent(captured) && panelChoice === panelIntent.current && timelineId === dataRef.current!.timeline?.id && timelineRevision === dataRef.current!.timeline?.revision && [...dataRef.current!.shots, ...dataRef.current!.nodes].some(record => record.id === id));
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
  function checkGeneration(shot: AppShot, provider: ProviderRecord | undefined, model: string | undefined, inputMode: string, frozen = false, subjectReference?: AppSubjectReference | null): boolean {
    const modelName = model as string;
    if (generationUnavailableReason) { notify(generationUnavailableReason, 'warning'); return false; }
    if (!frozen && !workspaceRef.current?.restored && (!shotTextRef.current || shotTextRef.current!.blocksLegacy(shot.id))) { notify(msg('shell.generationCheckText'), 'warning'); return false; }
    if (referenceWorkBlocked()) return false;
    const issue = generationInputIssueDescriptor(shot, provider, modelName, dataRef.current!.assets, inputMode, { frozen, subjectReference, ...(!frozen && inputMode === 'subject' ? { savedShot: dataRef.current!.shots.find(item => item.id === shot.id), boundReference: Boolean(referenceForShot(dataRef.current!.edges as never[], shot.id)) } : {}) }) || providerAvailabilityDescriptor(provider);
    if (issue) { notify(issue, 'error'); return false; }
    if (dataRef.current!.jobs.some(j => j.shotId === shot.id && j.status === 'submission_unknown')) { notify(msg('shell.generationBillingUnknown'), 'error'); openTasks(); return false; }
    return true;
  }
  const submitGeneration = async ({ shot, providerId, model, scenario, inputMode, retryJobId, subjectReference, expectedRetrySnapshot }: GenerationReviewArgs): Promise<unknown> => {
    const canRevealTasks = captureTaskWorkspaceIntent(readTaskRevealContext) || (() => false);
    const provider = providers.find(item => item.id === providerId);
    if (!checkGeneration(shot as AppShot, provider as ProviderRecord | undefined, model as string, inputMode as string, Boolean(retryJobId), subjectReference)) return;
    if (retryJobId && shot.subjectReference) {
      const retrySnapshot = expectedRetrySnapshot as {subjectReference?: SubjectReference} | null | undefined;
      if (!retrySnapshot || subjectVideoIdentity(retrySnapshot.subjectReference) !== subjectVideoIdentity(shot.subjectReference)) { notify(msg('shell.error.retrySnapshotChanged'), 'warning'); return; }
      return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, msg('shell.retryCreated'), { subjectRetry: true, expectedSubjectReference: retrySnapshot.subjectReference, expectedRetrySnapshot });
    }
    if (retryJobId) return run(`retry:${retryJobId}`, 'job.retry', { jobId: retryJobId, requestId: requestId() }, msg('shell.retryCreated'));
    const result = await run(`generate:${shot.id}`, 'generation.submit', { shotId: shot.id, expectedRevision: shot.revision, requestId: requestId(), providerId, ...(model ? { model } : {}), ...(providerId === 'mock' ? { parameters: { scenario } } : {}), ...(subjectReference ? { subjectVersionId: subjectReference.subjectVersionId } : {}) }, undefined, subjectReference ? { expectedSubjectReference: subjectReference } : {});
    if (result) { const submitted = result as {status?: string}; notify(submitted.status === 'submission_unknown' ? msg('shell.generationUnconfirmed') : msg('shell.generationSubmitted'), submitted.status === 'submission_unknown' ? 'warning' : 'success'); openTasks(canRevealTasks); }
  };
  function generate(shot: AppShot, options: GenerationOptionState = generationOptionsRef.current[shot.id] || {}): void {
    const { provider, model, scenario, inputMode } = generationSelection(providers, options, shot);
    const subjectReference = inputMode === 'subject' ? options.subjectReference : undefined;
    const currentOptions = generationOptionsRef.current[shot.id] || {};
    const currentSelection = generationSelection(providers, currentOptions, shot);
    if (inputMode === 'subject' && (shot.projectId !== currentProject.current || !dataRef.current!.shots.some(current => current.id === shot.id && current.revision === shot.revision) || currentSelection.inputMode !== 'subject' || currentSelection.provider?.id !== provider?.id || currentSelection.model !== model || currentSelection.scenario !== scenario || subjectVideoIdentity(currentOptions.subjectReference) !== subjectVideoIdentity(subjectReference))) return;
    if (!checkGeneration(shot, provider, model, inputMode, false, subjectReference)) return;
    const args = { shot, providerId: provider!.id, model, scenario, inputMode, ...(subjectReference ? { subjectReference: structuredClone(subjectReference) } : {}) };
    if (!provider!.mock) reviewGeneration(args); else submitGeneration(args);
  }
  function retryGeneration(job: AppJob, stillCurrent: () => boolean = () => true): void {
    if (!stillCurrent()) return;
    const provider = providers.find(item => item.id === job.providerId);
    const shot = { ...job.snapshot!, id: job.shotId } as unknown as AppShot;
    const inputMode = shot.subjectReference ? 'subject' : shot.referenceAssetIds?.length ? 'image' : 'text';
    if (!checkGeneration(shot, provider, job.model, inputMode, true)) return;
    const args = { shot, providerId: job.providerId, model: job.model, inputMode, retryJobId: job.id, ...(job.snapshot!.subjectReference ? { expectedRetrySnapshot: structuredClone(job.snapshot) } : {}) };
    if (!provider!.mock) reviewGeneration(args as unknown as GenerationReviewArgs, stillCurrent); else submitGeneration(args as unknown as GenerationReviewArgs);
  }
  function reviewGeneration(args: GenerationReviewArgs, taskViewGuard?: () => boolean): void {
    const frozen = Boolean(args.retryJobId);
    const referenceOptions = { frozen, subjectReference: args.subjectReference };
    const review = { ...structuredClone(args), ...(taskViewGuard ? { taskViewGuard } : {}), ...(args.subjectReference || args.shot.subjectReference ? { subjectProviderIdentity: (subjectVideoProfileIdentity as unknown as (provider: unknown, model: unknown) => unknown)(providers.find(provider => provider.id === args.providerId), args.model) } : {}), approvalContext: context(), approvalView: generationReviewScope.current,
      referenceIdentity: generationReferenceIdentity(args.shot, dataRef.current!.assets, referenceOptions),
      // Keep reviewed thumbnail labels/metadata stable while the modal is open.
      referenceAssets: structuredClone(dataRef.current!.assets.filter(asset => generationReferences(args.shot, referenceOptions).references.some(reference => reference.assetId === asset.id))) };
    realConfirmRef.current = review; setRealConfirm(review);
  }
  function confirmGeneration(args: GenerationReviewArgs): void {
    if (realConfirmRef.current !== args) return;
    realConfirmRef.current = null; setRealConfirm(null);
    const frozen = Boolean(args.retryJobId);
    const currentShot = dataRef.current!.shots.find(shot => shot.id === args.shot.id);
    const selection = generationSelection(providers, generationOptionsRef.current[args.shot.id], currentShot || {});
    const currentJob = frozen ? dataRef.current!.jobs.find(job => job.id === args.retryJobId) : null;
    const stale = Boolean(args.taskViewGuard && !args.taskViewGuard()) || !isCurrent(args.approvalContext as CapturedContext) || args.approvalView !== generationReviewScope.current || !currentShot ||
      (!frozen && (currentShot.revision !== args.shot.revision || selection.provider?.id !== args.providerId || selection.model !== args.model || selection.inputMode !== args.inputMode || (args.subjectReference || selection.inputMode === 'subject') && subjectVideoIdentity(selection.inputMode === 'subject' ? generationOptionsRef.current[args.shot.id]?.subjectReference : null) !== subjectVideoIdentity(args.subjectReference))) ||
      (frozen && (!currentJob || JSON.stringify(currentJob.snapshot) !== JSON.stringify(Object.fromEntries(Object.entries(args.shot).filter(([key]) => key !== 'id'))))) ||
      (args.subjectProviderIdentity && (subjectVideoProfileIdentity as unknown as (provider: unknown, model: unknown) => unknown)(providers.find(provider => provider.id === args.providerId), args.model) !== args.subjectProviderIdentity) ||
      generationReferenceIdentity(args.shot, dataRef.current!.assets, { frozen, subjectReference: args.subjectReference }) !== args.referenceIdentity;
    if (stale) { notify(msg('shell.generationInputsChanged'), 'warning'); return; }
    submitGeneration(args);
  }
  async function createProject(name: string, description: string, timelinePresetId?: string): Promise<boolean> {
    if (application?.isRestoredWorkspace(workspaceRef.current)) return false;
    if (nativeWindow) { void nativeProjectEntry?.show('new'); return false; }
    if (projectCreateFlight.current) return false;
    if (nativeWindow && !editorInputs.current!.canCreateProject()) { notify(msg('projects.previousCreateKeep'), 'warning'); return false; }
    const flight: Record<string, unknown> = {}; projectCreateFlight.current = flight;
    let nativeCreate: unknown = null;
    const captured = context(), lifetime = importSession.current.selection;
    const alive = () => importSession.current.active && importSession.current.selection === lifetime;
    const current = () => alive() && isCurrent(captured);
    markBusy(captured.projectId, 'project-create-flow', true);
    try {
      const settingsTicket = await prepareSettingsDeparture();
      const settingsCurrent = (): boolean => Boolean(current() && settingsTicket && settingsNavigation.current!.canLeave(settingsTicket as Parameters<NonNullable<typeof settingsNavigation.current>['canLeave']>[0]));
      if (!settingsCurrent() || !await guardProjectNavigation(msg('shell.confirm.createProject'), false, settingsCurrent) || !settingsCurrent()) return false;
      if (nativeWindow) { nativeCreate = editorInputs.current!.beginProjectCreate(captured.projectId); if (!nativeCreate) return false; }
      const nativeOptions: RunOptions | undefined = nativeCreate ? ({
        validateResponse: (result: unknown) => editorInputs.current!.validateProjectCreate(nativeCreate as object, result as object, name, description),
        onFailure: (_error: unknown, outcome: {dispatched: boolean; rejected: boolean}) => editorInputs.current!.failProjectCreate(nativeCreate as object, outcome),
      } satisfies RunOptions) : undefined;
      const created = await run('project-create', 'project.create', { name, description, ...(timelinePresetId === undefined ? {} : { timelinePresetId }) }, undefined, nativeOptions);
      if (!created || !current()) return false;
      try {
        const list = await rpc('project.list'); if (!current()) return false;
        setProjects(list as AppProject[]); setShowCreate(false);
        const accepted = await selectProject((created as {id: string}).id);
        if (accepted && alive() && currentProject.current === (created as {id: string}).id) notify(msg('projects.createdImportHint'));
        return accepted;
      } catch (error) {
        if (current()) {
          if (projectOpenFailureKind(error) === 'auth') setAuth(false);
          setProjectListStatus({ busy: false, error: msg('projects.maybeCreated') }); notify(readableError(error), 'error');
        }
        return false;
      }
    } finally {
      if (nativeCreate) editorInputs.current!.finishProjectCreate(nativeCreate);
      if (projectCreateFlight.current === flight) projectCreateFlight.current = null;
      if (alive()) markBusy(captured.projectId, 'project-create-flow', false);
    }
  }
  async function addShot(): Promise<void> {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation(msg('shell.confirm.createShot'))) return;
    const state = dataRef.current, count = state.shots.length;
    const position = chooseCanvasPosition([...state.shots, ...state.nodes] as never[], { x: 350 + (count % 3) * 330, y: Math.floor(count / 3) * 430 + 80 });
    const shot = await run('shot-create', 'shot.create', { projectId: state.project!.id, title: t('projects.default.shot', { number: String(count + 1).padStart(2, '0') }), prompt: '', duration: 2, aspectRatio: '9:16', referenceAssetIds: [], position });
    if (shot && await inspect((shot as {id: string}).id)) revealCanvas((shot as {id: string}).id);
  }
  async function addStructure(): Promise<void> {
    const owner = data.project?.id;
    if (!owner || owner !== currentProject.current || dataRef.current!.project?.id !== owner || dataRef.current!.shots.length || dataRef.current!.nodes.length || isBusy('structure')) return;
    if (!await guardNavigation(msg('shell.confirm.createStructure'))) return;
    if (owner !== currentProject.current || dataRef.current!.project?.id !== owner || dataRef.current!.shots.length || dataRef.current!.nodes.length || isBusy('structure')) return;
    const captured = context(), state = dataRef.current, projectId = state.project!.id;
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
      const next = await refresh(projectId) as AppData | null;
      if (isCurrent(captured) && next) { const first = next.shots.find(shot => shot.orderIndex === base); if (first && await inspect(first.id)) revealCanvas(); notify(msg('projects.structureReady')); }
    } catch (e) { if (isCurrent(captured)) notify(readableError(e), 'error'); await refresh(projectId); } finally { markBusy(projectId, 'structure', false); }
  }
  async function addNode(type: string, asset?: AppAsset, dropPosition?: {x: number; y: number}): Promise<void> {
    if (!data.project) return setShowCreate(true);
    if (!await guardNavigation(msg('shell.confirm.addCanvas'))) return;
    const state = dataRef.current;
    if (type !== 'text' && !asset) { asset = state.assets.find(a => a.mimeType.startsWith(`${type}/`)); if (!asset) { notify(msg(type === 'image' ? 'assets.importImageFirst' : type === 'audio' ? 'assets.importAudioFirst' : 'assets.importVideoFirst'), 'warning'); fileInput.current?.click(); return; } }
    const saved = viewRef.current!.canvas.viewport;
    const location = dropPosition || (workspaceMode === 'canvas' ? flow.screenToFlowPosition({ x: window.innerWidth * .43, y: window.innerHeight * .35 }) : { x: saved ? (300 - saved.x) / saved.zoom : 100, y: saved ? (200 - saved.y) / saved.zoom : 100 });
    const node = await run('node-create', 'node.create', { projectId: state.project!.id, type, label: type === 'text' ? t('projects.default.note') : asset!.name, ...(type === 'text' ? { text: '' } : { assetId: asset!.id }), position: chooseCanvasPosition([...state.shots, ...state.nodes] as never[], location) });
    if (node && await inspect((node as {id: string}).id)) revealCanvas((node as {id: string}).id);
  }
  async function importFiles(files?: FileList | File[]): Promise<void> {
    if (application?.isRestoredWorkspace(workspaceRef.current)) return;
    if (!importSession.current.active || !files?.length) return;
    const selection = ++importSession.current.selection;
    ++requestCounter.current; // Invalidate an older batch's pending refresh.
    if (!data.project) return setShowCreate(true);
    const projectId = data.project.id;
    if (projectId !== currentProject.current || dataRef.current!.project?.id !== projectId) return;
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
        if (nativeWindow) nativeImport = editorInputs.current!.beginImport(projectId);
        const asset = await rpc('asset.import', input, invocation as never);
        if (!importAcknowledged(asset, input)) throw localizedError(msg('shell.error.importAcknowledgement'));
        editorInputs.current!.finishImport(nativeImport, false); nativeImport = null;
        done++;
      }
      if (ownsSelection()) notify(importFeedback(batch, done));
    } catch (error) {
      const failure = error as {definitive?: boolean; status?: number};
      const kind = !dispatched ? 'local' : failure.definitive === true && (failure.status as number) >= 400 && (failure.status as number) < 500 ? 'rejected' : 'unknown';
      editorInputs.current!.finishImport(nativeImport, kind === 'unknown'); nativeImport = null;
      if (ownsSelection()) notify(importFeedback(batch, done, { kind, reason: kind === 'unknown' ? '' : readableError(error) as string } as never), 'error');
    } finally {
      try { if (ownsSelection()) await refresh(projectId); }
      finally {
        if (importSession.current.active) markBusy(projectId, 'import', false);
        else busyRef.current.delete(`${projectId}:import`);
        if (ownsSelection() && inputElement === fileInput.current && inputElement) inputElement.value = '';
      }
    }
  }
  function shotTextContext(): Record<string, unknown> {
    const projectId = currentProject.current;
    let legacyPending = true;
    try { legacyPending = pendingForProject(projectId as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || (REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(entry.operation)); }
    catch { /* Unreadable legacy identity cannot authorize another save. */ }
    return {
      scope: `${projectId}:${projectEpoch.current}:${inspectorEpoch}`,
      restored: workspaceRef.current?.restored === true,
      connected: workbenchReady && online && auth === true && !loading,
      busy: legacyPending || isBusy('canvas:mutation') || isBusy('reference:mutation') || (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(projectId, 'reference:mutation'),
      executionEpoch: `${navigationEpoch.current}:${panelIntent.current}`,
    };
  }
  async function saveShot(shotId: string, expectedRevision: number, patch: Record<string, unknown>): Promise<unknown> {
    if (referenceWorkBlocked()) return null;
    return run(`save:${shotId}`, 'shot.update', { shotId, expectedRevision, patch }, msg('projects.shotSaved'), { returnAfterNavigation: true });
  }
  async function saveNode(nodeId: string, expectedRevision: number, patch: Record<string, unknown>): Promise<unknown> { return run(`save:${nodeId}`, 'node.update', { nodeId, expectedRevision, patch }, msg('projects.nodeSaved'), { returnAfterNavigation: true }); }
  async function savePosition(_: React.MouseEvent, node: FlowNode): Promise<void> {
    const snapshot = dataRef.current;
    const record = snapshot.shots.find(s => s.id === node.id) || snapshot.nodes.find(n => n.id === node.id);
    if (record) await run(`position:${node.id}`, snapshot.shots.some(s => s.id === node.id) ? 'shot.update' : 'node.update', { [snapshot.shots.some(s => s.id === node.id) ? 'shotId' : 'nodeId']: record.id, expectedRevision: record.revision, patch: { position: node.position } });
    dragging.current = false;
  }
  function referenceWorkBlocked(): boolean {
    if (shotTextRef.current?.blocksLegacy()) { notify(msg('shell.shotTextPending'), 'warning'); return true; }
    if ((tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(currentProject.current, 'reference:mutation')) { notify(msg('shell.referenceRecoveryPending'), 'warning'); openTasks(); return true; }
    if (pendingForProject(currentProject.current as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation))) { notify(msg('shell.projectEditPending'), 'warning'); openTasks(); return true; }
    if (isBusy('reference:mutation')) { notify(msg('shell.referenceSyncing'), 'warning'); return true; }
    if (hasPendingReference(pendingForProject(currentProject.current as string, { workspace: workspaceRef.current as never, activeOnly: true }) as never[])) { notify(msg('shell.referencePending'), 'warning'); openTasks(); return true; }
    return false;
  }
  async function attachReference(sourceNodeId: string, targetShotId: string): Promise<unknown> {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify(msg('shell.referenceSaveBeforeConnect'), 'warning'); return null; }
    const state = dataRef.current;
    const source = state.nodes.find(node => node.id === sourceNodeId);
    const shot = state.shots.find(item => item.id === targetShotId);
    const issue = referenceAttachIssueDescriptor({ source, shot, assets: state.assets as never[], edges: state.edges as never[], projectId: state.project?.id });
    if (issue) { notify(issue, 'warning'); return null; }
    return run('reference:mutation', 'reference.attach', { projectId: state.project!.id, sourceNodeId, targetShotId, expectedSourceRevision: source!.revision, expectedShotRevision: shot!.revision, requestId: requestId(), role: 'first_frame' }, msg('shell.referenceConnected'));
  }
  async function detachReference(edgeId: string): Promise<unknown> {
    if (referenceWorkBlocked()) return null;
    if (inspectorDirty) { notify(msg('shell.referenceSaveBeforeDisconnect'), 'warning'); return null; }
    const state = dataRef.current;
    const edge = state.edges.find(item => item.id === edgeId && isReferenceEdge(item));
    const shot = state.shots.find(item => item.id === edge?.target);
    if (!edge || !shot) { await refresh(); return null; }
    if (!await confirm(msg('shell.confirm.disconnectReference', { name: shot.title }))) return null;
    if (currentProject.current !== state.project!.id || referenceWorkBlocked()) return null;
    return run('reference:mutation', 'reference.detach', { projectId: state.project!.id, edgeId, expectedShotRevision: shot!.revision, requestId: requestId() }, msg('shell.referenceDisconnected'));
  }
  async function connect(connection: {source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null}): Promise<unknown> {
    if (connection.source === connection.target) return notify(msg('shell.differentNodes'), 'warning');
    if (connection.sourceHandle === REFERENCE_SOURCE_HANDLE || connection.targetHandle === REFERENCE_TARGET_HANDLE) {
      if (connection.sourceHandle !== REFERENCE_SOURCE_HANDLE || connection.targetHandle !== REFERENCE_TARGET_HANDLE) return notify(msg('shell.referencePortHint'), 'warning');
      return attachReference(connection.source, connection.target);
    }
    await run(`edge:${connection.source}:${connection.target}`, 'edge.create', { projectId: dataRef.current!.project!.id, source: connection.source, target: connection.target }, msg('shell.visualLinkAdded'));
  }
  function beforeDeleteEdges({ edges: removed }: {nodes: FlowNode[]; edges: FlowEdge[]}): Promise<{nodes: FlowNode[]; edges: FlowEdge[]}> {
    const selected = removed.filter(edge => edge.id === selectedEdgeId);
    if (selected.some(edge => isReferenceEdge(dataRef.current!.edges.find(item => item.id === edge.id)))) notify(msg('shell.referenceDisconnectHint'), 'warning');
    return Promise.resolve({ nodes: [], edges: selected.filter(edge => !isReferenceEdge(dataRef.current!.edges.find(item => item.id === edge.id))) });
  }
  async function selectVersion(shot: AppShot, versionId: string): Promise<unknown> { return run(`version:${shot.id}`, 'version.select', { shotId: shot.id, versionId, expectedRevision: shot.revision }, msg('projects.versionUpdated')); }
  async function reorder(id: string, targetIndex: number): Promise<void> {
    const ordered = [...dataRef.current!.shots].sort((a, b) => a.orderIndex - b.orderIndex); const from = ordered.findIndex(s => s.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= ordered.length || from === targetIndex) return;
    ordered.splice(targetIndex, 0, ordered.splice(from, 1)[0]);
    await run('reorder', 'shot.reorder', { projectId: data.project!.id, expectedRevision: dataRef.current!.project!.revision, shotIds: ordered.map(s => s.id) }, msg('projects.storyboardReordered'));
  }
  function readTaskRevealContext(): TaskRevealContext {
    return { active: importSession.current.active && projectSessionReady() && viewReady.current && taskWorkspaceState.current?.connected === true,
      projectId: currentProject.current || '', projectEpoch: projectEpoch.current, navigationEpoch: navigationEpoch.current,
      panelIntent: panelIntent.current, workspaceScope: workspaceOriginScope(workspaceRef.current) as string };
  }
  function readTaskViewContext(): TaskViewContext {
    const current = readTaskRevealContext();
    return { ...current, active: current.active && taskWorkspaceState.current?.visible === true };
  }
  function captureTaskView(): unknown { return captureTaskWorkspaceIntent(readTaskViewContext); }
  function openTasks(canReveal: () => boolean = () => true, selectedId?: string): boolean {
    if (clipDraftRef.current?.hasPendingComposition() || !canReveal() || !currentProject.current || !viewReady.current) return false;
    markPanelIntent(); setSelectedTaskId(selectedId); setShowDelivery(false); setShowImage(false); setShowTasks(true); return true;
  }
  function inspectTaskJob(job: AppJob, stillCurrent: () => boolean): unknown {
    const attempt = ++taskShotAttempt.current;
    const target = { projectId: currentProject.current || '', jobId: job.id, shotId: job.shotId, tab: job.status === 'succeeded' ? 'versions' : 'settings' };
    return navigateTaskShot(target as unknown as Parameters<typeof navigateTaskShot>[0], {
      readContext: readTaskViewContext, isVisible: () => attempt === taskShotAttempt.current && stillCurrent(),
      hasTarget: selected => dataRef.current!.project?.id === selected.projectId &&
        dataRef.current!.jobs.some(item => item.id === selected.jobId && item.shotId === selected.shotId && item.projectId === selected.projectId) &&
        dataRef.current!.shots.some(item => item.id === selected.shotId && item.projectId === selected.projectId),
      guard: canNavigate => guardNavigation(msg('shell.confirm.viewTaskShot'), false, canNavigate),
      reveal: selected => {
        navigationEpoch.current++; setShowTasks(false);
        updateView('canvas', { selectedId: selected.shotId, inspectorTab: selected.tab, highlightedVersionId: null });
        updateView('activeMode', 'canvas'); setPropertiesPage('inspector'); setRightDockTab('properties');
        setPanelOpen('inspector', true, 'canvas');
      },
    });
  }
  function openExportHistory(): void { if (clipDraftRef.current?.hasPendingComposition()) return; markPanelIntent(); setShowTasks(false); setShowImage(false); setShowExports(true); setShowDelivery(true); }
  async function createExport(): Promise<void> { const panelChoice = panelIntent.current, projectId = currentProject.current; const result = await run('export', 'export.create', { projectId: data.project!.id, requestId: requestId() }); if (result) { if (panelChoice === panelIntent.current && projectId === currentProject.current) openExportHistory(); notify(msg('shell.storyboardExportCreated')); } }
  const timeline = data.timeline;
  const timelinePending = taskState.phase !== 'ready' || activeTasks.some(task => task.lane === 'timeline:mutation') || activePending.some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render');
  const timelineBusy = Boolean(busy['timeline:mutation'] || timelinePending);
  const assetUsageAttempt = useRef(0), assetUsageAvailability = useRef<{ready: boolean} | null>(null), assetUsageSnapshot = useRef<unknown>(null);
  const assetUsageReady = online && auth === true && !loading && !timelineBusy && viewReady.current && data.project?.id === currentProject.current;
  assetUsageAvailability.current = { ready: assetUsageReady };
  const nextTimelineUsage = useMemo(() => deriveTimelineAssetUsage({ projectId: data.project?.id || '', assets: data.assets, timeline, ready: assetUsageReady }), [data.project?.id, data.assets, timeline, assetUsageReady]);
  const timelineUsage = (retainTimelineAssetUsage as unknown as (previous: unknown, next: unknown) => unknown)(assetUsageSnapshot.current, nextTimelineUsage);
  assetUsageSnapshot.current = timelineUsage;
  function readAssetUsageNavigation(): Record<string, unknown> {
    const projectId = currentProject.current || '', snapshot = dataRef.current;
    return { active: importSession.current.active && projectSessionReady() && viewReady.current, projectId, projectEpoch: projectEpoch.current,
      navigationEpoch: navigationEpoch.current, panelIntent: panelIntent.current, attempt: assetUsageAttempt.current, workspaceScope: workspaceOriginScope(workspaceRef.current),
      usage: deriveTimelineAssetUsage({ projectId, assets: snapshot.assets, timeline: snapshot.timeline,
        ready: Boolean(assetUsageAvailability.current?.ready) && snapshot.project?.id === projectId && !isBusy('timeline:mutation') }) };
  }
  async function locateAssetUse(use: unknown, isStillVisible: () => boolean = () => true): Promise<unknown> {
    assetUsageAttempt.current++;
    return (locateTimelineAssetUse as unknown as (use: unknown, options: unknown) => Promise<unknown>)(use, { read: readAssetUsageNavigation, isVisible: isStillVisible,
      confirm: (canDiscard: () => boolean) => guardNavigation(msg('shell.confirm.locateClip'), false, canDiscard),
      reveal: (target: {clipId: string; startFrame: number}) => {
        setPropertiesPage('inspector'); setRightDockTab('properties'); navigationEpoch.current++;
        updateView('editing', { selectedClipId: target.clipId, quickAssetId: null, playhead: target.startFrame, previewKind: 'source', timelineCollapsed: false });
        updateView('activeMode', 'editing'); setPanelOpen('inspector', true, 'editing'); setMobilePanel(geometry.narrow ? 'timeline' : 'canvas');
        const captured = context(), epoch = projectEpoch.current, panel = panelIntent.current, attempt = assetUsageAttempt.current;
        revealTimelineAssetUse(target.clipId,
          () => importSession.current.active && isCurrent(captured) && epoch === projectEpoch.current && panel === panelIntent.current && attempt === assetUsageAttempt.current
            && viewRef.current!.activeMode === 'editing' && viewRef.current!.editing.selectedClipId === target.clipId && (matchesTimelineAssetUse as unknown as (usage: unknown, target: unknown) => boolean)(readAssetUsageNavigation().usage, target),
          () => document.querySelector('[data-testid="timeline-scroll"]'), callback => requestAnimationFrame(callback));
      } });
  }
  function timelineFormatContext(): TimelineFormatContext {
    const projectId = currentProject.current, snapshot = dataRef.current;
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: projectSessionReady() && snapshot.project?.id === projectId ? projectId : null,
      projectRevision: snapshot.project?.revision, timelineId: snapshot.timeline?.id || null, timelineRevision: snapshot.timeline?.revision || 0,
      connected: workbenchReady && online && auth === true && !loading,
      pending: !projectId || (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(projectId) || pendingForProject(projectId as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || entry.operation.startsWith('timeline.')) };
  }
  async function saveTimelineFormat(intent: TimelineFormatIntent): Promise<{status: string; timeline?: unknown; error?: unknown}> {
    const live = timelineFormatContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || !live.connected || live.pending || !isDurableEditOperation('timeline.format.set')) return { status: 'rejected' };
    let failure: {error?: unknown; dispatched?: boolean; rejected?: boolean} | undefined, acknowledged: unknown;
    const result = await runDurable('timeline:mutation', 'timeline.format.set', intent.input, msg('shell.timelineFormatSaved'), {
      returnAfterNavigation: true, canExecute: () => intent.scope === timelineFormatContext().scope,
      validateResponse: value => { if (!timelineFormatAcknowledged(intent, value)) throw Object.assign(localizedError(msg('shell.error.formatAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    return { status: (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(intent.projectId) || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  }
  const timelineFormat = useTimelineFormat({ ...timelineFormatContext(), getContext: timelineFormatContext,
    visible: !application && workbenchReady && propertiesPage === 'format' && rightDockTab === 'properties' && panelVisible('inspector'),
    refreshKey: `${lastSync?.getTime() || 0}:${taskState.phase}:${taskState.items.map(task => `${task.id}:${task.revision}`).join(',')}`,
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.format.get', input, options as never), submit: saveTimelineFormat, createRequestId: requestId,
    onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useTimelineFormat>[0]) as unknown as TimelineFormatRuntime;
  timelineFormatRef.current = timelineFormat;
  useEffect(() => { setFormatDirty(Boolean(timelineFormat.state?.dirty || timelineFormat.state?.submitting)); }, [timelineFormat.state?.dirty, timelineFormat.state?.submitting]);
  function openTimelineFormat(): void {
    setShowProjects(false); setPropertiesPage('format'); setRightDockTab('properties'); setPanelOpen('inspector', true);
  }
  function subtitleContext(): SubtitleContext {
    const projectId = currentProject.current, snapshot = dataRef.current;
    return { scope: `${projectId}:${projectEpoch.current}`, projectId: projectSessionReady() && snapshot.project?.id === projectId ? projectId : null, timeline: snapshot.timeline as SubtitleTimeline | null,
      connected: workbenchReady && online && auth === true && !loading, pending: !projectId || isBusy('timeline:mutation') || (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(projectId, 'timeline:mutation') || pendingForProject(projectId as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      visible: workbenchReady && workspaceMode === 'editing' && propertiesPage === 'subtitle' && rightDockTab === 'properties' && panelVisible('inspector') } as SubtitleContext;
  }
  async function saveSubtitle(intent: SubtitleIntent): Promise<{status: string; timeline?: unknown; error?: unknown}> {
    const live = subtitleContext();
    if (intent.scope !== live.scope || intent.projectId !== live.projectId || intent.timelineId !== live.timeline?.id || intent.input.expectedRevision !== live.timeline?.revision || !live.connected || live.pending || !(live as SubtitleContext & {visible?: boolean}).visible || !isDurableEditOperation(intent.operation)) return { status: 'rejected' };
    let failure: {error?: unknown; dispatched?: boolean; rejected?: boolean} | undefined, acknowledged: unknown;
    const result = await runDurable('timeline:mutation', intent.operation, intent.input, msg('shell.subtitleSaved'), {
      returnAfterNavigation: true, canExecute: (() => intent.scope === subtitleContext().scope && subtitlesRef.current?.controller.isVisible() && intent.selection === subtitlesRef.current?.controller.getState().selection) as unknown as (preparedTask: unknown) => boolean,
      validateResponse: value => { if (!subtitleAcknowledged(intent, value as SubtitleTimeline | null | undefined)) throw Object.assign(localizedError(msg('shell.error.subtitleAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    return { status: (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(intent.projectId, 'timeline:mutation') || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  }
  const subtitles = useSubtitles({ ...subtitleContext(), getContext: subtitleContext, submit: saveSubtitle, createRequestId: requestId, onDirtyChange: setSubtitleDirty } as unknown as Parameters<typeof useSubtitles>[0]) as unknown as SubtitlesRuntime;
  subtitlesRef.current = subtitles;
  async function openSubtitle(cueId: string | null, frame: number = viewRef.current!.editing.playhead): Promise<void> {
    const captured = context(), panelChoice = panelIntent.current, controller = subtitlesRef.current?.controller, selected = controller?.getState();
    if (!controller || viewRef.current!.activeMode !== 'editing' || loading) return;
    const sameSelection = selected!.draft && (cueId ? selected!.cueId === cueId : !selected!.cueId && Number(selected!.draft.startFrame) === frame);
    if (!sameSelection && (selected!.submitting || selected!.uncertain)) { notify(msg('shell.subtitlePending'), 'warning'); openTasks(); return; }
    if (!sameSelection && selected!.dirty) {
      if (!await confirm(msg('shell.confirm.changeSubtitle'))) return;
      if (!isCurrent(captured) || panelChoice !== panelIntent.current || controller.getState() !== selected) return;
      controller.discardDraft(selected!.scope);
    }
    if (!isCurrent(captured) || panelChoice !== panelIntent.current) return;
    if (!sameSelection && !(cueId ? controller.select(cueId, selected!.scope) : controller.begin(frame, selected!.scope))) return;
    setPropertiesPage('subtitle'); setRightDockTab('properties'); setPanelOpen('inspector', true);
  }
  function clipReplacementContext(): Record<string, unknown> {
    const state = dataRef.current, editing = viewRef.current!.editing;
    return { scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: projectSessionReady() && state.project?.id === currentProject.current ? currentProject.current : null,
      timeline: state.timeline, clipId: editing.selectedClipId, assets: state.assets, versions: state.versions, shots: state.shots,
      dirty: dirtyRef.current, busy: isBusy('timeline:mutation'), pending: (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(currentProject.current, 'timeline:mutation') || pendingForProject(currentProject.current as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => entry.operation.startsWith('timeline.') && entry.operation !== 'timeline.render'),
      connected: workbenchReady && online && auth === true && !loading, visible: projectSessionReady() && viewRef.current!.activeMode === 'editing' && !editing.quickAssetId };
  }
  async function replaceTimelineClipSource(review: ClipReplacementReview): Promise<{status: string; timeline?: unknown; error?: unknown}> {
    // UI candidate metadata cannot authorize a mutation. Recheck the exact
    // reviewed owner, revision, content and draft against live App refs.
    const issue = clipReplacementReviewIssue(review, clipReplacementContext());
    if (issue) return { status: 'rejected', error: { code: 'REVISION_CONFLICT' } };
    let failure: {error?: unknown; dispatched?: boolean; rejected?: boolean} | undefined, acknowledged: unknown;
    const result = await mutateTimeline('timeline.clip.replaceSource', review.input, review.expectedRevision, {
      returnAfterNavigation: true, onFailure: (error, details) => { failure = { error, ...details }; }, errorMessage: clipReplacementErrorDescriptor,
      validateResponse: value => { if (!clipReplacementAcknowledged(review, value)) throw Object.assign(localizedError(msg('shell.error.replacementAcknowledgement')), { code: 'BACKEND_PROTOCOL_ERROR' }); acknowledged = value; },
    });
    // A failed refresh cannot erase an already validated mutation receipt.
    if (result || acknowledged) return { status: 'applied', timeline: result || acknowledged };
    const unresolved = (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(review.projectId, 'timeline:mutation') || pendingForProject(review.projectId as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => entry.key === 'timeline:mutation');
    return { status: unresolved || (failure?.dispatched && !failure.rejected) ? 'unknown' : 'rejected', error: failure?.error };
  }
  function exportSettingsContext(): Record<string, unknown> & {scope: string; enabled: boolean} {
    return { scope: `${currentProject.current}:${projectEpoch.current}`, enabled: Boolean(projectSessionReady() && dataRef.current!.project?.id === currentProject.current && online && auth === true && !loading && !isBusy('timeline:render:export') && !pendingForProject(currentProject.current as string, { workspace: workspaceRef.current as never, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) };
  }
  const exportSettings = useExportSettings({ ...exportSettingsContext(), getContext: exportSettingsContext } as unknown as Parameters<typeof useExportSettings>[0]) as unknown as ExportSettingsRuntime;
  exportSettingsRef.current = exportSettings.controller;
  function exportRangeContext(): ExportRangeContext {
    const base = exportSettingsContext(), local = localDeliveryRef.current?.controller.getState();
    return { ...base, enabled: base.enabled && showDelivery && !showExports && !(local?.scope === base.scope && (local.busy || local.pending)),
      projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current!.timeline?.id || null, revision: dataRef.current!.timeline?.revision || null,
      durationFrames: dataRef.current!.timeline?.durationFrames ?? null };
  }
  const exportRange = useExportRange({ ...exportRangeContext(), getContext: exportRangeContext } as unknown as Parameters<typeof useExportRange>[0]) as unknown as ExportRangeRuntime;
  exportRangeRef.current = exportRange.controller;
  function deliveryNameContext(): DeliveryNameContext { return { ...exportSettingsContext(), projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null }; }
  const deliveryName = useTimelineDeliveryName({ ...deliveryNameContext(), getContext: deliveryNameContext } as unknown as Parameters<typeof useTimelineDeliveryName>[0]) as unknown as DeliveryNameRuntime;
  deliveryNameRef.current = deliveryName;
  function localDeliveryContext(): LocalDeliveryContext {
    const scope = `${currentProject.current}:${projectEpoch.current}`;
    return { scope, projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current!.timeline?.id || null, timelineRevision: dataRef.current!.timeline?.revision || null,
      restored: Boolean(workspaceRef.current?.restored), connected: workbenchReady && online && auth === true && !loading,
      visible: workbenchReady && showDelivery && !showExports, busy: isBusy('timeline:render:export'),
      executionEpoch: `${navigationEpoch.current}:${panelIntent.current}:${exportSettings.controller!.getVersion(scope)}:${exportRange.controller!.getVersion(scope)}`,
      deliveryName: deliveryName.controller!.getName(scope), nameVersion: deliveryName.controller!.getVersion(scope), dirty: deliveryName.controller!.hasUnsaved(scope) };
  }
  const localDelivery = useLocalDelivery({ context: localDeliveryContext(), getContext: localDeliveryContext,
    isRenderInput: (value: unknown) => schemas['timeline.render'].safeParse(value).success,
    validateResponse: (input: Record<string, unknown>, value: unknown) => isTimelineMutationResponse('timeline.render', input, value),
    validateNotApplied: (input: Record<string, unknown>, code: string) => hasRequestNotAppliedProof({ code, status: 409, details: { mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: input.projectId, requestId: input.requestId } }, input, { operation: 'timeline.render' }),
    onRestore: (draft: {raw: {deliveryName: string}}, captured: {scope: string; nameVersion: number}) => deliveryNameRef.current?.controller.choose(draft.raw.deliveryName, captured.scope, captured.nameVersion) === true,
    onAccepted: async ({ intent }: {intent: {input: {projectId: string}}}) => { if (currentProject.current === intent.input.projectId) await refresh(intent.input.projectId); } } as unknown as Parameters<typeof useLocalDelivery>[0]) as unknown as LocalDeliveryRuntime;
  localDeliveryRef.current = localDelivery;
  function exportCheckContext(): Record<string, unknown> & {scope: string} {
    return { scope: `${currentProject.current}:${projectEpoch.current}`, projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: dataRef.current!.timeline?.id, revision: dataRef.current!.timeline?.revision, connected: workbenchReady && online && auth === true && !loading,
      exportSettings: exportSettings.controller!.getSettings(`${currentProject.current}:${projectEpoch.current}`), settingsVersion: exportSettings.controller!.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      exportRange: exportRange.controller!.getRange(`${currentProject.current}:${projectEpoch.current}`), rangeVersion: exportRange.controller!.getVersion(`${currentProject.current}:${projectEpoch.current}`),
      deliveryName: deliveryName.controller!.getName(`${currentProject.current}:${projectEpoch.current}`), deliveryNameVersion: deliveryName.controller!.getVersion(`${currentProject.current}:${projectEpoch.current}`) };
  }
  const exportCheckView = exportCheckContext();
  const exportPreflight = useExportPreflight({ ...exportCheckView, getContext: exportCheckContext, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), visible: workbenchReady && showDelivery && !showExports,
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.preflight', input, options as never),
    readCapabilities: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.capabilities', input, options as never), onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useExportPreflight>[0]) as unknown as ExportPreflightRuntime;
  const canOpenExport = Boolean(data.project && timeline?.id && !loading);
  const canCheckExport = Boolean(canOpenExport && Number.isSafeInteger(timeline!.revision) && timeline!.revision > 0 && online && auth === true && !deliveryName.error && !exportRange.error && (restored || !localDelivery.state.baselineConflict && !localDelivery.state.candidate));
  const pendingTimelineExport = activePending.some(entry => entry.key === 'timeline:render:export') || (!restored && localDelivery.state.pending);
  const [exportPreviewAttempt, setExportPreviewAttempt] = useState<{scope: string; timelineId: string; contextKey: string | null; input: Record<string, unknown>; submitting: boolean; exportId: string | null; receipt: unknown} | null>(null);
  const [sampleRangeDraft, setSampleRangeDraft] = useState<DraftRangeInput | null>(null);
  const sampleRangeDraftRef = useRef(sampleRangeDraft);
  sampleRangeDraftRef.current = sampleRangeDraft;
  function sampleExportContext(): Record<string, unknown> & {scope: string} {
    const base = exportCheckContext(), draft = sampleRangeDraftRef.current?.scope === base.scope ? sampleRangeDraftRef.current : null;
    const range = draft && /^\d+$/.test(draft.startText) && /^\d+$/.test(draft.endText) ? { startFrame: Number(draft.startText), endFrame: Number(draft.endText) } : null;
    return { ...base, exportRange: isExportPreviewRange(range, dataRef.current!.timeline?.durationFrames as number) ? range : null, rangeVersion: draft?.version || 0 };
  }
  function sampleExportContextKey(): string { return exportPreviewContextKey({ ...sampleExportContext(), scope: `${exportCheckContext().scope}:${workspaceOriginScope(workspaceRef.current)}` } as unknown as Parameters<typeof exportPreviewContextKey>[0], dataRef.current!.timeline as never, dataRef.current!.assets as never); }
  function chooseSampleExportRange(draft: DraftRangeInput): void {
    if (!exportRangeContext().enabled || localDelivery.state.busy || pendingTimelineExport) return;
    const next = { ...draft, scope: exportCheckContext().scope, version: (sampleRangeDraftRef.current?.version || 0) + 1 };
    sampleRangeDraftRef.current = next; setSampleRangeDraft(next);
  }
  function selectSampleExportRange(): void {
    const range = suggestedExportPreviewRange(dataRef.current!.timeline?.durationFrames as number, viewRef.current!.editing.playhead, exportRange.value as never);
    if (range) chooseSampleExportRange({ startText: String(range.startFrame), endText: String(range.endFrame) } as DraftRangeInput);
  }
  const sampleExportView = sampleExportContext();
  const sampleExportPreflight = useExportPreflight({ ...sampleExportView, getContext: sampleExportContext, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), visible: workbenchReady && showDelivery && !showExports,
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.preflight', input, options as never),
    readCapabilities: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.capabilities', input, options as never), onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useExportPreflight>[0]) as unknown as ExportPreflightRuntime;
  async function generateSampleExport(): Promise<void> {
    if (!workbenchReady || !showDelivery || showExports || !exportRangeContext().enabled || isBusy('timeline:render:export') || localDeliveryRef.current?.state.busy || pendingTimelineExport || dirtyRef.current || timelineFormatRef.current?.controller.hasUnsaved()) return;
    const captured = context(), choice = panelIntent.current, controller = sampleExportPreflight.controller;
    if (sampleRangeDraftRef.current?.scope !== exportCheckContext().scope) selectSampleExportRange();
    if (!isExportPreviewRange(sampleExportContext().exportRange as never, dataRef.current!.timeline?.durationFrames as number)) return;
    const sampleKey = sampleExportContextKey();
    const stillCurrent = () => isCurrent(captured) && choice === panelIntent.current && sampleKey === sampleExportContextKey() && !dirtyRef.current && !timelineFormatRef.current?.controller.hasUnsaved();
    controller.setContext(sampleExportContext());
    await controller.check();
    if (!stillCurrent()) return;
    const checked = controller.getState();
    if (!checked.binding || checked.attempted || !['ready', 'incomplete'].includes(checked.phase)) return;
    await renderTimeline('export', checked.binding, undefined, true);
  }
  function clipLoudnessContext(): TimelineClipLoudnessContext {
    const saved = dataRef.current!.timeline, workspaceScope = workspaceOriginScope(workspaceRef.current), editing = viewRef.current!.editing;
    return { ...savedClipLoudnessFields(saved, dataRef.current!.assets, editing.selectedClipId),
      scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${clipLoudnessEpoch.current}:${inspectorEpoch}`,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current!.assets),
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && viewRef.current!.activeMode === 'editing' && !editing.quickAssetId && rightDockTab === 'properties' && propertiesPage === 'inspector' && panelVisible('inspector') && !previewAssetRef.current && !comparisonIdRef.current && !webSettingsOpen,
      restored: workspaceRef.current?.restored === true,
      hasUnsavedDrafts: inspectorDirty || formatDirty || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate || subtitlesRef.current?.controller.hasUnsaved() || timelineFormatRef.current?.controller.hasUnsaved()),
      pending: timelineBusy || isBusy('timeline:mutation') };
  }
  function timelineMixLoudnessContext(): TimelineMixLoudnessContext {
    const workspaceScope = workspaceOriginScope(workspaceRef.current), saved = dataRef.current!.timeline;
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: saved?.id || null, revision: saved?.revision || null, durationFrames: saved?.durationFrames || 0,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current!.assets),
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${viewRef.current!.activeMode}`,
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: !application && workbenchReady && showDelivery && !showExports,
      restored: workspaceRef.current?.restored === true,
      hasUnsavedDrafts: clipDirty || subtitleDirty || formatDirty || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate || subtitlesRef.current?.controller.hasUnsaved() || timelineFormatRef.current?.controller.hasUnsaved()),
      pending: timelineBusy || isBusy('timeline:mutation') };
  }
  const timelineMixLoudness = useTimelineMixLoudness({ context: timelineMixLoudnessContext(), getContext: timelineMixLoudnessContext,
    getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.loudness.prepare', input, options as never), onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useTimelineMixLoudness>[0]) as unknown as TimelineMixLoudnessRuntime;
  const nativePreviewPause = useRef<(() => void) | null>(null), exportPreviewPause = useRef<(() => void) | null>(null), comparisonPreviewPause = useRef<(() => void) | null>(null);
  const registerComparisonPreviewPause = useCallback((pause: (() => void) | null) => { comparisonPreviewPause.current = pause; return () => { if (comparisonPreviewPause.current === pause) comparisonPreviewPause.current = null; }; }, []);
  function setComparisonId(id: string | null): void {
    if (id && (!projectSessionReady() || dataRef.current!.project?.id !== currentProject.current ||
      dataRef.current!.shots.filter(shot => shot.id === id && shot.projectId === currentProject.current).length !== 1)) return;
    clipLoudnessEpoch.current++;
    comparisonIdRef.current = id;
    comparisonPreviewPause.current?.();
    if (id) { audioPreview.controller!.revoke(); nativePreviewPause.current?.(); exportPreviewPause.current?.(); }
    updateComparisonId(id);
  }
  function comparisonContext(): ComparisonContext {
    const state = dataRef.current, workspaceScope = workspaceOriginScope(workspaceRef.current);
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: currentProject.current, workspaceOrigin: workspaceScope,
      connected: projectSessionReady() && state.project?.id === currentProject.current && online && auth === true && !loading,
      visible: Boolean(comparisonIdRef.current && workbenchReady && !webSettingsOpen), restored: workspaceRef.current?.restored === true,
      shot: state.shots.find(shot => shot.id === comparisonIdRef.current) || null, versions: state.versions as never[], assets: state.assets as never[] };
  }
  function useComparedVersion(binding: ComparisonBinding): unknown {
    const current = comparisonContext();
    if (!comparisonCurrent(binding, current) || isBusy(`version:${binding.shotId}`)) return;
    return selectVersion(current.shot as AppShot, binding.versionId);
  }
  function beforeMainPreviewPlay(): void {
    if (comparisonIdRef.current) { nativePreviewPause.current?.(); return; }
    comparisonPreviewPause.current?.(); exportPreviewPause.current?.();
  }
  function beforeExportPreviewPlay(): void {
    if (comparisonIdRef.current) { exportPreviewPause.current?.(); return; }
    comparisonPreviewPause.current?.(); audioPreview.controller!.revoke(); nativePreviewPause.current?.();
  }
  function beforeTimelineAudioPlay(): void {
    if (comparisonIdRef.current) { audioPreview.controller!.revoke(); return; }
    comparisonPreviewPause.current?.(); exportPreviewPause.current?.(); nativePreviewPause.current?.();
  }
  const registerExportPreviewPause = useCallback((pause: (() => void) | null) => { exportPreviewPause.current = pause; return () => { if (exportPreviewPause.current === pause) exportPreviewPause.current = null; }; }, []);
  const registerNativePreviewPause = useCallback((pause: (() => void) | null) => { nativePreviewPause.current = pause; return () => { if (nativePreviewPause.current === pause) nativePreviewPause.current = null; }; }, []);
  function soundAuditionContext(): TimelineAudioPreviewContext {
    const workspaceScope = workspaceOriginScope(workspaceRef.current), saved = dataRef.current!.timeline, editing = viewRef.current!.editing;
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      executionScope: `${navigationEpoch.current}:${viewRef.current!.activeMode}:${editing.previewKind}:${editing.selectedClipId}:${editing.quickAssetId}`,
      projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      timelineId: saved?.id || null, revision: saved?.revision || null, durationFrames: saved?.durationFrames || 0,
      sourceIdentity: timelineAudioPreviewSourceIdentity(saved, dataRef.current!.assets),
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: !application && workbenchReady && workspaceMode === 'editing' && previewKind === 'timeline' && panelVisible('canvas') && !previewAsset && !comparisonIdRef.current,
      restored: workspaceRef.current?.restored === true, hasUnsavedDrafts: clipDirty || subtitleDirty || formatDirty || Boolean(clipDraftRef.current?.getState().candidate) };
  }
  const audioPreview = useTimelineAudioPreview({ ...(nativeAudioAdmission ? { nativeAdmission: nativeAudioAdmission } : {}), context: soundAuditionContext(), getContext: soundAuditionContext,
    readPlan: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.audioPreview.plan', input, options as never),
    readContinuousPlan: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.audioPreview.continuousPlan', input, options as never),
    getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current), onUnauthorized: () => setAuth(false),
    onExplicitPosition: setPlayhead, onBeforePlay: beforeTimelineAudioPlay } as unknown as Parameters<typeof useTimelineAudioPreview>[0]) as unknown as ReturnType<typeof useTimelineAudioPreview>;
  function readTimelineLoudnessRecoveryScope(): string | null {
    return timelineLoudnessApplyRecoveryScope(lastProjectRef.current!.getState().identityBlocked ? null : preferenceScope.current, workspaceOriginScope(workspaceRef.current)) as string | null;
  }
  const timelineLoudnessApply = useTimelineLoudnessApply({
    nativeCloseRegistry: nativeCloseRegistry.current,
    getRecoveryScope: readTimelineLoudnessRecoveryScope,
    getObservation: () => timelineMixLoudnessViewState(timelineMixLoudness.controller!.getState(), timelineMixLoudnessContext()),
    confirm, createRequestId: requestId,
    submit: (intent: never, canExecute: never) => submitTimelineLoudnessApply(intent, canExecute, {
      mutate: mutateTimeline, isDurable: isDurableEditOperation,
      isPending: (projectId: string | null) => (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(projectId, 'timeline:mutation'), acknowledged: isTimelineMutationResponse,
    } as never),
  } as unknown as Parameters<typeof useTimelineLoudnessApply>[0]);
  timelineLoudnessApplyRef.current = timelineLoudnessApply;
  const effectivePlayhead = timelineAudioPreviewPosition(audioPreview, playhead);
  const seekTimelineSound = (frame: number) => seekTimelineAudioPreview(audioPreview, frame, setPlayhead);
  function exportSamplePeakContext(): Record<string, unknown> {
    const workspaceScope = workspaceOriginScope(workspaceRef.current);
    return { scope: workspaceScope === null ? null : `${currentProject.current}:${projectEpoch.current}:${workspaceScope}`,
      projectId: projectSessionReady() && dataRef.current!.project?.id === currentProject.current ? currentProject.current : null,
      executionScope: `${navigationEpoch.current}:${panelIntent.current}:${viewRef.current!.activeMode}`,
      connected: projectSessionReady() && workspaceScope !== null && online && auth === true && !loading,
      visible: workbenchReady && showDelivery && showExports, restored: workspaceRef.current?.restored === true,
      exports: dataRef.current!.exports, assets: dataRef.current!.assets };
  }
  const exportSamplePeak = useExportSamplePeak({ context: exportSamplePeakContext(), getContext: exportSamplePeakContext,
    isRenderRecord: isTimelineRenderRecord, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.samplePeak', input, options as never), onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useExportSamplePeak>[0]) as unknown as ExportSamplePeakRuntime;
  function checkTimelineExport(review?: Record<string, unknown> | null): unknown {
    const current = exportCheckContext();
    if (review && ['scope', 'projectId', 'timelineId', 'revision', 'settingsVersion', 'deliveryNameVersion', 'rangeVersion'].some(key => review[key] !== current[key])) return null;
    if (!workspaceRef.current?.restored && (localDeliveryRef.current?.controller.getState().baselineConflict || localDeliveryRef.current?.controller.getState().candidate)) return null;
    exportPreflight.controller!.setContext(current);
    return exportPreflight.controller!.check();
  }
  const exportLoudness = useExportLoudness({ context: exportSamplePeakContext(), getContext: exportSamplePeakContext,
    isRenderRecord: isTimelineRenderRecord, getInvocation: () => pinNewWorkspaceIntent({}, workspaceRef.current),
    read: (input: Record<string, unknown>, options?: Parameters<typeof rpc>[2]) => rpc('timeline.export.loudness', input, options as never), onUnauthorized: () => setAuth(false) } as unknown as Parameters<typeof useExportLoudness>[0]) as unknown as ExportSamplePeakRuntime;
  function openTimelineExport(): void {
    if (clipDraftRef.current?.hasPendingComposition()) return;
    markPanelIntent(); setShowTasks(false); setShowImage(false); setShowExports(false); setShowDelivery(true);
    exportPreflight.controller!.setVisible(true);
    // Opening is passive. Only the explicit Check action runs capability/media work.
  }
  const historyState = timelineHistoryState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading });
  const splitState = timelineSplitState({ projectId: data.project?.id, timeline, history: data.timelineHistory, busy: Boolean(busy['timeline:mutation']), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : selectedClipId, playhead: effectivePlayhead, mode: workspaceMode });
  async function splitTimelineClip(): Promise<unknown> {
    if (application) return null;
    if (currentProject.current !== dataRef.current!.project?.id) return null;
    const latest = timelineSplitState({ projectId: currentProject.current, timeline: dataRef.current!.timeline, history: dataRef.current!.timelineHistory, busy: isBusy('timeline:mutation'), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading, selectedClipId: propertiesPage === 'subtitle' ? null : viewRef.current!.editing.selectedClipId, playhead: timelineAudioPreviewPosition(audioPreview, viewRef.current!.editing.playhead), mode: viewRef.current!.activeMode });
    if (!latest.canSplit) return null;
    audioPreview.controller!.revoke();
    const result = await mutateTimeline('timeline.clip.split', { clipId: latest.clipId, atFrame: latest.atFrame });
    if (result) notify(msg('shell.clipSplit', { frame: latest.atFrame as number, left: latest.leftDuration as number, right: latest.rightDuration as number }));
    return result;
  }
  function changeTimelineHistory(direction: string): unknown {
    if (workspaceMode !== 'editing' || !['undo', 'redo'].includes(direction) || currentProject.current !== dataRef.current!.project?.id) return null;
    const latest = timelineHistoryState({ projectId: currentProject.current, timeline: dataRef.current!.timeline, history: dataRef.current!.timelineHistory, busy: isBusy('timeline:mutation'), pending: timelinePending, dirty: clipDirty || subtitleDirty, online: online && auth === true && !loading });
    if (!(direction === 'undo' ? latest.canUndo : latest.canRedo)) return null;
    return mutateTimeline(`timeline.${direction}`);
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (viewRef.current!.activeMode !== 'editing') return;
      const guards = { modalOpen: hasOpenWorkbenchModal(document) };
      if (!application && timelineSplitActionForKey(event, guards)) {
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
  async function mutateTimeline(operation: string, input: Record<string, unknown> = {}, expectedRevision?: number, options?: RunOptions): Promise<unknown> {
    if (application?.isRestoredWorkspace(workspaceRef.current) && !['timeline.clip.update', 'timeline.undo', 'timeline.redo'].includes(operation)) return null;
    if (clipDraftRef.current?.hasPendingComposition()) return null;
    if (!dataRef.current!.timeline) return null;
    const allowed=(prepared:unknown)=>!touchesLockedTrack(operation,input,dataRef.current!.timeline,new Set(trackLocksRef.current[currentProject.current||'']||[]))&&(options?.canExecute?.(prepared)??true);
    if(!allowed(undefined)){notify(msg('edit.track.lockedHint'),'warning');return null;}
    if ((tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(currentProject.current, 'timeline:mutation') || timelinePending) { notify(msg('shell.timelinePending'), 'warning'); openTasks(); return null; }
    return run('timeline:mutation', operation, { projectId: currentProject.current, expectedRevision: expectedRevision ?? dataRef.current!.timeline.revision, requestId: requestId(), ...input }, undefined, {...options,canExecute:allowed});
  }
  async function selectClip(id: string, showPreview = true): Promise<void> {
    if (clipDraftRef.current?.hasPendingComposition()) return;
    const captured = context(), panelChoice = panelIntent.current, timelineId = dataRef.current!.timeline?.id, timelineRevision = dataRef.current!.timeline?.revision;
    const canDiscard = (): boolean => Boolean(isCurrent(captured) && panelChoice === panelIntent.current && timelineId === dataRef.current!.timeline?.id && timelineRevision === dataRef.current!.timeline?.revision && dataRef.current!.timeline?.clips.some(clip => clip.id === id));
    if ((id !== selectedClipId || quickAssetId || workspaceMode !== 'editing' || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation(msg('shell.confirm.changeClip'), false, canDiscard)) return;
    const clip = dataRef.current!.timeline?.clips.find(c => c.id === id); if (!canDiscard() || !clip) return;
    setPropertiesPage('inspector');
    navigationEpoch.current++;
    // Re-selecting the same clip can leave every view patch unchanged. Publish
    // its new epoch before another popup binds to the previous render's scope.
    setNavigationPresentation(value => value + 1);
    leaveReferencePage();
    updateView('editing', { selectedClipId: id, quickAssetId: null, playhead: clip.startFrame, ...(showPreview ? { previewKind: 'source' } : {}) });
    updateView('activeMode', 'editing'); setMobilePanel('canvas');
  }
  async function addTimelineAsset(assetId: string, trackId?: string | null, startFrame?: number, dropSnapshot?: AssetDropSnapshot): Promise<void> {
    if (application?.isRestoredWorkspace(workspaceRef.current)) return;
    const panelChoice = panelIntent.current;
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (!await guardNavigation(msg('shell.confirm.addTimeline'))) return;
    const state = dataRef.current, asset = state.assets.find(a => a.id === assetId), tl = state.timeline;
    if (!asset || !tl) return;
    const kind = assetKind(asset) === 'audio' ? 'audio' : 'video';
    const track = tl.tracks.find(t => t.id === trackId) || (!trackId && tl.tracks.find(t => t.kind === kind));
    if (!track || track.kind !== kind) { notify(msg(kind === 'audio' ? 'shell.needsAudioTrack' : 'shell.needsVideoTrack'), 'warning'); return; }
    const length = assetTimelineDuration(asset);
    if (!length.known) { notify(length.noteMessage as AppMessage, 'warning'); return; }
    const durationFrames = dropSnapshot?.durationFrames ?? length.durationFrames;
    const start = startFrame ?? Math.max(0, ...tl.clips.filter(c => c.trackId === track.id).map(c => c.startFrame + c.durationFrames));
    const before = new Set(tl.clips.map(c => c.id));
    const result = await mutateTimeline('timeline.clip.add', { trackId: track.id, assetId, name: asset.name, startFrame: start, durationFrames, sourceInFrame: 0 }, dropSnapshot?.expectedRevision);
    if (result) {
      const revealAddedClip = panelIntent.current === panelChoice;
      const added = (result as AppTimeline).clips.find(c => !before.has(c.id));
      updateView('editing', { ...(added ? { selectedClipId: added.id, playhead: added.startFrame } : {}), quickAssetId: null, previewKind: 'source', ...(revealAddedClip ? { timelineCollapsed: false } : {}) });
      // The accepted clip remains saved. A newer panel choice wins over this
      // request's automatic workspace switch, without cancelling business work.
      if (revealAddedClip) { navigationEpoch.current++; updateView('activeMode', 'editing'); setMobilePanel('canvas'); }
      notify(msg('shell.clipAdded'));
    }
  }
  async function returnToSource(assetId: string): Promise<void> {
    const source = sourceForAsset(dataRef.current, assetId) as {asset: AppAsset; version: {id: string; number: number}; shot: {id: string} | null; node: {id: string} | null} | null; if (!source) return;
    if (application) return previewSource(source.asset);
    if (source.shot) { if (await inspect(source.shot.id, 'versions', source.version.id, { reveal: true })) revealCanvas(source.shot.id); }
    else if (source.node) { if (await inspect(source.node.id, 'settings', null, { reveal: true })) revealCanvas(source.node.id); }
    else {
      if (!await guardNavigation(msg('shell.confirm.returnSource'))) return;
      navigationEpoch.current++; updateView('activeMode', 'canvas');
      updateView('shared', { assetSearch: source.asset.name, assetFilter: 'all' }); setPanelOpen('assets', true, 'canvas'); setMobilePanel('assets'); setPreviewAsset(source.asset);
    }
  }
  async function moveTimelineClip(clipId: string, trackId: string, startFrame: number, dropSnapshot?: AssetDropSnapshot): Promise<void> {
    if (dropSnapshot && dropSnapshot.projectId !== currentProject.current) return;
    if (clipDirty && !await guardNavigation(msg('shell.confirm.moveClip'))) return;
    const clip = dataRef.current!.timeline?.clips.find(c => c.id === clipId);
    const track = dataRef.current!.timeline?.tracks.find(t => t.id === trackId);
    const asset = dataRef.current!.assets.find(a => a.id === clip?.assetId);
    if (!clip || !track) return;
    if (track.kind !== (assetKind(asset) === 'audio' ? 'audio' : 'video')) { notify(msg('shell.compatibleTracks'), 'warning'); return; }
    const result = await mutateTimeline('timeline.clip.update', { clipId, patch: { trackId, startFrame } }, dropSnapshot?.expectedRevision);
    if (result) { setSelectedClipId(clipId); setPlayhead(startFrame); }
  }
  function renderUncheckedTimeline(intent: unknown): Promise<void> { return renderTimeline('export', null, intent); }
  async function renderTimeline(purpose: string, binding?: unknown, uncheckedIntent?: unknown, sample = false): Promise<void> {
    if (!dataRef.current!.timeline?.clips.length) return;
    if (sample && (purpose !== 'export' || uncheckedIntent || dirtyRef.current || timelineFormatRef.current?.controller.hasUnsaved() || !isExportPreviewRange(sampleExportContext().exportRange as never, dataRef.current!.timeline.durationFrames))) return;
    let exportInput;
    if (purpose === 'export') {
      const selectedPreflight = sample ? sampleExportPreflight : exportPreflight;
      selectedPreflight.controller.setContext(sample ? sampleExportContext() : exportCheckContext());
      if (isBusy('timeline:render:export')) return;
      // A saved receipt must be recovered explicitly from the task panel. A new
      // confirmation must never silently replay it or mint a second request.
      try {
        if (pendingForProject(currentProject.current as string, { strict: true, workspace: workspaceRef.current as never, activeOnly: true }).some(entry => entry.key === 'timeline:render:export')) {
          notify(msg('shell.exportPending'), 'warning'); openTasks(); return;
        }
      } catch { notify(msg('shell.exportRecordUnavailable'), 'error'); openTasks(); return; }
      if (!workspaceRef.current?.restored && !localDeliveryRef.current?.controller.canPrepare()) return;
      exportInput = uncheckedIntent ? selectedPreflight.controller.takeUncheckedExportIntent(uncheckedIntent as never) : selectedPreflight.controller.takeExportBinding(binding as never);
      if (!exportInput) return;
    }
    const deliveryPanelChoice = panelIntent.current, deliveryProjectId = currentProject.current, deliveryRangeVersion = exportCheckContext().rangeVersion;
    const deliveryCapture = purpose === 'export' ? deliveryNameRef.current?.controller.capture() : null;
    const input = { ...(exportInput || { projectId: currentProject.current, expectedRevision: dataRef.current!.timeline.revision }), requestId: requestId(), purpose };
    const captured = context();
    const sampleContextKey = sample ? sampleExportContextKey() : null;
    if (sample) setExportPreviewAttempt({ scope: exportCheckContext().scope, timelineId: dataRef.current!.timeline.id, contextKey: sampleContextKey, input: structuredClone(input), submitting: true, exportId: null, receipt: null });
    const result = (purpose === 'export' && !workspaceRef.current?.restored
      ? await localDeliveryRef.current!.controller.submit(input as never, { canExecute: () => isCurrent(captured) && (!sample || sampleContextKey === sampleExportContextKey()), nameCapture: deliveryCapture })
      : await run(`timeline:render:${purpose}`, 'timeline.render', input)) as {id?: string; [key: string]: unknown} | null | undefined;
    if (sample) setExportPreviewAttempt(previous => (previous?.input.requestId === input.requestId ? { ...previous, submitting: false, ...(result && isTimelineRenderRecord(result, input) ? { exportId: result.id as string, receipt: result } : {}) } : previous) as typeof previous);
    if (result) { const matchingDelivery = !deliveryCapture || deliveryNameRef.current?.controller.acknowledge(deliveryCapture, result); if (purpose === 'preview') { updateView('activeMode', 'editing'); setPreviewKind('timeline'); } else if (!sample && matchingDelivery && deliveryPanelChoice === panelIntent.current && deliveryProjectId === currentProject.current && deliveryRangeVersion === exportCheckContext().rangeVersion) { setDeliveryAttempt({ projectId: deliveryProjectId as string, id: result.id as string }); setShowExports(false); return; } if (purpose !== 'preview' && !sample) notify(msg('shell.timelineExportStarted')); }
  }
  async function previewSource(asset: AppAsset): Promise<void> {
    const owner = context();
    if (viewRef.current!.activeMode === 'canvas') {
      const choice = panelIntent.current;
      const current = () => isCurrent(owner) && viewRef.current!.activeMode === 'canvas' && choice === panelIntent.current && dataRef.current!.assets.some(item => item.id === asset.id && item.projectId === owner.projectId);
      if (!current() || !await guardNavigation(msg('shell.confirm.viewCanvasSource'), false, current) || !current()) return;
      navigationEpoch.current++;
      leaveReferencePage(); setPropertiesPage('inspector');
      updateView('canvas', { selectedId: null, selectedEdgeId: null, inspectorTab: 'settings', highlightedVersionId: null });
      setPreviewAsset(asset); setPanelOpen('inspector', true, 'canvas');
      return;
    }
    if ((viewRef.current!.editing.quickAssetId !== asset.id || subtitlesRef.current?.controller.hasUnsaved()) && !await guardNavigation(msg('shell.confirm.changeSource'))) return;
    if (!isCurrent(owner) || !dataRef.current!.assets.some(item => item.id === asset.id && item.projectId === owner.projectId)) return;
    navigationEpoch.current++;
    setPropertiesPage('inspector');
    updateView('editing', { quickAssetId: asset.id, selectedClipId: null, previewKind: 'source' });
  }
  async function addSavedSourceRange(snapshot: SourceRangeSnapshot): Promise<void> {
    const captured = context(), panelChoice = panelIntent.current;
    if (!snapshot || snapshot.scope !== sourceRangeScope || snapshot.projectId !== captured.projectId || !sameSourceSnapshot(snapshot as never, (sourceRanges.controller as unknown as {snapshot(): unknown}).snapshot() as never)) return;
    const state = dataRef.current;
    const plan = sourceRangeAddPlan({ snapshot, asset: state.assets.find(asset => asset.id === snapshot.assetId), timeline: state.timeline,
      blocked: isBusy('timeline:mutation') || isBusy('canvas:mutation') || pendingForProject(captured.projectId, { workspace: captured.workspace as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation) || entry.operation.startsWith('timeline.')) });
    if (!plan.valid) { notify(plan.reasonMessage as AppMessage, 'warning'); return; }
    // Capture exact primitives before dispatch. Saving a different source range
    // later cannot change this request, its retry receipt, or existing clips.
    const result = await mutateTimeline('timeline.clip.add', { ...plan.input }, plan.expectedRevision);
    if (!result || !isCurrent(captured)) return;
    if (panelIntent.current === panelChoice) setPanelOpen('timeline', true, 'editing');
    notify(msg('shell.savedRangeAdded'));
  }
  function canvasDrop(event: React.DragEvent<HTMLDivElement>): void {
    const assetId = event.dataTransfer.getData(ASSET_DRAG);
    if (!assetId) return;
    event.preventDefault(); const asset = dataRef.current!.assets.find(a => a.id === assetId);
    if (asset) addNode(assetKind(asset), asset, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }
  const sortedShots = useMemo(() => [...data.shots].sort((a, b) => a.orderIndex - b.orderIndex), [data.shots]);
  const chosenShot = data.shots.find(s => s.id === selectedId);
  const chosenNode = data.nodes.find(n => n.id === selectedId);
  const chosenClip = timeline?.clips.find(c => c.id === selectedClipId);
  const liveClipInspector = chosenClip ? { key: `${data.project?.id}:${chosenClip.id}:${inspectorEpoch}`, scope: `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`, projectId: currentProject.current, clip: chosenClip, timeline, asset: data.assets.find(a => a.id === chosenClip.assetId), restored, workspaceOrigin: workspace?.workspaceOrigin } : null;
  clipInspectorRetention.current = retainClipInspector(clipInspectorRetention.current, liveClipInspector as never, { pending: clipCompositionPending || Boolean(clipDraftRef.current?.hasPendingComposition()), dirty: clipDirty, connected: online && auth === true && !loading });
  const displayedClipInspector = clipInspectorRetention.current.snapshot;
  const clipInspectorRetained = clipInspectorRetention.current.retained;
  clipConnectionBlocked.current = !online || auth !== true || clipInspectorRetained;
  const retainWorkbenchForClip = retainClipWorkbench(displayedClipInspector, clipCompositionPending || Boolean(clipDraftRef.current?.hasPendingComposition()), clipDirty);
  const staleClips = staleClipSources(timeline?.clips ?? [], data.shots, data.versions);
  const agentTimelineSelection = workspaceMode === 'editing' && propertiesPage === 'inspector' && !quickAssetId
    ? makeAgentTimelineClipSelection(timeline, selectedClipId, data.project?.id) : null;
  const agentTimelineGainSelection = workspaceMode === 'editing' && propertiesPage === 'inspector' && !quickAssetId
    ? makeAgentTimelineGainSelection(timeline, selectedClipId, data.project?.id, data.assets) : null;
  const gainBlockContext = { connected: workbenchReady && online && auth === true && !loading, dirty: inspectorDirty || formatDirty,
    recoveredDraft: agentClipDraftBlocked || Boolean(clipDraftRef.current?.hasUnsaved() || clipDraftRef.current?.getState().candidate), pending: timelineBusy };
  const gainTrackLocked=Boolean(chosenClip&&lockedTrackIds.has(chosenClip.trackId));
  const gainBlockedReason = gainTrackLocked ? renderCoreMessage('zh-Hans',msg('edit.track.lockedHint')) : agentTimelineGainBlockedReason(gainBlockContext);
  const gainBlockedDescriptor = gainTrackLocked ? msg('edit.track.lockedHint') : agentTimelineGainBlockedDescriptor(gainBlockContext);
  const agentTimelineBlockedDescriptor = lockedTrackIds.size ? msg('edit.track.lockedHint') : !online || auth !== true || loading ? msg('shell.waitProjectLoad')
    : inspectorDirty ? msg('shell.saveBeforeMoveReview')
      : timelineBusy ? msg('shell.timelineBusy') : '';
  const agentTimelineBlockedReason = renderCoreMessage('zh-Hans', agentTimelineBlockedDescriptor);
  const chosenVersion = data.versions.find(v => v.id === chosenShot?.selectedVersionId);
  const sourceAsset = data.assets.find(a => a.id === (quickAssetId || chosenClip?.assetId));
  const clipSource = (chosenClip && sourceForAsset(data, chosenClip.assetId)) as {asset: AppAsset; version: {id: string; number: number}; shot: {id: string; title: string} | null; node: {id: string} | null} | null;
  const rangeAsset = workspaceMode === 'editing' && quickAssetId ? sourceAsset : null;
  const rangeSelectionKey = `${currentProject.current}:${projectEpoch.current}:${workspaceMode}:${quickAssetId || ''}:${inspectorEpoch}`;
  const rangeSelectionEpoch = useRef<{key: string | null; serial: number}>({ key: null, serial: 0 });
  if (rangeSelectionEpoch.current.key !== rangeSelectionKey) rangeSelectionEpoch.current = { key: rangeSelectionKey, serial: rangeSelectionEpoch.current.serial + 1 };
  const sourceRangeScope = `${rangeSelectionKey}:${rangeSelectionEpoch.current.serial}`;
  const sourceRanges = useSourceRange({ scope: sourceRangeScope, projectId: !application && workbenchReady ? data.project?.id : null, asset: rangeAsset,
    read: ((input: Record<string, unknown>) => rpc('asset.range.get', input)) as never,
    save: ((input: Record<string, unknown>) => run(`source-range:${input.assetId as string}`, 'asset.range.set', input, msg('shell.sourceRangeSaved'), { returnAfterNavigation: true })) as never,
    refreshGeneration: sourceRangeRefresh[`${data.project?.id}:${rangeAsset?.id}`] || 0, onDirtyChange: setSourceDirty });
  const sourceRangeBlocked = !online || loading || Boolean(busy['canvas:mutation'] || timelineBusy || activePending.some(entry => isMutationOperation(entry.operation)));
  const frameExtraction = useFrameExtraction({ projectId: !application && workbenchReady ? data.project?.id : null, sourceScope: sourceRangeScope, sourceAsset: rangeAsset, assets: data.assets as never[],
    visible: !application && workbenchReady && workspaceMode === 'editing' && Boolean(quickAssetId && rangeAsset) && (panelVisible('canvas') || panelVisible('inspector') && rightDockTab === 'properties'),
    blocked: restored || sourceRangeBlocked || Object.values(busy).some(Boolean), rpc: rpc as never, createRequestId: requestId,
    onResult: (projectId: string) => { if (currentProject.current === projectId) void refresh(projectId); }, revealAsset: revealImageAsset });

  const dispositionScope = `${currentProject.current}:${projectEpoch.current}`;
  const dispositionBlocked = !online || loading || Boolean(busy['canvas:mutation'] || activePending.some(entry => isMutationOperation(entry.operation)));
  const dispositions = useAssetDispositions({ scope: dispositionScope, projectId: !application && workbenchReady ? (data.project?.id ?? null) : null, assets: data.assets as never[],
    read: ((input: Record<string, unknown>) => rpc('asset.disposition.list', input)) as never,
    save: (input: Record<string, unknown>) => run(dispositionKey(input.assetId as string), 'asset.disposition.set', input, msg('shell.assetMarkSaved'), { returnAfterNavigation: true }),
    hasPending: ((projectId: string | null) => pendingForProject(projectId as string, { strict: true, workspace: (context().workspace || { restored: false }) as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation))) as never,
    pendingState: activePending.some(entry => isMutationOperation(entry.operation)), blocked: dispositionBlocked, refreshGeneration: dispositionRefresh[data.project?.id as string] || 0 });
  const annotationScope = `${workspaceOriginScope(workspace)}:${currentProject.current}:${projectEpoch.current}`;
  const annotationBlocked = restored || !online || auth !== true || loading || dispositionBlocked;
  const annotations = useAssetAnnotations({ scope: annotationScope, ownerScope: JSON.stringify([workspaceOriginScope(workspace), currentProject.current]) as never, projectId: !application && workbenchReady ? (data.project?.id ?? null) : null, assets: data.assets as never[],
    read: input => rpc('asset.annotation.list', input),
    save: async input => { let failure; const result = await run(annotationKey(input.assetId), 'asset.annotation.set', input, msg('annotations.savedToast'), { returnAfterNavigation: true, errorMessage: annotationError, onFailure: (error, outcome) => { failure = { error, ...outcome }; } }); return { result, failure }; },
    canSave: () => !annotationBlocked,
    hasPending: (projectId, assetId, ownerScope) => { const [origin] = JSON.parse(ownerScope as string); const ownerWorkspace = origin === 'normal' ? { restored: false } : typeof origin === 'string' && origin.startsWith('restored:') ? { restored: true, workspaceOrigin: origin.slice(9) } : null; return pendingForProject(projectId as string, { strict: true, workspace: ownerWorkspace as never, activeOnly: true }).some(entry => isMutationOperation(entry.operation) && (!assetId || entry.operation === 'asset.annotation.set' && entry.input.assetId === assetId)); },
    pendingAssetIds: (projectId, ownerScope) => { const [origin] = JSON.parse(ownerScope as string); const ownerWorkspace = origin === 'normal' ? { restored: false } : typeof origin === 'string' && origin.startsWith('restored:') ? { restored: true, workspaceOrigin: origin.slice(9) } : null; return pendingForProject(projectId as string, { strict: true, workspace: ownerWorkspace as never, activeOnly: true }).filter(entry => entry.operation === 'asset.annotation.set').map(entry => entry.input.assetId) as string[]; },
    pendingState: activePending, refreshGeneration: annotationRefresh[data.project?.id as string] || 0, registry: nativeCloseRegistry.current });
  const subjectScope = `${currentProject.current}:${projectEpoch.current}:${inspectorEpoch}`;
  const subjectBlocked = !online || loading || (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(currentProject.current, 'subject:mutation');
  const subjects = useSubjects({ scope: subjectScope, projectId: !application && workbenchReady ? (data.project?.id ?? null) : null, assets: data.assets as never[], shotIds: data.shots.map(shot => shot.id),
    read: ((operation: string, input: Record<string, unknown>) => rpc(operation, input)) as never,
    save: (operation: string, input: Record<string, unknown>, options: RunOptions) => runDurable('subject:mutation', operation, input, msg('shell.planningLinkSaved'), { ...options, returnAfterNavigation: true }),
    hasPending: ((projectId: string) => (tasksRef.current!.blocked as unknown as (projectId: string | null, lane?: string) => boolean)(projectId, 'subject:mutation')) as never, blocked: subjectBlocked,
    pendingState: taskState, refreshGeneration: subjectRefresh[data.project?.id as string] || 0, onDirtyChange: setSubjectDirty });
  subjectsRef.current = subjects as unknown as SubjectsRuntime;
  const selectedCanvasAsset = chosenNode?.assetId || chosenVersion?.assetId || chosenShot?.referenceAssetIds?.[0] || (!chosenNode && !chosenShot && canvasAssetSelectionRef.current?.projectId === currentProject.current && canvasAssetSelectionRef.current?.epoch === projectEpoch.current ? canvasAssetSelectionRef.current.id : null);
  const librarySource = workspaceMode === 'editing' ? sourceAsset : previewAsset || data.assets.find(asset => asset.id === selectedCanvasAsset);
  const inUseAssetIds = new Set([...(timeline?.clips || []).map(clip => clip.assetId), ...data.nodes.map(node => node.assetId), ...data.shots.flatMap(shot => generationReferences(shot).references.map(reference => reference.assetId)), ...data.shots.map(shot => data.versions.find(version => version.id === shot.selectedVersionId)?.assetId)].filter(Boolean));

  const timelineJobs = [...data.exports].filter(e => e.mode === 'timeline').sort((a, b) => b.createdAt!.localeCompare(a.createdAt!));
  const previewJob = timelineJobs.find(e => !e.snapshot?.exportRange && ['succeeded','completed','ready'].includes(e.status));
  const latestRender = timelineJobs.find(item => !data.restore?.heldExportIds.includes(item.id));
  const jobs = useMemo(() => [...data.jobs].sort((a, b) => b.createdAt!.localeCompare(a.createdAt!)), [data.jobs]);
  const activeCount = restored ? 0 : jobs.filter(activeJob).length;
  const activeRenderCount = restored ? 0 : timelineJobs.filter(item => ['queued','running'].includes(item.status) && !data.restore?.heldExportIds?.includes(item.id)).length;
  const taskCount = activeCount + activeRenderCount + activePending.length + activeTasks.length;
  const selectedCount = data.shots.filter(s => s.selectedVersionId).length;
  const orderedExports = [...data.exports].sort((a, b) => b.createdAt!.localeCompare(a.createdAt!));
  const saveIsDirty=Boolean(inspectorDirty||formatDirty||annotations.state?.dirtyCount||preferenceStatus.pending);
  const saveFailed=['error','conflict'].includes(preferenceStatus.phase);
  const formalExportRecord=deliveryAttempt&&deliveryAttempt.projectId===data.project?.id?orderedExports.find(item=>item.id===deliveryAttempt.id)??null:null;
  const exportDetails=useExportActivity({projectId:data.project?.id||'',exportId:formalExportRecord?.id||'',status:formalExportRecord?.status||'',scope:JSON.stringify([currentProject.current,projectEpoch.current,navigationEpoch.current,panelIntent.current,showDelivery,showExports]),enabled:showDelivery&&!showExports&&!restored&&!application&&online&&auth===true});
  const taskDispositions=useTaskDispositions({projectId:currentProject.current||'',scope:taskViewScope,enabled:Boolean(currentProject.current)&&showTasks&&!restored,targets:[...jobs.map(item=>({kind:'generation' as const,taskId:item.id,status:item.status})),...orderedExports.map(item=>({kind:'render' as const,taskId:item.id,status:item.status})),...activeTasks.map(item=>({kind:'edit' as const,taskId:item.id,status:item.status}))],expectedWorkspaceOrigin:workspace?.workspaceOrigin});
  useEffect(() => {
    if (dragging.current) return;
    const next = [...data.nodes.map(record => ({ id: record.id, type: record.type, position: record.position, selected: record.id === selectedId, data: { record, asset: data.assets.find(a => a.id === record.assetId), canReference: isImageReferenceNode(record, data.assets as never[], data.project?.id), referenceBusy, onInspect: (id: string, nextTab: string) => inspect(id, nextTab, null, { reveal: true }) } })), ...sortedShots.map((record, index) => ({ id: record.id, type: 'shot', position: record.position, selected: record.id === selectedId, data: { record, index, referenceConnection: referenceForShot(data.edges as never[], record.id), referenceSourceLabel: data.nodes.find(node => node.id === (referenceForShot(data.edges as never[], record.id) as {source?: string} | null | undefined)?.source)?.label || data.assets.find(asset => asset.id === (referenceForShot(data.edges as never[], record.id) as {source?: string; sourceAssetId?: string} | null | undefined)?.sourceAssetId)?.name || msg('assets.imageNode'), referenceBusy, asset: data.assets.find(a => a.id === record.referenceAssetIds?.[0]), version: data.versions.find(v => v.id === record.selectedVersionId), versionCount: data.versions.filter(v => v.shotId === record.id).length, job: jobs.find(j => j.shotId === record.id), busy: busy[`generate:${record.id}`], generationUnavailableReason, generationProvider: generationSelection(providers, generationOptions[record.id], record).provider, onInspect: (id: string, nextTab: string) => inspect(id, nextTab, null, { reveal: true }), onGenerate: async (shot: AppShot) => { if (!await inspect(shot.id)) return; if (shot.id === selectedId && inspectorDirty) { notify(msg('shell.saveShotBeforeGenerate'), 'warning'); return; } generate(shot); } } }))];
    setNodes(next as FlowNode[]);
  }, [data, sortedShots, selectedId, jobs, busy, inspectorDirty, providers, generationOptions, referenceBusy, generationUnavailableReason]);
  const edges = useMemo(() => data.edges.map(edge => canvasEdge(edge, edge.id === selectedEdgeId, locale)), [data.edges, selectedEdgeId, locale]);
  const selectedEdge = data.edges.find(edge => edge.id === selectedEdgeId);
  const visibleAssets = data.assets.filter(a => (assetFilter === 'all' || a.mimeType?.startsWith(`${assetFilter}/`)) && a.name.toLowerCase().includes(assetSearch.toLowerCase()));
  const guardRetainedInputInteraction = (event: React.SyntheticEvent) => {
    if (!clipConnectionBlocked.current || !retainWorkbenchForClip) return;
    if ((event.target as Element | null)?.closest?.('[data-testid="clip-volume-envelope"], [data-testid="clip-opacity-envelope"], [data-retained-input-action]')) return;
    event.preventDefault(); event.stopPropagation();
  };
  function imageEditScope() { return `${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}:${panelIntent.current}:${workspaceOriginScope(workspaceRef.current)}`; }
  function isImageEditIntentCurrent(intent: ImageEditIntent | null) {
    return intent === imageEditIntentRef.current && !application && !restored && online && auth === true && !loading && projectSessionReady() && showImage && !webSettingsOpen &&
      Boolean(imageEditIntentSource(intent as ImageEditIntent, { scope: imageEditScope(), projectId: currentProject.current as string, assets: dataRef.current!.assets }));
  }
  async function openImageEdit(asset: AppAsset): Promise<boolean> {
    if (application || restored || !online || auth !== true || loading || !projectSessionReady() || clipDraftRef.current?.hasPendingComposition()) return false;
    const captured = context(), epoch = projectEpoch.current, choice = panelIntent.current;
    const intent = captureImageEditIntent({ id: requestId(), scope: imageEditScope(), projectId: currentProject.current as string, asset });
    const current = () => Boolean(intent && isCurrent(captured) && epoch === projectEpoch.current && choice === panelIntent.current && !application && !restored && online && auth === true && !loading && projectSessionReady() && imageEditIntentSource(intent, { scope: imageEditScope(), projectId: currentProject.current as string, assets: dataRef.current!.assets }));
    if (!current() || !await guardNavigation(msg('shell.confirm.viewCanvasSource'), false, current) || !current()) return false;
    // The image session owns its exact form-version guard. Opening only presents
    // this source intent; existing image drafts still require its explicit choice.
    markPanelIntent(); setShowTasks(false); setShowDelivery(false); setShowImage(true);
    const next = captureImageEditIntent({ id: intent!.id, scope: imageEditScope(), projectId: intent!.projectId, asset });
    if (!next) return false;
    setImageEditIntent(next); return true;
  }
  if (auth === false && !retainWorkbenchForClip) return <Login onLogin={boot} />;
  if ((auth === null || auth === 'error') && !retainWorkbenchForClip) return <div className="boot-page"><LanguageControl /><div className="brand"><span className="brand-mark"><BrandMark /></span>Mioon</div>{auth === null ? <><span className="spinner" /><p>{t('shell.connecting')}</p></> : <><h2>{t('shell.connectFailed')}</h2><p>{toast?.message ? renderImportFeedback(locale, toast.message) : t('shell.checkServer')}</p><Button variant="ghost" className="button primary" onClick={() => { setAuth(null); boot(); }}><Icon name="refresh" />{t('shell.reconnect')}</Button></>}</div>;
  if (nativeWindow && !workbenchReady && !retainWorkbenchForClip) return <EditorWindowOpening error={projectOpening.error} onRetry={() => { void selectProject((currentProject.current || nativeWindow.context.initialProjectId) as string, false, true); }} onProjects={() => { void nativeProjectEntry?.show('open'); }} />;
  const webSettingsCenter = nativeWindow ? null : <WebSettingsCenter key="global-settings-center" request={webSettingsRequest} registry={settingsNavigation.current} onOpenChange={setWebSettingsOpen} connectionsAvailable={!application && !restored} renderSettings={props => <SettingsConnectionForms {...props} />} />;
  if (!workbenchReady && !retainWorkbenchForClip) return <>{webSettingsCenter}<ProjectHome summaryEnabled={!application && !restored} summaryScope={(preferenceScope.current || workspaceOriginScope(workspace)) as string} projects={projects as never[]} phase={projectOpening.phase === 'error' ? 'error' : loading || projectOpening.phase === 'opening' ? 'opening' : 'home'} openingName={projects.find(item => item.id === projectOpening.projectId)?.name || t('projects.project')} error={projectOpening.error} notice={toast?.message} busy={Boolean(busy['project-create'] || busy['project-create-flow'])} listBusy={projectListStatus.busy} listError={projectListStatus.error} page={homePage as never} onPage={changeHomePage} onOpen={id => { void selectProject(id); }} onRetry={() => { if (projectOpening.projectId) void selectProject(projectOpening.projectId, false, true); }} onRefresh={refreshHomeProjects} onCreate={createProject} createDisabledReason={opacityRestored ? t('opacity.restored.createUnavailable') : ''} help={<LastProjectStatus state={(lastProjectStatus || lastProjectRef.current!.getState()) as never} controller={lastProjectRef.current} restored={restored} />} status={opacityRestored ? <OpacityRestoredNotice draftsPersistent={application?.supportsRestoredClipDrafts(workspace)} /> : restored && <RestoredUnavailable title={t('shell.restoredScope')} />} settings={null} /></>;
  return <>{webSettingsCenter}<main className={`workbench workbench-v2 dock-workbench shell-redesign ${geometry.narrow ? 'dock-narrow' : ''} ${geometry.compact ? 'dock-compact' : ''} mode-${workspaceMode} mobile-${mobilePanel} ${assetsCollapsed ? 'assets-collapsed' : ''} ${inspectorCollapsed ? 'inspector-collapsed' : ''} ${timelineCollapsed ? 'timeline-collapsed' : ''}`} data-testid="workbench" onClickCapture={guardRetainedInputInteraction} onKeyDownCapture={guardRetainedInputInteraction} onSubmitCapture={guardRetainedInputInteraction} data-workspace-mode={workspaceMode} data-narrow={geometry.narrow ? 'true' : 'false'} data-compact={geometry.compact ? 'true' : 'false'} style={geometry.style as never}>
    {retainWorkbenchForClip && clipConnectionBlocked.current && <div className="notice warning" role="status" data-testid="retained-clip-connection"><p>{t('volume.envelope.connectionRetained')}</p></div>}
    <WorkspaceVisibilityProvider visible={!comparisonId}>
    <Input ref={fileInput} className="sr-only" type="file" disabled={opacityRestored} accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" multiple aria-label={t('assets.importLocal')} data-testid="asset-upload" onChange={e => importFiles(Array.from(e.target.files ?? []))} />
    <WorkbenchTopbar brand={<a className="brand" href={window.location.pathname} onClick={event => { event.preventDefault(); void showProjectHome(); }} aria-label={t('shell.title')}><span className="brand-name">Mioon</span></a>} projectMenu={<DropdownMenu open={showProjects} onOpenChange={setShowProjects}><DropdownMenuTrigger render={<Button variant="ghost" className="project-trigger" data-testid="project-switcher" aria-label={data.project?.name || t('projects.choose')} title={data.project?.name || t('projects.choose')} />}><Icon name="folder" size={16} /><span>{data.project?.name || t('projects.choose')}</span><Icon name="down" size={13} /></DropdownMenuTrigger><DropdownMenuContent align="start" className="workbench-project-menu"><DropdownMenuGroup><DropdownMenuLabel>{t('projects.yourProjects')}</DropdownMenuLabel>{projects.map(p => <DropdownMenuItem key={p.id} onClick={() => nativeWindow ? nativeProjectEntry?.open(p.id) : selectProject(p.id)}><Icon name="folder" size={15} /><span>{p.name}</span>{p.id === data.project?.id && <Icon name="check" size={14} />}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem onClick={() => { setShowProjects(false); if (nativeWindow) void nativeProjectEntry?.show('open'); else setShowProjectChooser(true); }}><Icon name="folder" size={15} />{t('projects.openWorkspace')}</DropdownMenuItem><DropdownMenuSub><DropdownMenuSubTrigger data-testid="panels-menu" disabled={loading || !data.project}><Icon name="grid" size={15} />{t('redesign.shell.view')}</DropdownMenuSubTrigger><DropdownMenuSubContent className="workspace-panels-menu"><DropdownMenuGroup><DropdownMenuLabel>{t('redesign.shell.view')}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem checked={!assetsCollapsed} data-testid="menu-panel-assets" onCheckedChange={open => setPanelOpen('assets', open)}>{t('assets.library')}</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={!inspectorCollapsed} data-testid="menu-panel-inspector" onCheckedChange={open => setPanelOpen('inspector', open)}>{t('shell.properties')}</DropdownMenuCheckboxItem>
      {workspaceMode === 'editing' ? <DropdownMenuCheckboxItem checked={!timelineCollapsed} data-testid="menu-panel-timeline" onCheckedChange={open => setPanelOpen('timeline', open)}>{t('shell.panel.multitrack')}</DropdownMenuCheckboxItem> : <DropdownMenuCheckboxItem checked={sequenceOpen} data-testid="menu-panel-storyboard" onCheckedChange={open => setPanelOpen('storyboard', open)}>{t('storyboard.order')}</DropdownMenuCheckboxItem>}
      </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem data-testid="reset-panel-layout" onClick={resetPanelLayout}><Icon name="refresh" size={14} />{t('shell.panel.reset')}</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub>
      <DropdownMenuItem data-testid="export-button" disabled={Boolean(application) || !data.shots.length || selectedCount !== data.shots.length || busy.export} title={selectedCount !== data.shots.length ? t('shell.generateAllShots') : t('shell.exportStoryboardHint')} onClick={createExport}><Icon name="download" size={16} />{t('shell.exportStoryboard')}</DropdownMenuItem><DropdownMenuItem data-testid="timeline-format-open" disabled={Boolean(application) || !data.project || loading} onClick={openTimelineFormat}><Icon name="settings" size={15} />{t('shell.timelineOutput')}</DropdownMenuItem><DropdownMenuItem className="new-project-menu" disabled={opacityRestored} onClick={() => { setShowProjects(false); if (nativeWindow) { void nativeProjectEntry?.show('new'); return; } setShowCreate(true); }}><Icon name="plus" size={15} />{t('projects.createNew')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>} modeSwitch={<Tabs value={workspaceMode} onValueChange={changeMode} className="topbar-workspace"><TabsList className="segmented workspace-tabs" aria-label={t('shell.workspaceMode')} tabIndex={!data.project && !loading && workspaceMode === 'canvas' ? 0 : undefined} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined}><TabsTrigger value="canvas" disabled={Boolean(application) || loading || !data.project} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined} data-testid="workspace-canvas">{t('shell.canvas')}</TabsTrigger><TabsTrigger value="editing" disabled={loading || !data.project} aria-describedby={!data.project && !loading && workspaceMode === 'canvas' ? 'workspace-mode-help' : undefined} data-testid="workspace-editing">{t('shell.editing')}</TabsTrigger></TabsList></Tabs>} status={<details className="topbar-status" data-testid="topbar-status"><summary aria-label={t('shell.statusDetails')} title={t('shell.statusDetails')}><span className={`status-dot ${!online ? 'neutral' : saveIsDirty ? 'orange' : saveFailed ? 'red' : 'green'}`} /><span className="topbar-status-label">{t(!online ? 'redesign.shell.offline' : saveIsDirty ? 'redesign.shell.draft' : saveFailed ? 'redesign.shell.saveFailed' : 'redesign.shell.saved')}</span><Icon name="down" size={12} /></summary><div className="topbar-status-content"><TopbarSaveStatus online={online} syncing={Object.values(busy).some(Boolean)} dirty={inspectorDirty || formatDirty || Boolean(annotations.state?.dirtyCount)} lastSync={lastSync} preferenceStatus={preferenceStatus} onRetry={() => preferencesRef.current!.flush({ projectId: currentProject.current } as unknown as {keepalive?: boolean})} onReload={reloadPreferences} /><UiPreferencesNotice /><>{nativeWindow ? <NativeLocatorStatus context={nativeWindow.context} bridge={nativeWindow.bridge} /> : <LastProjectStatus state={(lastProjectStatus || lastProjectRef.current!.getState()) as never} controller={lastProjectRef.current} restored={workspace?.restored === true} />}</></div></details>} actions={<>
      <TaskPopover scope={`${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}:${panelIntent.current}`} visible={!showTasks && !showDelivery && !showImage && !webSettingsOpen && !comparisonId} count={taskCount} uncertain={taskState.phase !== 'ready' || activePending.length > 0 || activeTasks.some(task => !['applied','not_applied'].includes(task.status))} items={[
        ...jobs.filter(job=>activeJob(job)||job.status==='submission_unknown'||job.phase==='output_review_required').map(job=>({id:job.id,label:data.shots.find(shot=>shot.id===job.shotId)?.title||t('tasks.center.shotTask'),status:renderMessage(jobStatusDescriptor(job)),phase:job.status==='submission_unknown'||job.phase==='output_review_required'?'attention':'active',progress:!restored&&activeJob(job)?job.progress:undefined,tone:job.status==='submission_unknown'?'warning':'neutral'})),
        ...orderedExports.filter(item=>item.mode==='timeline'&&['queued','running'].includes(item.status)).map(item=>({id:`render:${item.id}`,label:typeof item.snapshot?.deliveryName==='string'?item.snapshot.deliveryName:t('redesign.tasks.rendering'),status:renderMessage(statusDescriptor(item.status)),phase:'active',progress:!restored&&!data.restore?.heldExportIds?.includes(item.id)?item.progress:undefined,tone:'neutral'})),
        ...activeTasks.filter(item=>!item.acknowledged).map(item=>({id:`local:${item.id}`,label:t('shell.tasks'),status:renderMessage(statusDescriptor(item.status)),phase:'attention',tone:'warning'})),
        ...activePending.map(item=>({id:`pending:${item.origin||'legacy'}:${item.key}`,label:t('shell.tasks'),status:t('redesign.tasks.unknownHint'),phase:'attention',tone:'warning'})),
      ] as never} onOpenTasks={id => { openTasks(undefined, id); }} />
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="icon-button" data-testid="workbench-actions" aria-label={t('redesign.shell.help')} title={t('redesign.shell.help')} />}><Icon name="info" size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem data-testid="region-guide-toggle" aria-expanded={showGuide} onClick={() => setShowGuide(!showGuide)}><Icon name="info" size={15} />{t('shell.regionGuide')}</DropdownMenuItem><DropdownMenuItem data-testid="agent-settings-open" disabled={Boolean(application)} onClick={() => openGlobalSettings('agent')}><Icon name="settings" size={15} />{t('shell.agentConnections')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <Button type="button" variant="ghost" className="icon-button" data-testid="global-settings-open" aria-label={t('settings.title')} title={t('settings.title')} onClick={() => openGlobalSettings()}><WorkbenchIcon name="settings" size={16} /></Button>
      {workspaceMode === 'editing' && <WorkbenchButton variant="primary" id="right-dock-delivery-tab" data-testid="export-timeline" disabled={!canOpenExport} onClick={openTimelineExport}><span data-testid="right-dock-tab-delivery">{t('redesign.shell.export')}</span></WorkbenchButton>}
    </>} />
    {showGuide && <section className="region-guide" role="region" aria-label={t('shell.regionGuide')} data-testid="region-guide"><header><strong>{t('shell.guideTitle')}</strong><Button variant="ghost" className="icon-button" aria-label={t('shell.closeGuide')} onClick={() => setShowGuide(false)}><Icon name="close" size={16} /></Button></header><div><p><b>{t('shell.canvas')}</b>{t('shell.guideCanvas')}</p><p><b>{t('shell.editing')}</b>{t('shell.guideEditing')}</p><p><b>{t('shell.sharedAssets')}</b>{t('shell.guideAssets')}</p><p><b>{t('shell.guideTransitionTitle')}</b>{t('shell.guideTransition')}</p></div><footer>{t('shell.guideVersions')}</footer></section>}
    <div className="workspace-surface" ref={panelSurface} data-testid="workspace-surface">
    {assetsCollapsed && (geometry.narrow ? <PanelRecall name="assets" label={t('assets.library')} icon="folder" expanded={panelOverlay === 'assets'} onClick={() => togglePanelOverlay('assets')} /> : <CompactPanelRail name="assets" label={t('assets.library')} scope={`${currentProject.current}:${projectEpoch.current}:${workspaceMode}`} visible={workbenchReady} expanded={panelOverlay === 'assets'} disabled={clipCompositionPending} onToggle={() => togglePanelOverlay('assets')} actions={[
      { id: 'assets', label: t('assets.assets'), icon: 'assets', selected: libraryTab === 'assets', onClick: () => showCompactLibrary('assets'), focusSelector: '[data-testid=library-assets-tab]' },
      { id: 'subjects', label: t('subjects.subjects'), icon: 'subjects', selected: libraryTab === 'subjects', disabled: Boolean(application), onClick: () => showCompactLibrary('subjects'), focusSelector: '[data-testid=library-subjects-tab]' },
    ]} bottomAction={{ id: 'import', label: t('assets.importLocal'), icon: 'import', disabled: opacityRestored || Boolean(busy.import), onClick: () => { if (!clipDraftRef.current?.hasPendingComposition() && !opacityRestored && !busy.import) fileInput.current?.click(); } }} />)}
    <PanelBoundary name="assets" className={panelOverlay === 'assets' ? 'panel-overlay' : ''} visible={panelVisible('assets')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('assets')}>
    <AssetLibrary activeTab={libraryTab} onTabChange={setLibraryTab} mutationDisabled={opacityRestored} annotations={application ? undefined : annotations} annotationBlocked={annotationBlocked} restored={restored} confirm={confirm} timelineUsage={timelineUsage as never} onLocateTimelineUse={locateAssetUse} subjects={application ? undefined : subjects as never} subjectBlocked={subjectBlocked} onInspectShot={id => inspect(id, 'settings', null, { reveal: true })} onShowTasks={() => openTasks()} dispositions={application ? undefined : dispositions as never} dispositionBlocked={dispositionBlocked} selectedAsset={librarySource} inUseAssetIds={inUseAssetIds as Set<string>} mode={workspaceMode} versions={data.versions} shots={data.shots} assets={data.assets} filter={assetFilter} onFilter={setAssetFilter} search={assetSearch} onSearch={setAssetSearch} onImport={opacityRestored ? undefined : () => data.project ? fileInput.current?.click() : setShowCreate(true)} onFiles={opacityRestored ? undefined : importFiles} onPreview={previewSource} onCanvas={application ? undefined : addNode} onTimeline={opacityRestored ? undefined : addTimelineAsset} busy={{ ...busy, timeline: timelineBusy }} collapsed={assetsCollapsed && panelOverlay !== 'assets'} onCollapse={() => panelOverlay === 'assets' ? setPanelOverlay(null) : setAssetsCollapsed(true)} project={data.project} />
    {panelOverlay === 'assets' && <div className="panel-overlay-tools"><Button variant="ghost" className="icon-button" data-testid="pin-assets" aria-label={t('redesign.shell.pin')} title={t('redesign.shell.pin')} onClick={() => setPanelOpen('assets', true)}><Icon name="lock" size={15} /></Button><Button variant="ghost" className="icon-button" aria-label={t('common.close')} onClick={() => setPanelOverlay(null)}><Icon name="close" size={15} /></Button></div>}
    {resizeHandle('assets', 'assetsWidth')}</PanelBoundary>
    <PanelBoundary name="canvas" visible={panelVisible('canvas')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus="[data-testid=mobile-panel-canvas]">
    <section className="canvas-area" aria-label={workspaceMode === 'canvas' ? t('shell.canvasWorkspace') : t('shell.editingWorkspace')} data-testid="active-workspace">{workspaceMode === 'canvas' && <CanvasToolbar scope={`${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} visible={panelVisible('canvas')} addingShot={Boolean(busy['shot-create'])} imageDisabled={Boolean(application)} onAddShot={addShot} onAddText={() => addNode('text')} onAddImage={() => addNode('image')} onAddVideo={() => addNode('video')} onGenerateImage={() => { if (clipDraftRef.current?.hasPendingComposition()) return; markPanelIntent(); setShowTasks(false); setShowDelivery(false); setShowImage(true); }} />}
      <div className="main-stage">{loading ? <div className="canvas-loading" data-testid="workspace-loading"><span className="spinner" />{t('projects.opening')}</div> : workspaceMode === 'canvas' ? <div className="flow-wrap" data-testid="canvas-drop-zone" onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={canvasDrop}><ReactFlow key={data.project?.id || 'empty'} nodes={nodes} edges={edges as never} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))} onNodeClick={(_, node) => inspect(node.id)} onNodeDoubleClick={(_, node) => { const record = dataRef.current!.nodes.find(n => n.id === node.id); const shot = dataRef.current!.shots.find(s => s.id === node.id); const version = dataRef.current!.versions.find(v => v.id === shot?.selectedVersionId); const asset = dataRef.current!.assets.find(a => a.id === (record?.assetId || version?.assetId || shot?.referenceAssetIds?.[0])); if (asset) previewSource(asset); }} onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={(event, node) => { void savePosition(event as unknown as React.MouseEvent, node); }} onConnect={connect} onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)} onPaneClick={() => setSelectedEdgeId(null)} onEdgesDelete={deleted => { setSelectedEdgeId(null); deleted.filter(edge => !isReferenceEdge(dataRef.current!.edges.find(item => item.id === edge.id))).forEach(edge => run(`delete-edge:${edge.id}`, 'edge.delete', { edgeId: edge.id })); }} onBeforeDelete={beforeDeleteEdges} onMove={(_, viewport) => setZoom(Math.round(viewport.zoom * 100))} onMoveEnd={(event, viewport) => { if (viewRef.current!.activeMode === 'canvas' && data.project?.id === currentProject.current) updateView('canvas', { viewport }, { passive: !event }); }} defaultViewport={view.canvas.viewport || { x: 0, y: 0, zoom: 1 }} onInit={instance => { const captured = context(), saved = viewRef.current!.canvas.viewport; requestAnimationFrame(() => { if (isCurrent(captured) && viewRef.current!.activeMode === 'canvas') { if (saved) instance.setViewport(saved); else instance.fitView({ padding: flowFitPadding(canvasFitPadding(.16)), minZoom: .65, maxZoom: 1 }); } }); }} fitView={!view.canvas.viewport} fitViewOptions={{ padding: 0.16, minZoom: .65, maxZoom: 1 }} minZoom={0.2} maxZoom={1.75} snapToGrid snapGrid={[12, 12]} defaultEdgeOptions={{ type: 'smoothstep' }} proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']} colorMode={resolvedTheme}><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--wb-line-subtle)" />{miniMap && <MiniMap nodeColor={n => n.type === 'shot' ? 'var(--wb-video-edge)' : 'var(--wb-muted)'} maskColor="var(--wb-overlay)" pannable zoomable />}</ReactFlow>
      {selectedEdge && <div className="selected-edge-note" data-testid="selected-edge-note">{isReferenceEdge(selectedEdge) ? <><Icon name="link" size={13} /><span>{t('shell.referenceLink')}</span><Button variant="ghost" size="sm" onClick={() => inspect(selectedEdge.target)}>{t('shell.viewDisconnect')}</Button></> : <><span>{t('shell.visualLinkNoGeneration')}</span><span className="muted">{t('shell.deleteKey')}</span></>}</div>}
      {(!data.project || !nodes.length) && !loading && <CanvasEmptyState hasProject={Boolean(data.project)} onAddShot={addShot} onCreateProject={() => setShowCreate(true)} onCreateStructure={addStructure} structureBusy={Boolean(busy.structure)} onImportReference={opacityRestored ? undefined : () => fileInput.current?.click()} onGenerateImage={() => { if (clipDraftRef.current?.hasPendingComposition()) return; markPanelIntent(); setShowTasks(false); setShowDelivery(false); setShowImage(true); }} imageDisabled={Boolean(application)} />}
      {loading && <div className="canvas-loading"><span className="spinner" />{t('projects.opening')}</div>}
      <div className="canvas-controls"><WorkbenchTooltip content={t('shell.zoomOutCanvas')}><Button variant="ghost" className="icon-button" aria-label={t('shell.zoomOut')} onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16} /></Button></WorkbenchTooltip><span>{zoom}%</span><WorkbenchTooltip content={t('shell.zoomInCanvas')}><Button variant="ghost" className="icon-button" aria-label={t('shell.zoomIn')} onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16} /></Button></WorkbenchTooltip><i /><WorkbenchTooltip content={t('shell.fitCanvasHint')}><Button variant="ghost" className="icon-button" aria-label={t('shell.fitCanvas')} data-testid="fit-canvas" onClick={() => flow.fitView({ padding: flowFitPadding(canvasFitPadding(0.18)), duration: 350, maxZoom: 1 })}><Icon name="zoom" size={16} /></Button></WorkbenchTooltip><Button variant="ghost" className={`icon-button ${miniMap ? 'active' : ''}`} aria-label={t('shell.showMinimap')} aria-pressed={miniMap} onClick={() => setMiniMap(!miniMap)}><Icon name="grid" size={16} /></Button></div><div className="canvas-hint"><Icon name="link" size={12} />{t('shell.canvasInteractionHint')}</div>
      </div> : <div className="preview-tab-panel">{restored && <p className="helper muted" role="status">{t('shell.restoredFrameUnavailable')}</p>}<Preview candidateConnected={online && auth === true && workbenchReady && !loading} opacityApplication={opacityApplication as never} heldExportIds={data.restore?.heldExportIds as never} onBeforePlay={beforeMainPreviewPlay} audioPreview={application ? undefined : audioPreview} onRegisterMediaPause={registerNativePreviewPause} key={data.project?.id || 'empty'} visible={panelVisible('canvas')} kind={previewKind} onKind={(kind: string) => { navigationEpoch.current++; setPreviewKind(kind); }} asset={sourceAsset} clip={quickAssetId ? null : chosenClip} timeline={timeline} job={previewJob as never} pendingJob={latestRender as never} playhead={playhead} onSeek={setPlayhead} sourceScope={sourceRangeScope} sourcePosition={sourceRanges.state?.position ?? 0} sourceSeek={sourceRanges.state?.seek} onSourcePosition={(frame: number, scope?: string | null) => (sourceRanges.controller as unknown as {position(frame: number, scope?: string | null): void}).position(frame, scope)} onCaptureFrame={application ? undefined : ((() => (frameExtraction.controller as unknown as {capture(): unknown}).capture()) as never)} captureBusy={frameCaptureBusy(frameExtraction.state)} onRender={renderTimeline} busy={Boolean(busy['timeline:render:preview'])} onCanvas={application ? undefined : () => changeMode('canvas')} onImport={opacityRestored ? undefined : () => data.project ? fileInput.current?.click() : setShowCreate(true)} canSeed={!application && Boolean(sortedShots.length && selectedCount === sortedShots.length)} seedBusy={timelineBusy} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} /></div>}</div>
    {workspaceMode === 'canvas' && <StoryboardStrip scope={`${currentProject.current}:${projectEpoch.current}:${navigationEpoch.current}`} open={sequenceOpen} onOpenChange={setSequenceOpen} shots={sortedShots as never[]} versions={data.versions} selectedId={selectedId || null} reordering={Boolean(busy.reorder)} assetDragType={ASSET_DRAG} onSelect={async shotId => { if (!await inspect(shotId)) return; flow.fitView({ nodes: [{ id: shotId }], padding: flowFitPadding(canvasFitPadding(.1)), duration: 250, maxZoom: 1 }); }} onReorder={reorder} onAddShot={addShot} renderThumbnail={shot => <Media version={data.versions.find(version => version.id === shot.selectedVersionId)} asset={data.assets.find(asset => asset.id === (shot as {referenceAssetIds?: string[]}).referenceAssetIds?.[0])} />} />}
    </section></PanelBoundary>
    {inspectorCollapsed && (geometry.narrow ? <PanelRecall name="inspector" label={rightDockTab === 'agent' ? t('redesign.shell.agent') : t('shell.properties')} icon="settings" expanded={panelOverlay === 'inspector'} onClick={() => togglePanelOverlay('inspector')} /> : <CompactPanelRail name="inspector" label={t('shell.inspectorTabs')} scope={`${currentProject.current}:${projectEpoch.current}:${workspaceMode}`} visible={workbenchReady} expanded={panelOverlay === 'inspector'} disabled={clipCompositionPending} onToggle={() => togglePanelOverlay('inspector')} actions={[
      { id: 'properties', label: t('shell.properties'), icon: 'properties', selected: rightDockTab === 'properties' && (workspaceMode !== 'canvas' || tab !== 'versions'), onClick: () => showCompactInspector('properties'), focusSelector: '[data-testid=right-dock-tab-properties]' },
      ...(workspaceMode === 'canvas' ? [{ id: 'versions', label: t('redesign.shell.versions'), icon: 'versions' as const, selected: rightDockTab === 'properties' && tab === 'versions', onClick: () => showCompactInspector('versions'), focusSelector: '[data-testid=right-dock-tab-versions]' }] : []),
      { id: 'agent', label: t('redesign.shell.agent'), icon: 'agent', selected: rightDockTab === 'agent', disabled: Boolean(application), onClick: () => showCompactInspector('agent'), focusSelector: '[data-testid=right-dock-tab-agent]' },
    ]} />)}
    <PanelBoundary name="inspector" className={panelOverlay === 'inspector' ? 'panel-overlay' : ''} visible={panelVisible('inspector')} scope={`${currentProject.current}:${workspaceMode}`} fallbackFocus={panelFallback('inspector')}>
    <Collapsible open={!inspectorCollapsed || panelOverlay === 'inspector'} onOpenChange={open => { if (!open && panelOverlay === 'inspector') setPanelOverlay(null); else setInspectorCollapsed(!open); }} className={`inspector-region ${inspectorCollapsed && panelOverlay !== 'inspector' ? 'panel-collapsed' : ''}`} render={<section aria-label={t('shell.inspectorTabs')} />}><header className="inspector-region-heading"><WorkbenchInspectorTabs mode={workspaceMode} value={rightDockTab === 'agent' ? 'agent' : workspaceMode === 'canvas' && tab === 'versions' ? 'versions' : 'properties'} agentDisabled={Boolean(application)} labels={{ workspace: t('shell.rightWorkspace'), properties: t('shell.properties'), versions: t('redesign.shell.versions'), agent: t('redesign.shell.agent') }} onValueChange={value => { if (clipDraftRef.current?.hasPendingComposition()) return; markPanelIntent(); if (value === 'agent') { setRightDockTab('agent'); setAgentPage('chat'); } else { setRightDockTab('properties'); if (workspaceMode === 'canvas') setTab(value === 'versions' ? 'versions' : 'settings'); } }} /><CollapsibleTrigger render={<Button variant="ghost" className="icon-button" aria-label={t('shell.collapseInspector')} title={t('shell.collapseInspector')} data-testid="toggle-inspector" />}><Icon name="minus" size={16} /></CollapsibleTrigger></header><RestoredWorkspace workspace={workspace as never} />{opacityRestored && <OpacityRestoredNotice draftsPersistent={application?.supportsRestoredClipDrafts(workspace)} />}<CollapsibleContent keepMounted className="inspector-region-content"><AgentDockPane id="right-dock-properties" labelledBy={workspaceMode === "canvas" && tab === "versions" ? "right-dock-versions-tab" : "right-dock-properties-tab"} visible={rightDockTab === 'properties'} fallbackFocus="[data-testid=right-dock-tab-agent]"><AgentDockPane id="properties-inspector-pane" visible={propertiesPage === 'inspector' || propertiesPage === 'subtitle' && workspaceMode === 'canvas'} fallbackFocus="[data-testid=timeline-format-back]">{workspaceMode === 'canvas' ? <div className="inspector-container">
    <Inspector onEditImage={!application && !restored ? openImageEdit : undefined} annotations={application ? undefined : annotations} annotationAsset={librarySource as never} annotationBlocked={annotationBlocked} restored={restored} onShowTasks={() => openTasks()} shotTextContext={{ ...shotTextContext(), getCurrent: shotTextContext } as never} onShotTextController={registerShotText} onShotTextAccepted={((({ response }: {response: {projectId: string}}) => { if (currentProject.current === response.projectId) void refresh(response.projectId); }) as never)} generationUnavailableReason={generationUnavailableReason as never} actionScopeKey={`${rightDockTab}:${propertiesPage}`} subjects={application ? undefined : subjects as never} subjectBlocked={subjectBlocked} key={`${data.project?.id}:${selectedId || 'empty'}:${inspectorEpoch}`} highlightedVersionId={highlightedVersionId} shot={chosenShot} node={chosenNode} project={data.project} assets={data.assets} versions={data.versions} jobs={jobs} providers={providers} generationOptions={generationOptions[selectedId as string]} onGenerationOptionsChange={updateGenerationOptions as never} tab={tab} setTab={setTab} busy={busy} onSave={saveShot as never} onNodeSave={saveNode as never} onGenerate={generate as never} onCancelJob={(job, stillCurrent) => { const live = dataRef.current!.jobs.find(item => item.id === job.id); if (!stillCurrent() || live?.projectId !== currentProject.current || live?.status !== job.status || JSON.stringify(live.snapshot) !== JSON.stringify(job.snapshot)) return; return run(`cancel:${job.id}`, 'job.cancel', { jobId: job.id }, undefined, { canExecute: stillCurrent }); }} onRetryJob={retryGeneration} onSelectVersion={selectVersion as never} onCompare={setComparisonId} onOpenJobs={() => openTasks()} onDirtyChange={setShotDirty} shots={sortedShots as never[]} nodes={data.nodes as never[]} edges={data.edges as never[]} referenceBusy={referenceBusy} referencePending={referencePending} onAttachReference={attachReference} onDetachReference={detachReference} onInspect={((id: string, nextTab: string) => inspect(id, nextTab, null, { reveal: true })) as never} onAddVersion={(assetId: string) => addTimelineAsset(assetId)} />
    </div> : quickAssetId && sourceAsset ? application ? <aside className="inspector" data-testid="candidate-source-inspector"><header className="inspector-heading"><Icon name="film" /><span>{sourceAsset.name}</span></header><div className="inspector-scroll"><Button data-testid="candidate-source-add" disabled={opacityRestored || timelineBusy} onClick={() => addTimelineAsset(sourceAsset.id)}>{t('assets.addToEditing')}</Button></div></aside> : <SourceRangeInspector asset={sourceAsset} state={sourceRanges.state} controller={sourceRanges.controller as never} timeline={timeline} blocked={sourceRangeBlocked} onAdd={addSavedSourceRange}>{restored ? <RestoredUnavailable title={t('shell.restoredFramesRetained')} /> : <FrameExtractionPanel controller={frameExtraction.controller as never} />}</SourceRangeInspector> : displayedClipInspector ? <TimelineInspector key={displayedClipInspector.key} loudnessContext={clipLoudnessContext as never} loudnessInvocation={() => pinNewWorkspaceIntent({}, workspaceRef.current)} onLoudnessUnauthorized={() => setAuth(false)} onReturnToSource={!clipInspectorRetained && clipSource ? () => returnToSource(displayedClipInspector.clip.assetId) : undefined} sourceDescription={(clipSource?.version && displayedClipInspector.clip.versionId === clipSource.version.id ? `${clipSource.shot?.title} · V${clipSource.version.number}` : clipSource?.asset?.name) as string | undefined} replacementContext={clipReplacementContext()} staleSource={staleClips.get(displayedClipInspector.clip.id) as never} opacityCandidate={application?.inspectorBinding} onReplaceSource={application ? undefined : replaceTimelineClipSource as never} onOpenRequests={() => openTasks()} clip={displayedClipInspector.clip} timeline={displayedClipInspector.timeline} asset={displayedClipInspector.asset} draftContext={{ scope: displayedClipInspector.scope, projectId: displayedClipInspector.projectId, restored: displayedClipInspector.restored, workspaceOrigin: displayedClipInspector.workspaceOrigin, audioRoleEditable, audioRoleCapability, volumeEnvelopeEditable: !clipInspectorRetained && volumeEnvelopeEditable && online && auth === true, volumeEnvelopeCapability }} draftConnected={!clipInspectorRetained && online && auth === true && !loading} onCompositionPendingChange={setClipCompositionPending} onDraftController={registerClipDraft} onReviewBlockedChange={setAgentClipDraftBlocked} onSave={((clipId: string, patch: Record<string, unknown>, revision: number, draftOptions: unknown) => mutateTimeline('timeline.clip.update', { clipId, patch }, revision, { returnAfterNavigation: true, canExecute: (draftOptions as {canExecute?: () => boolean} | undefined)?.canExecute })) as never} onRemove={opacityRestored ? undefined : async (clipId: string) => { const result = await mutateTimeline('timeline.clip.remove', { clipId }); if (result) setSelectedClipId(null); }} onRippleRemove={opacityRestored ? undefined : async (clipId: string) => { const result = await mutateTimeline('timeline.clip.rippleRemove', { clipId }); if (result) setSelectedClipId(null); }} onSplit={splitTimelineClip} splitDisabled={!splitState.canSplit || clipInspectorRetained} onShowAsset={() => { if (!clipInspectorRetained && displayedClipInspector.projectId && displayedClipInspector.clip.assetId) void revealImageAsset(displayedClipInspector.clip.assetId, displayedClipInspector.projectId); }} onDirtyChange={setClipDirty} busy={timelineBusy||lockedTrackIds.has(displayedClipInspector.clip.trackId)} onPreview={() => { setQuickAssetId(null); setPreviewKind('source'); }} /> : <aside className="inspector" data-testid="editing-inspector-empty"><header className="inspector-heading"><Icon name="layers" /><span>{t('shell.clipProperties')}</span></header><div className="inspector-empty"><h3>{t('shell.selectTimelineClip')}</h3><p>{t('shell.clipPropertiesHint')}</p></div></aside>}</AgentDockPane><AgentDockPane id="properties-subtitle-pane" visible={propertiesPage === 'subtitle' && workspaceMode === 'editing'} fallbackFocus="[data-testid=right-dock-tab-properties]"><SubtitleInspector state={subtitles.state} controller={subtitles.controller} renderJob={previewJob as never} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane><AgentDockPane id="properties-format-pane" visible={propertiesPage === 'format'} fallbackFocus="[data-testid=right-dock-tab-properties]"><TimelineFormatPanel state={timelineFormat.state} controller={timelineFormat.controller} onBack={() => setPropertiesPage('inspector')} onOpenTasks={() => openTasks()} /></AgentDockPane></AgentDockPane><AgentDockPane id="right-dock-agent" labelledBy="right-dock-agent-tab" visible={rightDockTab === 'agent'} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title={t('shell.restoredAgentHistory')} /> : !application && <AgentWorkspace onOpenSettings={openGlobalSettings} settingsOverlayOpen={webSettingsOpen} nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry.current} navigationRegistry={settingsNavigation.current} projectId={data.project?.id} projectName={data.project?.name} selectedShot={chosenShot ? { id: chosenShot.id, revision: chosenShot.revision, title: chosenShot.title, prompt: chosenShot.prompt || '' } : null} selectedTimelineClip={agentTimelineSelection} timelineEditBlockedReason={agentTimelineBlockedReason as never} timelineEditBlockedDescriptor={agentTimelineBlockedDescriptor as never} selectedTimelineGainClip={agentTimelineGainSelection} timelineGainBlockedReason={gainBlockedReason} timelineGainBlockedDescriptor={gainBlockedDescriptor} onApplied={(projectId: string) => { if (currentProject.current === projectId) void refresh(projectId); }} page={agentPage} onPage={setAgentPage} onCollapse={() => setPanelOpen('inspector', false)} onDraftChange={onAgentDraftChange} />}</AgentDockPane></CollapsibleContent></Collapsible>
    {panelOverlay === 'inspector' && <div className="panel-overlay-tools"><Button variant="ghost" className="icon-button" data-testid="pin-inspector" aria-label={t('redesign.shell.pin')} title={t('redesign.shell.pin')} onClick={() => setPanelOpen('inspector', true)}><Icon name="lock" size={15} /></Button><Button variant="ghost" className="icon-button" aria-label={t('common.close')} onClick={() => setPanelOverlay(null)}><Icon name="close" size={15} /></Button></div>}
    {resizeHandle('inspector', 'inspectorWidth')}</PanelBoundary>
    {workspaceMode === 'editing' && data.project && !loading && <><PanelBoundary name="timeline" visible={timelineContainerVisible} scope={`${currentProject.current}:editing`} fallbackFocus={panelFallback('timeline')}>{resizeHandle('timeline', 'timelineHeight')}<Timeline lockedTrackIds={lockedTrackIds} onToggleTrackLock={id=>{const projectId=currentProject.current;if(!projectId||loading||!timeline?.tracks.some(track=>track.id===id))return;setTrackLocks(previous=>{const ids=new Set(previous[projectId]||[]);if(ids.has(id))ids.delete(id);else ids.add(id);return {...previous,[projectId]:[...ids]};});}} basicEditingOnly={Boolean(application)} structureReadOnly={opacityRestored} sessionViewOnly={opacityRestored} staleClips={staleClips} waveformReadOnly={Boolean(application) || restored} workspaceOrigin={workspace?.workspaceOrigin} key={data.project.id} viewState={view.editing as never} onViewStateChange={(patch: Record<string, unknown>, options?: unknown) => { if (data.project?.id === currentProject.current && viewRef.current!.activeMode === 'editing') updateView('editing', patch, options as {passive?: boolean}); }} timeline={timeline} historyState={historyState} onHistory={changeTimelineHistory} splitState={splitState} onSplit={splitTimelineClip} assets={data.assets} selectedClipId={propertiesPage === 'subtitle' ? null : selectedClipId} selectedCueId={propertiesPage === 'subtitle' ? subtitles.state?.cueId : null} onSelectSubtitle={(cueId: string) => openSubtitle(cueId)} onAddSubtitle={(frame: number) => openSubtitle(null, frame)} subtitleBlocked={!subtitles.state?.connected} onSelectClip={selectClip} onAddAsset={addTimelineAsset as never} onMoveClip={moveTimelineClip as never} removalBlocked={clipDirty || subtitleDirty || formatDirty || timelinePending || !online || loading || auth !== true} onRemove={opacityRestored ? undefined : async (clipId: string) => { const result = await mutateTimeline('timeline.clip.remove', { clipId }); if (result) setSelectedClipId(null); }} onRippleRemove={opacityRestored ? undefined : async (clipId: string) => { const result = await mutateTimeline('timeline.clip.rippleRemove', { clipId }); if (result) setSelectedClipId(null); }} onTrackAdd={(kind: string) => mutateTimeline('timeline.track.add', { kind })} onTrackUpdate={(trackId: string, patch: Record<string, unknown>) => mutateTimeline('timeline.track.update', { trackId, patch })} onSeed={() => mutateTimeline('timeline.seed', {}, timeline?.revision)} onRender={renderTimeline} onSeek={seekTimelineSound} playhead={effectivePlayhead} presentationVisible={timelineContainerVisible} visible={panelVisible('timeline')} collapsed={timelineCollapsed} onCollapse={toggleTimelinePanel} busy={timelineBusy} canSeed={!application && Boolean(sortedShots.length && selectedCount === sortedShots.length)} renderJob={latestRender} /></PanelBoundary>{timelineCollapsed && geometry.narrow && <PanelRecall name="timeline" label={t('shell.timeline')} icon="layers" onClick={() => setPanelOpen('timeline', true)} />}</>}
    </div>
    <nav className="mobile-nav" aria-label={t('shell.mobileNavigation')}>{[['assets', 'folder', t('assets.assets')], ['canvas', workspaceMode === 'canvas' ? 'grid' : 'play', workspaceMode === 'canvas' ? t('shell.canvas') : t('shell.preview')], ['inspector', rightDockTab === 'agent' ? 'sparkle' : 'settings', rightDockTab === 'agent' ? t('redesign.shell.agent') : t('shell.properties')], ...(workspaceMode === 'editing' ? [['timeline', 'layers', t('shell.timeline')]] : [])].map(([id, icon, label]) => <Button variant="ghost" className={mobilePanel === id ? 'active' : ''} key={id} data-testid={`mobile-panel-${id}`} aria-pressed={mobilePanel === id} onClick={() => mobileNavigate(id)}><Icon name={icon} size={17} />{label}</Button>)}</nav>

    <Dialog open={showImage} onOpenChange={open => { if (!open) { markPanelIntent(); setShowImage(false); } }}><WorkbenchDialogContent title={t('shell.images')} size="large" keepMounted hidden={!showImage} inert={!showImage} data-testid="image-generation-dialog"><AgentDockPane id="right-dock-image" labelledBy="right-dock-image-tab" visible={showImage} fallbackFocus="[data-testid=right-dock-tab-properties]">{restored ? <RestoredUnavailable title={t('shell.restoredImageHistory')} /> : !application && <ImageGeneration editIntent={imageEditIntent as never} isEditIntentCurrent={isImageEditIntentCurrent} onOpenSettings={openGlobalSettings} settingsOverlayOpen={webSettingsOpen} nativeSettingsScope={nativeSettingsScope} nativeCloseRegistry={nativeCloseRegistry.current} navigationRegistry={settingsNavigation.current} key={data.project?.id || 'no-project'} projectId={data.project?.id} projectName={data.project?.name} projectAssets={data.assets as never[]} onDirtyChange={onImageDraftChange as unknown as () => void} onGenerated={((projectId: string) => { if (currentProject.current === projectId) void refresh(projectId); }) as never} onRevealAsset={revealImageAsset} />}</AgentDockPane></WorkbenchDialogContent></Dialog>
    <Dialog open={showDelivery} onOpenChange={open => { if (!open) { markPanelIntent(); setShowDelivery(false); exportPreviewPause.current?.(); } }}><WorkbenchDialogContent title={t('redesign.shell.export')} size="large" keepMounted hidden={!showDelivery} inert={!showDelivery} data-testid="timeline-export-dialog"><AgentDockPane id="right-dock-delivery" labelledBy="right-dock-delivery-tab" visible={showDelivery} fallbackFocus="[data-testid=right-dock-tab-properties]"><DeliveryWorkspace page={showExports ? 'history' : 'compose'} onPage={page => { markPanelIntent(); setShowExports(page === 'history'); }}><AgentDockPane id="delivery-compose-pane" labelledBy="delivery-compose-tab" visible={!showExports} fallbackFocus="[data-testid=delivery-page-history]"><TimelineExportPreflight fileRecoveryEnabled={!restored&&!application} projectId={data.project?.id} activity={exportDetails.activity} output={exportDetails.output} cancelBusy={Boolean(busy['cancel-export'])} onCancel={() => { if (!exportDetails.current() || !formalExportRecord || !['queued','running'].includes(formalExportRecord.status)) return; const id=formalExportRecord.id, snapshot=JSON.stringify(formalExportRecord.snapshot), request=formalExportRecord.requestId; const allowed=()=>exportDetails.current()&&dataRef.current!.exports.some(item=>item.id===id&&item.projectId===currentProject.current&&item.requestId===request&&JSON.stringify(item.snapshot)===snapshot&&['queued','running'].includes(item.status)); return run('cancel-export','export.cancel',{projectId:currentProject.current,exportId:id},undefined,{canExecute:allowed}); }} onClose={() => {markPanelIntent();setShowDelivery(false);exportPreviewPause.current?.();}} onHistory={openExportHistory} onReexport={() => {if(clipDraftRef.current?.hasPendingComposition()||!canOpenExport)return;setDeliveryAttempt(null);setDeliveryReviewVersion(value=>value+1);openTimelineExport();}} onLocateClip={(clipId:string)=>{if(!exportDetails.current()||!dataRef.current!.timeline?.clips.some(item=>item.id===clipId))return;setSelectedClipId(clipId);setQuickAssetId(null);setShowDelivery(false);setPanelOpen('inspector',true,'editing');}} preview={<ExportPreview
      result={exportPreviewResult(exportPreviewAttempt as never, data.exports as never, { scope: exportCheckView.scope, contextKey: sampleExportContextKey(), connected: Boolean(exportCheckView.connected), isRenderRecord: isTimelineRenderRecord, heldExportIds: data.restore?.heldExportIds as never }) as never}
      visible={!comparisonId && workbenchReady && showDelivery && !showExports}
      canSelect={exportRangeContext().enabled && !localDelivery.state.busy && !pendingTimelineExport}
      canGenerate={Boolean(canCheckExport && exportRangeContext().enabled && !busy['timeline:render:export'] && !localDelivery.state.busy && !pendingTimelineExport && !dirtyRef.current && !formatDirty && !['checking', 'unknown'].includes(sampleExportPreflight.state?.phase as string) && (sampleRangeDraft?.scope !== exportCheckView.scope || isExportPreviewRange(sampleExportView.exportRange as never, timeline?.durationFrames as number)))}
      rangeDraft={(sampleRangeDraft?.scope === exportCheckView.scope ? sampleRangeDraft : null) as never} onRangeChange={chooseSampleExportRange as never}
      preflightState={sampleExportPreflight.state as never} canCheck={Boolean(canOpenExport && Number.isSafeInteger(timeline?.revision) && timeline!.revision > 0 && online && auth === true && !deliveryName.error && (restored || !localDelivery.state.baselineConflict && !localDelivery.state.candidate) && sampleExportView.exportRange && !localDelivery.state.busy && !pendingTimelineExport)}
      checkDetails={<>
        {sampleExportPreflight.state?.error && <p className="notice error" role="alert">{preflightErrorMessage({ code: sampleExportPreflight.state.errorCode }, locale)}</p>}
        {sampleExportPreflight.state?.capabilityPhase && <p className="export-preflight-note">{exportCapabilityMessage(sampleExportPreflight.state.capabilityPhase, locale)}</p>}
        {(sampleExportPreflight.state as {report?: {issues?: {code?: string; severity?: string; message?: string}[]}} | null)?.report?.issues?.map((issue, index) => <p className="notice warning" key={index}>{preflightIssueMessage(issue, locale)}</p>)}
        {sampleExportPreflight.state?.phase === 'incomplete' && <p className="notice warning">{t('export.preflight.incompleteWarning')}</p>}
      </>}
      onCheck={() => { sampleExportPreflight.controller!.setContext(sampleExportContext()); sampleExportPreflight.controller!.check(); }}
      onSelect={selectSampleExportRange} onGenerate={generateSampleExport}
      onRegisterMediaPause={registerExportPreviewPause} onBeforePlay={beforeExportPreviewPlay}
    />} recoveryRequired={Boolean(localDelivery.state.candidate || localDelivery.state.baselineConflict || localDelivery.state.autosavePaused || localDelivery.state.draftFailure || localDelivery.state.draftError || localDelivery.state.intentUncertain || localDelivery.state.intentFailure || localDelivery.state.intentError || localDelivery.state.phase === 'error' || localDelivery.state.retainedPreparation && localDelivery.state.intent?.intentId !== localDelivery.state.retainedPreparation.intentId || localDelivery.state.intent && localDelivery.state.intent.outcome.status !== 'accepted')} loudness={!application && <TimelineMixLoudness loudness={timelineMixLoudness} onRevokeApply={() => timelineLoudnessApply.controller!.revoke()} apply={<TimelineLoudnessApply apply={timelineLoudnessApply} observation={timelineMixLoudness.state} onOpenTasks={() => openTasks()} />} />} recovery={<DeliveryDraftRecovery state={localDelivery.state} controller={localDelivery.controller} disabled={!online || auth !== true || loading} />} state={exportPreflight.state as never} timeline={timeline} deliveryName={deliveryName.value} deliveryNameError={deliveryName.error} deliveryNameDisabled={!deliveryNameContext().enabled} onDeliveryNameChange={(value: string) => { if (deliveryName.controller!.choose(value, deliveryName.scope, deliveryName.version)) exportPreflight.controller!.setContext(exportCheckContext()); }} rangeDraft={exportRange.draft} exportRange={exportRange.value} rangeError={exportRange.error} rangeDisabled={!exportRangeContext().enabled} onRangeChange={((draft: ExportRangeDraft) => { if (exportRange.controller!.chooseRange(draft, exportRange.scope, exportRange.version)) exportPreflight.controller!.setContext(exportCheckContext()); }) as never} exportSettings={exportSettings.value as never} settingsDisabled={!exportSettingsContext().enabled} onSettingsChange={(value: unknown) => { if (exportSettings.controller!.choose(value, exportSettings.scope, exportSettings.version)) exportPreflight.controller!.setContext(exportCheckContext()); }} projectName={data.project?.name} canCheck={canCheckExport} exportBusy={Boolean(busy['timeline:render:export']) || localDelivery.state.busy} pendingExport={pendingTimelineExport} dirty={inspectorDirty || formatDirty} onCheck={() => checkTimelineExport(exportCheckView)} onExport={(binding: unknown) => renderTimeline('export', binding)} onUncheckedExport={renderUncheckedTimeline} reviewVersion={deliveryReviewVersion} downloadEnabled={!application && !data.restore?.heldExportIds?.includes(deliveryAttempt?.id as string)} renderRecord={formalExportRecord as never} onTasks={() => openTasks()} /></AgentDockPane><AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible={showExports} fallbackFocus="[data-testid=delivery-page-compose]"><ExportHistoryList outputAssets={data.assets} onClose={() => {markPanelIntent();setShowDelivery(false);exportPreviewPause.current?.();}} fileRecoveryEnabled={!restored && !application} onReexport={() => { if (clipDraftRef.current?.hasPendingComposition() || !canOpenExport) return; setDeliveryAttempt(null); setDeliveryReviewVersion(value => value + 1); openTimelineExport(); }} candidateConnected={online && auth === true && workbenchReady && !loading} opacityApplication={opacityApplication} projectId={data.project?.id} samplePeak={application ? undefined : exportSamplePeak as never} loudness={application ? undefined : exportLoudness as never} heldExportIds={data.restore?.heldExportIds} orderedExports={orderedExports} projectName={data.project?.name} timelineRevision={timeline?.revision} /></AgentDockPane></DeliveryWorkspace></AgentDockPane></WorkbenchDialogContent></Dialog>
    <Dialog open={showTasks} onOpenChange={open => { if (!open) { markPanelIntent(); setShowTasks(false); } }}><WorkbenchDialogContent title={t('shell.tasks')} size="large" keepMounted hidden={!showTasks} inert={!showTasks} data-testid="task-center-dialog"><AgentDockPane id="right-dock-tasks" labelledBy="right-dock-tasks-tab" visible={showTasks} fallbackFocus="[data-testid=right-dock-tab-properties]"><TaskCenter dispositions={taskDispositions} selectedTaskId={selectedTaskId} taskViewScope={taskViewScope} onOpenExportHistory={openExportHistory} captureView={captureTaskView} workspace={workspace} activeCount={activeCount + activeRenderCount} pending={pending as never} busy={busy} jobs={jobs} data={data as never} reconcileIds={reconcileIds as never} setReconcileIds={setReconcileIds as never} run={run as never} retryGeneration={retryGeneration as never} onInspectJob={inspectTaskJob as never} context={context} confirm={confirm as never} isCurrent={isCurrent as never} tasks={taskState as never} onRecover={recoverTask as never} onReload={(() => tasksRef.current!.load(currentProject.current as string)) as never} onAdopt={adoptLegacyTask as never} /></AgentDockPane></WorkbenchDialogContent></Dialog>
    {showProjectChooser && <Modal title={t('projects.openWorkspace')} onClose={() => setShowProjectChooser(false)}><div className="project-chooser-list">{projects.map(project => <Button variant="ghost" key={project.id} onClick={async () => { if (await selectProject(project.id)) setShowProjectChooser(false); }}><Icon name="folder" size={16} />{project.name}</Button>)}</div></Modal>}
    {toast && <div className={`workbench-toast ${toast.type}`} data-testid="global-toast" role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'success' ? 'check' : 'info'} size={17} /><span>{renderImportFeedback(locale, toast.message)}</span><Button variant="ghost" className="icon-button small" aria-label={t('shell.dismissNotice')} onClick={() => setToast(null)}><Icon name="close" size={15} /></Button></div>}
    {!nativeWindow && !opacityRestored && showCreate && <CreateProject onClose={() => { navigationEpoch.current++; setShowCreate(false); }} onCreate={createProject} busy={busy['project-create'] || busy['project-create-flow']} />}
    {previewAsset && <Modal title={previewAsset.name} subtitle={`${previewAsset.mimeType} · ${formatNumber(previewAsset.sizeBytes / 1024 / 1024, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`} onClose={() => setPreviewAsset(null)} wide><div className="asset-preview-large"><Media asset={previewAsset} controls /></div><div className="modal-footer"><Button variant="ghost" className="button primary" onClick={() => { addNode(assetKind(previewAsset), previewAsset); setPreviewAsset(null); }}><Icon name="plus" size={16} />{t('assets.addCanvas')}</Button></div></Modal>}
    {realConfirm && <Modal title={t('shell.generationConfirmTitle')} subtitle={t('shell.generationCosts')} onClose={() => { realConfirmRef.current = null; setRealConfirm(null); }}><div className="modal-form"><div className="confirmation-summary"><strong>{providerDisplayName(providers.find(p => p.id === realConfirm.providerId) || { id: realConfirm.providerId }, t)}</strong>{realConfirm.retryJobId && <p>{t('shell.generationRetryScope')}</p>}<span>{t('shell.generationReviewParameters', { model: realConfirm.model as string, mode: renderMessage(inputModeDescriptor(realConfirm.inputMode as string)), seconds: realConfirm.shot.duration as number, ratio: realConfirm.shot.aspectRatio as string })}</span><p>{t('shell.generationDataScope', { count: generationReferences(realConfirm.shot, { frozen: Boolean(realConfirm.retryJobId), subjectReference: realConfirm.subjectReference }).references.length })}</p>{(realConfirm.subjectReference || realConfirm.shot.subjectReference) ? <><SubjectVideoSummary reference={realConfirm.subjectReference || realConfirm.shot.subjectReference} assets={realConfirm.referenceAssets} latestSubject={((subjects as never as {state?: {subjects: Record<string, unknown>}} | null)?.state?.subjects[((realConfirm.subjectReference || realConfirm.shot.subjectReference) as AppSubjectReference).subjectVersion.subjectId as string]) as never} /><p className="subject-warning" data-testid="paid-subject-face-warning">{renderMessage(realConfirm.providerId === 'ark' ? ARK_SUBJECT_WARNING_MESSAGE : MOCK_SUBJECT_WARNING_MESSAGE)}</p><p className="muted">{t('shell.generationSubjectScope')}</p></> : <VideoFrameSummary shot={realConfirm.shot} assets={realConfirm.referenceAssets} frozen={Boolean(realConfirm.retryJobId)} />}<p className="muted">{t('shell.generationBudgetScope')}</p><p className="muted">{t('shell.generationUnknownNoRetry')}</p></div><Button variant="ghost" className="button primary full" data-testid="confirm-live-generation" onClick={() => confirmGeneration(realConfirm)}>{t('shell.generationConfirmSend')}</Button></div></Modal>}
    </WorkspaceVisibilityProvider>
    {comparisonId && <VersionComparison key={`${data.project?.id}:${projectEpoch.current}:${comparisonId}`} context={comparisonContext()} getContext={comparisonContext}
      onClose={() => setComparisonId(null)} onUse={useComparedVersion} onAdd={binding => { if (!timelineBusy && comparisonCurrent(binding, comparisonContext()) && !isBusy(`version:${binding.shotId}`)) addTimelineAsset(binding.assetId); }} busy={Boolean(busy[`version:${comparisonId}`])}
      onRegisterMediaPause={registerComparisonPreviewPause} onBeforePlay={() => { audioPreview.controller!.revoke(); nativePreviewPause.current?.(); exportPreviewPause.current?.(); }} />}
  </main></>;
}
