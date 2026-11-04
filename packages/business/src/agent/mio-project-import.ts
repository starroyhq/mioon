import {lstatSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isMioProjectMediaRelativePath} from '../../../contracts/src/mio-project-media.ts';
import {mioProjectFileImportInputSchema} from '../../../contracts/src/mio-project-import.ts';
import type {MioProjectFileImportInput} from '../../../contracts/src/mio-project-import.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from '../project-file/held-files.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {isInsideRealDirectory} from '../media-reference/paths.ts';
import {readProjectUnpublishedMediaSnapshot} from '../referenced-asset-unpublished.ts';
import {readProjectOutputUnpublishedSnapshot} from '../project-output-unpublished.ts';
import {createReferencedAssetProjectImport, projectAssetImportPreparationSchema} from '../referenced-asset-project-import.ts';
import type {ProjectAssetImportContext, ProjectAssetImportPreparation, ProjectAssetImportCreationProof,
  ProjectAssetImportExecution, ProjectAssetImportLookup} from '../referenced-asset-project-import.ts';
import type {OrdinaryServices} from '../services.ts';
import {createMioProjectScope} from './mio-project-scope.ts';

interface PrepareContext extends ProjectAssetImportContext {readonly requestId: string; readonly retained?: unknown}
interface ExecuteContext extends ProjectAssetImportContext {readonly recordCreatedInside: (proof: ProjectAssetImportCreationProof) => void}
export interface MioProjectImportPort {
  prepare(projectId: string, input: MioProjectFileImportInput, context: PrepareContext): Promise<ProjectAssetImportPreparation>;
  execute(preparation: ProjectAssetImportPreparation, context: ExecuteContext): Promise<ProjectAssetImportExecution>;
  lookup(preparation: ProjectAssetImportPreparation, context: ProjectAssetImportContext): Promise<ProjectAssetImportLookup>;
}
function invalid(): never {throw new AppError('AGENT_TASK_INVALID_TARGET', '只能导入当前项目内可见且已完整发布的媒体文件', 409, {mutationOutcome: 'not_applied'});}
function changed(): never {throw new AppError('AGENT_TASK_TARGET_CHANGED', '准备的项目文件已变化，请重新选择', 409, {mutationOutcome: 'not_applied'});}
function sameSource(prepared: ProjectAssetImportPreparation, file: string, info: BigIntStats): boolean {
  const expected = prepared.sourceIdentity;
  return prepared.file === file && expected.dev === String(info.dev) && expected.ino === String(info.ino) &&
    expected.birthtimeNs === String(info.birthtimeNs) && expected.size === String(info.size) &&
    expected.mtimeNs === String(info.mtimeNs) && expected.ctimeNs === String(info.ctimeNs);
}

/** Native project capability. The S1 importer owns media validation and the
 * registration transaction; this adapter only narrows its filesystem scope. */
