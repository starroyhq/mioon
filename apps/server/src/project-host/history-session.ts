import {createHash} from 'node:crypto';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {PROJECT_HISTORY_FILE} from '../../../../packages/contracts/src/project-file.ts';
import type {ProjectVersionListInput, ProjectVersionPreviewInput} from '../../../../packages/contracts/src/project-version-operations.ts';
import {projectHistoryStatusSchema} from '../../../../packages/contracts/src/project-history-recovery.ts';
import type {ProjectHistoryStatus} from '../../../../packages/contracts/src/project-history-recovery.ts';
import {readProjectContentStamp} from '../../../../packages/business/src/project-file/content-stamp.ts';
import {projectHistoryFileIdentity} from '../../../../packages/business/src/project-file/history-switch.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';
import {createProjectVersions} from '../../../../packages/business/src/project-versions/service.ts';
import {inspectProjectDocumentForCopy} from '../../../../packages/business/src/project-versions/codec.ts';
import type {EncodedProjectDocument} from '../../../../packages/business/src/project-versions/codec.ts';
import {PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES} from '../../../../packages/business/src/project-versions/limits.ts';
import type {ProjectHostContext} from './host.ts';

export const projectHistoryRequired = (): AppError => new AppError('PROJECT_HISTORY_DIVERGED', '这份项目与本机记录不一致，请先确认处置；旧任务不会继续运行。', 409);
export interface ProjectHistorySession {
  status(): ProjectHistoryStatus;
  listVersions(input: ProjectVersionListInput): ReturnType<ReturnType<typeof createProjectVersions>['list']>;
  previewVersion(input: ProjectVersionPreviewInput): ReturnType<ReturnType<typeof createProjectVersions>['preview']>;
}

/** All inputs are read through the owner's one connection. In particular,
 * opening a recovery session never constructs a service with recover/tick. */
export function createProjectHistorySession(context: ProjectHostContext, assertMutationAllowed?: () => void): ProjectHistorySession {
  const {store, signal} = context;
  const alive = (): void => {signal.throwIfAborted(); if (!store.db.isOpen) throw projectHistoryRequired();};
  const versions = createProjectVersions(store, {executionDomain: 'empty', assertMutationAllowed});
  let versionCounts: {versionCount: number; recoverableVersionCount: number} | undefined;
  const countVersions = () => {
    if (versionCounts) return versionCounts;
    let versionCount = 0, recoverableVersionCount = 0;
    for (const row of store.db.prepare(`SELECT b.hash,b.profile,b.codec,b.rawBytes,b.compressedBytes,
      CASE WHEN b.rawBytes BETWEEN 1 AND ? AND b.compressedBytes BETWEEN 1 AND ? AND length(b.payload)=b.compressedBytes THEN b.payload END AS payload,
      count(v.id) AS n FROM project_version_blobs b JOIN project_versions v ON v.blobHash=b.hash WHERE v.projectId=? GROUP BY b.hash`)
      .iterate(PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES, store.projectId)) {
      const body = inspectProjectDocumentForCopy(row as unknown as EncodedProjectDocument);
      if (body.projectId !== store.projectId) throw new AppError('PROJECT_VERSION_RECORD_INVALID', '版本正文不属于本项目。', 422);
      versionCount += Number(row.n); if (body.restoreSupported) recoverableVersionCount += Number(row.n);
    }
    versionCounts = {versionCount, recoverableVersionCount};
    return versionCounts;
  };
  const status = (): ProjectHistoryStatus => {
    alive();
    const admission = store.historyAdmission;
    const seen = store.db.prepare('SELECT seenContentSequence,seenContentToken FROM history_state WHERE singleton=1').get()!;
    const {versionCount, recoverableVersionCount} = countVersions();
    // Submitted jobs have external effects even if this computer never saw a
    // final result. The count is diagnostic only: none is resumed or reposted.
    const jobs = Number(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE projectId=? AND (json_extract(data,'$.status') IN ('submitting','submission_unknown','running','downloading'))").get(store.projectId)!.n);
    let unknownProviderTasks = jobs;
    for (const table of ['image_tasks', 'frame_tasks', 'scene_tasks'] as const) {
      unknownProviderTasks += Number(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE projectId=? AND state IN ('dispatching','receiving','persisting','outcome_unknown','local_result_error')`).get(store.projectId)!.n);
    }
    const value = {projectId: store.projectId, state: admission.state, reason: admission.reason, file: readProjectContentStamp(store.db),
      seen: {contentSequence: Number(seen.seenContentSequence), contentToken: seen.seenContentToken},
      historyIdentity: projectHistoryFileIdentity(path.join(store.localDir, PROJECT_HISTORY_FILE)), versionCount, recoverableVersionCount, unknownProviderTasks};
    const confirmationDigest = createHash('sha256').update(canonicalJson({...value, projectIdentity: projectHistoryFileIdentity(store.projectFile)})).digest('hex');
    return projectHistoryStatusSchema.parse({...value, confirmationDigest});
  };
  return Object.freeze({status,
    listVersions: (input: ProjectVersionListInput) => {alive(); return versions.list(input);},
    previewVersion: (input: ProjectVersionPreviewInput) => {alive(); return versions.preview(input);},
  });
}
