/** Project RPC seam for the shared format-5 sequence-edit contract.
 *
 * UI-B/UI-E/MT call preview, commit, history and undo/redo here; the actual
 * planning, delta application, receipt and history rows stay in
 * `format5-sequence-sync.ts` / `format5-editor-history.ts`. This module never
 * builds its own receipt or history row.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {assertProjectStore} from './store-runtime.ts';
import {
  moveSequenceSyncHistory, previewSequenceSync, readSequenceSyncProjection, runSequenceSync,
} from './format5-sequence-sync.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {SequenceEditCommitRequest, SequenceEditHistoryCommand, SequenceEditHistoryCursor} from '../../contracts/src/sequence-edit.ts';
import type {SequenceSyncCommand} from '../../contracts/src/sequence-sync.ts';

interface PreviewInput {projectId: string; requestId: string; actionId?: string; command: SequenceSyncCommand}
interface CommitInput {projectId: string; envelope: SequenceEditCommitRequest['envelope']; expectedPlanDigest: string}
interface HistoryCommandInput {projectId: string; requestId: string; actionId: string; expected: SequenceEditHistoryCursor}
interface HistoryAction {actionId: string; operation: string; affected: number}
export interface SequenceHistoryView {
  epoch: string; position: number; revision: number; undo: HistoryAction | null; redo: HistoryAction | null;
}
type Row = Record<string, any>;
const format5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
const requireFormat5 = (store: ProjectStore): void => {
  if (!format5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
};
const projectCheck = (store: ProjectStore, projectId: string): void => {
  if (projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
};
export function createFormat5SequenceEditService(store: ProjectStore): {
  preview(input: PreviewInput): unknown;
  commit(input: CommitInput): unknown;
  history(input: {projectId: string}): SequenceHistoryView;
  undo(input: HistoryCommandInput): unknown;
  redo(input: HistoryCommandInput): unknown;
} {
  assertProjectStore(store);
  function history(input: {projectId: string}): SequenceHistoryView {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    const state = store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state WHERE projectId=?')
      .get(store.projectId) as Row | undefined;
    if (!state) return {epoch: store.projectId, position: 0, revision: 1, undo: null, redo: null};
    const action = (position: number): HistoryAction | null => {
      if (position < 1) return null;
      const row = store.db.prepare(`SELECT actionId,operation FROM main.editor_history_entries
        WHERE projectId=? AND epoch=? AND position=?`).get(store.projectId, state.epoch, position) as Row | undefined;
      return row ? {actionId: String(row.actionId), operation: String(row.operation), affected: 0} : null;
    };
    return {epoch: String(state.epoch), position: Number(state.position), revision: Number(state.revision),
      undo: action(Number(state.position)), redo: action(Number(state.position) + 1)};
  }
  function preview(input: PreviewInput): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    const result = previewSequenceSync(store, input.command, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {})});
    return result;
  }
  function commit(input: CommitInput): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    return runSequenceSync(store, input.envelope, {expectedPlanDigest: input.expectedPlanDigest});
  }
  function move(input: HistoryCommandInput, direction: 'undo' | 'redo'): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    const command: SequenceEditHistoryCommand = {projectId: store.projectId, requestId: input.requestId,
      actionId: input.actionId, direction, expected: input.expected};
    return moveSequenceSyncHistory(store, command);
  }
  return {preview, commit, history, undo: input => move(input, 'undo'), redo: input => move(input, 'redo')};
}
export function readFormat5SequenceProjection(store: ProjectStore): unknown {
  assertProjectStore(store);
  requireFormat5(store);
  return readSequenceSyncProjection(store);
}
