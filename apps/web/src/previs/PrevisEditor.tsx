import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PrevisCamera, PrevisNodeRecord, PrevisProp, PrevisScene } from '@mioon/contracts';
import { PREVIS_LIMITS, PREVIS_THUMBNAIL_CARD, canonicalPrevisValue } from '@mioon/contracts';
import { WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { ArrowLeft, Box, Camera, CircleAlert, CircleCheck, LoaderCircle, LocateFixed, Monitor, Move, Orbit, PersonStanding, Redo2, Sun, Undo2, X } from '@mioon/ui/components/workbench-icons';
import { message } from '../../../../packages/i18n/src/index.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { previsFrameRect, previsLookAt, normalizePrevisCamera } from './previs-camera.ts';
import type { PrevisRect } from './previs-camera.ts';
import { PREVIS_LIGHT_SELECTION, canRedoPrevisModel, canUndoPrevisModel, createPrevisEditorModel, editPrevisModel, previsElementCenter, previsFigureName, previsPropName, previsSceneCenter, recordPrevisModelExport, redoPrevisModel, replacePrevisModel, selectPrevisElement, undoPrevisModel } from './previs-editor-state.ts';
import { addPrevisKeyframe, jumpToPrevisKeyframe, movePrevisKeyframe, previsKeyframeContentKey, previsKeyframeLabel, previsKeyframeName, removePrevisKeyframe, renamePrevisKeyframe } from './previs-keyframes.ts';
import { PREVIS_FRAME_ISSUE_KEYS, previsConnectedShots, previsFrameIssue, previsKeyframeUses, previsShotNumber } from './previs-output.ts';
import type { PrevisEdgeView, PrevisFrameOutcome, PrevisFrameRequest, PrevisFrameRole, PrevisFrameUndo, PrevisImportOutcome, PrevisImportRequest, PrevisShotView, PrevisUndoOutcome } from './previs-output.ts';
import PrevisKeyframes from './PrevisKeyframes.tsx';
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
  /** The project's shots and canvas links, for setting keyframes as shot frames. */
  shots: readonly PrevisShotView[];
  edges: readonly PrevisEdgeView[];
  /** Adds an exported picture to the asset library (or finds the identical one). */
  onImport: (request: PrevisImportRequest) => Promise<PrevisImportOutcome>;
  onSetFrame: (request: PrevisFrameRequest) => Promise<PrevisFrameOutcome>;
  /** Undoes a set frame; `scene` is the editor's scene, which knows every image exported so far. */
  onUndoFrame: (undo: PrevisFrameUndo, scene: PrevisScene) => Promise<PrevisUndoOutcome>;
  /** Closing the window asks first while a save is waiting, running or refused. */
  closeRegistry?: NativeCloseRegistry;
}
const THUMBNAIL_DELAY_MS = 1200, LEAVE_WAIT_MS = 8000, KEYFRAME_THUMB_DELAY_MS = 450, IMPORT_LIMIT_BYTES = 30 * 1024 * 1024;
/** A set frame that can be undone, with the shot number it was set on. */
interface FrameUndo { readonly value: PrevisFrameUndo; readonly number: string }
interface EditorToast { readonly id: number; readonly tone: 'progress' | 'success' | 'warning' | 'error'; readonly title: string; readonly detail?: string; readonly undo?: FrameUndo }
interface KeyframeThumbnail { readonly key: string; readonly url: string; readonly base64: string }
const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> => new Promise(resolve => canvas.toBlob(resolve, type, quality));
async function encodeBlob(blob: Blob): Promise<{ base64: string; sha256: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { base64: btoa(binary), sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}
/** A JPEG of the canvas no larger than the thumbnail cache allows. */
async function encodeJpeg(canvas: HTMLCanvasElement, maxBytes: number): Promise<{ blob: Blob; base64: string } | null> {
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await canvasBlob(canvas, 'image/jpeg', quality);
    if (blob && blob.size <= maxBytes) return { blob, base64: (await encodeBlob(blob)).base64 };
  }
  return null;
}
const exportName = (node: string, label: string, name: string): string => `${node} · ${label} ${name}`.replace(/[\u0000-\u001f\u007f/\\]/gu, ' ').slice(0, 190).trim() + '.png';
const STATUS_KEYS = { saved: 'previs.save.saved', pending: 'previs.save.pending', saving: 'previs.save.saving', retrying: 'previs.save.retrying', conflict: 'previs.save.conflict', failed: 'previs.save.failed', readOnly: 'previs.save.readOnly' } as const;
const same = (a: unknown, b: unknown): boolean => canonicalPrevisValue(a) === canonicalPrevisValue(b);
const typing = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]'));
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);

