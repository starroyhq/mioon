import {isProjectStore} from '../../../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../../../packages/business/src/project-file/store.ts';
import {initializeProjectTimelineFormat} from '../../../../packages/business/src/project-timeline-format.ts';
import {newTimelineRecord} from '../../../../packages/business/src/timeline-new-record.ts';

export interface ProjectInitializationOptions {
  readonly name: string;
  readonly description?: string;
  readonly timelinePresetId?: string;
  readonly now?: () => Date;
}

/** The file's ID exists before its first runtime. Initialize only its empty
 * project table; reopening must never replace an existing project's content. */
export function ensureProjectRow(store: ProjectStore, {name, description = '', timelinePresetId, now = () => new Date()}: ProjectInitializationOptions): void {
  if (!isProjectStore(store)) throw new TypeError('Project initialization requires a live kernel store');
  if (typeof name !== 'string' || name.length < 1 || name.length > 150 || typeof description !== 'string' || description.length > 2000) {
    throw new TypeError('Invalid project name or description');
  }
  store.tx(() => {
    const rows = store.db.prepare('SELECT id FROM project.projects LIMIT 2').all();
    if (rows.length !== 0) {
      if (rows.length !== 1 || rows[0]?.id !== store.projectId) throw new TypeError('Project rows do not match the kernel project identity');
      return;
    }
    const stamp = now().toISOString();
    store.put('projects', {id: store.projectId, name, description, revision: 1, createdAt: stamp, updatedAt: stamp});
    if (timelinePresetId !== undefined) initializeProjectTimelineFormat({
      inTransaction: () => store.db.isTransaction,
      requireProject: id => store.get('projects', id),
      findTimeline: id => store.list('timelines', id)[0],
      create: (id, preset) => newTimelineRecord(id, preset, () => now().toISOString()),
      save: timeline => store.put('timelines', timeline),
    }, store.projectId, timelinePresetId);
  });
}
