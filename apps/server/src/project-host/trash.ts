import {lstatSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {projectDeleteInputSchema, projectDeleteResponseSchema} from '../../../../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteInput, ProjectDeleteResponse} from '../../../../packages/contracts/src/project-lifecycle.ts';
import {ProjectTrashRefusedError} from '../../../../packages/contracts/src/project-trash-native.ts';
import type {ProjectTrashFileGeneration, ProjectTrashPort, ProjectTrashReservation} from '../../../../packages/contracts/src/project-trash-native.ts';
import type {ProjectWorkInspection} from './background-coordinator.ts';
import type {AppLibrary} from '../../../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../../../packages/business/src/project-service-application.ts';
import {hasBlockingMioRun, inspectClosedProjectForTrash} from '../../../../packages/business/src/project-file/closed-copy.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostManager} from './manager.ts';
import {projectHostError, projectNotFound} from './errors.ts';
import {createProjectTrashRecords, invalidTrashIntent, PROJECT_TRASH_OPERATION, projectTrashDigest} from './trash-records.ts';
import type {ProjectTrashIntent} from './trash-records.ts';

export type ProjectTrashBoundary = 'prepared' | 'dispatched' | 'trashed' | 'before-receipt';
export interface ProjectTrashActions {
  readonly available: boolean;
  trash(input: ProjectDeleteInput): Promise<ProjectDeleteResponse>;
  drain(): Promise<void>;
}
const failure = (code: string, message: string, status = 409) => new AppError(code, message, status);
const sourceChanged = () => failure('PROJECT_TRASH_SOURCE_CHANGED', '项目文件或日志状态已变化，未移到废纸篓，请重新确认。');
const uncertain = () => failure('PROJECT_TRASH_UNCONFIRMED', '无法确认项目文件是否已移到废纸篓，登记已保留，未再次移动文件。');
const generation = (file: string): ProjectTrashFileGeneration => {
  let info;
  try {info = lstatSync(file, {bigint: true});} catch {throw sourceChanged();}
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw sourceChanged();
  return {dev: String(info.dev), ino: String(info.ino), size: Number(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), birthtimeNs: String(info.birthtimeNs)};
};

/** The main process owns OS trash and real window admission. This service
 * owns project/history admission and the durable boundary before that effect. */
export function createProjectTrash({manager, library, directories, signal, assertProjectFile, inspectProjectWork, port, onBoundary}: {
  readonly manager: ProjectHostManager;
  readonly library: AppLibrary;
  readonly directories: AppDirectories;
  readonly signal: AbortSignal;
  readonly assertProjectFile: (file: string) => void;
  readonly inspectProjectWork: (projectId: string) => ProjectWorkInspection;
  readonly port?: ProjectTrashPort;
  readonly onBoundary?: (boundary: ProjectTrashBoundary, input: ProjectDeleteInput) => void | Promise<void>;
}): ProjectTrashActions {
  const assertAllowed = createProjectServiceApplication(library, signal).assertMutationAllowed!;
  const records = createProjectTrashRecords(directories.dataDir, assertAllowed);
  const running = new Map<string, {digest: string; promise: Promise<ProjectDeleteResponse>}>();
  const parse = (raw: unknown): ProjectDeleteInput => {
    const result = projectDeleteInputSchema.safeParse(raw);
    if (!result.success || !path.isAbsolute(result.data.projectFile) || path.normalize(result.data.projectFile) !== result.data.projectFile) {
      throw failure('VALIDATION_ERROR', '移到废纸篓需要明确确认当前登记的项目文件、文件身份和项目版本。', 400);
    }
    return result.data;
  };
  const replay = (input: ProjectDeleteInput): ProjectDeleteResponse | null => {
    const previous = library.receipts.read(PROJECT_TRASH_OPERATION, input.requestId);
    if (!previous) return null;
    if (previous.digest !== projectTrashDigest(input)) throw failure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。');
    const response = projectDeleteResponseSchema.safeParse(previous.response);
    if (!response.success || response.data.requestId !== input.requestId || response.data.projectId !== input.projectId
      || response.data.projectFile !== input.projectFile) throw invalidTrashIntent();
    // Never inspect or operate on a later file at the former path on replay.
    return response.data;
  };
  const assertNoUnconfirmed = (projectId: string): void => {
    for (const intent of records.list()) {
      if (intent.input.projectId !== projectId || intent.phase !== 'dispatched') continue;
      if (!replay(intent.input)) throw uncertain();
    }
  };
  const assertIdle = (projectId: string, ownPausedAdmission = false): void => {
    assertAllowed();
    const status = manager.status(projectId), work = inspectProjectWork(projectId);
    if (status && (status.state !== 'open' || status.paused && !ownPausedAdmission
      || status.leases.window > 0 || status.leases.request > 0 || status.leases.task > 0)
      || work.projectId !== projectId || work.certainty !== 'known' || work.mayWriteBack) {
      throw projectHostError('PROJECT_HOST_BUSY', {projectId});
    }
  };
  const checkSource = (intent: ProjectTrashIntent): void => {
    assertAllowed(); assertProjectFile(intent.input.projectFile);
    try {
      if (canonicalJson(generation(intent.input.projectFile)) !== canonicalJson(intent.source.generation)
        || ['-journal', '-wal', '-shm'].some(suffix => lstatSync(intent.input.projectFile + suffix, {throwIfNoEntry: false}))) throw sourceChanged();
    } catch {throw sourceChanged();}
  };
  const boundary = async (name: ProjectTrashBoundary, input: ProjectDeleteInput): Promise<void> => {
    await onBoundary?.(name, input); assertAllowed();
  };
  const execute = async (input: ProjectDeleteInput): Promise<ProjectDeleteResponse> => {
    assertAllowed();
    const previous = replay(input);
    if (previous) return previous;
    const digest = projectTrashDigest(input), existing = records.read(input.requestId);
    if (existing && existing.digest !== digest) throw failure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。');
    assertNoUnconfirmed(input.projectId);
    if (!port) throw failure('PROJECT_TRASH_UNAVAILABLE', '当前环境暂不支持将项目文件移到废纸篓。');
    const registered = library.registry.get(input.projectId);
    if (!registered) throw projectNotFound(input.projectId);
    if (registered.projectFile !== input.projectFile || canonicalJson(registered.fileIdentity) !== canonicalJson(input.fileIdentity)) throw sourceChanged();
    assertProjectFile(input.projectFile); assertIdle(input.projectId);
    let reservation: ProjectTrashReservation | undefined;
    try {
      reservation = await port.reserve({requestId: input.requestId, projectId: input.projectId});
      assertAllowed();
      return await manager.withExclusive(input.projectId, async entry => {
        assertAllowed();
        const cached = replay(input);
        if (cached) return cached;
        assertNoUnconfirmed(input.projectId); assertIdle(input.projectId);
        if (entry.projectFile !== input.projectFile || canonicalJson(entry.fileIdentity) !== canonicalJson(input.fileIdentity)) throw sourceChanged();
        assertProjectFile(entry.projectFile);
        const inspected = inspectClosedProjectForTrash({projectFile: entry.projectFile,
          historyFile: id => path.join(projectLocation(directories, id).localDir, 'history.db'), assertMutationAllowed: assertAllowed});
        if (inspected.identity.projectId !== input.projectId || inspected.generation.dev !== input.fileIdentity.dev
          || inspected.generation.ino !== input.fileIdentity.ino) throw sourceChanged();
        if (inspected.revision !== input.expectedRevision) throw failure('REVISION_CONFLICT', '项目版本已变化，请重新确认。');
        if (inspected.history?.hasBlockingMio) throw projectHostError('PROJECT_HOST_BUSY', {projectId: input.projectId});
        const source: ProjectTrashIntent['source'] = {projectId: input.projectId, revision: inspected.revision,
          contentSequence: inspected.identity.contentSequence, contentToken: inspected.identity.contentToken, generation: inspected.generation};
        if (existing && canonicalJson(existing.source) !== canonicalJson(source)) throw sourceChanged();
        let intent: ProjectTrashIntent = {version: 1, operation: PROJECT_TRASH_OPERATION, input, digest, phase: 'prepared', source};
        checkSource(intent);
        records.write(intent);
        let nativeStarted = false, nativeCompleted = false;
        try {
          await boundary('prepared', input); assertIdle(input.projectId); checkSource(intent);
          intent = {...intent, phase: 'dispatched'}; records.write(intent);
          await boundary('dispatched', input); assertIdle(input.projectId); checkSource(intent);
          nativeStarted = true;
          await reservation!.trash({requestId: input.requestId, projectId: input.projectId, projectFile: input.projectFile, fileIdentity: source.generation});
          nativeCompleted = true;
          await boundary('trashed', input);
          await boundary('before-receipt', input);
          const response = projectDeleteResponseSchema.parse({requestId: input.requestId, projectId: input.projectId,
            projectFile: input.projectFile, trashed: true, records: 'retained'});
          // B1 is the final outcome. Leave the dispatch record intact: the
          // immutable receipt takes precedence even if the process exits now.
          library.tx(() => {
            assertAllowed();
            const current = library.registry.get(input.projectId);
            if (!current || current.projectFile !== input.projectFile
              || canonicalJson(current.fileIdentity) !== canonicalJson(input.fileIdentity)) throw uncertain();
            library.registry.remove(input.projectId);
            library.receipts.write({operation: PROJECT_TRASH_OPERATION, requestId: input.requestId, digest, response, createdAt: new Date().toISOString()});
          });
          return response;
        } catch (error) {
          if (!nativeStarted || !nativeCompleted && error instanceof ProjectTrashRefusedError) {
            // A live owner can record an exact pre-OS refusal. If the owner is
            // gone, keep the more conservative durable dispatch marker.
            try {assertAllowed(); records.write({...intent, phase: 'not-started'});} catch { /* No destructive effect is retried during cleanup. */ }
            throw error;
          }
          throw uncertain();
        }
      }, {rejectWindowLeases: true, assertCanClose: host => {
        assertIdle(input.projectId, true);
        if (hasBlockingMioRun(host.store.db, input.projectId)) throw projectHostError('PROJECT_HOST_BUSY', {projectId: input.projectId});
      }});
    } finally {reservation?.release();}
  };
  return {available: port !== undefined,
    trash(raw): Promise<ProjectDeleteResponse> {
      assertAllowed();
      const input = parse(raw), digest = projectTrashDigest(input), active = running.get(input.requestId);
      if (active) {
        if (active.digest !== digest) throw failure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。');
        return active.promise;
      }
      const promise = execute(input).finally(() => {running.delete(input.requestId);});
      running.set(input.requestId, {digest, promise});
      return promise;
    },
    async drain(): Promise<void> {await Promise.allSettled([...running.values()].map(value => value.promise));},
  };
}
