import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PrevisCamera, PrevisNodeRecord, PrevisProp, PrevisScene } from '@mioon/contracts';
import { PREVIS_LIMITS, PREVIS_THUMBNAIL_CARD, canonicalPrevisValue } from '@mioon/contracts';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { ArrowLeft, Box, Camera, LocateFixed, Monitor, Move, Orbit, PersonStanding, Redo2, Sun, Undo2 } from '@mioon/ui/components/workbench-icons';
import { message } from '../../../../packages/i18n/src/index.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { PREVIS_FOCAL_PRESETS, previsFrameRect, previsLookAt, normalizePrevisCamera } from './previs-camera.ts';
import type { PrevisRect } from './previs-camera.ts';
import { PREVIS_LIGHT_SELECTION, canRedoPrevisModel, canUndoPrevisModel, createPrevisEditorModel, editPrevisModel, previsElementCenter, previsFigureName, previsPropName, previsSceneCenter, redoPrevisModel, replacePrevisModel, selectPrevisElement, undoPrevisModel } from './previs-editor-state.ts';
import type { PrevisEditorModel, PrevisSelection, PrevisTranslate } from './previs-editor-state.ts';
import { createPrevisSaver } from './previs-save.ts';
import type { PrevisSaveState, PrevisSaver } from './previs-save.ts';
import { addPrevisFigure, addPrevisProp, holdPrevisProp, removePrevisElement, updatePrevisFigure, updatePrevisLight, updatePrevisProp } from './previs-scene.ts';
import type { PrevisFigurePatch, PrevisLightPatch, PrevisPropPatch } from './previs-scene.ts';
import { createPrevisViewport } from './previs-viewport.ts';
import type { PrevisViewMode, PrevisViewport } from './previs-viewport.ts';
import type { NativeCloseRegistry } from '../native-close-state.ts';
import PrevisOutline from './PrevisOutline.tsx';
import PrevisProperties from './PrevisProperties.tsx';
import './previs.css';

// The camera previs editor (09-12). It opens over the whole window, edits one
// previs node and saves its scene automatically. Rendering is local; nothing
// here calls a model or costs money. Keyframes and export come with C8c.
export interface PrevisEditorProps {
  node: PrevisNodeRecord;
  projectName: string;
  frame: { width: number; height: number; aspect: number; ratio: string };
  readOnly: boolean;
  /** Scene revision of the card thumbnail the canvas already has, 0 for none. */
  thumbnailRevision: number;
  rpc: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  requestId: () => string;
  onThumbnail: (nodeId: string, sceneRevision: number, dataBase64: string) => void;
  onClose: () => void;
  /** Closing the window asks first while a save is waiting, running or refused. */
  closeRegistry?: NativeCloseRegistry;
}
const THUMBNAIL_DELAY_MS = 1200, LEAVE_WAIT_MS = 8000;
const STATUS_KEYS = { saved: 'previs.save.saved', pending: 'previs.save.pending', saving: 'previs.save.saving', retrying: 'previs.save.retrying', conflict: 'previs.save.conflict', failed: 'previs.save.failed', readOnly: 'previs.save.readOnly' } as const;
const same = (a: unknown, b: unknown): boolean => canonicalPrevisValue(a) === canonicalPrevisValue(b);
const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]'));
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);

