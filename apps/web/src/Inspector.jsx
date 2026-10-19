import { jobStatusDescriptor, statusDescriptor, outputReviewDescriptor } from './creation-i18n.ts';
import { message as msg } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
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
import AssetAnnotations from './AssetAnnotations.tsx';
import CanvasOverview from './CanvasOverview.tsx';
import BoardInspectorGroup from './BoardInspectorGroup.tsx';
import VersionCardPreview from './VersionCardPreview.tsx';
import './board-redesign.css';
import { activeJob, assetUrl, outputReviewRequired } from './api.js';
import { Media } from './Nodes.jsx';
import { dragAsset } from './Timeline.jsx';
import ProviderSettings from './ProviderSettings.jsx';
import VideoFrameControls, { VideoFrameSummary } from './VideoFrameControls.jsx';
import SubjectVideoSelection from './SubjectVideoSelection.jsx';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoConflictIssue } from './subject-video.js';
import ShotSubjectBindings from './ShotSubjectBindings.jsx';
import { imageEditSourceIssueDescriptor } from './image-generation.js';
import { ReferenceSourcePanel, BoundReference } from './ReferenceConnections.jsx';
import { referenceForShot } from './reference-connections.js';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, inputModeLabel, inputModeDescriptor, generationInputIssueDescriptor, providerAvailabilityDescriptor } from './generation-settings.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { schemas } from '@mioon/contracts';
import { useLocalShotText, mergeFreshShotTextAck } from './local-shot-text-state.ts';
import ShotTextDraftRecovery from './ShotTextDraftRecovery.tsx';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';

