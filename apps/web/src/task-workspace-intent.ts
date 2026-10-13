export interface TaskWorkspaceContext {
  readonly active: boolean;
  readonly projectId: string;
  readonly projectEpoch: number;
  readonly navigationEpoch: number;
  readonly panelIntent: number;
  readonly workspaceScope: string;
}

export interface TaskShotTarget {
  readonly projectId: string;
  readonly jobId: string;
  readonly shotId: string;
  readonly tab: 'settings' | 'versions';
}

export interface TaskShotNavigationActions {
  readContext(): TaskWorkspaceContext;
  isVisible(): boolean;
  hasTarget(target: TaskShotTarget): boolean;
  guard(canNavigate: () => boolean): Promise<boolean>;
  reveal(target: TaskShotTarget): void;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validContext(value: unknown): value is TaskWorkspaceContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'active' in value && value.active === true
    && 'projectId' in value && nonempty(value.projectId)
    && 'projectEpoch' in value && counter(value.projectEpoch)
    && 'navigationEpoch' in value && counter(value.navigationEpoch)
    && 'panelIntent' in value && counter(value.panelIntent)
    && 'workspaceScope' in value && nonempty(value.workspaceScope);
}

function copyContext(value: unknown): TaskWorkspaceContext | null {
  if (!validContext(value)) return null;
  return Object.freeze({ active: value.active, projectId: value.projectId, projectEpoch: value.projectEpoch,
    navigationEpoch: value.navigationEpoch, panelIntent: value.panelIntent, workspaceScope: value.workspaceScope });
}

function sameContext(captured: TaskWorkspaceContext, current: unknown): boolean {
  return validContext(current) && current.active === captured.active && current.projectId === captured.projectId
    && current.projectEpoch === captured.projectEpoch && current.navigationEpoch === captured.navigationEpoch
    && current.panelIntent === captured.panelIntent && current.workspaceScope === captured.workspaceScope;
}

/** View authority only. Callers advance epochs/intents even when leaving and
 * returning to the same project, tab or panel before an asynchronous result. */
export function captureTaskWorkspaceIntent(read: () => TaskWorkspaceContext): (() => boolean) | null {
  const captured = copyContext(read());
  return captured === null ? null : () => sameContext(captured, read());
}

function validTarget(value: unknown): value is TaskShotTarget {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'projectId' in value && nonempty(value.projectId)
    && 'jobId' in value && nonempty(value.jobId)
    && 'shotId' in value && nonempty(value.shotId)
    && 'tab' in value && (value.tab === 'settings' || value.tab === 'versions');
}

/** One explicit shot choice. The guard must consult the supplied predicate at
 * its discard boundary; reveal contains only synchronous view updates. */
export async function navigateTaskShot(input: TaskShotTarget, actions: TaskShotNavigationActions): Promise<boolean> {
  if (!validTarget(input)) return false;
  const target = Object.freeze({ projectId: input.projectId, jobId: input.jobId, shotId: input.shotId, tab: input.tab });
  const captured = copyContext(actions.readContext());
  if (captured === null || captured.projectId !== target.projectId) return false;
  const canNavigate = (): boolean => sameContext(captured, actions.readContext()) && actions.isVisible() && actions.hasTarget(target);
  if (!canNavigate() || !await actions.guard(canNavigate) || !canNavigate()) return false;
  actions.reveal(target);
  return true;
}
