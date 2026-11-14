import {
  CANVAS_EDIT_LIMITS, canvasEditingResponses, createCanvasRequestId,
} from '../../../packages/contracts/src/canvas-editing.ts';
import type {
  CanvasArchiveListInput, CanvasArchivePreviewInput, CanvasEditBase, CanvasEditInput, CanvasEditResult,
  CanvasEditingOperation, CanvasEditingResponse, CanvasHistoryInput, CanvasTarget, CanvasTargetExpectation,
} from '../../../packages/contracts/src/canvas-editing.ts';
import {layoutCanvas} from '../../../packages/contracts/src/canvas-tidy-layout.ts';
import type {CanvasLayoutInput, CanvasLayoutMove} from '../../../packages/contracts/src/canvas-tidy-layout.ts';
import type {ContentStamp} from '../../../packages/contracts/src/project-file.ts';

export type CanvasEditRpc = (operation: CanvasEditingOperation, input: unknown) => Promise<unknown>;
export type CanvasArchiveItem = CanvasEditingResponse<'canvas.archive.list'>['items'][number];
type Page = CanvasEditingResponse<'canvas.archive.list'>;
type History = CanvasEditingResponse<'canvas.history.get'>;
type Preview = CanvasEditingResponse<'canvas.archive.preview'>;
type HistoryDirection = 'undo' | 'redo';
type WriteOperation = 'canvas.apply' | 'canvas.history.undo' | 'canvas.history.redo';
type Stamp = Pick<CanvasEditBase, 'contentSequence' | 'contentToken'>;
type Flight = {generation: number; projectId: string; dispatched: boolean};
type ArchiveReview = Pick<Preview, 'versions' | 'clips' | 'shotImpacts' | 'impactedShotCount'> & {count: number};
export type CanvasEditingNotice = {kind: 'restored'; count: number} | {kind: 'undone' | 'redone'};
type ArchiveState = {
  items: readonly CanvasArchiveItem[];
  count: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  canRestoreAll: boolean;
};
type CanvasEditToast = {kind: 'archive' | 'layout'; count: number; actionId: string};

export interface CanvasEditingContext {
  scope: string;
  projectId: string | null;
  enabled: boolean;
  writable: boolean;
  base: CanvasEditBase | undefined;
}

export interface CanvasEditingState {
  busy: boolean;
  history: History | null;
  review: ArchiveReview | null;
  archive: ArchiveState;
  toast: CanvasEditToast | null;
  canUndo: boolean;
  canRedo: boolean;
  canUndoToast: boolean;
  historyScope: string;
}

interface ControllerOptions {
  rpc: CanvasEditRpc;
  refresh: (projectId: string) => Promise<unknown>;
  isCurrent?: () => boolean;
  onError?: (error: unknown) => void;
  onNotice?: (notice: CanvasEditingNotice) => void;
  onArchived?: (targets: readonly CanvasTarget[]) => void;
  createNonce?: () => string;
  now?: () => number;
}

const blankArchive: ArchiveState = {items: [], count: 0, loading: false, error: null, hasMore: false, canRestoreAll: false};

export const canvasEditErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return 'NETWORK';
};

function error(code: string) {
  return Object.assign(new Error(code), {code, definitive: true});
}

const targetKey = ({kind, id}: CanvasTarget) => `${kind}:${id}`;
const toExpectation = ({kind, id, revision}: CanvasTargetExpectation): CanvasTargetExpectation => ({kind, id, revision});
const sameStamp = (a: Stamp | undefined, b: Stamp | undefined) => Boolean(a && b &&
  a.contentSequence === b.contentSequence && a.contentToken === b.contentToken);
const contentStamp = ({contentSequence, contentToken}: Stamp): ContentStamp => ({contentSequence, contentToken});
const conflict = (failure: unknown) => ['CANVAS_EDIT_CONFLICT', 'CANVAS_CONFIRMATION_REQUIRED',
  'CANVAS_UI_UNDO_CONFLICT', 'CANVAS_UI_REDO_CONFLICT'].includes(canvasEditErrorCode(failure));

function expectations<T extends CanvasTarget>(base: CanvasEditBase, targets: readonly T[]): (T & CanvasTargetExpectation)[] {
  if (targets.length > CANVAS_EDIT_LIMITS.targets) throw error('CANVAS_UI_COUNT_LIMIT');
  const revisions = new Map(base.targets.map(target => [targetKey(target), target.revision]));
  const keys = new Set<string>();
  return targets.map(target => {
    const key = targetKey(target), revision = revisions.get(key);
    if (revision === undefined || keys.has(key)) throw error('CANVAS_EDIT_CONFLICT');
    keys.add(key);
    return {...target, revision};
  });
}

