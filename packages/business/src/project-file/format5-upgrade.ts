import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {projectFormatUpgradePreviewSchema} from '../../../contracts/src/project-format-upgrade.ts';
import type {ProjectFormatUpgradePreview} from '../../../contracts/src/project-format-upgrade.ts';
import {isProjectId, PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import {HISTORY_APPLICATION_ID, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION,
  FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from './schema/databases.ts';
import type {SequenceProjectFormat} from './schema/databases.ts';
import {upgradeProject5To6Inside} from './schema/format6-upgrade.ts';
import {FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION} from './schema/domains/canvas.ts';
import {historyManifestForVersion, projectManifestForVersion} from './schema/format-manifests.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import {FORMAT4_INITIAL_HISTORY_MANIFEST} from './schema/history-v11-manifest.ts';
import {HISTORY_UPGRADES} from './schema/history-upgrades.ts';
import type {SchemaManifest} from './schema/manifest-check.ts';
import {inspectProjectFormatReadOnly, projectReadFormatOptions} from './connection.ts';
import type {OpenProjectConnectionOptions, ProjectLocation} from './connection.ts';
import {createFormatUpgradeBackupFromLockedFiles} from './format4-backup.ts';
import type {PreparedFormat5Conversion} from './format5-conversion-store.ts';
import {applyFormat5ConversionInside, prepareFormat5Conversion, readFormat5ConversionInput} from './format5-conversion-store.ts';
import type {Format5ConversionAllocation, Format5ConversionPlan} from './format5-conversion.ts';
import type {ProjectStore} from './store.ts';
import {isProjectStore, openProjectStore} from './store.ts';
import {readProjectContentStamp} from './content-stamp.ts';
import {newTimelineRecord} from '../timeline-new-record.ts';
import {timelineOutputPreset} from '../../../contracts/src/timeline-output-geometry.ts';
import type {Format5LegacyTimeline} from './format5-conversion.ts';

export type Format5UpgradeBoundary =
  | 'before-backup' | 'after-backup' | 'before-conversion'
  | 'after-content' | 'after-structure'
  | 'before-version-write' | 'after-version-write'
  | 'before-commit' | 'after-commit';

export interface Format5UpgradeObservation {
  readonly projectVersion: number;
  readonly historyVersion: number | null;
}
export interface Format5UpgradeOptions {
  readonly projectFile: string;
  readonly locate: (projectId: string) => ProjectLocation;
  readonly checkCopy?: OpenProjectConnectionOptions['checkCopy'];
  /** Trusted caller's approval for the exact preview identity, including the
   * consequence sentence rendered by the host confirmation. */
  readonly approveUpgrade?: (preview: ProjectFormatUpgradePreview) => boolean;
  readonly onUpgradeBoundary?: (phase: Format5UpgradeBoundary, observed: Format5UpgradeObservation) => void;
}
export interface Format5UpgradeResult {
  readonly store: ProjectStore;
  /** Null when the file was already on the target format. */
  readonly preview: ProjectFormatUpgradePreview | null;
  readonly backupId: string | null;
  readonly plan: Format5ConversionPlan | null;
}

const invalid = (code = 'PROJECT_INVALID'): AppError => new AppError(code, '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
const upgradeRequired = (preview: ProjectFormatUpgradePreview): AppError =>
  new AppError('PROJECT_FORMAT_UPGRADE_REQUIRED', '请确认升级项目格式。升级前将保留旧格式备份。', 409, preview);
const digest = (value: unknown): string => JSON.stringify(value);

/** Read the closed local records enough for confirmation: profile, identity and
 * the history format that the same opening will have after legacy migration. */
function readHistoryPreview(historyFile: string, projectId: string,
  sourceProject: ProjectFormatUpgradePreview['projectVersion']): number | null {
  const info = lstatSync(historyFile, {bigint: true, throwIfNoEntry: false});
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1n) throw invalid();
  const db = new DatabaseSync(`${pathToFileURL(historyFile).href}?mode=ro`, {readOnly: true, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false});
  try {
    if (db.prepare('PRAGMA main.application_id').get()?.application_id !== HISTORY_APPLICATION_ID) throw invalid();
    if (db.prepare('PRAGMA main.encoding').get()?.encoding !== 'UTF-8') throw invalid();
    if (db.prepare('PRAGMA main.journal_mode').get()?.journal_mode !== 'delete') throw invalid();
    const versions = db.prepare('SELECT version FROM main.schema_version').all();
    if (versions.length !== 1 || typeof versions[0]?.version !== 'number') throw invalid();
    let version = versions[0].version as number;
    if (version === FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION) version = FORMAT4_HISTORY_SCHEMA_VERSION;
    if (version === 8 || version === 9) version = 10;
    if (![10, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION].includes(version)) throw invalid('PROJECT_FORMAT_NEWER');
    if (sourceProject === 3 && version !== 10) throw invalid();
    if (sourceProject === 4 && version !== FORMAT4_HISTORY_SCHEMA_VERSION && version !== 10) throw invalid();
    if (sourceProject === FORMAT5_PROJECT_SCHEMA_VERSION && version !== FORMAT5_HISTORY_SCHEMA_VERSION) throw invalid();
    // The checked staging version may differ from the on-disk one only for the
    // reviewed single-step legacy transitions; validate its current manifest.
    const current = versions[0].version as number;
    const expected = historyManifestForVersion(current) ?? HISTORY_UPGRADES.find(upgrade => upgrade.from.version === current)?.from
      ?? (current === FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION ? FORMAT4_INITIAL_HISTORY_MANIFEST : undefined);
    if (!expected) throw invalid();
    const differences = compareManifest(readSchemaManifest(db, 'main'), expected.entries);
    if (differences.missing.length || differences.changed.length || differences.unexpected.length) throw invalid();
    const states = db.prepare('SELECT singleton,projectId,seenContentSequence,seenContentToken FROM main.history_state').all();
    if (states.length !== 1 || states[0]?.singleton !== 1 || states[0]?.projectId !== projectId) throw invalid();
    if (db.prepare('PRAGMA main.quick_check').get()?.quick_check !== 'ok') throw invalid();
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid();
    return version;
  } finally {db.close();}
}

/** A closed read-only confirmation preview. Returns null when the file already
 * is format 5 (then no confirmation is needed). */
export function previewFormat5Upgrade(projectFile: string, projectId?: string, historyFile?: string): ProjectFormatUpgradePreview | null {
  return previewSequenceFormatUpgrade(FORMAT5_PROJECT_SCHEMA_VERSION, projectFile, projectId, historyFile);
}

export function previewSequenceFormatUpgrade(target: SequenceProjectFormat, file: string,
  projectId?: string, historyFile?: string): ProjectFormatUpgradePreview | null {
  const identity = inspectProjectFormatReadOnly(file, projectReadFormatOptions(target));
  if (projectId !== undefined && identity.projectId !== projectId) throw invalid();
  if (identity.formatVersion === target) return null;
  if (identity.formatVersion === FORMAT6_PROJECT_SCHEMA_VERSION) throw invalid();
  const source = identity.formatVersion;
  const historyVersion = readHistoryPreview(historyFile ?? path.join(path.dirname(path.resolve(file)), PROJECT_HISTORY_FILE), identity.projectId, source);
  const preview = projectFormatUpgradePreviewSchema.parse({projectId: identity.projectId, contentSequence: identity.contentSequence,
    contentToken: identity.contentToken, projectVersion: source, historyVersion,
    targetProjectVersion: target, targetHistoryVersion: FORMAT5_HISTORY_SCHEMA_VERSION});
  return Object.freeze(preview);
}

function allocationFor(store: ProjectStore): Format5ConversionAllocation {
  const input = readFormat5ConversionInput(store);
  const generous = (count: number, floor: number): string[] => Array.from({length: Math.max(count * 2 + floor, floor)}, () => randomUUID());
  const clips = input.timeline?.clips.length ?? 0, nodes = input.nodes.length, shots = input.shots.length;
  return {sequenceRootId: randomUUID(), createdAt: new Date().toISOString(),
    nodeIds: generous(nodes + clips, 64), clipIds: generous(clips, 64),
    segmentGroupIds: generous(clips + nodes, 64), edgeIds: generous(edgesCount(input.edges.length, nodes, clips), 128),
    anchorConflictPolicy: 'reject'};
}
function edgesCount(edges: number, nodes: number, clips: number): number {return edges + nodes + clips + 16;}
/** Reusable allocation for trusted copy/template conversions that run inside a
 * caller-owned transaction. */
export function createFormat5ConversionAllocation(store: ProjectStore) {return allocationFor(store);}
/** Reviewed conversion preparation for a trusted writable source. A legacy
 * project row without any saved timeline still upgrades: an empty current
 * default geometry is written instead of inventing media or content. */
export function prepareTrustedFormat5Conversion(store: ProjectStore): PreparedFormat5Conversion {
  let emptyTimeline: Format5LegacyTimeline | undefined;
  if (store.list('timelines', store.projectId).length === 0 && store.get('projects', store.projectId) !== undefined) {
    const preset = timelineOutputPreset('portrait_1080');
    if (preset) {
      const value = newTimelineRecord(store.projectId, preset, () => new Date().toISOString());
      const {subtitles: _subtitles, ...template} = value;
      emptyTimeline = {...template, tracks: value.tracks.map(track => ({...track})), clips: []};
    }
  }
  let allocation = allocationFor(store);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {return prepareFormat5Conversion(store, allocation, emptyTimeline ? {emptyTimeline} : {});}
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'FORMAT5_CONVERSION_ID_REQUIRED') throw error;
      allocation = {...allocation, sequenceRootId: randomUUID(), nodeIds: [...allocation.nodeIds, ...allocation.nodeIds],
        clipIds: [...allocation.clipIds, ...allocation.clipIds], segmentGroupIds: [...allocation.segmentGroupIds, ...allocation.segmentGroupIds],
        edgeIds: [...allocation.edgeIds, ...allocation.edgeIds]};
    }
  }
  throw invalid('FORMAT5_CONVERSION_ID_REQUIRED');
}
const prepareUpgradeConversion = prepareTrustedFormat5Conversion;