export function createMioProjectImport({store, services, privateDirectories, signal}: {
  readonly store: ProjectStore; readonly services: Pick<OrdinaryServices, 'call'>;
  readonly privateDirectories: readonly string[]; readonly signal?: AbortSignal;
}): MioProjectImportPort {
  const scope = createMioProjectScope({store, privateDirectories, signal});
  const importer = createReferencedAssetProjectImport(store, {importPath: (input, context) =>
    services.call('asset.import', input, {signal: context.signal})});
  const combined = (caller?: AbortSignal): AbortSignal | undefined => signal && caller ? AbortSignal.any([signal, caller]) : signal ?? caller;
  function owner(context: ProjectAssetImportContext): () => void {
    const lifetime = combined(context.signal);
    return () => {lifetime?.throwIfAborted(); scope.live(); context.beforeEffect(); lifetime?.throwIfAborted(); scope.live();};
  }
  function locate(relative: string): {file: string; info: BigIntStats} {
    if (!isMioProjectMediaRelativePath(relative)) invalid();
    let file: string, info: BigIntStats;
    try {file = realpathSync(path.join(scope.directory, relative)); info = lstatSync(file, {bigint: true});} catch {return changed();}
    const actual = path.relative(scope.realDirectory, file).split(path.sep).join('/');
    if (!info.isFile() || !isInsideRealDirectory(scope.realDirectory, file) || !isMioProjectMediaRelativePath(actual) || scope.isPrivate(file)) invalid();
    const identity = {dev: String(info.dev), ino: String(info.ino)};
    if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) invalid();
    return {file, info};
  }
  async function publicationFence(relative: string, context: ProjectAssetImportContext) {
    const live = owner(context), fence = () => {live(); locate(relative);};
    fence();
    const imports = await readProjectUnpublishedMediaSnapshot(store, {...context, beforeEffect: fence});
    const publications = await readProjectOutputUnpublishedSnapshot(store, {...context, beforeEffect: fence});
    const check = () => {
      fence(); imports.assertCurrent(); publications.assertCurrent(); const source = locate(relative);
      if (imports.isExcluded(source.file, source.info) || publications.isExcluded(source.file, source.info)) invalid();
      fence();
    };
    check(); return {check, source: locate(relative)};
  }
  return {
    async prepare(projectId, input, context) {
      if (projectId !== scope.projectId) invalid();
      const parsed = mioProjectFileImportInputSchema.safeParse(input); if (!parsed.success) invalid();
      const effect = {...context, signal: combined(context.signal)};
      const admitted = await publicationFence(parsed.data.path, effect);
      if (context.retained !== undefined) {
        const prepared = projectAssetImportPreparationSchema.parse(context.retained);
        if (prepared.input.projectId !== projectId || prepared.input.requestId !== context.requestId ||
            prepared.input.name !== parsed.data.name || !sameSource(prepared, admitted.source.file, admitted.source.info)) changed();
        admitted.check(); return prepared;
      }
      const prepared = await importer.prepare({projectId, requestId: context.requestId, sourcePath: admitted.source.file,
        ...(parsed.data.name === undefined ? {} : {name: parsed.data.name})}, {...effect, beforeEffect: admitted.check});
      admitted.check(); return prepared;
    },
    async execute(raw, context) {
      const prepared = projectAssetImportPreparationSchema.parse(raw), live = owner(context);
      if (prepared.input.projectId !== scope.projectId) invalid();
      const effect = {...context, signal: combined(context.signal)};
      // Original-key replay is an observation. It neither rereads a deleted
      // source nor manufactures a new creation right from a historical receipt.
      const previous = await importer.lookup(prepared.input, {...effect, beforeEffect: live});
      previous.assertCurrent(); live();
      if (previous.outcome === 'applied') return {disposition: 'reused', asset: previous.asset, receipt: previous.receipt};
      if (previous.outcome === 'retired') return changed();
      if (previous.outcome !== 'not_applied') throw new AppError('AGENT_TASK_UNKNOWN_RESULT', '请先核对原请求的登记结果', 409);
      const relative = path.relative(scope.directory, prepared.file).split(path.sep).join('/');
      const admitted = await publicationFence(relative, effect);
      if (!sameSource(prepared, admitted.source.file, admitted.source.info)) changed();
      // S1 writes its own intent/prepared receipt. Retaining the directory
      // snapshot across those writes would reject our own successful operation.
      // The frozen source epoch still fences every subsequent hash/probe/put;
      // creating a publication link/copy for that inode changes this epoch too.
      const fence = () => {live(); const source = locate(relative); if (!sameSource(prepared, source.file, source.info)) changed();};
      fence(); return importer.execute(prepared, {...effect, beforeEffect: fence});
    },
    async lookup(raw, context) {
      const prepared = projectAssetImportPreparationSchema.parse(raw);
      if (prepared.input.projectId !== scope.projectId) invalid();
      // Resolving an unknown outcome must also work after its source vanished.
      // The absolute original input is only receipt-binding data in this path.
      return importer.lookup(prepared.input, {...context, signal: combined(context.signal), beforeEffect: owner(context)});
    },
  };
}
