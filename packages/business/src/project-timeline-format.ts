import {AppError} from '../../contracts/src/app-error.ts';
import {TIMELINE_CURRENT_OUTPUT_PRESETS, type TimelineOutputPreset} from '../../contracts/src/timeline-output-geometry.ts';

interface ProjectFormatStore<T> {
  inTransaction(): boolean;
  requireProject(projectId: string): unknown;
  findTimeline(projectId: string): unknown;
  create(projectId: string, preset: TimelineOutputPreset): T;
  save(timeline: T): T;
}

/** Project creation owns the transaction. No format receipt/history is needed
 * before the newly created project becomes observable to another caller. */
export function initializeProjectTimelineFormat<T>(store: ProjectFormatStore<T>, projectId: string, presetId: string): T {
  if (!store.inTransaction()) throw new AppError('PROJECT_FORMAT_TRANSACTION_REQUIRED', '项目画幅必须与新建项目原子保存', 500);
  const preset = TIMELINE_CURRENT_OUTPUT_PRESETS.find(item => item.id === presetId);
  if (!preset) throw new AppError('VALIDATION_ERROR', '新项目画幅无效', 400);
  store.requireProject(projectId);
  if (store.findTimeline(projectId)) throw new AppError('TIMELINE_FORMAT_LOCKED', '项目已有时间线，不能重复初始化画幅', 409);
  return store.save(store.create(projectId, preset));
}
