import {lstatSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION, inspectProjectFormatHeader, projectReadFormatOptions,
  PROJECT_FILE_SCHEMA_VERSION, isSequenceProjectFormat, recoverProjectFile} from '@mioon/business/project-file/index';
import type {ProjectFileRecovery} from '@mioon/business/project-file/index';
import {assertProjectReaderRequirementsReadOnly} from '../../../packages/business/src/project-file/connection.ts';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {PROJECT_READER_UPDATE_REQUIRED} from '../../../packages/contracts/src/project-reader-requirements.ts';
import {PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import {PROJECT_INVALID_REASONS} from '../../../packages/contracts/src/project-file.ts';

export interface ProjectCatalogScanInput {
  readonly file: string;
  readonly generation: string;
  readonly birthtime: string;
  readonly journalGeneration: string | null;
  readonly checkHeader: boolean;
  readonly targetFormat?: number;
}

const formatStatuses = ['current', 'upgrade-required', 'newer'] as const;

export interface ProjectCatalogScanResult {
  readonly recovery: ProjectFileRecovery | {readonly state: 'invalid'; readonly reason: 'format-newer'} | {readonly state: 'update-required'} | 'changed';
  readonly generation?: string;
  readonly birthtime?: string;
  readonly format?: {readonly generation: string; readonly status: typeof formatStatuses[number]};
}

export function catalogFileGeneration(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Runs only in the catalog process. Reading and closing a raw descriptor in
 * a worker thread would release another thread's SQLite locks on the inode. */
export function scanProjectCatalogFile(input: ProjectCatalogScanInput): ProjectCatalogScanResult {
  const {file, generation, birthtime, journalGeneration, checkHeader} = input;
  const targetFormat = input.targetFormat ?? PROJECT_FILE_SCHEMA_VERSION;
  const developmentProfile = targetFormat === FORMAT6_PROJECT_SCHEMA_VERSION ? projectReadFormatOptions(targetFormat) : undefined;
  const recoveryProfile = targetFormat === FORMAT4_PROJECT_SCHEMA_VERSION ? {deferLegacyRecovery: true as const} : developmentProfile;
  const journal = file + '-journal';
  let changed = false;
  const failChanged = (): never => {
    changed = true;
    throw new Error('Project catalog observation changed');
  };
  const assertProject = (info: BigIntStats): void => {
    if (!info.isFile() || catalogFileGeneration(info) !== generation || String(info.birthtimeNs) !== birthtime) failChanged();
  };
  const assertJournal = (info: BigIntStats | undefined): void => {
    if ((info ? catalogFileGeneration(info) : null) !== journalGeneration) failChanged();
  };
  const observe = (): BigIntStats => lstatSync(file, {bigint: true});
  const unmodified = () => assertJournal(lstatSync(journal, {bigint: true, throwIfNoEntry: false}));
  let recovery: ProjectCatalogScanResult['recovery'];
  let before: BigIntStats;
  try {
    before = observe();
    assertProject(before);
    unmodified();
    try {
      recovery = recoverProjectFile(file, recoveryProfile, {project: assertProject, journal: assertJournal});
    } catch (error) {
      if (error instanceof AppError && error.code === PROJECT_READER_UPDATE_REQUIRED) recovery = {state: 'update-required'};
      else if (error instanceof AppError && error.code === 'PROJECT_FORMAT_NEWER') recovery = {state: 'invalid', reason: 'format-newer'};
      else throw error;
    }
    if (changed) return {recovery: 'changed'};
    const after = observe();
    // Recovery may update the content generation, but cannot replace the
    // file. Other observations must still describe the exact same generation.
    const sameFile = after.isFile() && after.dev === before.dev && after.ino === before.ino && after.birthtimeNs === before.birthtimeNs;
    if (!sameFile || recovery.state !== 'recovered' && catalogFileGeneration(after) !== generation) return {recovery: 'changed'};
    const afterGeneration = catalogFileGeneration(after);
    const result = {recovery, generation: afterGeneration, birthtime};
    if (!checkHeader || after.nlink !== 1n || recovery.state !== 'clean' && recovery.state !== 'recovered') return result;
    const assertHeader = (info: BigIntStats): void => {
      if (!info.isFile() || info.nlink !== 1n || catalogFileGeneration(info) !== afterGeneration || String(info.birthtimeNs) !== birthtime) failChanged();
    };
    let status: typeof formatStatuses[number];
    try {
      const version = inspectProjectFormatHeader(file, developmentProfile, assertHeader);
      if (version === FORMAT6_PROJECT_SCHEMA_VERSION) assertProjectReaderRequirementsReadOnly(file, developmentProfile);
      status = version < targetFormat ? 'upgrade-required' : version === targetFormat ? 'current' : 'newer';
    } catch (error) {
      if (changed) return {recovery: 'changed'};
      if (error instanceof AppError && error.code === PROJECT_READER_UPDATE_REQUIRED) {
        assertHeader(observe());
        return {...result, recovery: {state: 'update-required'}};
      }
      if (!(error instanceof AppError) || error.code !== 'PROJECT_FORMAT_NEWER') return result;
      status = 'newer';
    }
    assertHeader(observe());
    return {...result, format: {generation: afterGeneration, status}};
  } catch (error) {
    const code = (error as {code?: unknown} | null)?.code;
    return {recovery: code === 'EACCES' || code === 'EPERM' ? {state: 'access-denied'} : code === 'ENOENT' || code === 'ENOTDIR' || changed ? 'changed' : {state: 'invalid', reason: 'unusable'}};
  }
}

const generationPattern = /^\d{1,40}:\d{1,40}:\d{1,32}:-?\d{1,32}:-?\d{1,32}$/u;
const birthtimePattern = /^-?\d{1,32}$/u;
const isGeneration = (value: unknown): value is string => typeof value === 'string' && generationPattern.test(value);
const isBirthtime = (value: unknown): value is string => typeof value === 'string' && birthtimePattern.test(value);

export function catalogObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isScanInput(value: unknown): value is ProjectCatalogScanInput {
  const input = catalogObject(value);
  return !!input && Object.keys(input).length === (input.targetFormat !== undefined ? 6 : 5)
    && typeof input.file === 'string' && input.file.length <= 4096 && !input.file.includes('\0') && path.isAbsolute(input.file) && path.resolve(input.file) === input.file
    && isGeneration(input.generation) && isBirthtime(input.birthtime)
    && (input.journalGeneration === null || isGeneration(input.journalGeneration)) && typeof input.checkHeader === 'boolean'
    && (input.targetFormat === undefined || input.targetFormat === PROJECT_FILE_SCHEMA_VERSION ||
      input.targetFormat === FORMAT4_PROJECT_SCHEMA_VERSION || isSequenceProjectFormat(input.targetFormat));
}

export function isCatalogScanBatch(value: unknown): value is readonly ProjectCatalogScanInput[] {
  return Array.isArray(value) && value.length <= PROJECT_ENTRY_LIMITS.maxEntries && value.every(isScanInput);
}

function isScanRecovery(value: unknown): boolean {
  if (value === 'changed') return true;
  const recovery = catalogObject(value);
  if (!recovery) return false;
  if (recovery.state === 'invalid') return Object.keys(recovery).length === 2
    && (recovery.reason === 'format-newer' || PROJECT_INVALID_REASONS.some(reason => reason === recovery.reason));
  return Object.keys(recovery).length === 1
    && ['clean', 'recovered', 'locked', 'open-here', 'missing', 'access-denied', 'update-required'].some(state => state === recovery.state);
}

export function isCatalogScanResult(value: unknown): value is ProjectCatalogScanResult {
  const result = catalogObject(value);
  if (!result || !Object.keys(result).every(key => ['recovery', 'generation', 'birthtime', 'format'].includes(key))
    || !isScanRecovery(result.recovery)) return false;
  const hasIdentity = isGeneration(result.generation) && isBirthtime(result.birthtime);
  if (!hasIdentity && (result.generation !== undefined || result.birthtime !== undefined)) return false;
  if (result.format === undefined) return true;
  const format = catalogObject(result.format);
  return hasIdentity && !!format && Object.keys(format).length === 2 && format.generation === result.generation
    && formatStatuses.some(status => status === format.status);
}
