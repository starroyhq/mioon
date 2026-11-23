import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {isAppLibraryHeld} from '@mioon/business/app-db/index';
import {projectFileRecoveryForHeld} from '@mioon/business/project-file/index';
import {PROJECT_ENTRY_LIMITS} from '../../../../packages/contracts/src/project-entry.ts';
import type {RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ApplicationFileGuard} from './application-storage.ts';
import type {CatalogRecovery} from './manager.ts';
import {catalogFileGeneration} from '../project-catalog-scan.ts';
import type {ProjectCatalogScanInput, ProjectCatalogScanResult} from '../project-catalog-scan.ts';
import {createNodeProjectCatalogClient} from '../project-catalog-client.ts';
import type {ProjectCatalogClient} from '../project-catalog-client.ts';

// Stay within the 15-second native directory request budget, with time for
// the server to send registration metadata when a volume does not respond.
const catalogTimeoutMs = 10_000;
// Leave libuv capacity for unrelated work even if moved registrations point
// at different stalled volumes. The private-tree walk uses one more slot.
const maxMetadataReads = 2;
const metadataReadLimit = Symbol('project catalog metadata capacity');
type SharedRead<T> = (signal: AbortSignal) => Promise<T>;

function shareRead<T>(operation: Promise<T>, release?: () => void): SharedRead<T> {
  type Outcome = {value: T} | {error: unknown};
  const waiting = new Set<(outcome: Outcome) => void>();
  let result: Outcome | undefined;
  const finish = (outcome: Outcome) => {
    result = outcome;
    release?.();
    for (const notify of waiting) notify(outcome);
  };
  void operation.then(value => finish({value}), error => finish({error}));
  return signal => new Promise((resolve, reject) => {
    const notify = (outcome: Outcome) => {
      waiting.delete(notify);
      signal.removeEventListener('abort', stop);
      if ('value' in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    const stop = () => notify({error: signal.reason});
    if (signal.aborted) stop();
    else if (result) notify(result);
    else {
      waiting.add(notify);
      signal.addEventListener('abort', stop, {once: true});
    }
  });
}

async function metadata(file: string): Promise<BigIntStats | undefined> {
  try {return await lstat(file, {bigint: true});}
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function held(info: BigIntStats): CatalogRecovery | undefined {
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  const result = projectFileRecoveryForHeld(identity);
  if (result) return {result};
  if (isAppLibraryHeld(identity)) return {result: {state: 'invalid', reason: 'not-a-project-file'}};
}

export function createProjectCatalog({client = createNodeProjectCatalogClient(), guard, signal, checkpoint, timeoutMs = catalogTimeoutMs, targetFormat = 5}: {
  readonly client?: ProjectCatalogClient;
  readonly guard?: ApplicationFileGuard;
  readonly signal: AbortSignal;
  readonly checkpoint: () => unknown;
  readonly timeoutMs?: number;
  readonly targetFormat?: number;
}) {
  signal.addEventListener('abort', () => client.close(), {once: true});
  const formats = new Map<string, NonNullable<ProjectCatalogScanResult['format']>>();
  const reads = new Map<string, SharedRead<BigIntStats | undefined>>();
  let snapshot: SharedRead<Awaited<ReturnType<ApplicationFileGuard['catalogSnapshot']>>> | undefined;
  const readMetadata = (file: string, scanSignal: AbortSignal): Promise<BigIntStats | undefined> => {
    scanSignal.throwIfAborted();
    let read = reads.get(file);
    if (!read) {
      if (reads.size >= maxMetadataReads) throw metadataReadLimit;
      read = shareRead(metadata(file), () => {reads.delete(file);});
      reads.set(file, read);
    }
    return read(scanSignal);
  };
  return async (projects: readonly RecentProject[], isCurrent: (project: RecentProject) => boolean,
    mayInspectHeader: (file: string) => boolean): Promise<ReadonlyMap<string, CatalogRecovery>> => {
    checkpoint();
    const scanSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const results = new Map<string, CatalogRecovery>();
    // Hold optional format hints separately until the batch has finished.
    const inspected = new Map<string, CatalogRecovery>();
    try {
      await inspect(projects, isCurrent, mayInspectHeader, scanSignal, results, inspected);
    } catch {
      // The registry and application fence are authoritative. A failed
      // inspection may leave metadata-only rows, never a stale format hint.
      checkpoint();
      return results;
    }
    checkpoint();
    for (const [id, observation] of inspected) results.set(id, observation);
    return results;
  };

  async function inspect(projects: readonly RecentProject[], isCurrent: (project: RecentProject) => boolean,
    mayInspectHeader: (file: string) => boolean, scanSignal: AbortSignal, results: Map<string, CatalogRecovery>,
    inspected: Map<string, CatalogRecovery>): Promise<void> {
    // Retain the underlying walk until its filesystem operation settles.
    // Timed-out callers detach; they cannot multiply blocked libuv jobs.
    if (guard) snapshot ??= shareRead(guard.catalogSnapshot(scanSignal), () => {snapshot = undefined;});
    const assertAllowed = await snapshot?.(scanSignal);
    const pending: {project: RecentProject; info: BigIntStats; journal?: BigIntStats; input: ProjectCatalogScanInput}[] = [];
    for (const project of projects) {
      scanSignal.throwIfAborted();
      const file = project.projectFile;
      try {
        const info = await readMetadata(file, scanSignal);
        scanSignal.throwIfAborted();
        assertAllowed?.(file, info);
        if (!info) {
          formats.delete(file);
          results.set(project.projectId, {result: {state: 'missing'}});
          continue;
        }
        if (!info.isFile()) {
          formats.delete(file);
          results.set(project.projectId, {result: {state: 'invalid', reason: 'not-a-regular-file'}});
          continue;
        }
        const owner = held(info);
        if (owner) {
          results.set(project.projectId, owner);
          continue;
        }
        const journal = await readMetadata(file + '-journal', scanSignal);
        scanSignal.throwIfAborted();
        assertAllowed?.(file + '-journal', journal);
        const generation = catalogFileGeneration(info);
        if (formats.get(file)?.generation !== generation) formats.delete(file);
        pending.push({project, info, journal, input: {
          file, generation, birthtime: String(info.birthtimeNs),
          journalGeneration: journal ? catalogFileGeneration(journal) : null,
          checkHeader: info.nlink === 1n && mayInspectHeader(file)
            && (info.ino === 0n || !formats.has(file) || !!journal?.isFile() && journal.size > 0n),
          targetFormat,
        }});
      } catch (error) {
        scanSignal.throwIfAborted();
        if (error === metadataReadLimit) throw error;
        formats.delete(file);
        results.set(project.projectId, {error});
      }
    }
    const current = pending.filter(({project, info, journal, input}) => {
      if (!isCurrent(project)) return false;
      try {
        // A synchronous guard or host admission can run while the metadata
        // awaits yield. Recheck the live sets before admitting scanner reads.
        assertAllowed?.(input.file, info);
        assertAllowed?.(input.file + '-journal', journal);
        const owner = held(info);
        if (owner) results.set(project.projectId, owner);
        else if (journal?.isFile() && journal.size > 0n && held(journal)) results.set(project.projectId, {pending: true});
        else return true;
      } catch (error) {
        results.set(project.projectId, {error});
      }
      return false;
    });
    if (current.length === 0) return;
    checkpoint();
    const scanned = await shareRead(client.scan(current.map(item => item.input), scanSignal))(scanSignal);
    if (scanned.length !== current.length) throw new Error('Project catalog scanner returned an incomplete batch');
    for (const [index, {project, input}] of current.entries()) {
      const observed = scanned[index]!;
      scanSignal.throwIfAborted();
      if (observed.recovery === 'changed') {
        results.set(project.projectId, {pending: true});
        continue;
      }
      try {
        const info = await readMetadata(input.file, scanSignal);
        scanSignal.throwIfAborted();
        assertAllowed?.(input.file, info);
        const generation = observed.generation ?? input.generation;
        if (!info || catalogFileGeneration(info) !== generation || String(info.birthtimeNs) !== (observed.birthtime ?? input.birthtime)) {
          results.set(project.projectId, {pending: true});
          continue;
        }
        const owner = held(info);
        if (owner) {
          results.set(project.projectId, owner);
          continue;
        }
        let result: Extract<CatalogRecovery, {result: unknown}>['result'] = observed.recovery;
        if (result.state === 'clean') {
          const journal = await readMetadata(input.file + '-journal', scanSignal);
          scanSignal.throwIfAborted();
          assertAllowed?.(input.file, info);
          assertAllowed?.(input.file + '-journal', journal);
          const journalGeneration = journal ? catalogFileGeneration(journal) : null;
          if (journalGeneration !== input.journalGeneration || journal?.isFile() && journal.size > 0n && held(journal)) {
            results.set(project.projectId, {pending: true});
            continue;
          }
        }
        if ((result.state === 'clean' || result.state === 'recovered') && info.nlink === 1n && mayInspectHeader(input.file)) {
          if (observed.format && info.ino !== 0n) {
            if (formats.size >= PROJECT_ENTRY_LIMITS.maxEntries) formats.delete(formats.keys().next().value!);
            formats.set(input.file, observed.format);
          }
          const format = input.checkHeader ? observed.format : formats.get(input.file);
          if (format?.generation === generation) {
            if (format.status === 'newer') result = {state: 'invalid', reason: 'format-newer'};
            if (format.status === 'upgrade-required') result = {state: 'upgrade-required'};
          }
        }
        inspected.set(project.projectId, {result});
      } catch (error) {
        scanSignal.throwIfAborted();
        if (error === metadataReadLimit) throw error;
        formats.delete(input.file);
        results.set(project.projectId, {error});
      }
    }
  }
}
