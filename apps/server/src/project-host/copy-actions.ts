import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {ensurePrivateDirectory, validatePrivateDirectory} from '../../../../packages/contracts/src/private-storage.ts';
import {projectCopyActionSchemas, projectCopyResponseSchema} from '../../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyActionInput, ProjectCopyActionOperation, ProjectAdoptCopyInput, ProjectCopyToInput, ProjectTemplateInput, ProjectCopyResponse} from '../../../../packages/contracts/src/project-copies.ts';
import type {AppLibrary} from '../../../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../../../packages/business/src/project-service-application.ts';
import {copyProjectToNewFile} from '../../../../packages/business/src/project-file/copy.ts';
import {captureClosedProjectSnapshot} from '../../../../packages/business/src/project-file/closed-copy.ts';
import {withLockedProjectCopy} from '../../../../packages/business/src/project-file/adopt-copy.ts';
import {createProjectCopyStagingDirectory, validateProjectCopyStagingDirectory, inspectCopiedProjectFile, openProjectBackup,
  publishProjectCopyFile, syncCopiedFile, syncCopiedDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {initializeProjectCopyHistory, readProjectCopyHistory} from '../../../../packages/business/src/project-file/copy-history.ts';
import {openProjectStore} from '../../../../packages/business/src/project-file/store.ts';
import {copyProjectVersionsToNewProjectInside} from '../../../../packages/business/src/project-versions/copy-to-project.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostManager} from './manager.ts';
import {copyFailure, copyIdentity, sameCopyIdentity} from './copy-records.ts';
import {createCopyActionRecords} from './copy-action-records.ts';
import type {ActionIntent} from './copy-action-records.ts';
import {copiedProjectConfirmationDirectories} from './copy-outside-confirmations.ts';
import {createProjectTemplateCatalog} from './templates.ts';
import type {ProjectTemplateCatalogEntry} from './templates.ts';

export type ProjectCopyActionBoundary = 'prepared' | 'captured' | 'staging' | 'ready' | 'records-prepared' | 'records-published' | 'directory-placeholder' | 'project-published' | 'registered';
type Replace = (file: string, expected: {projectId: string; contentSequence: number; contentToken: string; fileIdentity: {dev: string; ino: string}}) => void;
const fileFailure = (error: unknown): unknown => {
  if (error instanceof AppError) return error;
  const code = (error as {code?: unknown} | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new AppError(code, '没有权限访问所选项目或目标位置。', 403);
  if (code === 'EROFS') return new AppError('PROJECT_INVALID', '所选位置只读，无法保存项目。', 422, {database: 'project', reason: 'read-only'});
  if (code === 'EEXIST') return copyFailure('PROJECT_FILE_EXISTS', '目标文件或文件夹已存在。');
  if (code === 'ENOENT' || code === 'ENOTDIR') return copyFailure('PROJECT_LOCATION_INVALID', '所选项目或目标位置已不存在。', 400);
  if (code === 'ENOSPC' || code === 'EDQUOT') return copyFailure('PROJECT_COPY_CAPACITY', '目标位置的可用空间不足。', 507);
  return error;
};

/** Selected-file operations do not acquire the original project's runtime.
 * All source reads go through the closed-file kernel capabilities. */
export function createProjectCopyActions({manager, library, directories, assertProjectFile, signal, projectTemplates = [], onActionBoundary}: {
  manager: ProjectHostManager; library: AppLibrary; directories: AppDirectories; assertProjectFile: (file: string) => void;
  signal: AbortSignal; projectTemplates?: readonly ProjectTemplateCatalogEntry[];
  onActionBoundary?: (phase: ProjectCopyActionBoundary, input: ProjectCopyActionInput) => void | Promise<void>;
}) {
  const assertAllowed = createProjectServiceApplication(library, signal).assertMutationAllowed!;
  const records = createCopyActionRecords(directories.dataDir, assertAllowed), catalog = createProjectTemplateCatalog(projectTemplates);
  const running = new Map<string, {digest: string; promise: Promise<ProjectCopyResponse>}>(), targets = new Set<string>();
  const digestFor = (operation: ProjectCopyActionOperation, input: ProjectCopyActionInput) => createHash('sha256').update(canonicalJson({operation, input})).digest('hex');
  const key = (operation: ProjectCopyActionOperation, requestId: string) => `${operation}:${requestId}`;
  const targetFor = (operation: ProjectCopyActionOperation, input: ProjectCopyActionInput): string => operation === 'project.adopt-copy'
    ? (input as ProjectAdoptCopyInput).sourceFile : operation === 'project.copy-to' ? (input as ProjectCopyToInput).projectFile
      : path.join((input as ProjectTemplateInput).parentDir, (input as ProjectTemplateInput).name, (input as ProjectTemplateInput).name + '.mioon');
  const parse = (operation: ProjectCopyActionOperation, raw: ProjectCopyActionInput): ProjectCopyActionInput => {
    const result = projectCopyActionSchemas[operation].safeParse(raw);
    if (!result.success) throw copyFailure('VALIDATION_ERROR', '项目复制参数无效。', 400);
    const input = result.data;
    const paths = 'sourceFile' in input ? [input.sourceFile, targetFor(operation, input)] : [input.parentDir];
    if (paths.some(file => !path.isAbsolute(file) || path.normalize(file) !== file)) throw copyFailure('VALIDATION_ERROR', '请选择当前系统上的规范绝对路径。', 400);
    return input;
  };
  const work = (intent: ActionIntent) => records.work(intent.operation, intent.input.requestId);
  const localStage = (intent: ActionIntent) => path.join(work(intent), 'local');
  const historyStage = (intent: ActionIntent) => path.join(localStage(intent), 'history.db');
  const stageFile = (intent: ActionIntent) => path.join(intent.stageDirectory!, intent.targetDirectory ? path.basename(intent.targetFile) : 'project.mioon');
  const save = (intent: ActionIntent): ActionIntent => {records.write(intent); return intent;};
  const boundary = async (phase: ProjectCopyActionBoundary, intent: ActionIntent): Promise<void> => {await onActionBoundary?.(phase, intent.input); assertAllowed();};
  const ensureWork = (intent: ActionIntent): string => {ensurePrivateDirectory(records.root, {create: true}); ensurePrivateDirectory(work(intent), {create: true}); return work(intent);};
  const matches = (file: string, identity: ActionIntent['stageIdentity']) => sameCopyIdentity(copyIdentity(file), identity);
  const replayAction = (operation: ProjectCopyActionOperation, raw: ProjectCopyActionInput): ProjectCopyResponse | null => {
    assertAllowed();
    const input = parse(operation, raw), receipt = library.receipts.read(operation, input.requestId);
    if (!receipt) return null;
    if (receipt.digest !== digestFor(operation, input)) throw copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。');
    const result = projectCopyResponseSchema.safeParse(receipt.response);
    if (!result.success || result.data.requestId !== input.requestId || result.data.project.projectFile !== targetFor(operation, input)
      || 'sourceProjectId' in input && result.data.sourceProjectId !== input.sourceProjectId) throw copyFailure('PROJECT_COPY_INTENT_INVALID', '项目复制回执绑定无效。');
    const registered = library.registry.get(result.data.project.projectId);
    if (!registered || registered.projectFile !== result.data.project.projectFile || !sameCopyIdentity(registered.fileIdentity, result.data.project.fileIdentity)
      || !matches(registered.projectFile, registered.fileIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '已复制项目的位置或身份已改变，未重新创建。');
    return result.data;
  };
  const cleanupWork = (intent: ActionIntent): void => {
    const directory = work(intent);
    if (lstatSync(directory, {throwIfNoEntry: false})) {
      validatePrivateDirectory(directory);
      if (readdirSync(directory).some(name => !['source', 'recheck', 'local', 'cache', 'tmp'].includes(name))) return;
      rmSync(directory, {recursive: true});
    }
  };
  const cleanup = (intent: ActionIntent): void => {
    try {
      cleanupWork(intent);
      if (intent.stageDirectory && matches(intent.stageDirectory, intent.stageDirectoryIdentity)) {
        validateProjectCopyStagingDirectory(intent.stageDirectory);
        rmdirSync(intent.stageDirectory);
      }
    } catch { /* A committed receipt is final, including after the target moves. */ }
  };
  const abandon = (intent: ActionIntent): void => {
    if (intent.phase !== 'abandoned') intent = save({...intent, phase: 'abandoned'});
    if (intent.stageDirectory && matches(intent.stageDirectory, intent.stageDirectoryIdentity)) {
      validateProjectCopyStagingDirectory(intent.stageDirectory);
      const safeTree = (directory: string): boolean => readdirSync(directory).every(name => {
        const info = lstatSync(path.join(directory, name));
        return !info.isSymbolicLink() && (info.isDirectory() ? safeTree(path.join(directory, name)) : info.isFile() && info.nlink === 1);
      });
      if (safeTree(intent.stageDirectory) && matches(intent.stageDirectory, intent.stageDirectoryIdentity)) {
        rmSync(intent.stageDirectory, {recursive: true}); syncCopiedDirectory(path.dirname(intent.stageDirectory));
      }
    }
    cleanupWork(intent);
  };
  const checkAdopt = (intent: ActionIntent): void => {
    if (library.registry.copyOf({projectId: intent.sourceProjectId, projectFile: intent.sourceFile}) === null) {
      throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '登记原件已不在原处，所选文件不再是待转换的副本。');
    }
  };

  async function finish(raw: ActionIntent, replace?: Replace): Promise<ProjectCopyResponse> {
    let intent = raw;
    assertAllowed();
    if (!intent.response || !intent.stageIdentity || !intent.historyIdentity || !intent.stageDirectory) throw copyFailure('PROJECT_COPY_INTENT_INVALID', '项目复制尚未准备完整。');
    const response = intent.response, target = intent.targetFile;
    assertProjectFile(target);
    const published = matches(target, intent.stageIdentity);
    if (published && intent.targetDirectory && !matches(intent.targetDirectory, intent.stageDirectoryIdentity)) {
      throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '模板项目必须和完整素材文件夹一起发布。');
    }
    if (!published && !matches(intent.stageDirectory, intent.stageDirectoryIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '项目复制暂存目录已改变。');
    if (!published) validateProjectCopyStagingDirectory(intent.stageDirectory);
    if (!published) {
      if (!matches(stageFile(intent), intent.stageIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '准备好的项目文件已被替换。');
      const prepared = inspectCopiedProjectFile(stageFile(intent));
      if (prepared.projectId !== intent.projectId || prepared.contentSequence !== response.contentSequence || prepared.contentToken !== response.contentToken) {
        throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '准备好的项目内容已改变，未发布。');
      }
      if (intent.operation === 'project.template.instantiate') catalog.verifyPreparedAssets(intent.input.templateId, intent.input.templateVersion, intent.stageDirectory!);
    }
    if (intent.operation === 'project.adopt-copy' && !published && !replace) {
      checkAdopt(intent);
      const recheck = path.join(ensureWork(intent), 'recheck');
      if (lstatSync(recheck, {throwIfNoEntry: false})) {validatePrivateDirectory(recheck); rmSync(recheck, {recursive: true});}
      return withLockedProjectCopy({projectFile: intent.sourceFile, expectedIdentity: intent.sourceIdentity,
        expectedSource: {projectId: intent.sourceProjectId, ...intent.sourceStamp!}, snapshotDirectory: recheck,
        assertMutationAllowed: assertAllowed}, locked => finish(intent, locked.replace));
    }
    const local = projectLocation(directories, intent.projectId).localDir;
    ensurePrivateDirectory(path.dirname(local), {create: true});
    if (!intent.recordsIdentity) {validatePrivateDirectory(localStage(intent)); intent = save({...intent, recordsIdentity: copyIdentity(localStage(intent))}); await boundary('records-prepared', intent);}
    if (!lstatSync(local, {throwIfNoEntry: false})) {
      if (!matches(localStage(intent), intent.recordsIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '暂存本机记录已改变。');
      renameSync(localStage(intent), local); syncCopiedDirectory(path.dirname(local)); syncCopiedDirectory(work(intent));
    } else if (!matches(local, intent.recordsIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标本机记录位置已被占用。');
    if (!matches(path.join(local, 'history.db'), intent.historyIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标本机记录已被替换。');
    if (intent.phase === 'ready') {intent = save({...intent, phase: 'records-published'}); await boundary('records-published', intent);}
    if (!matches(target, intent.stageIdentity)) {
      if (intent.operation === 'project.adopt-copy') {
        checkAdopt(intent); assertAllowed();
        replace!(stageFile(intent), {projectId: intent.projectId, contentSequence: response.contentSequence, contentToken: response.contentToken, fileIdentity: intent.stageIdentity!});
      } else if (intent.targetDirectory) {
        const folder = intent.targetDirectory;
        if (!lstatSync(folder, {throwIfNoEntry: false})) {
          mkdirSync(folder, {mode: 0o700});
          intent = save({...intent, directoryPlaceholderIdentity: copyIdentity(folder)});
          syncCopiedDirectory(path.dirname(folder)); await boundary('directory-placeholder', intent);
        }
        if (!matches(folder, intent.directoryPlaceholderIdentity) || readdirSync(folder).length !== 0) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '模板目标文件夹已被占用，未合并或覆盖。');
        renameSync(intent.stageDirectory!, folder); syncCopiedDirectory(path.dirname(folder));
      } else {
        const found = copyIdentity(target);
        if (found && !sameCopyIdentity(found, intent.placeholderIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标已被其他文件占用。');
        if (found) {unlinkSync(target); syncCopiedDirectory(path.dirname(target)); intent = save({...intent, placeholderIdentity: null});}
        publishProjectCopyFile(stageFile(intent), target, {onPlaceholder: identity => {intent = save({...intent, placeholderIdentity: identity});}});
      }
    }
    if (!matches(target, intent.stageIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '已发布文件身份与准备结果不一致。');
    if (!intent.targetDirectory && matches(stageFile(intent), intent.stageIdentity)) {unlinkSync(stageFile(intent)); syncCopiedDirectory(intent.stageDirectory!);}
    intent = save({...intent, phase: 'project-published', placeholderIdentity: null, directoryPlaceholderIdentity: null});
    await boundary('project-published', intent);
    const registered = library.registry.get(intent.projectId);
    if (registered && (registered.projectFile !== target || !sameCopyIdentity(registered.fileIdentity, intent.stageIdentity))) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '新项目登记已改变。');
    if (!registered) {
      const identity = inspectCopiedProjectFile(target);
      if (identity.projectId !== intent.projectId || identity.contentSequence !== response.contentSequence || identity.contentToken !== response.contentToken) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '目标内容身份已改变。');
      const store = openProjectStore({projectFile: target, locate: id => projectLocation(directories, id), checkCopy: library.registry.checkCopy});
      try {if (store.historyState !== 'current') throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '新项目记录身份不匹配。');} finally {store.close();}
    }
    const confirmations = intent.operation === 'project.copy-to' ? copiedProjectConfirmationDirectories(library.outsidePaths, intent.sourceProjectId, path.dirname(intent.sourceFile)) : [];
    if (intent.operation === 'project.template.instantiate') {
      if (!matches(intent.targetDirectory!, intent.stageDirectoryIdentity)) throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '模板项目文件夹身份已改变。');
      catalog.verifyPreparedAssets(intent.input.templateId, intent.input.templateVersion, intent.targetDirectory!);
    }
    assertAllowed();
    library.tx(() => {
      assertAllowed(); if (!registered) library.registry.upsert(response.project);
      for (const directory of confirmations) library.outsidePaths.confirm({projectId: intent.projectId, directory, confirmedAt: new Date().toISOString()});
      library.receipts.write({operation: intent.operation, requestId: intent.input.requestId, digest: intent.digest, response, createdAt: new Date().toISOString()});
    });
    await boundary('registered', intent);
    intent = save({...intent, phase: 'completed'}); cleanup(intent); return response;
  }

  async function build(raw: ActionIntent, sourceFile: string, sourceHistory: string | null, replace?: Replace): Promise<ProjectCopyResponse> {
    let intent = raw;
    const parent = intent.targetDirectory ? path.dirname(intent.targetDirectory) : path.dirname(intent.targetFile);
    const stageDirectory = createProjectCopyStagingDirectory(parent, '.project-copy-');
    intent = save({...intent, stageDirectory, stageDirectoryIdentity: copyIdentity(stageDirectory)}); await boundary('staging', intent);
    const template = intent.operation === 'project.template.instantiate' ? catalog.prepareAssets(intent.input.templateId, intent.input.templateVersion,
      {directory: stageDirectory, targetDirectory: intent.targetDirectory!, locale: intent.input.locale, assertMutationAllowed: assertAllowed}) : null;
    const source = openProjectBackup(sourceFile);
    let copied: Awaited<ReturnType<typeof copyProjectToNewFile>>;
    try {
      copied = await copyProjectToNewFile(source, {projectFile: stageFile(intent), sourceProjectDir: path.dirname(intent.sourceFile),
        targetProjectDir: path.dirname(intent.targetFile), projectId: intent.projectId, contentToken: intent.contentToken,
        expectedSource: {projectId: intent.sourceProjectId, ...intent.sourceStamp!}, clearProcessRevisions: true,
        ...('name' in intent.input ? {projectName: intent.input.name} : {}),
        ...(template ? {referenceTargets: template.referenceTargets, templatePresentation: template.presentation} : {}),
        publish: (from, to) => publishProjectCopyFile(from, to)});
    } finally {source.close();}
    assertAllowed();
    ensurePrivateDirectory(localStage(intent), {create: true}); initializeProjectCopyHistory(historyStage(intent), intent.projectId, copied);
    const store = openProjectStore({projectFile: stageFile(intent), locate: () => ({localDir: localStage(intent), cacheDir: path.join(work(intent), 'cache'), tempDir: path.join(work(intent), 'tmp')})});
    let versions = 0;
    try {
      if (store.historyState !== 'current') throw copyFailure('PROJECT_COPY_TARGET_CHANGED', '复制初始记录身份不匹配。');
      if (sourceHistory) versions = readProjectCopyHistory(sourceHistory, previous => store.tx(() => copyProjectVersionsToNewProjectInside(previous, store.db,
        {sourceProjectId: intent.sourceProjectId, projectId: intent.projectId, sourceProjectDir: path.dirname(intent.sourceFile), targetProjectDir: path.dirname(intent.targetFile)})).versions);
    } finally {store.close();}
    syncCopiedFile(historyStage(intent)); syncCopiedDirectory(localStage(intent));
    const fileIdentity = copyIdentity(stageFile(intent));
    const response = projectCopyResponseSchema.parse({requestId: intent.input.requestId, sourceProjectId: intent.sourceProjectId,
      project: {projectId: intent.projectId, projectFile: intent.targetFile, fileIdentity, name: copied.name ?? 'Project', lastOpenedAt: null, summary: null},
      contentSequence: copied.contentSequence, contentToken: copied.contentToken, versions});
    intent = save({...intent, phase: 'ready', stageIdentity: fileIdentity, historyIdentity: copyIdentity(historyStage(intent)), response});
    // Full source history is conversion input only. The complete target and
    // its rebound versions suffice for every continuation after ready.
    rmSync(path.join(work(intent), 'source'), {recursive: true, force: true});
    await boundary('ready', intent); return finish(intent, replace);
  }

  async function execute(operation: ProjectCopyActionOperation, input: ProjectCopyActionInput, existing: ActionIntent | null): Promise<ProjectCopyResponse> {
    if (existing) {
      if (existing.digest !== digestFor(operation, input)) throw copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。');
      if (['prepared', 'captured', 'abandoned'].includes(existing.phase)) {abandon(existing); throw copyFailure('PROJECT_COPY_INTERRUPTED', '复制准备已中断并作废，请重新发起。');}
      return finish(existing);
    }
    const template = operation === 'project.template.instantiate' ? catalog.describe((input as ProjectTemplateInput).templateId, (input as ProjectTemplateInput).templateVersion) : null;
    const sourceFile = template?.projectFile ?? (input as ProjectAdoptCopyInput).sourceFile;
    const sourceProjectId = template?.projectId ?? (input as ProjectAdoptCopyInput).sourceProjectId, targetFile = targetFor(operation, input);
    assertProjectFile(sourceFile); assertProjectFile(targetFile);
    if (operation !== 'project.adopt-copy' && lstatSync(operation === 'project.template.instantiate' ? path.dirname(targetFile) : targetFile, {throwIfNoEntry: false})) throw copyFailure('PROJECT_FILE_EXISTS', '目标文件或文件夹已存在。');
    const sourceIdentity = copyIdentity(sourceFile);
    if (!sourceIdentity || !template && !sameCopyIdentity(sourceIdentity, (input as ProjectAdoptCopyInput).sourceIdentity)) throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '所选源文件身份已改变。');
    if (operation === 'project.copy-to' && manager.status(sourceProjectId)) throw copyFailure('PROJECT_HOST_BUSY', '源项目尚未关闭。');
    if (operation === 'project.adopt-copy' && library.registry.copyOf({projectId: sourceProjectId, projectFile: sourceFile}) === null) {
      throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '所选文件不再是仍有登记原件的副本。');
    }
    library.registry.assertCanRegister?.(); assertAllowed();
    let intent = save({version: 1, operation, input, digest: digestFor(operation, input), projectId: randomUUID(), contentToken: randomBytes(16).toString('hex'),
      sourceFile, sourceProjectId, sourceIdentity, sourceStamp: template?.sourceStamp ?? (input as ProjectAdoptCopyInput).sourceStamp,
      targetFile, targetDirectory: operation === 'project.template.instantiate' ? path.dirname(targetFile) : null,
      phase: 'prepared', stageDirectory: null, stageDirectoryIdentity: null, stageIdentity: null, historyIdentity: null, recordsIdentity: null,
      placeholderIdentity: null, directoryPlaceholderIdentity: null, response: null} as ActionIntent);
    if (operation === 'project.adopt-copy') checkAdopt(intent);
    await boundary('prepared', intent);
    const directory = path.join(ensureWork(intent), 'source');
    if (operation === 'project.adopt-copy') return withLockedProjectCopy({projectFile: sourceFile, expectedIdentity: sourceIdentity,
      expectedSource: {projectId: sourceProjectId, ...intent.sourceStamp!}, snapshotDirectory: directory, assertMutationAllowed: assertAllowed}, async locked => {
        intent = save({...intent, phase: 'captured'}); await boundary('captured', intent); return build(intent, locked.projectFile, null, locked.replace);
      });
    if (!matches(sourceFile, intent.sourceIdentity)) throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '所选源文件已被替换。');
    if (operation === 'project.copy-to' && manager.status(sourceProjectId)) throw copyFailure('PROJECT_HOST_BUSY', '源项目尚未关闭。');
    const captured = await captureClosedProjectSnapshot({projectFile: sourceFile, directory, assertMutationAllowed: assertAllowed,
      historyFile: id => operation === 'project.copy-to' ? path.join(projectLocation(directories, id).localDir, 'history.db') : path.join(work(intent), 'no-template-history')});
    if (!matches(sourceFile, intent.sourceIdentity)) throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '所选源文件已被替换。');
    if (operation === 'project.copy-to' && (manager.status(sourceProjectId) || !captured.historyFile
      && lstatSync(path.join(projectLocation(directories, sourceProjectId).localDir, 'history.db'), {throwIfNoEntry: false}))) {
      throw copyFailure('PROJECT_HOST_BUSY', '源项目的本机记录在复制期间被打开或创建，请关闭后重试。');
    }
    if (captured.identity.projectId !== sourceProjectId || intent.sourceStamp && (captured.identity.contentSequence !== intent.sourceStamp.contentSequence || captured.identity.contentToken !== intent.sourceStamp.contentToken)) throw copyFailure('PROJECT_COPY_SOURCE_CHANGED', '所选源项目内容已改变。');
    intent = save({...intent, phase: 'captured', sourceStamp: {contentSequence: captured.identity.contentSequence, contentToken: captured.identity.contentToken}});
    await boundary('captured', intent); return build(intent, captured.projectFile, captured.historyFile);
  }

  const call = (operation: ProjectCopyActionOperation, raw: ProjectCopyActionInput): Promise<ProjectCopyResponse> => {
    assertAllowed();
    const input = parse(operation, raw), replay = replayAction(operation, input);
    if (replay) return Promise.resolve(replay);
    const id = key(operation, input.requestId), digest = digestFor(operation, input), previous = running.get(id);
    if (previous) {if (previous.digest !== digest) return Promise.reject(copyFailure('REQUEST_ID_REUSED', '请求 ID 已用于不同的项目操作。')); return previous.promise;}
    const intent = records.read(operation, input.requestId), target = targetFor(operation, input);
    if (targets.has(target)) return Promise.reject(copyFailure('PROJECT_COPY_BUSY', '目标正在复制，请稍后重试。'));
    targets.add(target);
    const promise = execute(operation, input, intent).catch(error => {throw fileFailure(error);}).finally(() => {running.delete(id); targets.delete(target);});
    running.set(id, {digest, promise}); return promise;
  };
  return {
    adoptCopy: async (input: ProjectAdoptCopyInput) => call('project.adopt-copy', input),
    copyTo: async (input: ProjectCopyToInput) => call('project.copy-to', input),
    instantiateTemplate: async (input: ProjectTemplateInput) => call('project.template.instantiate', input), replayAction,
    async recover(): Promise<void> {
      assertAllowed();
      for (let intent of records.list()) {
        const receipt = library.receipts.read(intent.operation, intent.input.requestId);
        if (receipt) {
          if (receipt.digest !== intent.digest || !intent.response || canonicalJson(receipt.response) !== canonicalJson(intent.response)) throw copyFailure('PROJECT_COPY_INTENT_INVALID', '恢复记录与回执不一致。');
          intent = save({...intent, phase: 'completed'}); cleanup(intent); continue;
        }
        if (intent.phase === 'completed') {cleanup(intent); continue;}
        if (['prepared', 'captured', 'abandoned'].includes(intent.phase)) {
          try {abandon(intent);} catch { /* Keep the intent for a later cleanup; unavailable media must not block startup. */ }
          continue;
        }
        try {await call(intent.operation, intent.input);} catch { /* Preserve published identities; never overwrite another file on startup. */ }
      }
    },
    async drain(): Promise<void> {while (running.size) await Promise.allSettled([...running.values()].map(value => value.promise));},
  };
}