const editable = (s) => ({ title: s.title, prompt: s.prompt || '', referenceAssetIds: s.referenceAssetIds || [], ...(Object.hasOwn(s, 'lastFrameAssetId') ? { lastFrameAssetId: s.lastFrameAssetId } : {}), duration: s.duration || 2, aspectRatio: s.aspectRatio || '9:16', parameters: s.parameters || {} });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export default function Inspector({ onEditImage, annotations, annotationAsset = null, annotationBlocked = false, restored = false, onShowTasks, generationUnavailableReason = '', subjects, subjectBlocked, shot, node, project, assets, versions, jobs, providers, tab, setTab, busy, onSave, onNodeSave, onGenerate, onSelectVersion, onCompare, onOpenJobs, onDirtyChange, onAddVersion, generationOptions = {}, onGenerationOptionsChange, shots = [], nodes = [], edges = [], referenceBusy = false, referencePending = false, onAttachReference, onDetachReference, onInspect, highlightedVersionId, actionScopeKey = '', shotTextContext = null, onShotTextController, onShotTextAccepted }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
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
      if (!await confirm(msg('inspector.confirm.textMode')) || !actionCurrent(epoch, serial) || !frameActionAllowed() || actionState.current.referenceLocked) return;
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
    if (!await confirm(msg('inspector.confirm.clearLastFrame')) || !actionCurrent(epoch, serial) || !frameActionAllowed()) return;
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
    if (!await confirm(msg('inspector.confirm.clearManual')) || !actionCurrent(epoch, serial) || !frameActionAllowed() || actionState.current.referenceLocked) return;
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
  const capabilityIssueDisplay = shot ? generationInputIssueDescriptor(draft, provider, model, assets, inputMode, { subjectReference: generationOptions.subjectReference, savedShot: shot, boundReference }) : '';
  const availabilityIssue = generationUnavailableReason || providerAvailabilityIssue(provider);
  const availabilityIssueDisplay = generationUnavailableReason || providerAvailabilityDescriptor(provider);
  const inputModes = [...new Set([...(capabilities?.inputModes || []), inputMode])];
  const ratios = capabilities?.aspectRatios || [];
  const durations = capabilities?.durations || [];
  const imageRules = capabilities?.referenceImages;
  const seedSupported = Boolean(capabilities?.seed || capabilities?.parameters?.includes('seed'));
  const unsupportedParameters = Object.keys(draft.parameters || {}).filter(key => capabilities?.parameters && !capabilities.parameters.includes(key));
  const annotationTarget = annotationAsset && annotationAsset.projectId === project?.id && assets.some(asset => asset.id === annotationAsset.id && asset.projectId === project?.id) ? annotationAsset : node?.assetId ? assets.find(asset => asset.id === node.assetId && asset.projectId === project?.id) : null;
  const imageEditIssue = node?.type === 'image' ? imageEditSourceIssueDescriptor(assets.find(asset => asset.id === node.assetId && asset.projectId === project?.id), project?.id) : null;
  const annotationPanel = annotations && (annotationTarget || annotations.state?.dirtyCount || annotations.state?.uncertainCount) ? <AssetAnnotations asset={annotationTarget} state={annotations.state} controller={annotations.controller} blocked={annotationBlocked} restored={restored} onShowTasks={onShowTasks || onOpenJobs} confirm={confirm} visible={visible && (!shot || tab === 'settings')} /> : null;
  if (!record && annotationTarget) return <aside className="inspector" data-testid="asset-inspector"><header className="inspector-heading"><Icon name="image" /><span title={annotationTarget.name}>{annotationTarget.name}</span></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll"><div className="inspector-asset"><Media asset={annotationTarget} controls={annotationTarget.mimeType?.startsWith('video/') || annotationTarget.mimeType?.startsWith('audio/')} /></div>{annotationPanel}</div></ScrollArea></aside>;
  if (!record) return <aside className="inspector"><header className="inspector-heading"><Icon name="settings" /><span>{t('inspector.title')}</span></header><div className="inspector-empty"><div className="empty-icon"><Icon name="film" size={28} /></div><h3>{t('inspector.emptyTitle')}</h3><p>{t('inspector.emptyHint')}</p></div>{project && (shots.length > 0 || nodes.length > 0) && <CanvasOverview shots={shots} versions={versions} jobs={jobs} nodes={nodes} />}</aside>;
  if (node) return <aside className="inspector" data-testid="node-inspector"><header className="inspector-heading"><Icon name={node.type === 'text' ? 'text' : node.type === 'image' ? 'image' : 'film'} /><span>{node.type === 'text' ? t('inspector.textNote') : t('inspector.assetNode')}</span><span className="revision">{t('inspector.revision', { number: node.revision })}</span></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll" style={{ overflow: 'visible' }}><Label className="field-label" htmlFor="node-label">{t('inspector.nodeName')}</Label><Input id="node-label" maxLength={150} value={draft.label} onChange={e => edit('label', e.target.value)} />{node.type === 'text' ? <><Label className="field-label" htmlFor="node-text">{t('inspector.textContent')}</Label><Textarea id="node-text" rows={12} maxLength={5000} value={draft.text} onChange={e => edit('text', e.target.value)} placeholder={t('inspector.notePlaceholder')} /></> : <div className="inspector-asset"><Media asset={assets.find(a => a.id === node.assetId)} controls={node.type !== 'image'} /></div>}{conflict && <div className="notice warning">{t('inspector.nodeConflict')}<Button variant="ghost" size="sm" onClick={reset}>{t('inspector.loadLatest')}</Button></div>}<Button size="sm" className="button primary full" disabled={!dirty || conflict || referenceBusy || busy[`save:${node.id}`]} onClick={save}><Icon name="check" size={16} />{t('inspector.saveNode')}</Button>{dirty && <Button variant="ghost" size="sm" className="text-button" onClick={reset}>{t('inspector.discard')}</Button>}{node.type === 'image' && onEditImage && <Button variant="ghost" size="sm" className="button full" data-testid="node-edit-image" title={renderMessage(imageEditIssue) || undefined} disabled={restored || !visible || referenceBusy || Boolean(imageEditIssue)} onClick={() => { if (!mounted.current || !visibleRef.current || actionEpoch.current !== renderedAction.epoch || editSerial.current !== renderSerial) return; const source = assets.find(asset => asset.id === node.assetId && asset.projectId === project?.id); if (source) onEditImage(source); }}><Icon name="sparkle" size={14} />{t('redesign.board.editImage')}</Button>}<ReferenceSourcePanel node={node} project={project} assets={assets} shots={shots} edges={edges} busy={referenceBusy || Boolean(shotTextContext && shotText.state.pending)} pending={referencePending} dirty={dirty} conflict={conflict} onAttach={onAttachReference} onInspect={onInspect} /><p className="muted helper visual-connection-note">{t('inspector.visualLinkHint')}</p>{annotationPanel}</div></ScrollArea></aside>;
  return <aside className="inspector" data-testid="shot-inspector">
    <header className="inspector-heading"><Icon name="settings" /><span>{t('inspector.shotSettings')}</span><span className="revision">{t('inspector.revision', { number: shot.revision })}</span></header>
    <Tabs value={tab} onValueChange={setTab} style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <TabsList variant="line" className="inspector-tabs w-auto justify-start rounded-none p-0" aria-label={t('inspector.shotPanel')}>
        <TabsTrigger value="settings" className={`flex-none rounded-none border-0 bg-transparent shadow-none ${tab === 'settings' ? 'active' : ''}`}>{t('inspector.parameters')}</TabsTrigger>
        <TabsTrigger value="versions" className={`flex-none rounded-none border-0 bg-transparent shadow-none ${tab === 'versions' ? 'active' : ''}`}>{t('inspector.versions')}<span>{selectedVersions.length}</span></TabsTrigger>
      </TabsList>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll" style={{ overflow: 'visible' }}><TabsContent value="versions"><div className="section-heading"><span>{t('inspector.explore')}</span><Button variant="ghost" size="sm" className="text-button" disabled={selectedVersions.length < 2} onClick={() => onCompare(shot.id)}><Icon name="compare" size={14} />{t('inspector.compare')}</Button></div>{selectedVersions.length ? selectedVersions.map(v => <div className={`version-card ${shot.selectedVersionId === v.id ? 'chosen' : ''} ${highlightedVersionId === v.id ? 'source-highlighted' : ''}`} key={v.id} ref={highlightedVersionId === v.id ? highlightedVersion : undefined} tabIndex={highlightedVersionId === v.id ? -1 : undefined} data-testid={`version-card-${v.id}`} data-source-highlighted={highlightedVersionId === v.id || undefined} aria-label={highlightedVersionId === v.id ? t('inspector.clipSourceVersion', { number: v.number }) : undefined} draggable={Boolean(v.assetId)} onDragStart={e => { if (v.assetId) dragAsset(e, v.assetId); }}><div className="version-preview"><VersionCardPreview sourceKey={`${v.id}:${v.assetId}:${v.sha256}`} title={t('projects.version', { number: v.number })} renderMedia={controls => <Media version={v} controls={controls} />} /></div>{highlightedVersionId === v.id && <div className="version-source-note" data-testid="highlighted-source-version"><Icon name="link" size={12} />{t('inspector.fixedSourceVersion', { number: v.number })}</div>}<div className="version-details"><strong>{t('projects.version', { number: v.number })}</strong><Badge className={`small-badge ${v.isMock ? 'neutral' : 'accent'}`}>{v.isMock ? t('inspector.mock') : v.providerId}</Badge><span className="spacer" />{shot.selectedVersionId === v.id && <span className="version-current"><Icon name="check" size={12} />{t('inspector.selected')}</span>}</div><p>{v.snapshot?.prompt || t('inspector.noPrompt')}</p><p className="version-generation-specs">{v.model || v.snapshot?.model || v.providerId} · {v.snapshot?.duration}s · {v.snapshot?.aspectRatio} · {t('shell.node.referenceCount', { count: v.snapshot?.referenceAssetIds?.length || 0 })}</p>{v.snapshot?.subjectReference ? <SubjectVideoSummary reference={v.snapshot.subjectReference} assets={assets} latestSubject={subjects?.state?.subjects[v.snapshot.subjectReference.subjectVersion?.subjectId]} compact /> : <VideoFrameSummary shot={v.snapshot} assets={assets} frozen compact />}<div className="version-card-footer"><span>{formatDate(v.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><Button variant="ghost" size="sm" className="button small" disabled={shot.selectedVersionId === v.id || busy[`version:${shot.id}`]} onClick={() => onSelectVersion(shot, v.id)}>{shot.selectedVersionId === v.id ? t('inspector.selected') : t('inspector.selectVersion')}</Button></div><Button variant="ghost" size="sm" className="button small full version-to-timeline" disabled={!v.assetId} onClick={() => onAddVersion(v.assetId)}>{t('inspector.addFixedVersion')}</Button></div>) : <div className="small-empty"><Icon name="layers" size={28} /><h4>{t('inspector.noVersions')}</h4><p>{t('inspector.versionScope')}</p><Button variant="ghost" size="sm" className="button" onClick={() => setTab('settings')}>{t('inspector.start')}</Button></div>}</TabsContent><TabsContent value="settings">
      {shot.selectedVersionId && <Button variant="ghost" size="sm" className="button small full version-to-timeline" data-testid="selected-version-to-timeline" onClick={() => { const selected = versions.find(v => v.id === shot.selectedVersionId); if (selected?.assetId) onAddVersion(selected.assetId); }}>{t('inspector.selectedToTimeline')}</Button>}
      <BoardInspectorGroup key={`shot:${shot.id}`} title={t('redesign.board.shotProperties')}>
      <div className="section-eyebrow">{t('inspector.shotIndex', { number: String(shot.orderIndex + 1).padStart(2, '0') })}<Badge className={`small-badge ${dirty ? 'warn' : 'neutral'}`}>{dirty ? t('inspector.unsaved') : t('inspector.synced')}</Badge></div>
      <Label className="field-label" htmlFor="shot-title">{t('inspector.shotName')}</Label><Input id="shot-title" data-testid="shot-title" value={draft.title} onChange={e => edit('title', e.target.value)} maxLength={shotTextContext ? LOCAL_SHOT_TEXT_LIMITS.rawTitleUnits : 150} />
      <Label className="field-label" htmlFor="shot-prompt"><span>{t('inspector.visualDescription')}</span><span className="optional">{t('inspector.promptLabel')}</span></Label><Textarea id="shot-prompt" data-testid="shot-prompt" className="prompt-input" rows={6} maxLength={shotTextContext ? LOCAL_SHOT_TEXT_LIMITS.rawPromptUnits : 5000} value={draft.prompt} onChange={e => edit('prompt', e.target.value)} placeholder={t('inspector.promptPlaceholder')} /><p className="input-hint">{t('inspector.promptHint')}{capabilities?.maxPromptLength && <span> {t('inspector.characterCount', { count: draft.prompt.length, limit: capabilities.maxPromptLength })}</span>}</p>
      {shotTextContext && <ShotTextDraftRecovery state={shotText.state} controller={shotText.controller} canSave={shotText.controller.canPrepare() && Boolean(draft.title.trim())} disabled={!visible || tab !== 'settings' || currentTextContext().busy} onInspect={onInspect} />}
      {textBlocksLegacy && <p className="input-hint" data-testid="shot-text-save-order">{t('inspector.textSaveOrder')}</p>}
      </BoardInspectorGroup>
      <BoardInspectorGroup key={`reference:${shot.id}`} title={t('redesign.board.referenceTitle')}>
      <BoundReference edge={boundReference} nodes={nodes} assets={assets} busy={referenceBusy || Boolean(shotTextContext && shotText.state.pending)} pending={referencePending} dirty={dirty} conflict={conflict} onDetach={onDetachReference} onInspect={onInspect} />
      {referencePending && !boundReference && <div className="notice warning" data-testid="reference-pending">{t('inspector.referencePending')}<Button variant="ghost" size="sm" onClick={onOpenJobs}>{t('inspector.openTasks')}</Button></div>}
      {inputMode === 'subject' && !subjectVideoConflictIssue(draft, { savedShot: shot, boundReference }) ? <p className="input-hint">{t('inspector.subjectScope')}</p> : inputMode === 'text' ? <p className="input-hint" data-testid="text-mode-hint">{t('inspector.textModeHint')}</p> : <>
        <div className="field-label"><span>{t('inspector.firstFrame')}</span><span className="optional">{t('inspector.selectedReferences', { count: draft.referenceAssetIds.length })}</span></div>
        <div className="reference-grid">{referenceAssets.map(a => <Button variant="ghost" size="sm" key={a.id} title={a.name} className={`reference-choice ${draft.referenceAssetIds.includes(a.id) ? 'selected' : ''}`} aria-label={t('inspector.referenceNamed', { name: a.name })} aria-pressed={draft.referenceAssetIds.includes(a.id)} disabled={referenceLocked || Boolean(shotTextContext && shotText.state.pending)} onClick={() => { if (!frameActionAllowed() || actionState.current.referenceLocked) return; updateGeneration({ inputMode: 'image' }); edit('referenceAssetIds', draft.referenceAssetIds.includes(a.id) ? [] : [a.id]); }}><img src={assetUrl(a)} alt={a.name} />{draft.referenceAssetIds.includes(a.id) && <span><Icon name="check" size={11} /></span>}</Button>)}{!referenceAssets.length && <p className="reference-empty">{t('inspector.importReferenceHint')}</p>}</div>
        {!boundReference && draft.referenceAssetIds.length > 0 && <Button variant="ghost" size="sm" className="text-button clear-manual-references" data-testid="clear-manual-references" disabled={referenceBlocked || Boolean(shotTextContext && shotText.state.pending)} onClick={clearManualReferences}>{t('inspector.clearManual')}</Button>}
        {boundReference && <p className="input-hint">{t('inspector.boundReferenceHint')}</p>}
        {imageRules && <p className="input-hint" data-testid="reference-requirements">{t('inspector.firstFrameImage')}{imageRules.mimeTypes?.length ? ` · ${imageRules.mimeTypes.map(type => type.replace('image/', '').toUpperCase()).join(' / ')}` : ''}{imageRules.minDimension ? t('inspector.minDimension', { dimension: imageRules.minDimension }) : ''}{imageRules.maxDimension ? t('inspector.maxDimension', { dimension: imageRules.maxDimension }) : ''}{imageRules.matchAspectRatio ? t('inspector.matchAspect') : ''}</p>}
        <VideoFrameControls draft={draft} assets={referenceAssets} disabled={referenceBlocked || !visible || Boolean(shotTextContext && shotText.state.pending)} onChoose={chooseLastFrame} onClear={clearLastFrame} />
        <VideoFrameSummary shot={draft} assets={assets} />
      </>}
      </BoardInspectorGroup>
      <BoardInspectorGroup key={`generation:${shot.id}`} title={t('redesign.board.generationSettings')}>
      <ProviderSettings providers={providers} provider={provider} model={model} capabilities={capabilities} onChange={updateGeneration} compact />
      <Label className="field-label" htmlFor="generation-input-mode">{t('inspector.generationMode')}</Label>
      <WorkbenchSelect id="generation-input-mode" data-testid="input-mode-select" disabled={referenceLocked || Boolean(shotTextContext && shotText.state.pending)} value={inputMode} onChange={e => changeInputMode(e.target.value)}>{inputModes.map(mode => <option key={mode} value={mode}>{renderMessage(inputModeDescriptor(mode))}{mode === 'subject' || capabilities?.inputModes?.includes(mode) ? '' : t('inspector.unsupported')}</option>)}</WorkbenchSelect>
      <div className="field-row"><div><Label className="field-label" htmlFor="shot-ratio">{t('inspector.aspectRatio')}</Label><WorkbenchSelect id="shot-ratio" data-testid="shot-ratio" value={draft.aspectRatio} onChange={e => edit('aspectRatio', e.target.value)}>{[...new Set([...ratios, draft.aspectRatio])].map(r => <option key={r} value={r}>{r}{ratios.includes(r) ? '' : t('inspector.unsupported')}</option>)}</WorkbenchSelect></div><div><Label className="field-label" htmlFor="shot-duration">{t('inspector.shotDuration')}</Label><WorkbenchSelect id="shot-duration" data-testid="shot-duration" value={draft.duration} onChange={e => edit('duration', Number(e.target.value))}>{[...new Set([...durations, draft.duration])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{t('shell.durationSeconds', { seconds: d })}{durations.includes(d) ? '' : t('inspector.unsupported')}</option>)}</WorkbenchSelect></div></div>
      </BoardInspectorGroup>
      {subjects && <BoardInspectorGroup key={`subjects:${shot.id}`} title={t('redesign.board.subjectAndStyle')}>
      {subjects && <ShotSubjectBindings shot={shot} subjects={subjects} assets={assets} blocked={subjectBlocked} onShowTasks={onOpenJobs} />}
      <SubjectVideoSelection shot={shot} draft={draft} subjects={subjects} assets={assets} provider={provider} model={model} options={generationOptions} disabled={referenceBlocked || subjectBlocked} boundReference={Boolean(boundReference)} onChange={patch => { if (frameActionAllowed()) updateGeneration(patch); }} />
      </BoardInspectorGroup>}
      {conflict && <div className="notice warning">{t('inspector.shotConflict')}<Button variant="ghost" size="sm" onClick={reset}>{t('inspector.loadLatest')}</Button></div>}
      {dirty && <div className="save-row"><Button size="sm" className="button primary" data-testid="save-shot" disabled={textBlocksLegacy || referenceBlocked || !draft.title.trim() || busy[`save:${shot.id}`]} onClick={save}><Icon name="check" size={15} />{t('inspector.saveChanges')}</Button><Button variant="ghost" size="sm" className="text-button" onClick={reset}>{t('inspector.discard')}</Button></div>}
      {annotationPanel}
      <Separator className="section-divider" />
      <Collapsible open={advanced} onOpenChange={setAdvanced}><CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="advanced-toggle h-auto"><span>{t('inspector.advanced')}</span><Icon name={advanced ? 'minus' : 'plus'} size={15} /></CollapsibleTrigger><CollapsibleContent className="advanced-fields">{provider?.mock && <><Label className="field-label" htmlFor="mock-scenario">{t('inspector.mockScenario')}</Label><WorkbenchSelect id="mock-scenario" data-testid="mock-scenario" value={scenario} onChange={e => updateGeneration({ scenario: e.target.value })}><option value="success">{t('inspector.mockSuccess')}</option><option value="failure">{t('inspector.mockFailure')}</option><option value="delay">{t('inspector.mockDelay')}</option><option value="timeout">{t('inspector.mockTimeout')}</option><option value="unknown">{t('inspector.mockUnknown')}</option></WorkbenchSelect></>}{(seedSupported || draft.parameters.seed !== undefined) && <><Label className="field-label" htmlFor="seed">{t('inspector.seed')}{!seedSupported && <span className="optional">{t('inspector.seedUnsupported')}</span>}</Label><Input id="seed" type="number" min={capabilities?.seed?.min} max={capabilities?.seed?.max} step="1" value={draft.parameters.seed ?? ''} onChange={e => { const params = { ...draft.parameters }; if (e.target.value === '') delete params.seed; else params.seed = Number(e.target.value); edit('parameters', params); }} placeholder={t('inspector.automatic')} />{capabilities?.seed && <p className="input-hint">{t('inspector.seedRange', { min: capabilities.seed.min, max: capabilities.seed.max })}</p>}</>}<>{unsupportedParameters.length > 0 && <div className="notice warning"><p>{t('inspector.unsupportedParameters', { parameters: unsupportedParameters.join(', ') })}</p><Button variant="ghost" size="sm" onClick={() => edit('parameters', Object.fromEntries(Object.entries(draft.parameters).filter(([key]) => !unsupportedParameters.includes(key))))}>{t('inspector.clearUnsupported')}</Button></div>}</><p className="helper muted">{t('inspector.historyScope')}</p></CollapsibleContent></Collapsible>
    </TabsContent>
    {shotJobs[0] && <div className={`latest-job ${shotJobs[0].status === 'submission_unknown' || outputReviewRequired(shotJobs[0]) ? 'warning' : ''}`}><Button variant="ghost" size="sm" onClick={onOpenJobs}><Icon name="clock" size={15} /><span>{renderMessage(jobStatusDescriptor(shotJobs[0]))}</span><Icon name="arrow" size={13} /></Button>{shotJobs[0].snapshot?.subjectReference && <SubjectVideoSummary reference={shotJobs[0].snapshot.subjectReference} assets={assets} compact />}{running && <div className="progress-track"><span style={{ width: `${Math.max(3, running.progress || 0)}%` }} /></div>}{outputReviewRequired(shotJobs[0]) && <p>{renderMessage(outputReviewDescriptor)}</p>}{shotJobs[0].status === 'submission_unknown' && <p>{t('inspector.billingUnknown')}</p>}</div>}
    </div></ScrollArea></Tabs><footer className="inspector-action">{(generationUnavailableReason || capabilityIssue || availabilityIssue) && <p className="capability-issue" data-testid="generation-issue" role="status"><Icon name="info" size={13} />{renderMessage(generationUnavailableReason || capabilityIssueDisplay || availabilityIssueDisplay)}</p>}{!generationUnavailableReason && !capabilityIssue && !availabilityIssue && (textBlocksLegacy || !draft.title.trim()) && <p className="capability-issue" data-testid="generation-save-first" role="status"><Icon name="info" size={13} />{textBlocksLegacy ? t('inspector.saveTextFirst') : t('inspector.nameRequired')}</p>}<Button size="sm" className="button generate-button full" data-testid="generate-shot" title={renderMessage(generationUnavailableReason) || undefined} disabled={textBlocksLegacy || generating || referenceBlocked || Boolean(capabilityIssue) || !draft.title.trim() || Boolean(availabilityIssue) || busy[`save:${shot.id}`]} onClick={generate}>{generating ? <span className="spinner" /> : <Icon name="sparkle" size={17} />}{generating ? `${renderMessage(statusDescriptor(running?.status || 'queued'))}` : dirty && !textBlocksLegacy ? t('inspector.saveGenerate') : t('inspector.generateShot')}<span className="button-shortcut">{draft.duration}s</span></Button></footer>
  </aside>;
}
