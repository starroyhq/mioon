/** Real format-5 board-RPC harness for UI-B2. Mounts the production
 * BoardUiLive/BoardInspector/session over the real project service; only the
 * shell around the board is a fixture. */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../../packages/ui/src/styles/globals.css';
import '../../../apps/web/src/styles.css';
import '../../../apps/web/src/edit-ui/edit-ui.css';
import '../../../apps/web/src/board-ui/board-ui.css';
import './fixture.css';
import {I18nProvider, createLanguageStore, useI18n} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import BoardUiLive from '../../../apps/web/src/board-ui/BoardUiLive.tsx';
import BoardInspector from '../../../apps/web/src/board-ui/BoardInspector.tsx';
import GenerateInEditingPanel from '../../../apps/web/src/edit-ui/GenerateInEditingPanel.tsx';
import SubjectLibrary from '../../../apps/web/src/SubjectLibrary.tsx';
import {useSubjects} from '../../../apps/web/src/use-subjects.ts';
import {WorkspaceVisibilityProvider} from '../../../apps/web/src/workspace-visibility.tsx';
import {assetKind, dragAsset} from '../../../apps/web/src/Timeline.tsx';
import {projectLiveBoard, boardDeleteIntent, boardNodeCreateIntent, boardNodeUpdateIntent, boardRestoreIntent, boardShotUpdateIntent, boardVersionIntent,
  subjectBindingDetachOperation, subjectBindingModeOperation, subjectBindingRestoreOperation,
  subjectCardCreateOperation, subjectCardDeleteOperation} from '../../../apps/web/src/board-ui/live.ts';
import {dragSubject} from '../../../apps/web/src/board-ui/subject-drag.ts';
import {readGenerationProviderDirectory} from '../../../apps/web/src/video-provider-directory.ts';
import {createPrevisNode} from '../../../apps/web/src/previs/previs-create.ts';
import {createPrevisEditorRpc} from '../../../apps/web/src/previs/previs-format5-rpc.ts';
import {generationSelection} from '../../../apps/web/src/generation-settings.ts';
import {format5GenerationInputService} from '../../../apps/web/src/board-ui/generation-input-request.ts';
import {format5GenerationEntry} from '../../../apps/web/src/format5-generation-entry.ts';
import type {GenerationProvider} from '../../../apps/web/src/generation-settings.ts';
import {referenceAttachRequest, referenceDetachRequest, referenceReorderRequest, referenceRoleRequest} from '../../../apps/web/src/board-ui/inputs.ts';
import type {BoardEditRequest, SequenceGenerationInputView} from '../../../apps/web/src/board-ui/inputs.ts';
import {BoardUiSession} from '../../../apps/web/src/board-ui/live-session.ts';
import type {BoardBinding, BoardMountView, BoardOutcome} from '../../../apps/web/src/board-ui/live-session.ts';
import type {EditUiNotice} from '../../../apps/web/src/edit-ui/EditUiNotice.tsx';
import type {SequenceHistoryView} from '../../../apps/web/src/edit-ui/session.ts';
import type {SequenceEditAllocation, SequenceEditIntent, SubjectEditOperation} from '../../../packages/contracts/src/sequence-edit.ts';