async function read<T extends CanvasEditingOperation>(rpc: CanvasEditRpc, operation: T, input: {projectId: string}): Promise<CanvasEditingResponse<T>> {
  const parsed = canvasEditingResponses[operation].safeParse(await rpc(operation, input));
  if (!parsed.success ||
    (operation !== 'canvas.history.get' && (!('projectId' in parsed.data) || parsed.data.projectId !== input.projectId))) {
    throw error('BACKEND_PROTOCOL_ERROR');
  }
  return parsed.data as CanvasEditingResponse<T>;
}

function replyIsDefinitive(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null && 'definitive' in failure && failure.definitive === true &&
    canvasEditErrorCode(failure) !== 'BACKEND_PROTOCOL_ERROR';
}

/** A retry is a lookup of the original receipt or, if absent, the exact original write. */
async function write(rpc: CanvasEditRpc, operation: WriteOperation, input: CanvasEditInput | CanvasHistoryInput,
  canRetry: () => boolean): Promise<CanvasEditResult> {
  try {
    return await read(rpc, operation, input);
  } catch (failure) {
    if (replyIsDefinitive(failure)) throw failure;
    if (!canRetry()) throw error('CANVAS_REQUEST_OUTCOME_UNKNOWN');
  }
  try {
    return await read(rpc, operation, input);
  } catch (failure) {
    if (replyIsDefinitive(failure)) throw failure;
    throw error('CANVAS_REQUEST_OUTCOME_UNKNOWN');
  }
}

function appendArchivePage(previous: Page, page: Page): Page {
  if (!sameStamp(previous, page) || previous.total !== page.total) throw error('CANVAS_EDIT_CONFLICT');
  if (page.next && !page.items.length) throw error('BACKEND_PROTOCOL_ERROR');
  const items = [...previous.items, ...page.items];
  if (new Set(items.map(targetKey)).size !== items.length || items.length > page.total ||
    !page.next && items.length !== page.total || page.next && items.length >= page.total) {
    throw error('BACKEND_PROTOCOL_ERROR');
  }
  return {...page, items};
}

function validFirstPage(page: Page): Page {
  if (!page.next && page.total !== page.items.length || page.next && (!page.items.length || page.total <= page.items.length)) {
    throw error('BACKEND_PROTOCOL_ERROR');
  }
  if (new Set(page.items.map(targetKey)).size !== page.items.length) throw error('BACKEND_PROTOCOL_ERROR');
  return page;
}

