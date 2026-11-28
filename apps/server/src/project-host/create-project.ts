import {rmSync, rmdirSync} from 'node:fs';
import path from 'node:path';
import {AppError, publicValue} from '../../../../packages/contracts/src/index.ts';
import {TIMELINE_FPS_READER_FEATURE} from '../../../../packages/contracts/src/project-reader-requirements.ts';
import {isTimelineFps} from '../../../../packages/contracts/src/timeline-fps.ts';
import type {RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ProjectEntryCreateInput} from '../../../../packages/contracts/src/project-entry-native.ts';
import {openProjectStore} from '../../../../packages/business/src/project-file/index.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION, isSequenceProjectFormat} from '../../../../packages/business/src/project-file/schema/databases.ts';
import {applyFormat5ConversionInside} from '../../../../packages/business/src/project-file/format5-conversion-store.ts';
import {prepareTrustedFormat5Conversion} from '../../../../packages/business/src/project-file/format5-upgrade.ts';
import {upgradeProject5To6Inside} from '../../../../packages/business/src/project-file/schema/format6-upgrade.ts';
import {readFormat5TimelineRecord} from '../../../../packages/business/src/project-file/format5-timeline.ts';
import type {Format4Options, ProjectFileFormat} from '../../../../packages/business/src/project-file/index.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostManager} from './manager.ts';
import type {ProjectFileIdentityPort, ProjectRegistryPort} from './ports.ts';
import {sameProjectFileIdentity} from './stand-ins.ts';
import {ensureProjectRow} from './project-initialization.ts';

/** One create path for the app RPC and trusted desktop control. Selecting a
 * location does not skip project-row initialization or ownership checks. */
export function createInitializedProject({manager, registry, directories, identity, assertProjectFile, format4, targetFormat, format6Development = false}: {
  readonly manager: ProjectHostManager;
  readonly registry: ProjectRegistryPort;
  readonly directories: AppDirectories;
  readonly identity: ProjectFileIdentityPort;
  readonly assertProjectFile: (file: string) => void;
  readonly format4?: Format4Options;
  readonly targetFormat?: ProjectFileFormat;
  readonly format6Development?: boolean;
}) {
  return async (input: ProjectEntryCreateInput): Promise<{readonly registration: RecentProject; readonly project: unknown}> => {
    const {timelineFps} = input;
    if (timelineFps !== undefined && (!format6Development || targetFormat !== FORMAT6_PROJECT_SCHEMA_VERSION || !isTimelineFps(timelineFps))) {
      throw new AppError('VALIDATION_ERROR', '项目帧率仅可为开发模式的新建格式 6 项目设置。', 400);
    }
    // Reject private application targets before creating any folder or file.
    assertProjectFile(input.projectFile ?? path.join(input.parentDir ?? directories.projectsDir, 'project.mioon'));
    let entry = await manager.create({name: input.name,
      ...(input.parentDir === undefined ? {} : {parentDir: input.parentDir}),
      ...(input.projectFile === undefined ? {} : {projectFile: input.projectFile})},
      {format: isSequenceProjectFormat(targetFormat) ? FORMAT4_PROJECT_SCHEMA_VERSION : targetFormat});
    let initialized = false;
    try {
      assertProjectFile(entry.projectFile);
      const openProfile = format4 ?? (isSequenceProjectFormat(targetFormat) ? {} : undefined);
      const store = openProjectStore({projectFile: entry.projectFile,
        locate: id => projectLocation(directories, id), checkCopy: registry.checkCopy, ...(openProfile === undefined ? {} : {format4: openProfile})});
      try {
        ensureProjectRow(store, {name: input.name,
          ...(input.description === undefined ? {} : {description: input.description}),
          ...(input.timelinePresetId === undefined ? {} : {timelinePresetId: input.timelinePresetId})});
        if (isSequenceProjectFormat(targetFormat)) {
          // A new project starts on the released kernel so the preset timeline
          // exists, then joins format 5 through the reviewed conversion. No
          // user confirmation is needed: the file was created by this request.
          const prepared = prepareTrustedFormat5Conversion(store);
          store.tx(() => {
            applyFormat5ConversionInside(store, prepared);
            if (targetFormat === FORMAT6_PROJECT_SCHEMA_VERSION) {
              upgradeProject5To6Inside(store.db, 'project');
              if (timelineFps !== undefined && timelineFps !== 30) {
                const timeline = readFormat5TimelineRecord(store.db, 'project');
                const project = store.get('projects', store.projectId);
                if (!timeline || timeline.clips.length || timeline.durationFrames !== 0 || !project || typeof project !== 'object') {
                  throw new TypeError('Frame rate initialization requires a new empty timeline');
                }
                store.put('projects', {...project, requiredReaderFeatures: [TIMELINE_FPS_READER_FEATURE]});
                store.put('timelines', {...timeline, fps: timelineFps});
              }
            }
          });
          const fileIdentity = identity(entry.projectFile);
          if (!fileIdentity) throw new Error('The new project file has no file identity');
          registry.upsert({...entry, fileIdentity});
          entry = {...entry, fileIdentity};
        }
        initialized = true;
        // Creation by itself does not compose a runtime or count as an open.
        // The existing public RPC performs its request admission afterwards;
        // desktop control admits the eventual editor window separately.
        return {registration: entry, project: publicValue(store.get('projects', entry.projectId))};
      } finally {store.close();}
    } catch (error) {
      if (!initialized && manager.status(entry.projectId) === null) {
        // A replaced path belongs to somebody else. Never unlink it, and never
        // remove a caller-chosen existing parent when initialization fails.
        const registration = registry.get(entry.projectId);
        if (registration && sameProjectFileIdentity(registration.fileIdentity, entry.fileIdentity)) {
          registry.remove(entry.projectId);
          if (sameProjectFileIdentity(identity(entry.projectFile), entry.fileIdentity)) {
            rmSync(entry.projectFile, {force: true});
            if (input.projectFile === undefined) {
              try {rmdirSync(path.dirname(entry.projectFile));} catch { /* Only remove our empty claimed folder. */ }
            }
          }
        }
      }
      throw error;
    }
  };
}
