import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {isAppLibraryHeld} from '@mioon/business/app-db/index';
import {projectFileRecoveryForHeld} from '@mioon/business/project-file/index';
import {PROJECT_ENTRY_LIMITS} from '../../../../packages/contracts/src/project-entry.ts';
import type {RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ApplicationFileGuard} from './application-storage.ts';
import type {CatalogRecovery} from './manager.ts';
import {catalogFileGeneration} from '../project-catalog-scan.ts';
import type {ProjectCatalogScanInput} from '../project-catalog-scan.ts';
import {createNodeProjectCatalogClient} from '../project-catalog-client.ts';
import type {ProjectCatalogClient} from '../project-catalog-client.ts';

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

export function createProjectCatalog({client = createNodeProjectCatalogClient(), guard, signal, checkpoint}: {
  readonly client?: ProjectCatalogClient;
  readonly guard?: ApplicationFileGuard;
  readonly signal: AbortSignal;
  readonly checkpoint: () => unknown;
}) {
  signal.addEventListener('abort', () => client.close(), {once: true});
  const formats = new Map<string, {generation: string; newer: boolean}>();
  let snapshot: ReturnType<ApplicationFileGuard['catalogSnapshot']> | undefined;
  return async (projects: readonly RecentProject[], isCurrent: (project: RecentProject) => boolean,
    mayInspectHeader: (file: string) => boolean): Promise<ReadonlyMap<string, CatalogRecovery>> => {
    checkpoint();
    // Background moved-file searches can finish together. They use the same
    // pending refresh without retaining a completed snapshot across reads.
    if (guard) snapshot ??= guard.catalogSnapshot(signal).finally(() => {snapshot = undefined;});
    const assertAllowed = await snapshot;
    const results = new Map<string, CatalogRecovery>();
    const pending: {project: RecentProject; input: ProjectCatalogScanInput}[] = [];
    for (const project of projects) {
      signal.throwIfAborted();
      const file = project.projectFile;
      try {
        const info = await metadata(file);
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
        const journal = await metadata(file + '-journal');
        assertAllowed?.(file + '-journal', journal);
        if (journal?.isFile() && journal.size > 0n && held(journal)) continue;
        const generation = catalogFileGeneration(info);
        if (formats.get(file)?.generation !== generation) formats.delete(file);
        pending.push({project, input: {
          file, generation, birthtime: String(info.birthtimeNs),
          journalGeneration: journal ? catalogFileGeneration(journal) : null,
          checkHeader: info.nlink === 1n && mayInspectHeader(file)
            && (info.ino === 0n || !formats.has(file) || !!journal?.isFile() && journal.size > 0n),
        }});
      } catch (error) {
        formats.delete(file);
        results.set(project.projectId, {error});
      }
    }
    const current = pending.filter(({project}) => isCurrent(project));
    if (current.length === 0) {
      checkpoint();
      return results;
    }
    checkpoint();
    const scanned = await client.scan(current.map(item => item.input)).catch(error => {
      checkpoint();
      throw error;
    });
    if (scanned.length !== current.length) throw new Error('Project catalog scanner returned an incomplete batch');
    for (const [index, {project, input}] of current.entries()) {
      const observed = scanned[index]!;
      if (observed.recovery === 'changed') continue;
      signal.throwIfAborted();
      try {
        const info = await metadata(input.file);
        assertAllowed?.(input.file, info);
        const generation = observed.generation ?? input.generation;
        if (!info || catalogFileGeneration(info) !== generation || String(info.birthtimeNs) !== (observed.birthtime ?? input.birthtime)) continue;
        const owner = held(info);
        if (owner) {
          results.set(project.projectId, owner);
          continue;
        }
        let result = observed.recovery;
        if ((result.state === 'clean' || result.state === 'recovered') && info.nlink === 1n && mayInspectHeader(input.file)) {
          if (observed.format && info.ino !== 0n) {
            if (formats.size >= PROJECT_ENTRY_LIMITS.maxEntries) formats.delete(formats.keys().next().value!);
            formats.set(input.file, observed.format);
          }
          const format = observed.format ?? formats.get(input.file);
          if (format?.generation === generation && format.newer) result = {state: 'invalid', reason: 'format-newer'};
        }
        results.set(project.projectId, {result});
      } catch (error) {
        formats.delete(input.file);
        results.set(project.projectId, {error});
      }
    }
    checkpoint();
    return results;
  };
}