function observation(store: ProjectStore): Format5UpgradeObservation {
  return {projectVersion: Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version),
    historyVersion: Number(store.db.prepare('SELECT version FROM main.schema_version').get()?.version)};
}

/** Convert one format 3/4 project to format 5 with one confirmation, one
 * verified original-format backup and a single kernel transaction. A failure at
 * any boundary leaves the original pair untouched; the caller reopens through
 * this kernel either as the old format or as the fully committed format 5. */
export function upgradeProjectFormatTo5(options: Format5UpgradeOptions): Format5UpgradeResult {
  return upgradeProjectSequenceFormat(FORMAT5_PROJECT_SCHEMA_VERSION, options);
}

export function upgradeProjectSequenceFormat(target: SequenceProjectFormat,
  options: Format5UpgradeOptions): Format5UpgradeResult {
  const projectFile = path.resolve(options.projectFile);
  const readProfile = projectReadFormatOptions(target);
  const inspected = inspectProjectFormatReadOnly(projectFile, readProfile);
  const openOptions = {projectFile, locate: options.locate, checkCopy: options.checkCopy};
  if (inspected.formatVersion === target) {
    return {store: openProjectStore({...openOptions, allowFormat6: readProfile?.allowFormat6}), preview: null, backupId: null, plan: null};
  }
  const preview = previewSequenceFormatUpgrade(target, projectFile, inspected.projectId,
    path.join(options.locate(inspected.projectId).localDir, PROJECT_HISTORY_FILE))!;
  if (options.approveUpgrade?.(preview) !== true) throw upgradeRequired(preview);
  // A format-4 source opens under the released format-4 profile; a format-3
  // source stays on the legacy profile so the same conversion reads it directly.
  const legacy = openProjectStore({...openOptions, ...(inspected.formatVersion === FORMAT4_PROJECT_SCHEMA_VERSION ? {format4: {}} : {})});
  if (!isProjectStore(legacy)) throw new TypeError('Project format upgrade requires the real kernel project store');
  let backupId: string | null = null, plan: Format5ConversionPlan | null = null;
  try {
    const stamp = readProjectContentStamp(legacy.db);
    if (stamp.contentSequence !== preview.contentSequence || stamp.contentToken !== preview.contentToken ||
      observation(legacy).projectVersion !== preview.projectVersion) throw upgradeRequired(preview);
    const prepared = preview.projectVersion < FORMAT5_PROJECT_SCHEMA_VERSION ? prepareUpgradeConversion(legacy) : null;
    const projectManifest = projectManifestForVersion(preview.projectVersion);
    const historyVersion = prepared?.historyVersion ?? preview.historyVersion;
    const historyManifest = historyVersion === null ? undefined
      : historyManifestForVersion(historyVersion) ?? HISTORY_UPGRADES.find(upgrade => upgrade.from.version === historyVersion)?.from;
    if (!projectManifest || historyVersion !== null && !historyManifest) throw invalid();
    options.onUpgradeBoundary?.('before-backup', observation(legacy));
    backupId = createFormatUpgradeBackupFromLockedFiles({
      projectFile: legacy.projectFile,
      ...(historyManifest ? {historyFile: path.join(legacy.localDir, PROJECT_HISTORY_FILE)} : {}),
      localDir: legacy.localDir,
      expected: {projectId: legacy.projectId, ...stamp},
      projectManifest, ...(historyManifest ? {historyManifest} : {}),
    });
    options.onUpgradeBoundary?.('after-backup', observation(legacy));
    options.onUpgradeBoundary?.('before-conversion', observation(legacy));
    legacy.tx(() => {
      const onBoundary: Format5UpgradeOptions['onUpgradeBoundary'] = options.onUpgradeBoundary;
      if (prepared) plan = applyFormat5ConversionInside(legacy, prepared, {onBoundary: phase =>
        onBoundary?.(phase, observation(legacy))});
      if (target === FORMAT6_PROJECT_SCHEMA_VERSION) upgradeProject5To6Inside(legacy.db, 'project', phase => {
        onBoundary?.(phase, observation(legacy));
      });
      options.onUpgradeBoundary?.('before-commit', observation(legacy));
    });
    options.onUpgradeBoundary?.('after-commit', observation(legacy));
  } finally {legacy.close();}
  const store = openProjectStore({...openOptions, allowFormat6: readProfile?.allowFormat6});
  return {store, preview, backupId, plan};
}
