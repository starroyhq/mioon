/** Project-file backups are local records, not projects. Listing and recovery
 * use the private index and the dedicated read-only kernel reader, never a
 * lease on the original project. */
import {randomBytes,randomUUID, createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {isProjectId} from '../../../../packages/contracts/src/project-file.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic, validateManagedFile, validatePrivateDirectory} from '../../../../packages/contracts/src/private-storage.ts';
import {projectBackupSchemas, projectBackupStatusSchema, projectBackupSummarySchema} from '../../../../packages/contracts/src/project-backups.ts';
import type {ProjectBackupStatus} from '../../../../packages/contracts/src/project-backups.ts';
import {legacyProjectBackupIndexSchema,legacyProjectBackupIntentSchema,projectBackupIndexSchema, projectBackupIntentSchema} from '../../../../packages/contracts/src/project-backup-records.ts';
import type {ProjectBackupEntry} from '../../../../packages/contracts/src/project-backup-records.ts';
import {createProjectBackup, openProjectBackup, inspectCopiedProjectFile, syncCopiedDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {copyProjectBackup} from '../../../../packages/business/src/project-file/copy.ts';
import type {ProjectFileFormat} from '../../../../packages/business/src/project-file/schema/databases.ts';
import {transferCopiedProjectConfirmations} from './copy-outside-confirmations.ts';
import type {CopyOutsidePaths} from './copy-outside-confirmations.ts';
import type {RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostContext} from './host.ts';
import type {ProjectFileIdentityPort, ProjectLifecycleHooks, ProjectRegistryPort} from './ports.ts';

const LIMIT = 1024 * 1024;
type Entry = ProjectBackupEntry;
type Status = ProjectBackupStatus;

const failure = (code: string, message: string, status = 409) => new AppError(code, message, status);
const exists = (file: string) => lstatSync(file, {throwIfNoEntry: false}) !== undefined;
const sameIdentity = (a: {dev: string; ino: string}, b: {dev: string; ino: string} | null) => b !== null && a.dev === b.dev && a.ino === b.ino;

export interface ProjectBackupsOptions {
  readonly outsidePaths?: CopyOutsidePaths;
  readonly directories: AppDirectories;
  readonly registry: ProjectRegistryPort;
  readonly identity: ProjectFileIdentityPort;
  readonly assertProjectFile: (file: string) => void;
  /** Trusted injection for failure/slow-I/O tests, never HTTP options. */
  readonly backup?: typeof createProjectBackup;
  /** Trusted in-process tests only. Defaults to the real native copy; there
   * is no HTTP/environment option for choosing a copy implementation. */
  readonly copy?: typeof copyProjectBackup;
  readonly openBackup?: typeof openProjectBackup;
  /** Trusted target format for isolated restores. The source backup is never upgraded. */
  readonly targetFormat?: ProjectFileFormat;
  readonly slowMs?: number;
  readonly onWarning?: (projectId: string, code: string) => void;
}

export function createProjectBackups({directories, registry, identity, assertProjectFile, outsidePaths, backup = createProjectBackup, copy = copyProjectBackup, openBackup = openProjectBackup, targetFormat, slowMs = 10_000,
  onWarning = (projectId, code) => console.warn('Project backup:', projectId, code)}: ProjectBackupsOptions) {
  const queues = new Map<string, Promise<unknown>>();
  const statuses = new Map<string, Status>();
  const targets = new Set<string>();
  // Published backups are immutable. Cache successful validation only, never
  // readers or failures; every hit still passes the private-file guard.
  const validated = new Map<string, string>();
  const rootFor = (projectId: string): string => {
    if (!isProjectId(projectId)) throw failure('VALIDATION_ERROR', '项目 ID 无效。', 400);
    return path.join(projectLocation(directories, projectId).localDir, 'backups');
  };
  const read = (root: string, name: string): unknown | null => {
    const text = readPrivateFile(path.join(root, name), {root, allowMissing: true, maxBytes: LIMIT, encoding: 'utf8'});
    if (text === null) return null;
    try { return JSON.parse(text as string); }
    catch { throw failure('PROJECT_BACKUP_INDEX_INVALID', '备份的本机记录损坏，原备份未更改。'); }
  };
  const write = (root: string, name: string, data: unknown) => writePrivateFileAtomic(path.join(root, name), JSON.stringify(data), {root, maxBytes: LIMIT});
  const durableWrite = (root: string, name: string, data: unknown) => {write(root, name, data); syncCopiedDirectory(root);};
  const index = (projectId: string): Entry[] => {
    const value = read(rootFor(projectId), 'index.json');
    if (value === null) return [];
    const parsed = projectBackupIndexSchema.safeParse(value);
    if(!parsed.success){
      const legacy=legacyProjectBackupIndexSchema.safeParse(value);
      if(legacy.success && legacy.data.projectId===projectId && legacy.data.backups.every(entry=>entry.projectId===projectId)
        && new Set(legacy.data.backups.map(entry=>entry.backupId)).size===legacy.data.backups.length)return [];
    }
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.backups.some(entry => entry.projectId !== projectId)
      || new Set(parsed.data.backups.map(entry => entry.backupId)).size !== parsed.data.backups.length) {
      throw failure('PROJECT_BACKUP_INDEX_INVALID', '备份索引无效，原备份未更改。');
    }
    return parsed.data.backups;
  };
  const fileFor = (projectId: string, backupId: string) => path.join(rootFor(projectId), backupId, 'project.mioon');
  const find = (projectId: string, backupId: string): Entry => {
    const found = index(projectId).find(entry => entry.backupId === backupId);
    if (!found) throw failure('PROJECT_BACKUP_NOT_FOUND', '找不到这份备份。', 404);
    validateManagedFile(fileFor(projectId, backupId), {root: rootFor(projectId), private: true});
    return found;
  };
  const validationKey = (entry: Entry): string => {
    const file = fileFor(entry.projectId, entry.backupId);
    validateManagedFile(file, {root: rootFor(entry.projectId), private: true});
    for(const suffix of ['-journal','-wal','-shm']){
      const sidecar=lstatSync(file+suffix,{throwIfNoEntry:false});
      if(sidecar && (sidecar.size>0 || !sidecar.isFile()))throw failure('PROJECT_BACKUP_CHANGED','备份存在未确认的日志，未执行恢复。');
    }
    const info = lstatSync(file, {bigint: true});
    // ctime/birthtime distinguish an inode reused for a different generation,
    // even when a replacement preserves its size and restores its mtime.
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs,
      entry.projectId, entry.contentSequence, entry.contentToken, entry.sizeBytes].join(':');
  };
  const verify = (entry: Entry, before = validationKey(entry)) => {
    const file = fileFor(entry.projectId, entry.backupId);
    const reader = openBackup(file);
    if (reader.identity.projectId !== entry.projectId || reader.identity.contentSequence !== entry.contentSequence || reader.identity.contentToken!==entry.contentToken || reader.identity.sizeBytes !== entry.sizeBytes) {
      reader.close();
      validated.delete(file);
      throw failure('PROJECT_BACKUP_CHANGED', '备份与索引不一致，未执行恢复。');
    }
    try {
      if (before !== validationKey(entry)) throw failure('PROJECT_BACKUP_CHANGED', '备份在校验期间改变，未执行恢复。');
      validated.set(file, before);
    } catch (error) {reader.close(); validated.delete(file); throw error;}
    return reader;
  };
  const confirm = (entry: Entry): void => {
    const file = fileFor(entry.projectId, entry.backupId);
    try {
      const key = validationKey(entry);
      if (validated.get(file) === key) return;
      validated.delete(file);
      const reader = verify(entry, key); reader.close();
    } catch (error) {validated.delete(file); throw error;}
  };
  const validEntries = (entries: Entry[]): Entry[] => entries.filter(entry => {
    try {confirm(entry); return true;} catch {return false;}
  });
  const cleanup = (projectId: string, retained: Entry[]): void => {
    const root = rootFor(projectId), keep = new Set(retained.map(entry => entry.backupId));
    // The per-project queue pins every reader. A crash can leave a complete
    // unindexed copy or an interrupted native staging directory; only our
    // reserved UUID directories and known SQLite staging names are removed.
    const removeOwned = (directory: string): void => {
      validatePrivateDirectory(directory);
      for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory() && /^copy-[A-Za-z0-9]+$/u.test(entry.name)) removeOwned(child);
        else if (entry.isFile() && /^(?:project\.mioon|[0-9a-f-]{36}\.sqlite)(?:-journal)?$/u.test(entry.name)) {
          validateManagedFile(child, {root, private: true}); rmSync(child); validated.delete(child);
        } else throw failure('PROJECT_BACKUP_CLEANUP_FAILED', '备份暂存目录包含未知文件，已保留。');
      }
      rmdirSync(directory);
    };
    for (const entry of readdirSync(root, {withFileTypes: true})) {
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(entry.name) && !keep.has(entry.name)) removeOwned(path.join(root, entry.name));
    }
    syncCopiedDirectory(root);
  };
  const enqueue = <T>(projectId: string, work: () => T | Promise<T>): Promise<T> => {
    const previous = queues.get(projectId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    queues.set(projectId, result);
    void result.finally(() => {if (queues.get(projectId) === result) queues.delete(projectId);}).catch(() => {});
    return result;
  };
  const initialStatus = (projectId: string): Status => ({projectId, state: 'idle', lastAttemptAt: null, lastCompletedAt: null, lastError: null});
  const readStatus = (projectId: string): Status => {
    const memory = statuses.get(projectId);
    if (memory) return memory;
    const raw = read(rootFor(projectId), 'status.json');
    if (raw === null) return initialStatus(projectId);
    const parsed = projectBackupStatusSchema.safeParse(raw);
    if (!parsed.success || parsed.data.projectId !== projectId) throw failure('PROJECT_BACKUP_INDEX_INVALID', '备份状态记录无效。');
    // An interrupted process cannot leave a backup looking actively running.
    return parsed.data.state === 'running' || parsed.data.state === 'slow'
      ? {...parsed.data, state: 'failed', lastError: {code: 'PROJECT_BACKUP_INTERRUPTED', message: '上次备份未确认完成；已有备份保留。'}} : parsed.data;
  };
  const saveStatus = (value: Status): void => {
    statuses.set(value.projectId, value);
    try {write(rootFor(value.projectId), 'status.json', value);}
    catch {try {onWarning(value.projectId, 'PROJECT_BACKUP_STATUS_IO');} catch {}}
  };
  const recordFailure = (projectId: string, current: Status, error: unknown): void => {
    const candidate = error as {code?: unknown};
    const code = typeof candidate?.code === 'string' && /^[A-Z0-9_]+$/u.test(candidate.code) ? candidate.code : 'PROJECT_BACKUP_IO';
    saveStatus({...current, state: 'failed', lastError: {code, message: '项目备份未完成；已有备份保留，请检查存储空间和权限。'}});
    try {onWarning(projectId, code);} catch {}
  };
  const capture = (host: ProjectHostContext, reason: 'open' | 'close'): Promise<void> => enqueue(host.projectId, async () => {
    const projectId = host.projectId, root = rootFor(projectId);
    let current: Status = {...initialStatus(projectId), lastAttemptAt: new Date().toISOString(), state: 'running'};
    let pending: string | undefined, published = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      current = {...readStatus(projectId), lastAttemptAt: current.lastAttemptAt, state: 'running', lastError: null};
      ensurePrivateDirectory(root, {create: true});
      saveStatus(current);
      const indexed = index(projectId);
      const stamp=host.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file WHERE singleton=1').get();
      // Unchanged opens need only the latest valid copy. Inspecting/listing or
      // making a new copy checks the older entries when they are actually used.
      let latestIndex = 0;
      for (; latestIndex < indexed.length; latestIndex++) {
        try {confirm(indexed[latestIndex]); break;} catch { /* A bad copy never suppresses a replacement. */ }
      }
      const latest = indexed[latestIndex];
      if (latest && stamp && latest.contentSequence === stamp.contentSequence && latest.contentToken===stamp.contentToken) {
        const retained = indexed.slice(latestIndex);
        if (latestIndex !== 0) durableWrite(root, 'index.json', {version: 2, projectId, backups: retained});
        // Confirm the committed index's directory before deleting any orphan.
        syncCopiedDirectory(root);
        cleanup(projectId, retained);
        saveStatus({...current, state: 'idle'});
        return;
      }
      timer = setTimeout(() => {current = {...current, state: 'slow'}; saveStatus(current);}, slowMs);
      timer.unref();
      const backupId = randomUUID();
      const destination = path.join(root, backupId);
      mkdirSync(destination, {mode: 0o700});
      pending = destination;
      ensurePrivateDirectory(pending);
      const copied = await backup(host.store, path.join(pending, 'project.mioon'));
      if (copied.projectId !== projectId) throw failure('PROJECT_BACKUP_CHANGED', '备份项目身份不一致。');
      const entry: Entry = {...projectBackupSummarySchema.parse({backupId, projectId, contentSequence: copied.contentSequence,contentToken:copied.contentToken, createdAt: new Date().toISOString(), reason, sizeBytes: copied.sizeBytes}), sourceProjectDir: host.store.projectDir};
      const previous = validEntries(indexed.slice(latestIndex));
      const next = [entry, ...previous].slice(0, 3);
      // Publication of this index is the commit point. Never restore an older
      // index after removing its files, even when later cleanup fails.
      write(root, 'index.json', {version: 2, projectId, backups: next});
      published = true;
      syncCopiedDirectory(root);
      // createProjectBackup has already validated this finished native copy.
      validated.set(fileFor(projectId, backupId), validationKey(entry));
      current = {...current, state: 'idle', lastCompletedAt: entry.createdAt};
      saveStatus(current);
      cleanup(projectId, next);
    } catch (error) {
      recordFailure(projectId, current, error);
      if (!published && pending) {
        // Only this invocation's fresh staging directory, never an indexed one.
        try {rmSync(pending, {recursive: true, force: true});} catch {}
      }
    } finally {if (timer) clearTimeout(timer);}
  });
  const hooks: ProjectLifecycleHooks = {
    afterOpen: host => capture(host, 'open'),
    beforeClose: host => capture(host, 'close'),
  };
  const list = async ({projectId}: {projectId: string}) => enqueue(projectId, () => ({projectId, backups: validEntries(index(projectId)).map(({sourceProjectDir: _, ...entry}) => entry)}));
  const inspect = async ({projectId, backupId}: {projectId: string; backupId: string}) => enqueue(projectId, () => {
    const entry = find(projectId, backupId), reader = verify(entry);
    try {
      const tableCounts: Record<string, number> = {};
      const tables = reader.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      for (const row of tables) {
        const name = String(row.name);
        tableCounts[name] = Number(reader.db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()?.n);
      }
      return {...entry, projectName: reader.identity.name, tableCounts};
    } finally {reader.close();}
  });
  const restore = async ({projectId: sourceProjectId, backupId, requestId, projectFile}: {projectId: string; backupId: string; requestId: string; projectFile: string}) => enqueue(sourceProjectId, async () => {
    const root = rootFor(sourceProjectId), requests = path.join(root, 'restore-requests');
    if (!projectBackupSchemas['project.backup.restore'].safeParse({projectId: sourceProjectId, backupId, requestId, projectFile}).success || path.basename(projectFile).startsWith('.')) throw failure('VALIDATION_ERROR', '恢复需要请求 ID 和新的绝对项目文件路径。', 400);
    assertProjectFile(projectFile);
    if (targets.has(projectFile)) throw failure('PROJECT_BACKUP_RESTORE_BUSY', '目标正在恢复，请稍后重试。');
    targets.add(projectFile);
    try {
      const digest = createHash('sha256').update(JSON.stringify({sourceProjectId, backupId, projectFile})).digest('hex');
      const previous = read(requests, `${requestId}.json`);
      const parsedIntent = previous === null ? null : projectBackupIntentSchema.safeParse(previous);
      if (parsedIntent && !parsedIntent.success) {
        const legacy=legacyProjectBackupIntentSchema.safeParse(previous);
        if(!legacy.success)throw failure('PROJECT_BACKUP_INDEX_INVALID', '恢复回执无效，未更改目标。');
        const saved=legacy.data;
        if(saved.digest!==digest || saved.requestId!==requestId || saved.sourceProjectId!==sourceProjectId)throw failure('REQUEST_ID_REUSED', '请求 ID 已用于不同的恢复。');
        // No old unfinished request has evidence for a fixed target token.
        // Only a complete receipt may be replayed, without opening its file.
        if(saved.phase!=='registered' || !saved.project || !saved.fileIdentity || saved.backupId!==backupId || saved.projectFile!==projectFile
          || saved.projectId===sourceProjectId || saved.project.projectId!==saved.projectId || saved.project.projectFile!==projectFile
          || !sameIdentity(saved.fileIdentity,saved.project.fileIdentity))throw failure('PROJECT_BACKUP_INDEX_INVALID','旧版未完成的恢复回执缺少内容令牌，未更改目标。');
        const registered=registry.get(saved.projectId);
        if(!registered || registered.projectFile!==projectFile || !sameIdentity(saved.fileIdentity,registered.fileIdentity)
          || !sameIdentity(saved.fileIdentity,identity(projectFile)))throw failure('PROJECT_BACKUP_RESTORE_CHANGED','已恢复的目标与旧回执不一致，未重新创建。');
        return {requestId,sourceProjectId,backupId,project:saved.project};
      }
      let intent = parsedIntent?.success ? parsedIntent.data : null;
      if (intent && (intent.digest !== digest || intent.requestId !== requestId || intent.sourceProjectId !== sourceProjectId)) throw failure('REQUEST_ID_REUSED', '请求 ID 已用于不同的恢复。');
      if (intent && (intent.backupId !== backupId || intent.projectFile !== projectFile || intent.projectId === sourceProjectId
        || intent.project && (intent.project.projectId !== intent.projectId || intent.project.projectFile !== projectFile
          || !intent.fileIdentity || !sameIdentity(intent.fileIdentity, intent.project.fileIdentity)))) throw failure('PROJECT_BACKUP_INDEX_INVALID', '恢复回执的绑定无效，未更改目标。');
      if (!intent) {
        if (exists(projectFile)) throw failure('PROJECT_FILE_EXISTS', '目标项目文件已存在。');
        const source=verify(find(sourceProjectId,backupId));
        let sourceContentSequence:number,sourceContentToken:string;
        try{sourceContentSequence=source.identity.contentSequence;sourceContentToken=source.identity.contentToken;}finally{source.close();}
        registry.assertCanRegister?.();
        ensurePrivateDirectory(requests, {create: true});
        syncCopiedDirectory(root);
        intent = {version: 2, requestId, digest, sourceProjectId, backupId, projectFile, projectId: randomUUID(),sourceContentSequence,sourceContentToken,
          targetContentToken:randomBytes(16).toString('hex'), phase: 'prepared', fileIdentity: null, project: null};
        durableWrite(requests, `${requestId}.json`, intent);
      }
      // Exact replay must not open a database already held by its new host.
      // The private receipt and registration bind the published file identity.
      const registered = registry.get(intent.projectId);
      if (registered && registered.projectFile === projectFile
        && (!intent.fileIdentity || sameIdentity(intent.fileIdentity, registered.fileIdentity))
        && sameIdentity(registered.fileIdentity, identity(projectFile))) {
        const project = intent.project ?? registered;
        if (intent.phase !== 'registered' || !intent.project) durableWrite(requests, `${requestId}.json`, {...intent, phase: 'registered', fileIdentity: registered.fileIdentity, project});
        return {requestId, sourceProjectId, backupId, project};
      }
      if (!exists(projectFile)) {
        if (intent.phase !== 'prepared') throw failure('PROJECT_BACKUP_RESTORE_CHANGED', '已恢复的目标被移动或删除，未重新创建。');
        const entry = find(sourceProjectId, backupId), reader = verify(entry); reader.close();
        if(entry.contentSequence!==intent.sourceContentSequence || entry.contentToken!==intent.sourceContentToken)throw failure('PROJECT_BACKUP_CHANGED','备份内容与恢复意图不一致，未执行恢复。');
        await copy({backupFile: fileFor(sourceProjectId, backupId), sourceProjectDir: entry.sourceProjectDir, projectFile, projectId: intent.projectId,
          ...(targetFormat === undefined ? {} : {targetFormat}),
          contentToken:intent.targetContentToken,expectedSource:{projectId:sourceProjectId,contentSequence:intent.sourceContentSequence,contentToken:intent.sourceContentToken}});
      }
      const copied = inspectCopiedProjectFile(projectFile);
      const fileIdentity = identity(projectFile);
      if (copied.projectId !== intent.projectId || copied.contentSequence!==intent.sourceContentSequence || copied.contentToken!==intent.targetContentToken
        || !fileIdentity || intent.fileIdentity && !sameIdentity(intent.fileIdentity, fileIdentity)) throw failure('PROJECT_BACKUP_RESTORE_CHANGED', '目标与恢复回执不一致，未覆盖目标。');
      intent = {...intent, phase: 'published', fileIdentity};
      durableWrite(requests, `${requestId}.json`, intent);
      const existing = registry.get(intent.projectId);
      if (existing && (existing.projectFile !== projectFile || !sameIdentity(fileIdentity, existing.fileIdentity))) throw failure('PROJECT_BACKUP_RESTORE_CHANGED', '恢复项目的登记已改变。');
      const project: RecentProject = existing ?? {projectId: intent.projectId, projectFile, fileIdentity, name: copied.name ?? '恢复的项目', lastOpenedAt: null, summary: null};
      const confirmationReceipt = `${requestId}-confirmations.json`;
      const confirmation = read(requests, confirmationReceipt);
      if (confirmation !== null) {
        const receipt = typeof confirmation === 'object' && !Array.isArray(confirmation) ? confirmation as Record<string, unknown> : null;
        const boundIdentity = receipt?.fileIdentity;
        if (!receipt || Object.keys(receipt).length !== 8 || receipt.version !== 1 || receipt.sourceProjectId !== sourceProjectId ||
          receipt.projectId !== intent.projectId || receipt.requestId !== requestId || receipt.digest !== digest || receipt.consumed !== true ||
          !boundIdentity || typeof boundIdentity !== 'object' || !('dev' in boundIdentity) || !('ino' in boundIdentity) ||
          boundIdentity.dev !== fileIdentity.dev || boundIdentity.ino !== fileIdentity.ino ||
          !Array.isArray(receipt.directories) || receipt.directories.length > 20_000 ||
          receipt.directories.some(directory => typeof directory !== 'string' || directory.length > 4096 || !path.isAbsolute(directory)) ||
          new Set(receipt.directories).size !== receipt.directories.length) {
          throw failure('PROJECT_BACKUP_INDEX_INVALID', '素材位置确认回执无效，未重新授予权限。');
        }
      }
      if (outsidePaths && confirmation === null) {
        const entry = find(sourceProjectId, backupId);
        transferCopiedProjectConfirmations(outsidePaths, sourceProjectId, intent.projectId, entry.sourceProjectDir, directories => {
          durableWrite(requests, confirmationReceipt, {version: 1, sourceProjectId, projectId: intent!.projectId,
            requestId, digest, fileIdentity, directories, consumed: true});
        });
      }
      registry.upsert(project);
      durableWrite(requests, `${requestId}.json`, {...intent, phase: 'registered', project});
      return {requestId, sourceProjectId, backupId, project};
    } finally {targets.delete(projectFile);}
  });
  const drain = async (): Promise<void> => {
    // Closing an HTTP socket does not cancel native SQLite copies. Finish
    // admitted app-level recoveries before the library or app lock is closed.
    while (queues.size) await Promise.allSettled([...queues.values()]);
  };
  // Trusted composition only. Deleting the entire records folder must pin the
  // same source queue as backup readers and recovery intent/publication work.
  const withProjectRecords = <T>(projectId: string, work: () => T | Promise<T>): Promise<T> => {
    if (!isProjectId(projectId)) throw failure('VALIDATION_ERROR', '项目 ID 无效。', 400);
    return enqueue(projectId, work);
  };
  return {hooks, list, inspect, restore, drain, withProjectRecords, status: async ({projectId}: {projectId: string}) => readStatus(projectId)};
}
