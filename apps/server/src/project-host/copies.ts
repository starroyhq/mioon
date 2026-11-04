import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory, validatePrivateDirectory} from '../../../../packages/contracts/src/private-storage.ts';
import {projectCopyInputSchema, projectCopyResponseSchema} from '../../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyInput, ProjectCopyOperation, ProjectCopyResponse} from '../../../../packages/contracts/src/project-copies.ts';
import type {AppLibrary} from '../../../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../../../packages/business/src/project-service-application.ts';
import {copyProjectToNewFile} from '../../../../packages/business/src/project-file/copy.ts';
import {captureClosedProjectSnapshot} from '../../../../packages/business/src/project-file/closed-copy.ts';
import {inspectCopiedProjectFile, openProjectBackup, syncCopiedFile, syncCopiedDirectory, publishProjectCopyFile,
  createProjectCopyStagingDirectory, validateProjectCopyStagingDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {initializeProjectCopyHistory, readProjectCopyHistory} from '../../../../packages/business/src/project-file/copy-history.ts';
import {openProjectStore} from '../../../../packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from '../../../../packages/business/src/project-file/content-stamp.ts';
import {copyProjectVersionsToNewProjectInside} from '../../../../packages/business/src/project-versions/copy-to-project.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostManager} from './manager.ts';
import {projectHostError} from './errors.ts';
import {copiedProjectConfirmationDirectories} from './copy-outside-confirmations.ts';
import {copyFailure, copyIdentity, createCopyRecords, sameCopyIdentity} from './copy-records.ts';
import type {CopyIntent} from './copy-records.ts';

export type ProjectCopyBoundary = 'prepared' | 'captured' | 'ready' | 'records-prepared' | 'records-published' | 'project-published' | 'registered';
export interface ProjectCopies {
  duplicate(input: ProjectCopyInput): Promise<ProjectCopyResponse>;
  saveAs(input: ProjectCopyInput): Promise<ProjectCopyResponse>;
  replay(operation: ProjectCopyOperation, input: ProjectCopyInput): ProjectCopyResponse | null;
  recover(): Promise<void>;
  drain(): Promise<void>;
}
export function createProjectCopies({manager, library, directories, assertProjectFile, signal, onBoundary}: {
  readonly manager: ProjectHostManager;
  readonly library: AppLibrary;
  readonly directories: AppDirectories;
  readonly assertProjectFile: (file: string) => void;
  readonly signal: AbortSignal;
  /** Trusted failure seam, never a request or environment option. */
  readonly onBoundary?: (boundary: ProjectCopyBoundary, input: ProjectCopyInput) => void | Promise<void>;
}): ProjectCopies {
  const assertAllowed = createProjectServiceApplication(library, signal).assertMutationAllowed!;
  const records = createCopyRecords(directories.dataDir, assertAllowed);
  const running = new Map<string, {digest: string; promise: Promise<ProjectCopyResponse>}>();
  const targets = new Set<string>();
  const key = (operation: ProjectCopyOperation, requestId: string) => operation + ':' + requestId;
  const digestFor = (operation: ProjectCopyOperation, input: ProjectCopyInput) => createHash('sha256').update(canonicalJson({operation, input})).digest('hex');
  const parse = (input: unknown): ProjectCopyInput => {
    const parsed = projectCopyInputSchema.safeParse(input);
    if (!parsed.success || !path.isAbsolute(parsed.data.projectFile) || path.normalize(parsed.data.projectFile) !== parsed.data.projectFile) {
      throw copyFailure('VALIDATION_ERROR', '复制需要项目、稳定请求 ID 和当前系统上新的规范绝对 .mioon 文件路径。', 400);
    }
    return parsed.data;
  };
  const boundary = async (phase: ProjectCopyBoundary, intent: CopyIntent): Promise<void> => {
    await onBoundary?.(phase, intent.input);
    assertAllowed();
  };
  const replay = (operation: ProjectCopyOperation, raw: ProjectCopyInput): ProjectCopyResponse | null => {
    assertAllowed();
    const input = parse(raw), receipt = library.receipts.read(operation, input.requestId);
    if (!receipt) return null;
    if (receipt.digest !== digestFor(operation, input)) throw copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目复制。');
    const parsed = projectCopyResponseSchema.safeParse(receipt.response);
    if (!parsed.success || parsed.data.sourceProjectId !== input.projectId || parsed.data.requestId !== input.requestId
      || parsed.data.project.projectFile !== input.projectFile) throw copyFailure('PROJECT_COPY_INTENT_INVALID', '项目复制回执绑定无效。');
    const actual = library.registry.get(parsed.data.project.projectId);
    if (!actual || actual.projectFile !== input.projectFile || !sameCopyIdentity(actual.fileIdentity, parsed.data.project.fileIdentity)
      || !sameCopyIdentity(actual.fileIdentity, library.projectFileIdentity(input.projectFile))) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '已复制的项目被移动、替换或移除，未重新创建。');
    }
    // Stat and the app receipt suffice; opening an edited/held target would
    // drop its POSIX locks and could turn replay into another restore.
    return parsed.data;
  };
  const work = (intent: CopyIntent) => records.work(intent.operation, intent.input.requestId);
  const ensureWork = (intent: CopyIntent): string => {
    const directory = work(intent);
    ensurePrivateDirectory(records.root, {create: true});
    ensurePrivateDirectory(directory, {create: true});
    return directory;
  };
  const stageFile = (intent: CopyIntent): string => path.join(intent.stageDirectory!, 'project.mioon');
  const stageLocal = (intent: CopyIntent): string => path.join(work(intent), 'local');
  const stageHistory = (intent: CopyIntent): string => path.join(stageLocal(intent), 'history.db');
  const save = (intent: CopyIntent): CopyIntent => {records.write(intent); return intent;};
  const verifyStageDirectory = (intent: CopyIntent): void => {
    if (!intent.stageDirectory || !sameCopyIdentity(copyIdentity(intent.stageDirectory), intent.stageDirectoryIdentity)) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '复制的暂存目录身份已改变。');
    }
    validateProjectCopyStagingDirectory(intent.stageDirectory);
  };
  const removeOwnedLink = (file: string, identity: CopyIntent['stageIdentity']): void => {
    if (!lstatSync(file, {throwIfNoEntry: false})) return;
    if (!sameCopyIdentity(copyIdentity(file), identity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '复制的暂存文件已被替换，未清理。');
    unlinkSync(file);
    syncCopiedDirectory(path.dirname(file));
  };
  const cleanup = (intent: CopyIntent): void => {
    // A source history backup is temporary conversion input, never a copied
    // diagnostic archive. Keep only the small app receipt after completion.
    try {
      const directory = work(intent);
      if (lstatSync(directory, {throwIfNoEntry: false})) {
        validatePrivateDirectory(directory);
        if (readdirSync(directory).some(name => !['source', 'local', 'cache', 'tmp'].includes(name))) return;
        rmSync(directory, {recursive: true});
      }
      if (intent.stageDirectory && sameCopyIdentity(copyIdentity(intent.stageDirectory), intent.stageDirectoryIdentity)) {
        validateProjectCopyStagingDirectory(intent.stageDirectory);
        rmdirSync(intent.stageDirectory); // Only our empty directory; never remove unknown contents.
      }
    } catch { /* A completed receipt remains final; a later recovery can clean its owned stages. */ }
  };

  async function finish(intent: CopyIntent): Promise<ProjectCopyResponse> {
    assertAllowed();
    if (!intent.response || !intent.stageIdentity || !intent.historyIdentity) throw copyFailure('PROJECT_COPY_INTENT_INVALID', '复制尚未准备完整。');
    const response = intent.response;
    verifyStageDirectory(intent);
    const target = intent.input.projectFile;
    assertProjectFile(target);
    const local = projectLocation(directories, intent.projectId).localDir;
    ensurePrivateDirectory(path.dirname(local), {create: true});
    if (!intent.recordsIdentity) {
      validatePrivateDirectory(stageLocal(intent));
      intent = save({...intent, recordsIdentity: copyIdentity(stageLocal(intent))});
      await boundary('records-prepared', intent);
    }
    if (!lstatSync(local, {throwIfNoEntry: false})) {
      if (!sameCopyIdentity(copyIdentity(stageLocal(intent)), intent.recordsIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '暂存本机记录目录身份已改变。');
      // Persist the complete private directory's identity before its atomic
      // publication. A crash on either side of rename resumes the same owner.
      renameSync(stageLocal(intent), local);
      syncCopiedDirectory(path.dirname(local));
      syncCopiedDirectory(work(intent));
    } else if (!sameCopyIdentity(copyIdentity(local), intent.recordsIdentity)) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '新项目的本机记录位置已被占用，未覆盖。');
    }
    ensurePrivateDirectory(local);
    const history = path.join(local, 'history.db');
    if (!sameCopyIdentity(copyIdentity(history), intent.historyIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标本机记录已被替换。');
    if (intent.phase === 'ready') {intent = save({...intent, phase: 'records-published'}); await boundary('records-published', intent);}

    const found = copyIdentity(target);
    if (!found || sameCopyIdentity(found, intent.placeholderIdentity)) {
      if (found) {removeOwnedLink(target, intent.placeholderIdentity); intent = save({...intent, placeholderIdentity: null});}
      publishProjectCopyFile(stageFile(intent), target, {
        onPlaceholder: identity => {intent = save({...intent, placeholderIdentity: identity});},
        onPublished: () => {intent = save({...intent, phase: 'project-published', fileIdentity: copyIdentity(target), placeholderIdentity: null});},
      });
    } else if (!sameCopyIdentity(found, intent.stageIdentity)) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标已被其他文件占用，未覆盖或重新复制。');
    }
    if (!sameCopyIdentity(copyIdentity(target), intent.stageIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标身份与复制提交不一致。');
    removeOwnedLink(stageFile(intent), intent.stageIdentity);
    if (intent.phase !== 'project-published' && intent.phase !== 'completed') {
      intent = save({...intent, phase: 'project-published', fileIdentity: copyIdentity(target)});
    }
    await boundary('project-published', intent);
    const current = library.registry.get(intent.projectId);
    if (current && (current.projectFile !== target || !sameCopyIdentity(current.fileIdentity, intent.stageIdentity))) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '新项目的登记已改变，未覆盖。');
    }
    if (!current) {
      const actual = inspectCopiedProjectFile(target);
      if (actual.projectId !== intent.projectId || actual.contentToken !== response.contentToken
        || actual.contentSequence !== response.contentSequence) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标内容与复制提交不一致。');
      // This opens only the completed target with its completed, matching
      // history. It validates all cross-file constraints, without a factory.
      const store = openProjectStore({projectFile: target, locate: id => projectLocation(directories, id), checkCopy: library.registry.checkCopy});
      try {
        if (store.historyState !== 'current' || canonicalJson(readProjectContentStamp(store.db)) !== canonicalJson({contentSequence: actual.contentSequence, contentToken: actual.contentToken})) {
          throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标记录未通过完整内容身份校验。');
        }
      } finally {store.close();}
    }
    const directoriesToConfirm = copiedProjectConfirmationDirectories(library.outsidePaths, intent.input.projectId, path.dirname(intent.sourceFile));
    assertAllowed();
    library.tx(() => {
      assertAllowed();
      if (!current) library.registry.upsert(response.project);
      for (const directory of directoriesToConfirm) library.outsidePaths.confirm({projectId: intent.projectId, directory, confirmedAt: new Date().toISOString()});
      library.receipts.write({operation: intent.operation, requestId: intent.input.requestId, digest: intent.digest,
        response, createdAt: new Date().toISOString()});
    });
    await boundary('registered', intent);
    intent = save({...intent, phase: 'completed', fileIdentity: intent.stageIdentity});
    cleanup(intent);
    return response;
  }

  async function execute(operation: ProjectCopyOperation, input: ProjectCopyInput, existing: CopyIntent | null): Promise<ProjectCopyResponse> {
    let intent = existing;
    const digest = digestFor(operation, input);
    if (intent && intent.digest !== digest) throw copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目复制。');
    if (intent && ['ready', 'records-published', 'project-published', 'completed'].includes(intent.phase)) return finish(intent);
    const observed = manager.status(input.projectId);
    if (observed?.leases.window || observed?.state === 'opening') throw projectHostError('PROJECT_HOST_BUSY', {projectId: input.projectId});
    return manager.withExclusive(input.projectId, async registration => {
      assertAllowed();
      assertProjectFile(registration.projectFile);
      assertProjectFile(input.projectFile);
      if (registration.projectFile === input.projectFile) throw copyFailure('PROJECT_FILE_EXISTS', '目标不能是原项目文件。');
      if (!intent) {
        if (lstatSync(input.projectFile, {throwIfNoEntry: false})) throw copyFailure('PROJECT_FILE_EXISTS', '目标项目文件已存在。');
        library.registry.assertCanRegister?.();
        intent = save({version: 1, operation, input, digest, projectId: randomUUID(), contentToken: randomBytes(16).toString('hex'),
          sourceFile: registration.projectFile, sourceIdentity: registration.fileIdentity, sourceStamp: null, phase: 'prepared',
          stageDirectory: null, stageDirectoryIdentity: null, stageIdentity: null, historyIdentity: null, recordsIdentity: null,
          placeholderIdentity: null, fileIdentity: null, response: null});
        await boundary('prepared', intent);
      }
      if (intent.sourceFile !== registration.projectFile || !sameCopyIdentity(intent.sourceIdentity, registration.fileIdentity)
        || !sameCopyIdentity(intent.sourceIdentity, library.projectFileIdentity(intent.sourceFile))) {
        throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '源项目的位置或文件身份已改变，未继续复制。');
      }
      const directory = ensureWork(intent), snapshotDirectory = path.join(directory, 'source');
      if (intent.phase === 'prepared') {
        if (lstatSync(snapshotDirectory, {throwIfNoEntry: false})) {validatePrivateDirectory(snapshotDirectory); rmSync(snapshotDirectory, {recursive: true});}
        ensurePrivateDirectory(snapshotDirectory, {create: true});
        const captured = await captureClosedProjectSnapshot({projectFile: intent.sourceFile,
          historyFile: id => projectLocation(directories, id).localDir + path.sep + 'history.db', directory: snapshotDirectory, assertMutationAllowed: assertAllowed});
        if (captured.identity.projectId !== input.projectId) throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '源文件不再是选中的项目。');
        intent = save({...intent, sourceStamp: {contentSequence: captured.identity.contentSequence, contentToken: captured.identity.contentToken}, phase: 'captured'});
        await boundary('captured', intent);
      }
      if (!intent.stageDirectory) {
        const stageDirectory = createProjectCopyStagingDirectory(path.dirname(input.projectFile), '.project-copy-');
        intent = save({...intent, stageDirectory, stageDirectoryIdentity: copyIdentity(stageDirectory)});
      }
      verifyStageDirectory(intent);
      const stageDirectory = intent.stageDirectory!;
      // No target has been published in this phase. Only this request's
      // private staging files can be rebuilt after an interrupted conversion.
      for (const file of readdirSync(stageDirectory)) {
        if (file !== 'project.mioon' && !file.startsWith('project-copy-')) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '暂存目录含未知文件，已保留。');
        rmSync(path.join(stageDirectory, file), {recursive: true, force: true});
      }
      const source = openProjectBackup(path.join(snapshotDirectory, 'project.source.sqlite'));
      let copied: Awaited<ReturnType<typeof copyProjectToNewFile>>;
      try {
        copied = await copyProjectToNewFile(source, {projectFile: stageFile(intent), sourceProjectDir: path.dirname(intent.sourceFile),
          targetProjectDir: path.dirname(input.projectFile), projectId: intent.projectId, contentToken: intent.contentToken,
          expectedSource: {projectId: input.projectId, ...intent.sourceStamp!}, clearProcessRevisions: true,
          ...(input.name === undefined ? {} : {projectName: input.name}), publish: (from, to) => publishProjectCopyFile(from, to)});
      } finally {source.close();}
      assertAllowed();
      const localDir = stageLocal(intent);
      if (lstatSync(localDir, {throwIfNoEntry: false})) {validatePrivateDirectory(localDir); rmSync(localDir, {recursive: true});}
      ensurePrivateDirectory(localDir, {create: true});
      initializeProjectCopyHistory(stageHistory(intent), intent.projectId, copied);
      const store = openProjectStore({projectFile: stageFile(intent), locate: () => ({localDir, cacheDir: path.join(directory, 'cache'), tempDir: path.join(directory, 'tmp')})});
      let versions = 0;
      try {
        if (store.historyState !== 'current') throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '复制目标的初始内容身份不匹配。');
        const sourceHistory = path.join(snapshotDirectory, 'history.source.sqlite');
        if (lstatSync(sourceHistory, {throwIfNoEntry: false})) {
          versions = readProjectCopyHistory(sourceHistory, previous => store.tx(() => copyProjectVersionsToNewProjectInside(previous, store.db, {sourceProjectId: input.projectId,
            projectId: intent!.projectId, sourceProjectDir: path.dirname(intent!.sourceFile), targetProjectDir: path.dirname(input.projectFile)})).versions);
        }
      } finally {store.close();}
      syncCopiedFile(stageHistory(intent));
      syncCopiedDirectory(localDir);
      const fileIdentity = copyIdentity(stageFile(intent));
      if (!fileIdentity) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '复制目标不再存在。');
      const response = projectCopyResponseSchema.parse({requestId: input.requestId, sourceProjectId: input.projectId,
        project: {projectId: intent.projectId, projectFile: input.projectFile, fileIdentity, name: input.name ?? copied.name ?? registration.name, lastOpenedAt: null, summary: null},
        contentSequence: copied.contentSequence, contentToken: copied.contentToken, versions});
      intent = save({...intent, phase: 'ready', stageIdentity: fileIdentity, historyIdentity: copyIdentity(stageHistory(intent)), response});
      rmSync(snapshotDirectory, {recursive: true});
      await boundary('ready', intent);
      return finish(intent);
    }, {rejectWindowLeases: true});
  }
  const call = (operation: ProjectCopyOperation, raw: ProjectCopyInput): Promise<ProjectCopyResponse> => {
    assertAllowed();
    const input = parse(raw), receipt = replay(operation, input);
    if (receipt) return Promise.resolve(receipt);
    const id = key(operation, input.requestId), digest = digestFor(operation, input), previous = running.get(id);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目复制。'));
      return previous.promise;
    }
    if (targets.has(input.projectFile)) return Promise.reject(copyFailure('PROJECT_COPY_BUSY', '目标正在复制，请保留请求 ID 稍后重试。'));
    const intent = records.read(operation, input.requestId);
    targets.add(input.projectFile);
    const promise = execute(operation, input, intent).finally(() => {running.delete(id); targets.delete(input.projectFile);});
    running.set(id, {digest, promise});
    return promise;
  };
  return {duplicate: async input => call('project.duplicate', input), saveAs: async input => call('project.save-as', input), replay,
    async recover(): Promise<void> {
      for (const intent of records.list()) {
        if (intent.phase === 'completed') {cleanup(intent); continue;}
        const receipt = library.receipts.read(intent.operation, intent.input.requestId);
        if (receipt) {
          if (receipt.digest !== intent.digest || !intent.response || canonicalJson(receipt.response) !== canonicalJson(intent.response)) {
            throw copyFailure('PROJECT_COPY_INTENT_INVALID', '复制恢复记录与已提交回执不一致。');
          }
          const completed = save({...intent, phase: 'completed'});
          cleanup(completed);
          continue;
        }
        if (['ready', 'records-published', 'project-published', 'completed'].includes(intent.phase)) {
          try {await call(intent.operation, intent.input);} catch { /* Keep exact intent and target; retry never overwrites unknown files. */ }
        }
      }
    },
    async drain(): Promise<void> {while (running.size) await Promise.allSettled([...running.values()].map(entry => entry.promise));},
  };
}