export default function PrevisEditor({ node, projectName, frame, readOnly, thumbnailRevision, rpc, requestId, onThumbnail, onClose, closeRegistry, shots, edges, onImport, onSetFrame, onUndoFrame }: PrevisEditorProps): React.ReactElement {
  const { t, formatNumber } = useI18n(), translate = t as unknown as PrevisTranslate, confirm = useConfirmation();
  const [model, setModel] = useState<PrevisEditorModel>(() => createPrevisEditorModel(node.scene));
  const [mode, setMode] = useState<PrevisViewMode>('orbit');
  const [webgl, setWebgl] = useState<'pending' | 'ready' | 'unavailable' | 'lost'>('pending');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [leaving, setLeaving] = useState(false);
  const calls = useRef({ rpc, requestId, onThumbnail, onClose, onImport, onSetFrame, onUndoFrame });
  calls.current = { rpc, requestId, onThumbnail, onClose, onImport, onSetFrame, onUndoFrame };
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
  // ---- Keyframes ----
  // Every keyframe ID this editor has shown, so a deleted keyframe's ID (and its cached picture) is not handed to a new one.
  const seenKeyframes = useRef(new Set<string>());
  for (const item of model.scene.keyframes) seenKeyframes.current.add(item.id);
  const recordKeyframe = useCallback(() => { const added = addPrevisKeyframe(modelRef.current.scene, undefined, [...seenKeyframes.current]); if (added.id) change(() => added.scene); }, [change]);
  // Jumping only moves the camera, so a restored copy can still look through keyframes.
  const jumpKeyframe = useCallback((id: string) => setModel(current => {
    const next = jumpToPrevisKeyframe(current.scene, id);
    return next === current.scene ? current : readOnly ? { ...current, scene: next } : editPrevisModel(current, next, { key: 'camera:jump' });
  }), [readOnly]);
  const renameKeyframe = useCallback((id: string, name: string) => change(scene => renamePrevisKeyframe(scene, id, name)), [change]);
  const moveKeyframe = useCallback((id: string, index: number) => change(scene => movePrevisKeyframe(scene, id, index)), [change]);
  const removeKeyframe = useCallback((id: string) => change(scene => removePrevisKeyframe(scene, id)), [change]);
  const connected = useMemo(() => previsConnectedShots(node.id, shots, edges), [node.id, shots, edges]);
  const others = useMemo(() => [...shots].filter(shot => !connected.includes(shot)).sort((a, b) => a.orderIndex - b.orderIndex), [shots, connected]);
  const uses = useMemo(() => previsKeyframeUses(model.scene, shots), [model.scene, shots]);
  const frameIssue = useCallback((shot: PrevisShotView, role: PrevisFrameRole) => previsFrameIssue({ shot, role, ratio: frame.ratio, edges }), [frame.ratio, edges]);
  // ---- Toasts: export and frame results, with undo for a set frame ----
  const [toast, setToast] = useState<EditorToast | null>(null), toastSerial = useRef(0);
  const showToast = useCallback((value: Omit<EditorToast, 'id'>): void => { setToast({ ...value, id: ++toastSerial.current }); }, []);
  useEffect(() => {
    if (!toast || toast.tone === 'progress') return;
    const timer = setTimeout(() => setToast(current => current?.id === toast.id ? null : current), toast.undo ? 12000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

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
  // ---- Keyframe pictures: local thumbnails for the strip, uploaded for the canvas ----
  const [keyframeThumbs, setKeyframeThumbs] = useState<Readonly<Record<string, KeyframeThumbnail>>>({});
  const keyframeThumbsRef = useRef(keyframeThumbs);
  keyframeThumbsRef.current = keyframeThumbs;
  const [thumbRetry, setThumbRetry] = useState(0);
  const thumbSize = useMemo(() => frame.aspect >= 1 ? { width: PREVIS_LIMITS.thumbnailEdge, height: Math.max(1, Math.round(PREVIS_LIMITS.thumbnailEdge / frame.aspect)) }
    : { width: Math.max(1, Math.round(PREVIS_LIMITS.thumbnailEdge * frame.aspect)), height: PREVIS_LIMITS.thumbnailEdge }, [frame.aspect]);
  useEffect(() => {
    if (webgl !== 'ready') return;
    const scene = model.scene, current = keyframeThumbsRef.current;
    const stale = scene.keyframes.filter(item => current[item.id]?.key !== previsKeyframeContentKey(scene, item));
    const gone = Object.keys(current).filter(id => !scene.keyframes.some(item => item.id === id));
    if (!stale.length && !gone.length) return;
    let cancelled = false;
    const timer = setTimeout(() => { void (async () => {
      const view = viewport.current;
      if (!view) return;
      if (view.busy()) { setThumbRetry(value => value + 1); return; }
      const canvases = stale.length ? view.renderViews(stale.map(item => ({ camera: item.camera, ...thumbSize }))) : [];
      if (!canvases) return;
      const encoded = await Promise.all(canvases.map(canvas => encodeJpeg(canvas, PREVIS_LIMITS.thumbnailBytes)));
      if (cancelled) return;
      const next: Record<string, KeyframeThumbnail> = { ...keyframeThumbsRef.current };
      for (const id of gone) { if (next[id]) URL.revokeObjectURL(next[id]!.url); delete next[id]; }
      stale.forEach((item, index) => {
        const value = encoded[index];
        if (!value) return;
        if (next[item.id]) URL.revokeObjectURL(next[item.id]!.url);
        next[item.id] = { key: previsKeyframeContentKey(scene, item), url: URL.createObjectURL(value.blob), base64: value.base64 };
      });
      setKeyframeThumbs(next);
    })(); }, KEYFRAME_THUMB_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [webgl, model.scene, thumbSize, thumbRetry]);
  useEffect(() => () => { for (const value of Object.values(keyframeThumbsRef.current)) URL.revokeObjectURL(value.url); }, []);
  // A keyframe picture goes to the cache once its scene is saved and only when it changed.
  const uploadedKeyframes = useRef(new Map<string, string>());
  useEffect(() => {
    // Saving a scene without a keyframe drops its cached picture, so one brought back by undo is uploaded again.
    for (const id of [...uploadedKeyframes.current.keys()]) if (!save.node.scene.keyframes.some(item => item.id === id)) uploadedKeyframes.current.delete(id);
    if (readOnly || webgl !== 'ready' || save.status !== 'saved' || !same(model.scene, save.node.scene)) return;
    const saved = save.node, pending = saved.scene.keyframes.filter(item => {
      const local = keyframeThumbs[item.id];
      return local && local.key === previsKeyframeContentKey(saved.scene, item) && uploadedKeyframes.current.get(item.id) !== local.key;
    });
    if (!pending.length) return;
    let cancelled = false;
    const timer = setTimeout(() => { void (async () => {
      for (const item of pending) {
        const local = keyframeThumbsRef.current[item.id];
        if (cancelled || !local || saver.current!.state().node.sceneRevision !== saved.sceneRevision) return;
        try {
          await calls.current.rpc('previs.thumbnail.set', { projectId: saved.projectId, nodeId: saved.id, slot: item.id, sceneRevision: saved.sceneRevision, dataBase64: local.base64 });
          uploadedKeyframes.current.set(item.id, local.key);
        } catch { return; /* A stale or refused thumbnail is a cache miss; the next save tries again. */ }
      }
    })(); }, THUMBNAIL_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [readOnly, webgl, save.status, save.node, model.scene, keyframeThumbs]);
  // ---- Export a keyframe picture, optionally as a shot's first or last frame ----
  const exporting = useRef<string | null>(null), exportRun = useRef<Promise<void> | null>(null), [busyKeyframe, setBusyKeyframe] = useState<string | null>(null);
  const exportKeyframe = useCallback(async (id: string, target: { shot: PrevisShotView; role: PrevisFrameRole } | null): Promise<void> => {
    const view = viewport.current, scene = modelRef.current.scene, index = scene.keyframes.findIndex(item => item.id === id), keyframe = scene.keyframes[index];
    if (readOnly || !view || !keyframe || exporting.current) return;
    exporting.current = id; setBusyKeyframe(id);
    const label = previsKeyframeLabel(index), saved = saver.current!.state().node;
    showToast({ tone: 'progress', title: t('previs.export.running', { label }) });
    try {
      const canvas = view.renderViews([{ camera: keyframe.camera, width: frame.width, height: frame.height }])?.[0];
      const blob = canvas ? await canvasBlob(canvas, 'image/png') : null;
      if (!blob) { showToast({ tone: 'error', title: t('previs.export.failed', { label }) }); return; }
      if (blob.size > IMPORT_LIMIT_BYTES) { showToast({ tone: 'error', title: t('previs.export.failed', { label }), detail: t('previs.export.tooLarge') }); return; }
      const encoded = await encodeBlob(blob);
      const imported = await calls.current.onImport({ projectId: saved.projectId, name: exportName(saved.label || t('previs.node.defaultLabel'), label, previsKeyframeName(keyframe, translate)),
        dataBase64: encoded.base64, sha256: encoded.sha256, width: frame.width, height: frame.height });
      if (imported.status !== 'imported') { showToast({ tone: imported.status === 'unknown' ? 'warning' : 'error', title: t(imported.status === 'unknown' ? 'previs.export.unknown' : 'previs.export.failed', { label }) }); return; }
      setModel(current => recordPrevisModelExport(current, id, imported.assetId));
      const done = t('previs.export.done', { label, width: frame.width, height: frame.height });
      if (!target) { showToast({ tone: 'success', title: done, detail: t('previs.export.library') }); return; }
      const number = previsShotNumber(target.shot);
      const outcome = await calls.current.onSetFrame({ projectId: saved.projectId, nodeId: saved.id, shotId: target.shot.id, role: target.role, assetId: imported.assetId });
      if (outcome.status === 'applied') showToast({ tone: 'success', title: done, detail: t(target.role === 'first' ? 'previs.frame.doneFirst' : 'previs.frame.doneLast', { number }), undo: { value: outcome.undo, number } });
      else showToast({ tone: outcome.status === 'refused' ? 'warning' : 'error', title: t(target.role === 'first' ? 'previs.frame.failedFirst' : 'previs.frame.failedLast', { number }),
        detail: outcome.status === 'refused' ? t(PREVIS_FRAME_ISSUE_KEYS[outcome.reason] as never) : t('previs.export.library') });
    } catch { showToast({ tone: 'error', title: t('previs.export.failed', { label }) }); }
    finally { exporting.current = null; setBusyKeyframe(null); }
  }, [readOnly, frame.width, frame.height, showToast, t, translate]);
  // One export at a time; leaving waits for it.
  const startExport = (id: string, target: { shot: PrevisShotView; role: PrevisFrameRole } | null): void => { if (!exporting.current) exportRun.current = exportKeyframe(id, target); };
  const undoFrame = useCallback(async ({ value, number }: FrameUndo): Promise<void> => {
    setToast(null);
    const outcome = await calls.current.onUndoFrame(value, modelRef.current.scene);
    if (outcome.status === 'undone') showToast({ tone: 'success', title: t('previs.frame.undone', { number }) });
    else if (outcome.status === 'failed') showToast({ tone: 'error', title: t('previs.frame.undoBlocked', { number }) });
    else if (outcome.reason === 'changed') showToast({ tone: 'warning', title: t('previs.frame.undoFailed', { number }) });
    else showToast({ tone: 'warning', title: t('previs.frame.undoBlocked', { number }), detail: t(PREVIS_FRAME_ISSUE_KEYS[outcome.reason] as never) });
  }, [showToast, t]);
  const leave = useCallback(async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    try {
      if (!readOnly) {
        // An export under way records its image on the keyframe first, so that record is saved too.
        if (exporting.current && exportRun.current) {
          await Promise.race([exportRun.current, new Promise(resolve => setTimeout(resolve, LEAVE_WAIT_MS))]);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
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
    if (key === 'k' && !event.altKey && !event.shiftKey) { event.preventDefault(); if (!readOnly) recordKeyframe(); return; }
    const selection = modelRef.current.selection;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection && selection !== PREVIS_LIGHT_SELECTION) { event.preventDefault(); remove(selection); return; }
    if (event.key === 'Escape' && selection) { event.preventDefault(); select(null); }
  };

  const scene = model.scene, camera = scene.camera, status = save.status;
  const rect: PrevisRect | null = size.width && size.height ? previsFrameRect(size.width, size.height, frame.aspect) : null;
  const focal = Math.round(camera.focalLength), label = node.label || save.node.label || t('previs.node.defaultLabel');
  const held = useMemo(() => new Set(scene.figures.flatMap(item => item.held ? [item.held.propId] : [])), [scene.figures]);
  const keyframeUrls = useMemo(() => Object.fromEntries(Object.entries(keyframeThumbs).map(([id, value]) => [id, value.url])), [keyframeThumbs]);
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
        <div className="previs-view-area" data-toast={toast ? '' : undefined}>
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
        {/* Export and frame results sit at the foot of the view, in place of the hints, so the strip stays usable. */}
        <div className="previs-toast-region" role="status" aria-live="polite">
          {toast && <div className="previs-toast" data-tone={toast.tone} data-testid="previs-toast">
            {toast.tone === 'progress' ? <LoaderCircle size={16} className="previs-spin" aria-hidden="true" /> : toast.tone === 'success' ? <CircleCheck size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
            <div className="previs-toast-copy"><strong>{toast.title}</strong>{toast.detail && <p>{toast.detail}</p>}</div>
            {toast.undo && <WorkbenchButton variant="secondary" size="compact" data-testid="previs-toast-undo" onClick={() => { void undoFrame(toast.undo!); }}>{t('previs.frame.undo')}</WorkbenchButton>}
            {toast.tone !== 'progress' && <button type="button" className="previs-icon-button" aria-label={t('previs.toast.dismiss')} onClick={() => setToast(null)}><X size={14} aria-hidden="true" /></button>}
          </div>}
        </div>
        </div>
        <PrevisKeyframes scene={scene} thumbnails={keyframeUrls} uses={uses} connected={connected} others={others} readOnly={readOnly} busy={busyKeyframe !== null}
          exportIssue={readOnly ? t('previs.frame.issueReadOnly') : !viewable || webgl !== 'ready' ? t('previs.frame.issueView') : null} frameIssue={frameIssue}
          onRecord={recordKeyframe} onJump={jumpKeyframe} onRename={renameKeyframe} onMove={moveKeyframe} onRemove={removeKeyframe}
          onExport={id => startExport(id, null)} onSetFrame={(id, shot, role) => startExport(id, { shot, role })}
          camera={camera} onFocal={value => setCamera({ ...camera, focalLength: value }, 'camera:focal-preset')} aspect={frame.aspect} />
      </div>
      <PrevisProperties scene={scene} selection={model.selection} readOnly={readOnly} shortcut={shortcut} onFigure={figure} onProp={prop} onLight={light} onCamera={setCamera} onHold={hold} onRemove={remove} />
    </div>
  </div>;
}