export default function PrevisEditor({ node, projectName, frame, readOnly, thumbnailRevision, rpc, requestId, onThumbnail, onClose, closeRegistry }: PrevisEditorProps): React.ReactElement {
  const { t, formatNumber } = useI18n(), translate = t as unknown as PrevisTranslate, confirm = useConfirmation();
  const [model, setModel] = useState<PrevisEditorModel>(() => createPrevisEditorModel(node.scene));
  const [mode, setMode] = useState<PrevisViewMode>('orbit');
  const [webgl, setWebgl] = useState<'pending' | 'ready' | 'unavailable' | 'lost'>('pending');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [leaving, setLeaving] = useState(false);
  const calls = useRef({ rpc, requestId, onThumbnail, onClose });
  calls.current = { rpc, requestId, onThumbnail, onClose };
  const modelRef = useRef(model);
  modelRef.current = model;
  const saver = useRef<PrevisSaver | null>(null);
  const [save, setSave] = useState<PrevisSaveState>(() => ({ status: readOnly ? 'readOnly' : 'saved', node, conflict: null, errorCode: null }));
  if (!saver.current) saver.current = createPrevisSaver({ node, readOnly, rpc: (operation, input) => calls.current.rpc(operation, input), requestId: () => calls.current.requestId(), onState: setSave });
  const host = useRef<HTMLDivElement | null>(null), overlay = useRef<HTMLDivElement | null>(null), viewport = useRef<PrevisViewport | null>(null);
  const thumbnail = useRef({ uploaded: thumbnailRevision, running: false });

  // ---- Edits ----
  const change = useCallback((transform: (scene: PrevisScene) => PrevisScene, key: string | null = null, select?: PrevisSelection): void => {
    setModel(current => readOnly ? current : editPrevisModel(current, transform(current.scene), { key, ...(select !== undefined ? { select } : {}) }));
  }, [readOnly]);
  const select = useCallback((selection: PrevisSelection): void => setModel(current => selectPrevisElement(current, selection)), []);
  const setCamera = useCallback((camera: PrevisCamera, key = 'camera'): void => {
    const next = normalizePrevisCamera(camera);
    // A read-only scene can still be looked around; the view is just not saved.
    setModel(current => same(current.scene.camera, next) ? current : readOnly ? { ...current, scene: { ...current.scene, camera: next } } : editPrevisModel(current, { ...current.scene, camera: next }, { key }));
  }, [readOnly]);
  const figure = useCallback((id: string, patch: PrevisFigurePatch, key?: string) => change(scene => updatePrevisFigure(scene, id, patch), key ?? null), [change]);
  const prop = useCallback((id: string, patch: PrevisPropPatch, key?: string) => change(scene => updatePrevisProp(scene, id, patch), key ?? null), [change]);
  const light = useCallback((patch: PrevisLightPatch, key?: string) => change(scene => updatePrevisLight(scene, patch), key ?? null), [change]);
  const hold = useCallback((figureId: string, propId: string | null, hand: 'left' | 'right') => change(scene => holdPrevisProp(scene, figureId, propId, hand)), [change]);
  const remove = useCallback((id: string) => change(scene => removePrevisElement(scene, id), null, null), [change]);
  const visible = useCallback((id: string, value: boolean) => {
    if (id === PREVIS_LIGHT_SELECTION) light({ visible: value });
    else if (modelRef.current.scene.figures.some(item => item.id === id)) figure(id, { visible: value });
    else prop(id, { visible: value });
  }, [figure, light, prop]);
  const addFigure = useCallback(() => { const added = addPrevisFigure(modelRef.current.scene); if (added.id) change(() => added.scene, null, added.id); }, [change]);
  const addProp = useCallback((kind: PrevisProp['kind']) => { const added = addPrevisProp(modelRef.current.scene, kind); if (added.id) change(() => added.scene, null, added.id); }, [change]);
  const undo = useCallback(() => { if (!readOnly) setModel(undoPrevisModel); }, [readOnly]);
  const redo = useCallback(() => { if (!readOnly) setModel(redoPrevisModel); }, [readOnly]);
  const focus = useCallback(() => {
    const scene = modelRef.current.scene, target = previsElementCenter(scene, modelRef.current.selection) ?? previsSceneCenter(scene);
    setCamera({ ...scene.camera, ...previsLookAt(scene.camera.position, target) }, 'camera:focus');
  }, [setCamera]);

  // ---- Saving ----
  useEffect(() => { saver.current!.schedule(model.scene); }, [model.scene]);
  // Another window or tool saved the node: show it when nothing here waits to be saved.
  useEffect(() => { if (saver.current!.external(node) === 'reloaded') setModel(current => replacePrevisModel(current, node.scene)); }, [node]);
  // Reset rather than close on cleanup: StrictMode remounts effects. A real
  // unmount still sends what is waiting, then stops retrying.
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (closing.current) { clearTimeout(closing.current); closing.current = null; }
    const current = saver.current!;
    return () => { void current.flush(); closing.current = setTimeout(() => current.close(), 0); };
  }, []);
  // Window close admission sees only whether this editor has unsaved or uncertain work.
  const closeSource = useRef<{ registration: ReturnType<NativeCloseRegistry['register']> | null; version: number; flags: string }>({ registration: null, version: 0, flags: '' });
  const closeFlags = { dirty: !readOnly && !same(model.scene, save.node.scene), busy: save.status === 'saving' || save.status === 'retrying', blocked: save.status === 'retrying' };
  const publishClose = (force = false): void => {
    const source = closeSource.current, flags = JSON.stringify(closeFlags);
    if (!source.registration || (!force && flags === source.flags)) return;
    source.flags = flags;
    source.registration.update({ ...closeFlags, version: ++source.version });
  };
  useLayoutEffect(() => {
    const registration = closeRegistry?.register('previs-editor') ?? null;
    closeSource.current.registration = registration;
    publishClose(true);
    return () => { if (closeSource.current.registration === registration) closeSource.current.registration = null; registration?.release(); };
  }, [closeRegistry]);
  useLayoutEffect(() => { publishClose(); });
  const uploadThumbnail = useCallback(async (): Promise<void> => {
    const state = saver.current!.state(), view = viewport.current, revision = state.node.sceneRevision;
    if (readOnly || !view || thumbnail.current.running || state.status !== 'saved' || revision <= thumbnail.current.uploaded || !same(modelRef.current.scene, state.node.scene)) return;
    thumbnail.current.running = true;
    try {
      const shot = await view.capture(PREVIS_LIMITS.thumbnailEdge, PREVIS_LIMITS.thumbnailBytes, 'wide');
      if (!shot || saver.current!.state().node.sceneRevision !== revision) return;
      await calls.current.rpc('previs.thumbnail.set', { projectId: state.node.projectId, nodeId: state.node.id, slot: PREVIS_THUMBNAIL_CARD, sceneRevision: revision, dataBase64: shot.dataBase64 });
      thumbnail.current.uploaded = Math.max(thumbnail.current.uploaded, revision);
      calls.current.onThumbnail(state.node.id, revision, shot.dataBase64);
    } catch { /* A stale or refused thumbnail is a cache miss; the next save renders another. */ }
    finally { thumbnail.current.running = false; }
  }, [readOnly]);
  useEffect(() => {
    if (readOnly || webgl !== 'ready' || save.status !== 'saved' || save.node.sceneRevision <= thumbnail.current.uploaded) return;
    const timer = setTimeout(() => { if (viewport.current?.busy()) return; void uploadThumbnail(); }, THUMBNAIL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [readOnly, webgl, save.status, save.node.sceneRevision, model.scene, uploadThumbnail]);
  const leave = useCallback(async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    try {
      if (!readOnly) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([saver.current!.flush(), new Promise(resolve => { timer = setTimeout(resolve, LEAVE_WAIT_MS); })]);
        if (timer) clearTimeout(timer);
        if (!same(modelRef.current.scene, saver.current!.state().node.scene)) {
          if (!await confirm(message('previs.leave.confirm'))) return;
        } else await Promise.race([uploadThumbnail(), new Promise(resolve => setTimeout(resolve, 3000))]);
      }
      calls.current.onClose();
    } finally { setLeaving(false); }
  }, [confirm, leaving, readOnly, uploadThumbnail]);

  // ---- Viewport ----
  useLayoutEffect(() => {
    if (!host.current || !overlay.current) return;
    const created = createPrevisViewport(host.current, overlay.current, {
      select: selection => select(selection),
      move: (id, position, final) => { const current = modelRef.current.scene; if (current.figures.some(item => item.id === id)) figure(id, { position }, `drag:${id}`); else prop(id, { position }, `drag:${id}`); void final; },
      camera: camera => setCamera(camera),
      lost: value => setWebgl(value ? 'lost' : 'ready'),
    });
    viewport.current = created;
    setWebgl(created ? 'ready' : 'unavailable');
    return () => { created?.dispose(); viewport.current = null; };
  }, [figure, prop, select, setCamera]);
  useLayoutEffect(() => { viewport.current?.update({ scene: model.scene, selection: model.selection, mode, readOnly, aspect: frame.aspect }); });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = (): void => setSize(current => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ---- Focus: into the 3D view on open (the canvas returns it on close), Tab stays inside ----
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { host.current?.focus({ preventScroll: true }); }, []);
  const trapTab = (event: React.KeyboardEvent): boolean => {
    if (event.key !== 'Tab' || !root.current) return false;
    const items = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(item => item.getClientRects().length > 0 && !item.closest('[hidden], [inert]'));
    if (!items.length) return false;
    const first = items[0]!, last = items[items.length - 1]!, active = document.activeElement;
    if (event.shiftKey ? active === first || !root.current.contains(active) : active === last || !root.current.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return true;
    }
    return false;
  };
  // ---- Keyboard: undo, redo, delete and deselect; nothing reaches the canvas below ----
  const onKeyDown = (event: React.KeyboardEvent): void => {
    event.stopPropagation();
    if (trapTab(event) || event.key === 'Tab') return;
    if (typing(event.target) || event.nativeEvent.isComposing) return;
    const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
    if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (command && key === 'y') { event.preventDefault(); redo(); return; }
    if (command) return;
    const selection = modelRef.current.selection;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection && selection !== PREVIS_LIGHT_SELECTION) { event.preventDefault(); remove(selection); return; }
    if (event.key === 'Escape' && selection) { event.preventDefault(); select(null); }
  };

  const scene = model.scene, camera = scene.camera, status = save.status;
  const rect: PrevisRect | null = size.width && size.height ? previsFrameRect(size.width, size.height, frame.aspect) : null;
  const focal = Math.round(camera.focalLength), label = node.label || save.node.label || t('previs.node.defaultLabel');
  const held = useMemo(() => new Set(scene.figures.flatMap(item => item.held ? [item.held.propId] : [])), [scene.figures]);
  const shortcut = mac ? '⌘Z' : 'Ctrl+Z', viewable = webgl !== 'unavailable' && webgl !== 'lost';
  return <div className="previs-editor" ref={root} role="dialog" aria-modal="true" aria-label={t('previs.editor.label')} data-testid="previs-editor" data-read-only={readOnly || undefined} onKeyDown={onKeyDown} onKeyUp={event => event.stopPropagation()}>
    <header className="previs-editor-topbar">
      <WorkbenchButton variant="secondary" className="previs-back" data-testid="previs-back" disabled={leaving} onClick={() => { void leave(); }}><ArrowLeft size={14} aria-hidden="true" />{t('previs.editor.back')}</WorkbenchButton>
      <span className="previs-topbar-divider" aria-hidden="true" />
      <span className="previs-editor-title"><span className="previs-title-icon"><Box size={13} aria-hidden="true" /></span><strong title={label}>{label}</strong><span className="previs-editor-project" title={projectName}>{projectName}</span></span>
      <span className="previs-topbar-spacer" />
      <button type="button" className="previs-icon-button" data-testid="previs-undo" aria-label={t('previs.editor.undo')} title={t('previs.editor.undo')} disabled={readOnly || !canUndoPrevisModel(model)} onClick={undo}><Undo2 size={15} aria-hidden="true" /></button>
      <button type="button" className="previs-icon-button" data-testid="previs-redo" aria-label={t('previs.editor.redo')} title={t('previs.editor.redo')} disabled={readOnly || !canRedoPrevisModel(model)} onClick={redo}><Redo2 size={15} aria-hidden="true" /></button>
      <span className="previs-save-status" role="status" data-status={status} data-testid="previs-save-status"><span className="previs-saved-dot" aria-hidden="true" />{t(STATUS_KEYS[status])}</span>
      <span className="previs-local-chip"><Monitor size={12} aria-hidden="true" />{t('previs.editor.local')}</span>
    </header>
    {(status === 'conflict' || status === 'failed' || readOnly) && <div className="previs-banner" role="alert" data-tone={readOnly ? 'neutral' : 'warning'} data-testid="previs-banner">
      {readOnly ? <span>{t('previs.readOnly.body')}</span> : status === 'conflict' ? <><span>{t('previs.conflict.body')}</span>
        <WorkbenchButton variant="secondary" size="compact" data-testid="previs-conflict-reload" onClick={() => { const latest = saver.current!.reload(); if (latest) setModel(current => replacePrevisModel(current, latest.scene)); }}>{t('previs.conflict.reload')}</WorkbenchButton>
        <WorkbenchButton variant="secondary" size="compact" data-testid="previs-conflict-overwrite" onClick={() => { void saver.current!.overwrite(); }}>{t('previs.conflict.overwrite')}</WorkbenchButton></>
        : <><span>{t('previs.failed.body', { code: save.errorCode ?? 'PREVIS_SAVE_FAILED' })}</span><WorkbenchButton variant="secondary" size="compact" data-testid="previs-retry" onClick={() => { void saver.current!.retry(); }}>{t('previs.failed.retry')}</WorkbenchButton></>}
    </div>}
    <div className="previs-editor-body">
      <PrevisOutline scene={scene} selection={model.selection} readOnly={readOnly} onSelect={select} onVisible={visible} onAddFigure={addFigure} onAddProp={addProp} />
      <div className="previs-stage">
        <div className="previs-viewport dark" ref={host} tabIndex={0} aria-label={t('previs.view.label')} data-testid="previs-viewport" data-mode={mode}>
          <div className="previs-overlay" ref={overlay} hidden={!viewable}>
            {rect && <div className="previs-frame" data-testid="previs-frame" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
              <span className="previs-frame-label"><strong>{frame.ratio}</strong>{t('previs.view.frame', { focal, width: frame.width, height: frame.height })}</span></div>}
            <svg className="previs-light-line" aria-hidden="true"><line data-previs-light-line="" /></svg>
            <div className="previs-selection" data-previs-selection="" hidden aria-hidden="true"><i /><i /><i /><i /></div>
            {scene.figures.map(item => <button type="button" key={item.id} data-previs-anchor={item.id} className="previs-anchor previs-anchor-figure" data-selected={model.selection === item.id || undefined} onClick={() => select(item.id)}><PersonStanding size={11} aria-hidden="true" />{previsFigureName(item, translate)}</button>)}
            {scene.props.filter(item => !held.has(item.id)).map(item => <button type="button" key={item.id} data-previs-anchor={item.id} className="previs-anchor previs-anchor-prop" data-selected={model.selection === item.id || undefined} onClick={() => select(item.id)}>{previsPropName(scene, item, translate)}</button>)}
            <button type="button" data-previs-anchor={PREVIS_LIGHT_SELECTION} className="previs-anchor previs-anchor-light" data-selected={model.selection === PREVIS_LIGHT_SELECTION || undefined} onClick={() => select(PREVIS_LIGHT_SELECTION)}><span className="previs-light-icon"><Sun size={13} aria-hidden="true" /></span>{t('previs.light.name')}</button>
          </div>
          {viewable && <><div className="previs-view-toolbar">
            <div className="previs-segments previs-mode" role="group" aria-label={t('previs.view.mode')}>
              <button type="button" className="previs-segment" aria-pressed={mode === 'orbit'} data-testid="previs-mode-orbit" onClick={() => setMode('orbit')}><Orbit size={13} aria-hidden="true" />{t('previs.view.orbit')}</button>
              <button type="button" className="previs-segment" aria-pressed={mode === 'free'} data-testid="previs-mode-free" onClick={() => setMode('free')}><Move size={13} aria-hidden="true" />{t('previs.view.free')}</button>
            </div>
            <button type="button" className="previs-icon-button previs-tool" data-testid="previs-focus" aria-label={t('previs.view.focus')} title={t('previs.view.focus')} onClick={focus}><LocateFixed size={14} aria-hidden="true" /></button>
          </div>
          <div className="previs-camera-chip" data-testid="previs-camera-chip"><Camera size={13} aria-hidden="true" />{t('previs.view.cameraChip', { height: formatNumber(camera.position[1], { minimumFractionDigits: 2, maximumFractionDigits: 2 }), pitch: Math.round(camera.pitch) })}</div>
          <div className="previs-hints" aria-hidden="true">
            <kbd>{t('previs.key.wasd')}</kbd><span>{t('previs.view.hintMove')}</span><i>·</i><kbd>{t('previs.key.space')}</kbd><span>{t('previs.view.hintUp')}</span><i>·</i>
            <kbd>{t('previs.key.shift')}</kbd><span>{t('previs.view.hintDown')}</span><i>·</i><kbd>{t('previs.key.wheel')}</kbd><span>{t('previs.view.hintFocal')}</span></div></>}
          {!viewable && <div className="previs-webgl" role="alert" data-testid="previs-webgl"><strong>{t('previs.webgl.title')}</strong><p>{t('previs.webgl.body')}</p></div>}
        </div>
        <div className="previs-focal-bar">
          <span className="previs-focal-title">{t('previs.focal.title')}</span><small>{t('previs.focal.current')}</small>
          <div className="previs-segments" role="group" aria-label={t('previs.focal.title')} data-testid="previs-focal">
            {PREVIS_FOCAL_PRESETS.map(value => <button type="button" key={value} className="previs-segment" aria-pressed={Math.abs(camera.focalLength - value) < 0.5} aria-label={t('previs.focal.preset', { focal: value })} data-testid={`previs-focal-${value}`} onClick={() => setCamera({ ...camera, focalLength: value }, 'camera:focal-preset')}>{value}</button>)}
          </div>
          <small>{t('previs.unit.millimetre')}</small>
          {!PREVIS_FOCAL_PRESETS.some(value => Math.abs(camera.focalLength - value) < 0.5) && <output className="previs-focal-value">{focal}</output>}
        </div>
      </div>
      <PrevisProperties scene={scene} selection={model.selection} readOnly={readOnly} shortcut={shortcut} onFigure={figure} onProp={prop} onLight={light} onCamera={setCamera} onHold={hold} onRemove={remove} />
    </div>
  </div>;
}