export function createCanvasEditingController({rpc, refresh, isCurrent = () => true, onError = () => {}, onNotice = () => {}, onArchived = () => {},
  createNonce = () => globalThis.crypto.randomUUID(), now = Date.now}: ControllerOptions) {
  let context: CanvasEditingContext = {scope: '', projectId: null, enabled: false, writable: false, base: undefined};
  let generation = 0, historySerial = 0, archiveSerial = 0;
  let reviewing: Preview | null = null, page: Page | null = null, appliedStamp: Stamp | undefined;
  let inFlight: Flight | null = null;
  let state: CanvasEditingState = {
    busy: false, history: null, review: null, archive: blankArchive, toast: null,
    canUndo: false, canRedo: false, canUndoToast: false, historyScope: '',
  };
  const listeners = new Set<() => void>();
  function emit(patch: Partial<CanvasEditingState>) {
    const next = {...state, ...patch};
    const {history, toast} = next;
    const ready = context.enabled && context.writable && !next.busy && !next.review;
    const canUndo = Boolean(ready && history?.undo && !history.undoConflict);
    const canRedo = Boolean(ready && history?.redo && !history.redoConflict);
    state = {...next, canUndo, canRedo, canUndoToast: Boolean(canUndo && toast && history?.undo?.id === toast.actionId),
      historyScope: JSON.stringify([context.scope, history?.requestEpoch, history?.revision, history?.undo?.id, history?.redo?.id,
        history?.undoConflict, history?.redoConflict, history?.undoBlocked, history?.redoBlocked])};
    for (const listener of listeners) listener();
  }
  const owned = (flight: Flight) => generation === flight.generation && context.projectId === flight.projectId && isCurrent();
  const visible = (flight: Flight) => owned(flight) && context.enabled;
  const writable = (flight: Flight) => visible(flight) && context.writable;

  function setContext(next: CanvasEditingContext): void {
    if (context.scope !== next.scope || context.projectId !== next.projectId) {
      generation++;
      archiveSerial++;
      historySerial++;
      inFlight = reviewing = page = null;
      appliedStamp = undefined;
      context = next;
      emit({busy: false, history: null, archive: blankArchive, review: null, toast: null});
      return;
    }
    const changed = context.enabled !== next.enabled || context.writable !== next.writable;
    const baseChanged = next.base !== context.base && !sameStamp(next.base, context.base);
    context = next;
    if (!changed && !baseChanged) return;
    if (!next.enabled) {
      archiveSerial++;
      historySerial++;
      reviewing = null;
      emit({review: null, archive: {...state.archive, loading: false}});
    } else if (!next.writable) {
      reviewing = null;
      emit({review: null});
    } else if (changed) {
      emit({});
    }
  }

  function capture(needWrite: boolean): Flight | null {
    if (!context.projectId || !context.enabled || needWrite && !context.writable || !isCurrent()) return null;
    return {generation, projectId: context.projectId, dispatched: false};
  }

  async function loadHistory(): Promise<History | null> {
    const flight = capture(false);
    if (!flight || inFlight) return null;
    const serial = ++historySerial;
    try {
      const history = await read(rpc, 'canvas.history.get', {projectId: flight.projectId});
      if (!visible(flight) || serial !== historySerial || inFlight) return null;
      emit({history});
      return history;
    } catch {
      if (visible(flight) && serial === historySerial) emit({history: null});
      return null;
    }
  }

  async function archivePage(projectId: string, after?: CanvasArchiveListInput['after'], limit?: number): Promise<Page> {
    return read(rpc, 'canvas.archive.list', {projectId, ...after && {after}, ...limit && {limit}} satisfies CanvasArchiveListInput);
  }

  async function loadArchive(append = false): Promise<void> {
    const flight = capture(false), previous = page;
    if (!flight || inFlight || append && (!previous?.next || state.archive.loading)) return;
    const serial = ++archiveSerial;
    emit({archive: {...state.archive, loading: true, error: null}});
    try {
      const next = await archivePage(flight.projectId, append ? previous!.next! : undefined);
      if (!visible(flight) || serial !== archiveSerial || inFlight) return;
      page = append ? appendArchivePage(previous!, next) : validFirstPage(next);
      const items = [...page.items].sort((a, b) => b.archive.at.localeCompare(a.archive.at) || targetKey(a).localeCompare(targetKey(b)));
      emit({archive: {items, count: page.total, loading: false, error: null, hasMore: page.next !== null,
        canRestoreAll: page.total > 0 && page.total <= CANVAS_EDIT_LIMITS.targets}});
    } catch (failure) {
      if (visible(flight) && serial === archiveSerial) {
        if (append && canvasEditErrorCode(failure) === 'CANVAS_EDIT_CONFLICT') {
          await loadArchive();
          return;
        }
        emit({archive: {...state.archive, loading: false, error: canvasEditErrorCode(failure), canRestoreAll: false}});
      }
    }
  }

  function commitInput(history: History, projectId: string, revision = history.revision): CanvasHistoryInput {
    const issuedAt = Math.max(now(), history.requestAfter + 1);
    return {projectId, historyRevision: revision, requestId: createCanvasRequestId(history.requestEpoch, createNonce(), issuedAt)};
  }

  async function mutate(flight: Flight, operation: WriteOperation, input: CanvasEditInput | CanvasHistoryInput,
    canApply = () => true): Promise<CanvasEditResult | null> {
    const canWrite = () => writable(flight) && canApply();
    if (!canWrite()) return null;
    flight.dispatched = true;
    const ack = await write(rpc, operation, input, canWrite);
    if (!owned(flight)) return null;
    appliedStamp = contentStamp(ack);
    emit({history: null});
    return ack;
  }

  async function act(action: (flight: Flight) => Promise<boolean>, direction?: HistoryDirection): Promise<boolean> {
    const flight = capture(true);
    if (!flight || inFlight) return false;
    inFlight = flight;
    historySerial++;
    archiveSerial++;
    emit({busy: true, archive: {...state.archive, loading: false}});
    let refreshNeeded = false;
    try {
      return await action(flight);
    } catch (failure) {
      const code = canvasEditErrorCode(failure);
      refreshNeeded = conflict(failure) || code === 'CANVAS_EDIT_BLOCKED';
      if (visible(flight)) {
        if (direction && code === 'CANVAS_EDIT_BLOCKED') {
          onError(error(direction === 'undo' ? 'CANVAS_UI_UNDO_BLOCKED' : 'CANVAS_UI_REDO_BLOCKED'));
        } else if (direction && conflict(failure)) {
          onError(error(direction === 'undo' ? 'CANVAS_UI_UNDO_CONFLICT' : 'CANVAS_UI_REDO_CONFLICT'));
        } else onError(code === 'CANVAS_EDIT_CAPACITY' ? error('CANVAS_UI_COUNT_LIMIT') : failure);
      }
      return false;
    } finally {
      if (inFlight === flight) {
        const reload = flight.dispatched || refreshNeeded;
        if (reload && owned(flight)) {
          try { await refresh(flight.projectId); } catch { /* The parent handles a failed reload. */ }
        }
        if (inFlight === flight) {
          inFlight = null;
          emit({busy: false});
          if (visible(flight)) await Promise.all([loadHistory(), loadArchive()]);
        }
      }
    }
  }

  async function preview(input: CanvasArchivePreviewInput): Promise<Preview> {
    const result = await read(rpc, 'canvas.archive.preview', input);
    const keyed = (values: readonly CanvasTargetExpectation[]) =>
      values.map(value => `${targetKey(value)}:${value.revision}`).sort().join('|');
    if (keyed(result.targets) !== keyed(input.targets)) throw error('BACKEND_PROTOCOL_ERROR');
    if (result.blocked.length) throw error(input.operation === 'archive' ? 'CANVAS_UI_ARCHIVE_BLOCKED' : 'CANVAS_UI_RESTORE_BLOCKED');
    return result;
  }

  async function commitArchive(flight: Flight, operation: 'archive' | 'restore', review: Preview): Promise<boolean> {
    if (!writable(flight)) return false;
    const history = await read(rpc, 'canvas.history.get', {projectId: flight.projectId});
    if (history.revision !== review.historyRevision) throw error('CANVAS_EDIT_CONFLICT');
    let result: CanvasEditResult | null;
    try {
      result = await mutate(flight, 'canvas.apply', {
        ...commitInput(history, flight.projectId, review.historyRevision), operation, targets: review.targets,
        ...(review.confirmation ? {confirmation: review.confirmation} : {}),
      });
    } catch (failure) {
      if (canvasEditErrorCode(failure) === 'CANVAS_EDIT_BLOCKED') {
        throw error(operation === 'archive' ? 'CANVAS_UI_ARCHIVE_BLOCKED' : 'CANVAS_UI_RESTORE_BLOCKED');
      }
      throw failure;
    }
    if (!result?.actionId) return false;
    if (operation === 'archive') {
      if (visible(flight)) onArchived(review.targets);
      emit({toast: {kind: 'archive', count: review.targets.length, actionId: result.actionId}});
    } else {
      emit({toast: null});
      if (visible(flight)) onNotice({kind: 'restored', count: review.targets.length});
    }
    return true;
  }

  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
    setContext,
    loadHistory,
    loadArchive: () => loadArchive(),
    loadMoreArchive: () => loadArchive(true),
    archiveSelection(targets: readonly CanvasTarget[]) {
      if (!targets.length || reviewing) return Promise.resolve(false);
      return act(async flight => {
        const base = context.base;
        if (!base) throw error('CANVAS_UI_LAYOUT_NOT_READY');
        const review = await preview({projectId: flight.projectId, operation: 'archive', targets: expectations(base, targets).map(toExpectation)});
        if (!writable(flight)) return false;
        if (review.versions || review.clips) {
          if (!review.confirmation) throw error('BACKEND_PROTOCOL_ERROR');
          reviewing = review;
          const {versions, clips, shotImpacts, impactedShotCount} = review;
          emit({review: {count: review.targets.length, versions, clips, shotImpacts, impactedShotCount}});
          return false;
        }
        return commitArchive(flight, 'archive', review);
      });
    },
    cancelArchive() {
      if (inFlight) return;
      reviewing = null;
      emit({review: null});
    },
    confirmArchive() {
      const review = reviewing;
      if (!review) return Promise.resolve(false);
      return act(flight => {
        reviewing = null;
        emit({review: null});
        return commitArchive(flight, 'archive', review);
      });
    },
    restore(item: CanvasTargetExpectation) {
      if (reviewing) return Promise.resolve(false);
      return act(async flight => {
        const review = await preview({projectId: flight.projectId, operation: 'restore', targets: [toExpectation(item)]});
        return commitArchive(flight, 'restore', review);
      });
    },
    restoreAll() {
      if (reviewing) return Promise.resolve(false);
      return act(async flight => {
        const projectId = flight.projectId;
        let collected = validFirstPage(await archivePage(projectId));
        if (collected.total > CANVAS_EDIT_LIMITS.targets) throw error('CANVAS_UI_COUNT_LIMIT');
        if (!collected.total) return false;
        while (collected.next && writable(flight)) {
          collected = appendArchivePage(collected, await archivePage(projectId, collected.next));
        }
        if (!writable(flight)) return false;
        const review = await preview({projectId, operation: 'restore', targets: collected.items.map(toExpectation)});
        if (!writable(flight)) return false;
        const check = await archivePage(projectId, undefined, 1);
        if (!sameStamp(collected, check) || collected.total !== check.total) throw error('CANVAS_EDIT_CONFLICT');
        return commitArchive(flight, 'restore', review);
      });
    },
    tidy(layout: CanvasLayoutInput) {
      const base = context.base;
      if (reviewing) return Promise.resolve(false);
      return act(async flight => {
        if (!base) throw error('CANVAS_UI_LAYOUT_NOT_READY');
        const result = layoutCanvas(layout);
        if (result.status === 'no-fit') throw error('CANVAS_UI_LAYOUT_NO_FIT');
        if (result.status !== 'moved') return false;
        return applyPositions(flight, base, result.moves, 'layout');
      });
    },
    move(moves: readonly CanvasLayoutMove[], base: CanvasEditBase, canApply?: () => boolean) {
      if (reviewing || !moves.length) return Promise.resolve(false);
      return act(flight => applyPositions(flight, base, moves, 'move', canApply));
    },
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    reportHistoryConflict,
    undoToast: () => state.toast ? travel('undo', state.toast.actionId) : Promise.resolve(false),
    dismissToast: () => emit({toast: null}),
  };

  async function applyPositions(flight: Flight, base: CanvasEditBase, moves: readonly CanvasLayoutMove[],
    operation: 'layout' | 'move', canApply = () => true): Promise<boolean> {
    if (!canApply()) return false;
    const history = await read(rpc, 'canvas.history.get', {projectId: flight.projectId});
    if (!canApply()) return false;
    if (!sameStamp(base, context.base) || appliedStamp && base.contentSequence < appliedStamp.contentSequence) {
      throw error('CANVAS_EDIT_CONFLICT');
    }
    const input = {...commitInput(history, flight.projectId), moves: expectations(base, moves)};
    const result = await mutate(flight, 'canvas.apply', operation === 'layout'
      ? {...input, operation, ...contentStamp(base)} : {...input, operation}, canApply);
    if (!result?.actionId) return false;
    emit({toast: operation === 'layout' ? {kind: 'layout', count: result.affected, actionId: result.actionId} : null});
    return true;
  }

  function reportHistoryConflict(direction: HistoryDirection): boolean {
    const conflictFlag = direction === 'undo' ? 'undoConflict' : 'redoConflict';
    if (reviewing || inFlight || !state.history?.[direction] || !state.history[conflictFlag] || !capture(true)) return false;
    onError(error(direction === 'undo' ? 'CANVAS_UI_UNDO_CONFLICT' : 'CANVAS_UI_REDO_CONFLICT'));
    return true;
  }

  function travel(direction: HistoryDirection, toastActionId?: string): Promise<boolean> {
    const actionId = toastActionId ?? state.history?.[direction]?.id;
    const conflictFlag = direction === 'undo' ? 'undoConflict' : 'redoConflict';
    const blockedFlag = direction === 'undo' ? 'undoBlocked' : 'redoBlocked';
    const conflictCode = direction === 'undo' ? 'CANVAS_UI_UNDO_CONFLICT' : 'CANVAS_UI_REDO_CONFLICT';
    if (reviewing || !actionId) return Promise.resolve(false);
    if (state.history?.[conflictFlag]) {
      if (toastActionId === undefined) reportHistoryConflict(direction);
      return Promise.resolve(false);
    }
    return act(async flight => {
      const history = await read(rpc, 'canvas.history.get', {projectId: flight.projectId});
      const target = history[direction];
      if (!target || target.id !== actionId || history[conflictFlag]) throw error(conflictCode);
      if (history[blockedFlag]) throw error('CANVAS_EDIT_BLOCKED');
      const ack = await mutate(flight, direction === 'undo' ? 'canvas.history.undo' : 'canvas.history.redo', commitInput(history, flight.projectId));
      if (!ack?.actionId) return false;
      emit({toast: null});
      if (visible(flight)) onNotice({kind: direction === 'undo' ? 'undone' : 'redone'});
      return true;
    }, direction);
  }
  return controller;
}