type Row = Record<string, any>;
const projectId = '70000000-0000-4000-8000-000000000001';
const rpc = async (operation: string, input: unknown): Promise<any> => {
  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({operation, input})});
  const body = await response.json() as {ok: boolean; data?: any; error?: {code?: string; message?: string}};
  if (operation === 'generation.submit') (globalThis as any).__boardWireLastGeneration = input;
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'RPC failed'), {code: body.error?.code ?? 'RPC_FAILED'});
  return body.data;
};
const syntheticThumb = (assetId: string): string => {
  const colors = ['#284b63', '#846b3e', '#5c3f66', '#2f5d50'];
  const color = colors[[...assetId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % colors.length];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="${color}"/><circle cx="240" cy="122" r="52" fill="#e8e2d2" opacity=".85"/><rect x="20" y="236" width="150" height="8" rx="4" fill="#e8e2d2" opacity=".35"/></svg>`)}`;
};
const uuid = (): string => globalThis.crypto.randomUUID();
const SUBJECT_CHARACTER = '70000000-0000-4000-8000-000000000090';
const SUBJECT_LOOK = '70000000-0000-4000-8000-000000000091';

function Harness(): React.ReactElement {
  const {t} = useI18n();
  const [data, setData] = useState<Row | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [mount, setMount] = useState<BoardMountView | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('70000000-0000-4000-8000-000000000003');
  const [notice, setNotice] = useState<EditUiNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [openedNode, setOpenedNode] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly GenerationProvider[]>([]);
  const [mockProviderInstalled, setMockProviderInstalled] = useState(false);
  const [editingPanelShot, setEditingPanelShot] = useState<string | null>(null);
  const activeProviders = useMemo<readonly GenerationProvider[]>(() => mockProviderInstalled
    ? [...providers, {id: 'mock', name: 'Mock · simulated motion', models: ['mock-motion-v1'],
      mock: true, configured: true, enabled: true, status: 'available'}] : providers, [providers, mockProviderInstalled]);
  const [generationOptions, setGenerationOptions] = useState<Record<string, Record<string, unknown>>>({});
  const [inputs, setInputs] = useState<SequenceGenerationInputView | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'settings' | 'versions'>('settings');
  const [revealNodeId, setRevealNodeId] = useState<string | null>(null);
  const stateRef = useRef<Row>({});
  const subjectFile = useRef<HTMLInputElement | null>(null);
  const subjectGate = useRef<string | null>(null);
  const session = useRef(new BoardUiSession(rpc, () => projectId));
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await rpc('project.get', {projectId});
      next.projectFormatVersion = 5;
      const nextHistory = await rpc('sequence.history.get', {projectId});
      const nextMount = await rpc('sequence.board.get', {projectId});
      const directory = await readGenerationProviderDirectory(operation => rpc(operation, {}));
      // The driver installs the Mock provider on demand for the generation
      // acceptance; keep it out of the default directory so no-service steps
      // remain no-service.
      setData(next); setHistory(nextHistory); setMount(nextMount);
      setProviders(directory.providers.filter(provider => provider.id !== 'mock'));
    } catch (error) {
      console.error('board fixture refresh failed', error);
      (window as any).__boardWireError = String((error as Error)?.message ?? error);
      throw error;
    }
  }, []);
  useEffect(() => {void refresh();}, [refresh]);
  // WT-3-02: a real subject library over the fixture project service. The import
  // button feeds the production asset.import RPC; creation and binding use the
  // production controller and board components.
  const importSubjectImage = useCallback(async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await rpc('asset.import', {projectId, name: file.name, mimeType: file.type || 'image/png', dataBase64: btoa(binary)});
    await refresh();
  }, [refresh]);
  const subjects = useSubjects({
    scope: `${projectId}:format5:${selectedNodeId ?? ''}`,
    projectId: data?.project?.id ?? null,
    assets: data?.assets ?? [],
    shotIds: (data?.shots ?? []).map((shot: Row) => String(shot.id)),
    read: (operation, input) => rpc(operation, input as never),
    save: async (operation, input) => {
      try { return await rpc(operation, input as never); }
      catch (error) { subjectGate.current = (error as {code?: string}).code ?? 'SUBJECT_SAVE_FAILED'; throw error; }
    },
  });
  const boardNodeType = (kind: string): 'image' | 'video' | 'audio' | null =>
    kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null;
  const freeBoardPosition = (): {x: number; y: number} => {
    const positions = Object.values<{x: number; y: number}>((stateRef.current.positions ?? {}));
    const xs = positions.map(point => point.x), ys = positions.map(point => point.y);
    const center = {x: (Math.min(0, ...xs) + Math.max(0, ...xs)) / 2, y: (Math.min(0, ...ys) + Math.max(0, ...ys)) / 2};
    for (let ring = 0; ring < 20; ring += 1) for (let dx = -ring; dx <= ring; dx += 1) for (let dy = -ring; dy <= ring; dy += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const candidate = {x: center.x + dx * 310, y: center.y + dy * 300};
      if (!positions.some(point => Math.abs(point.x - candidate.x) < 260 && Math.abs(point.y - candidate.y) < 264)) return candidate;
    }
    return {x: 100, y: 100};
  };
  const addAssetToBoard = useCallback(async (kind: string, asset: Row): Promise<void> => {
    const nodeType = boardNodeType(kind);
    if (!nodeType) return;
    const nodeId = uuid();
    setBusy(true);
    try {
      const outcome = await session.current.run(boardNodeCreateIntent(nodeId, nodeType, String(asset.name ?? '素材'),
        freeBoardPosition(), {assetId: String(asset.id)}));
      if (!outcome.ok) return;
      setNotice({id: outcome.actionId ?? 'board-applied', message: `Added ${String(asset.name ?? '')}`});
      await refresh();
      setSelectedNodeId(nodeId); setRevealNodeId(nodeId);
    } finally {setBusy(false);}
  }, [refresh]);
  const dropAssetOnBoard = useCallback(async (assetId: string, position: {x: number; y: number}): Promise<void> => {
    const asset = (data?.assets ?? []).find((item: Row) => item.id === assetId) as Row | undefined;
    if (!asset) return;
    const kind = String(asset.mimeType ?? '').split('/')[0] ?? '';
    const nodeType = boardNodeType(kind);
    if (!nodeType) return;
    const nodeId = uuid();
    setBusy(true);
    try {
      const outcome = await session.current.run(boardNodeCreateIntent(nodeId, nodeType, String(asset.name ?? '素材'),
        position, {assetId: String(asset.id)}));
      if (!outcome.ok) return;
      setNotice({id: outcome.actionId ?? 'board-applied', message: `Added ${String(asset.name ?? '')}`});
      await refresh();
      setSelectedNodeId(nodeId); setRevealNodeId(nodeId);
    } finally {setBusy(false);}
  }, [data, refresh]);

  const addPrevis = useCallback(async (): Promise<void> => {
    const requestId = uuid();
    setBusy(true);
    try {
      const previsRpc = createPrevisEditorRpc({rpc: (operation, input) => rpc(operation, input),
        format5: true, projectId: () => projectId, requestId: () => requestId});
      const outcome = await createPrevisNode({projectId, label: t('previs.node.defaultLabel'),
        position: freeBoardPosition()}, {rpc: previsRpc, requestId: () => requestId});
      await refresh();
      if (outcome.status !== 'created') return;
      setSelectedNodeId(outcome.node.id);
      setRevealNodeId(outcome.node.id);
      setNotice({id: outcome.node.id, message: t('previs.node.defaultLabel')});
    } finally {setBusy(false);}
  }, [refresh, t]);
  useEffect(() => {
    const shot = data?.shots?.find((item: Row) => item.id === selectedNodeId);
    if (!shot) {setInputs(null); return;}
    const selection = generationSelection(activeProviders, (generationOptions[selectedNodeId!] ?? {}) as never, shot as never);
    const provider = selection.provider;
    const request = {projectId, shotId: shot.id, ...format5GenerationInputService(provider, selection)};
    let cancelled = false;
    void rpc('sequence.generation-inputs.get', request).then(value => {if (!cancelled) setInputs(value as SequenceGenerationInputView);})
      .catch(() => {if (!cancelled) setInputs(null);});
    return () => {cancelled = true;};
  }, [data, activeProviders, generationOptions, selectedNodeId]);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(query?.matches === true);
    update(); query?.addEventListener?.('change', update);
    return () => query?.removeEventListener?.('change', update);
  }, []);
  const projection = useMemo(() => data ? projectLiveBoard({shots: data.shots, nodes: data.nodes, edges: data.edges,
    versions: data.versions, assets: data.assets, jobs: data.jobs, clips: data.timeline?.clips ?? [],
    subjects: mount?.subjects ?? [], frameAspect: '9:16', thumbnailFor: syntheticThumb}) : null,
  [data, mount?.subjects]);
  const activeFilmId = data?.timeline?.mainTrack?.sequenceNodeId ?? null;
  const run = useCallback(async (intent: SequenceEditIntent, message: string): Promise<BoardOutcome> => {
    setBusy(true);
    try {
      const outcome = await session.current.run(intent);
      if (outcome.ok && outcome.status === 'applied') {
        setNotice({id: outcome.actionId ?? 'board-applied', message});
        await refresh();
      }
      return outcome;
    } finally {setBusy(false);}
  }, [refresh]);
  const runSubject = useCallback(async (operation: SubjectEditOperation, allocation: SequenceEditAllocation | undefined,
    message: string): Promise<BoardOutcome> => {
    setBusy(true);
    try {
      const outcome = await session.current.runSubject(operation, allocation);
      if (outcome.ok && outcome.status === 'applied') {setNotice({id: outcome.actionId ?? 'board-applied', message}); await refresh();}
      return outcome;
    } finally {setBusy(false);}
  }, [refresh]);
  const subjectName = (subjectId: string): string => mount?.subjects.find(subject => subject.id === subjectId)?.name ?? '';
  const cardNodeForSubject = (subjectId: string): string | null =>
    projection?.nodes.find(node => node.kind === 'subject' && node.subjectId === subjectId)?.id ?? null;
  const addSubjectCard = useCallback((subjectId: string, position: {x: number; y: number}): void => {
    void runSubject(subjectCardCreateOperation(uuid(), subjectId, position), undefined,
      t('boardUi.notice.subjectCardAdded', {name: mount?.subjects.find(subject => subject.id === subjectId)?.name ?? ''}));
  }, [runSubject, mount, t]);
  const setBindingMode = useCallback((binding: BoardBinding, mode: 'follow' | 'locked', versionId: string | null): void => {
    void runSubject(subjectBindingModeOperation(binding.id, mode, versionId), undefined,
      t('boardUi.notice.bindingUpdated', {name: subjectName(binding.subjectId)}));
  }, [runSubject, mount, t]);
  const detachBinding = useCallback((binding: BoardBinding): void => {
    void runSubject(subjectBindingDetachOperation(binding.id), undefined, t('boardUi.notice.subjectDetached'));
  }, [runSubject, t]);
  const restoreBinding = useCallback((binding: BoardBinding): void => {
    const cardNodeId = cardNodeForSubject(binding.subjectId);
    if (!cardNodeId) return;
    const edgeId = uuid();
    void runSubject(subjectBindingRestoreOperation(binding.id, 'follow', null),
      {clips: [], nodes: [], splitClips: [], edges: [{id: edgeId, fromId: cardNodeId, toId: binding.shotId}]},
      t('boardUi.notice.subjectLinked', {name: subjectName(binding.subjectId)}));
  }, [runSubject, projection, mount, t]);
  const deleteCard = useCallback((nodeId: string, subjectId: string): void => {
    setSelectedNodeId(null);
    void runSubject(subjectCardDeleteOperation(nodeId), undefined,
      t('boardUi.notice.subjectCardDeleted', {name: subjectName(subjectId)}));
  }, [runSubject, mount, t]);
  const runReference = useCallback(async (request: BoardEditRequest, message: string): Promise<BoardOutcome> => {
    setBusy(true);
    try {
      const outcome = await session.current.run(request);
      if (outcome.ok && outcome.status === 'applied') {
        setNotice({id: outcome.actionId ?? 'board-applied', message});
        await refresh();
      }
      return outcome;
    } finally {setBusy(false);}
  }, [refresh]);
  const updateGenerationOptions = useCallback((shotId: string, options: Record<string, unknown>): void => {
    setGenerationOptions(current => ({...current, [shotId]: {...current[shotId], ...options}}));
  }, []);
  const updateShot = useCallback(async (shotId: string, patch: {title?: string; prompt?: string; duration?: number},
    expectedRevision: number): Promise<{ok: boolean; code?: string}> => {
    setBusy(true);
    try {
      const outcome = await session.current.run(boardShotUpdateIntent(shotId, expectedRevision, patch));
      if (outcome.ok && outcome.status === 'applied') {setNotice({id: outcome.actionId ?? shotId, message: t('projects.shotSaved')}); await refresh();}
      return outcome.ok ? {ok: true} : {ok: false, code: outcome.code};
    } finally {setBusy(false);}
  }, [refresh, t]);
  const generateShot = useCallback((shotId: string): void => {
    const shot = data?.shots?.find((item: Row) => item.id === shotId);
    const options = generationOptions[shotId] ?? {};
    const selection = shot ? generationSelection(activeProviders, options as never, shot as never) : null;
    const provider = selection?.provider;
    if (!shot || !selection || !provider) return;
    const entry = format5GenerationEntry({shot: shot as never, provider, model: selection.model, options,
      frame: data?.timeline && (data.timelineFrameTransaction === true || true) ? data.timeline as never : null});
    if (entry.issue) {(window as any).__boardWireGenerationError = 'FRAME'; return;}
    setBusy(true);
    void (async () => {
      try {
        try {
          const submitted = await rpc('generation.submit', {shotId, expectedRevision: shot.revision, requestId: uuid(),
            ...(entry.aspectSource ? {aspectSource: entry.aspectSource} : {}),
            providerId: provider.id, ...(provider.connectionId ? {connectionId: provider.connectionId,
              configurationRevision: provider.configurationRevision, modelEntryId: selection.modelEntryId} : {}),
            model: selection.model, ...(provider.id === 'mock' ? {parameters: {scenario: selection.scenario}} : {})});
          // The headless driver starts a synthetic task worker on demand; poll
          // the real project service so the fixture state sees terminal status,
          // the written version and the followed main-track clip.
          if (provider.id === 'mock' && submitted?.id) {
            for (let attempt = 0; attempt < 120; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 250));
              const next = await rpc('project.get', {projectId});
              const current = (next.jobs ?? []).find((job: Row) => job.id === submitted.id);
              if (current && ['succeeded', 'failed', 'cancelled'].includes(String(current.status))) break;
            }
          }
        } catch (error) {
          (window as any).__boardWireGenerationError = String((error as Error)?.message ?? error);
        }
        await refresh();
      } finally {setBusy(false);}
    })();
  }, [data, activeProviders, generationOptions, refresh]);
  const changeInputRole = useCallback((edgeId: string, shotId: string, role: never): void => {
    void runReference(referenceRoleRequest(edgeId, shotId, role), t('boardUi.notice.roleChanged'));
  }, [runReference, t]);
  const detachInput = useCallback((entry: {source: 'edge' | 'subject' | 'previs'; edgeId?: string; bindingId?: string}, shotId: string): void => {
    if (entry.source === 'subject' && entry.bindingId) {
      void runSubject(subjectBindingDetachOperation(entry.bindingId), undefined, t('boardUi.notice.subjectDetached'));
      return;
    }
    if (entry.edgeId) void runReference(referenceDetachRequest(entry.edgeId, shotId), t('boardUi.notice.referenceDetached', {name: ''}));
  }, [runReference, runSubject, t]);
  const setPrimaryInput = useCallback((edgeId: string, shotId: string): void => {
    const ordered = (inputs?.entries ?? []).flatMap(entry => entry.source === 'edge' && entry.edgeId ? [entry.edgeId] : []);
    const unique = [...new Set(ordered)];
    if (!unique.includes(edgeId)) return;
    void runReference(referenceReorderRequest(shotId, [edgeId, ...unique.filter(id => id !== edgeId)]),
      t('boardUi.notice.primaryChanged'));
  }, [inputs, runReference, t]);
  useEffect(() => {
    // Headless acceptance hook for the native custom-select steps, which the
    // keyboard-only Playwright flow cannot drive reliably. Every call goes
    // through the same handlers/components the buttons use.
    (window as any).__boardWireActions = {
      // WT-3-02: the production controller path the subject inspector uses to
      // append a version (the inspector's AgentEditingBoundary needs the full
      // workbench shell, which this fixture does not mount).
      subjectAddVersion: (subjectId: string, assetId: string) => {
        const scope = subjects.state?.scope;
        if (!scope) return null;
        subjects.controller.updateVersion(subjectId, assetId, scope);
        return subjects.controller.addVersion(subjectId, scope);
      },
      setGeneration: (shotId: string, patch: Record<string, unknown>) => updateGenerationOptions(shotId, patch),
      installMockProvider: () => setMockProviderInstalled(true),
      openEditingGeneratePanel: (shotId: string) => {setSelectedNodeId(shotId); setEditingPanelShot(shotId);},
      refresh: () => refresh(),
      setInspectorTab: (tab: string) => setInspectorTab(tab === 'versions' ? 'versions' : 'settings'),
      clearSelection: () => setSelectedNodeId(null),
      updateShot: (shotId: string, patch: Record<string, unknown>, expectedRevision: number) => updateShot(shotId, patch as never, expectedRevision),
      externalUpdateShot: async (shotId: string, patch: Record<string, unknown>, expectedRevision: number) => {
        await session.current.run(boardShotUpdateIntent(shotId, expectedRevision, patch as never));
      },
      setPrimary: (edgeId: string, shotId: string) => setPrimaryInput(edgeId, shotId),
      detachInput: (entry: Record<string, unknown>, shotId: string) => detachInput(entry as never, shotId),
      changeRole: (edgeId: string, shotId: string, role: string) => {
        void runReference(referenceRoleRequest(edgeId, shotId, role as never), t('boardUi.notice.roleChanged'));
      },
    };
  }, [updateGenerationOptions, runReference, setPrimaryInput, detachInput, t]);
  const undoNotice = useCallback(async (actionId: string): Promise<boolean> => {
    const view = await session.current.history();
    if (!view?.undo || view.undo.actionId !== actionId) {setNotice(null); return false;}
    const outcome = await session.current.undo(view);
    setNotice(null);
    if (outcome.ok) await refresh();
    return outcome.ok;
  }, [refresh]);
  useEffect(() => {
    const key = async (event: KeyboardEvent): Promise<void> => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      const view = await session.current.history();
      if (!view) return;
      const outcome = event.shiftKey ? await session.current.redo(view as never) : await session.current.undo(view as never);
      if (outcome.ok) await refresh(); else setNotice({id: `error-${Date.now()}`, message: t('editUi.error.SEQUENCE_EDIT_HISTORY_CONFLICT')});
    };
    window.addEventListener('keydown', event => {void key(event);});
    return () => window.removeEventListener('keydown', () => {});
  }, [refresh, t]);
  const restore = useCallback(async (archivedId: string, name: string): Promise<void> => {
    if (!projection) return;
    const chain = projection.projection.films.find(film => film.id === activeFilmId) ?? projection.projection.films[0];
    const tail = chain?.items.at(-1)?.nodeId ?? activeFilmId;
    const kind = mount?.archived.find(item => item.id === archivedId)?.kind ?? 'node';
    if (tail || kind === 'node') await run(boardRestoreIntent([{kind, id: archivedId}]), t('boardUi.notice.restored', {name}));
  }, [projection, activeFilmId, run, t]);
  useEffect(() => {
    stateRef.current = {ready: Boolean(data), data, history, mount, selectedNodeId, notice, busy, reduced, openedNode,
      cards: projection?.nodes.map(node => ({id: node.id, kind: node.kind, name: node.name, subjectId: node.subjectId})) ?? [],
      films: projection?.projection.films.map(film => ({id: film.id, items: film.items.map(item => item.nodeId)})) ?? [],
      floating: projection?.projection.floatingNodeIds ?? [], positions: projection?.positions ?? {},
      timelineRevision: data?.timeline?.revision, syncRevision: mount?.syncRevision, inSync: mount?.inSync,
      subjects: mount?.subjects ?? [], bindings: mount?.bindings ?? [],
      subjectList: subjects.state?.list.items.map(subject => ({id: subject.id, name: subject.name, kind: subject.kind})) ?? [],
      subjectImages: subjects.state?.assets.map(asset => ({id: asset.id, projectId: asset.projectId ?? null, mimeType: asset.mimeType ?? null})) ?? [],
      assetCount: data?.assets?.length ?? 0,
      subjectGate: subjectGate.current,

      shots: (data?.shots ?? []).map((shot: Row) => ({id: shot.id, title: shot.title, prompt: shot.prompt,
        duration: shot.duration, aspectRatio: shot.aspectRatio, revision: shot.revision, selectedVersionId: shot.selectedVersionId})),
      jobs: data?.jobs ?? [],
      versions: (data?.versions ?? []).map((version: Row) => ({id: version.id, shotId: version.shotId, number: version.number})),
      clips: ((data?.timeline as Row | null)?.clips ?? []).map((clip: Row) => ({id: clip.id, trackId: clip.trackId,
        versionId: clip.versionId, sourceState: clip.sourceState, sequenceSource: clip.sequenceSource})),
      inputs: inputs ? {shotId: inputs.shotId, mode: inputs.mode, usedCount: inputs.usedCount, service: inputs.service?.providerId ?? null,
        entries: inputs.entries.map(entry => ({source: entry.source, status: entry.status, role: entry.role,
          edgeId: entry.edgeId, bindingId: entry.bindingId, subjectVersionNumber: entry.subjectVersionNumber,
          label: entry.label, reason: entry.reason ?? null, primary: entry.primary === true}))} : null,
      providers: providers.map(provider => ({id: provider.id, connectionId: provider.connectionId ?? null}))};
    (window as any).__boardWireState = stateRef.current;
  }, [data, history, mount, selectedNodeId, notice, busy, reduced, openedNode, projection, inputs, providers, subjects.state]);
  if (!projection) return <div className="board-fixture-loading">Loading…</div>;
  return <div className="board-fixture">
    <header className="board-fixture-head"><strong>Mioon · 画板</strong><span data-testid="fixture-format">格式 5</span>
      <span data-testid="fixture-sync" data-synced={mount?.inSync ? 'true' : 'false'}>{t(mount?.inSync ? 'boardUi.synced' : 'boardUi.outOfSync')}</span>
      <button type="button" data-testid="wire-tab-settings" onClick={() => setInspectorTab('settings')}>属性页</button>
      <button type="button" data-testid="wire-tab-versions" onClick={() => setInspectorTab('versions')}>版本页</button></header>
    <main className="board-fixture-board" data-testid="board-fixture-board">
      <BoardUiLive board={projection} activeFilmId={activeFilmId} history={history} mount={mount}
        selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} run={run} runReference={runReference}
        runSubject={runSubject} inputs={inputs}
        onUndoNotice={undoNotice} onDismissNotice={notice => setNotice(current => current?.id === notice.id ? null : current)}
        notice={notice} reduceMotion={reduced} busy={busy}
        onAssetDrop={(assetId, position) => {void dropAssetOnBoard(assetId, position);}} revealNodeId={revealNodeId}
        onAddPrevis={() => {void addPrevis();}} addingPrevis={busy}/>
    </main>
    <aside className="board-fixture-subject-library" data-testid="board-fixture-subject-library">
      <button type="button" data-testid="subject-import" onClick={() => subjectFile.current?.click()}>导入图片</button>
      <input ref={subjectFile} type="file" accept="image/png,image/jpeg,image/webp" style={{display: 'none'}}
        data-testid="subject-import-input"
        onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; if (file) void importSubjectImage(file);}}/>
      <WorkspaceVisibilityProvider visible>
        <SubjectLibrary subjects={subjects as never} assets={data?.assets ?? []} shots={data?.shots ?? []}
          dragToBoard onInspectSubject={() => {}} onShowTasks={() => {}}/>
      </WorkspaceVisibilityProvider>
    </aside>
    <aside className="board-fixture-inspector">
      <BoardInspector board={projection} activeFilmId={activeFilmId} mount={mount} selectedNodeId={selectedNodeId}
        versions={data?.versions ?? []} shots={data?.shots ?? []} nodes={data?.nodes ?? []} busy={busy}
        activeTab={inspectorTab}
        dialogueSubjects={{}}
        dialogueCueCount={((data?.timeline as Row | null)?.subtitles?.cues ?? [] as readonly Row[])
          .filter((cue: Row) => (cue.dialogueRef as Row | null | undefined)?.shotId === (selectedNodeId ?? '')).length}
        onDialogueApplied={() => {void refresh();}}
        rpc={(operation, input) => rpc(operation, input)}
        onUpdateShot={updateShot} onGenerateShot={generateShot}
        onSelectVersion={(nodeId, versionId) => {void run(boardVersionIntent(nodeId, versionId), t('boardUi.notice.version', {name: projection.nodes.find(node => node.id === nodeId)?.name ?? ''}));}}
        onDelete={nodeId => {void run(boardDeleteIntent(nodeId), t('boardUi.notice.deleted', {name: projection.nodes.find(node => node.id === nodeId)?.name ?? ''})); setSelectedNodeId(null);}}
        onOpenInEditing={nodeId => setOpenedNode(nodeId)}
        onRestore={(archivedId, name) => {void restore(archivedId, name);}}
        onSetBindingMode={setBindingMode} onDetachBinding={detachBinding} onRestoreBinding={restoreBinding}
        onDeleteSubjectCard={deleteCard}
        onUpdateNode={(nodeId, patch, expectedRevision) => {void run(boardNodeUpdateIntent(nodeId, expectedRevision, patch), t('projects.nodeSaved'));}}
        providers={providers} generationOptions={generationOptions[selectedNodeId!]}
        inputs={inputs} onGenerationOptionsChange={updateGenerationOptions} onInputRoleChange={changeInputRole as never}
        onInputDetach={detachInput} onInputPrimary={setPrimaryInput}/>
      <aside className="board-fixture-assets" data-testid="board-fixture-assets">
        {(data?.assets ?? []).map((asset: Row) => <div key={asset.id} className="asset-card"
          data-testid={`asset-card-${asset.id}`} draggable onDragStart={event => dragAsset(event.nativeEvent as unknown as Parameters<typeof dragAsset>[0], asset.id)}>
          <strong>{asset.name}</strong>
          <button type="button" data-testid={`asset-to-canvas-${asset.id}`}
            onClick={() => {void addAssetToBoard(assetKind(asset as never), asset);}}>添加到画板</button>
        </div>)}
      </aside>
      <section className="board-fixture-subjects" data-testid="board-fixture-subjects">
        <h4>{t('boardUi.inspector.subjects')}</h4>
        {(mount?.subjects ?? []).map(subject => <div key={subject.id} className="board-fixture-subject"
          data-testid={`fixture-subject-${subject.id}`} draggable
          onDragStart={event => dragSubject(event.nativeEvent, subject.id)}
          onClick={() => addSubjectCard(subject.id, {x: 620, y: 260})} role="button" tabIndex={0}
          onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); addSubjectCard(subject.id, {x: 620, y: 260});}}}>
          <span>{subject.name}</span><small>{t(`boardUi.kind.${subject.kind}`)}</small>
        </div>)}
      </section>
      <p className="board-fixture-opened" data-testid="board-fixture-opened">{openedNode ?? ''}</p>
    </aside>
    <div className="board-fixture-status" data-testid="board-fixture-status">
      <span data-testid="fixture-history-position">{history?.position ?? 0}</span>
      <span data-testid="fixture-history-undo">{history?.undo?.operation ?? ''}</span>
      <span data-testid="fixture-history-redo">{history?.redo?.operation ?? ''}</span>
      <span data-testid="fixture-at-earliest">{history?.atEarliest ? 'true' : 'false'}</span>
    </div>
    {editingPanelShot && (() => {
      const shot = data?.shots?.find((item: Row) => item.id === editingPanelShot);
      if (!shot) return null;
      const job = (data?.jobs ?? []).find((item: Row) => item.shotId === shot.id);
      return <div className="board-fixture-editing-generate">
        <GenerateInEditingPanel shot={shot} shotLabel={String(Math.max(0, (data?.shots ?? []).findIndex((item: Row) => item.id === shot.id)) + 1).padStart(2, '0')}
          inputs={inputs} subjectNames={{}} cueCount={0} jobStatus={job?.status ?? null} busy={busy}
          generateBlocked={Boolean(job && ['queued','running','submitted','pending'].includes(String(job.status)))
            || (data?.versions ?? []).some((version: Row) => version.shotId === shot.id)}
          resizable onSavePrompt={prompt => updateShot(shot.id, {prompt}, Number(shot.revision) || 1)}
          onResize={duration => updateShot(shot.id, {duration}, Number(shot.revision) || 1)}
          onGenerate={() => generateShot(shot.id)} onRevealOnBoard={() => {}} rpc={(operation, input) => rpc(operation, input)}
          onDialogueApplied={() => {void refresh();}}/>
      </div>;
    })()}
  </div>;
}

const store = createLanguageStore({systemLanguages: ['zh-Hans']});
createRoot(document.getElementById('root')!).render(<I18nProvider store={store}><Harness/></I18nProvider>);
