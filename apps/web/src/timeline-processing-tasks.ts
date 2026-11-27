import {useEffect, useRef, useState} from 'react';
import {timelineProcessingResponseSchemas} from '../../../packages/contracts/src/timeline-processing.ts';
import type {SpeedProcessingItem} from '../../../packages/contracts/src/timeline-speed.ts';
import type {MessageArguments, MessageKey} from '../../../packages/i18n/src/index.ts';
import type {TaskOverviewItem} from './TaskPopover.tsx';

type ReadProcessingTasks = (operation: 'timeline.processing.list', input: {projectId: string},
  options: {signal: AbortSignal}) => Promise<unknown>;

const active = (task: SpeedProcessingItem): boolean => task.status === 'queued' || task.status === 'running';
const empty: readonly SpeedProcessingItem[] = Object.freeze([]);
const delays = {active: 1_000, idle: 5_000, unavailable: 30_000};

/** A single in-flight list read. Switching project, closing or disabling the
 * feature releases both the pending timer and result ownership. */
export function observeSpeedProcessingTasks(projectId: string, read: ReadProcessingTasks,
  receive: (items: readonly SpeedProcessingItem[]) => void): () => void {
  const observer = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    if (observer.signal.aborted) return;
    let delay = delays.idle;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      try {
        const response = await read('timeline.processing.list', {projectId}, {signal: observer.signal});
        if (observer.signal.aborted) return;
        const {items} = timelineProcessingResponseSchemas['timeline.processing.list'].parse(response);
        receive(items);
        if (items.some(active)) delay = delays.active;
      } catch {
        delay = delays.unavailable;
      }
    }
    if (!observer.signal.aborted) timer = setTimeout(() => {void poll();}, delay);
  };
  void poll();
  return () => {observer.abort(); clearTimeout(timer);};
}

export function useSpeedProcessingTasks({projectId, scope, revision, read}: {
  projectId: string | null; scope: string; revision?: number; read: ReadProcessingTasks;
}): readonly SpeedProcessingItem[] {
  const reader = useRef(read);
  reader.current = read;
  const key = JSON.stringify([projectId, scope, revision]);
  const [view, setView] = useState<{key: string; items: readonly SpeedProcessingItem[]}>();
  useEffect(() => {
    if (!projectId) return;
    return observeSpeedProcessingTasks(projectId, (...args) => reader.current(...args), items => setView({key, items}));
  }, [projectId, key]);
  return projectId && view?.key === key ? view.items : empty;
}

export interface SpeedProcessingTaskView {
  readonly key: string;
  readonly label: string;
  readonly status: string;
  readonly active: boolean;
  readonly warning: boolean;
  readonly progress?: number;
  readonly reason?: string;
}

type Translate = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
const kinds = {
  reverse: 'tasks.processing.reverse', optical: 'tasks.processing.optical', preview: 'tasks.processing.preview',
} as const;
const statuses = {
  queued: 'export.status.queued', running: 'redesign.export.processing', ready: 'export.status.succeeded', failed: 'export.status.failed',
} as const;
const reasons = {
  SOURCE_UNAVAILABLE: 'tasks.processing.sourceUnavailable',
  DISK_FULL: 'projectPackage.error.noSpace.title',
  CACHE_LIMIT: 'tasks.processing.cacheLimit',
  UNSUPPORTED_FORMAT: 'tasks.processing.unsupportedFormat',
  INTERPOLATION_UNAVAILABLE: 'tasks.processing.interpolationUnavailable',
  PROCESSING_FAILED: 'tasks.processing.failed',
} as const;

export function speedProcessingTaskViews(items: readonly SpeedProcessingItem[], clips: readonly {id: string; name: string}[],
  t: Translate): SpeedProcessingTaskView[] {
  const names = new Map(clips.map(clip => [clip.id, clip.name]));
  const groups = new Map<string, {task: SpeedProcessingItem; clips: Set<string>}>();
  for (const task of items) {
    let group = groups.get(task.taskId);
    if (!group) {
      group = {task, clips: new Set()};
      groups.set(task.taskId, group);
    }
    const name = names.get(task.clipId);
    if (name) group.clips.add(name);
  }
  return [...groups.values()].map(({task, clips: clipNames}) => {
    const kind = t(kinds[task.kind]), names = [...clipNames].join(' · ');
    return {key: `processing:${task.taskId}`, label: names ? `${kind} · ${names}` : kind,
      status: t(statuses[task.status]), active: active(task), warning: task.status === 'failed',
      ...(task.status === 'running' && task.progress !== undefined ? {progress: task.progress} : {}),
      ...(task.status === 'failed' && task.reason ? {reason: t(reasons[task.reason])} : {})};
  });
}

export function speedProcessingOverviewItems(tasks: readonly SpeedProcessingTaskView[]): TaskOverviewItem[] {
  return tasks.filter(task => task.active || task.warning).map(task => ({
    id: task.key, label: task.label, status: task.status, progress: task.progress,
    detail: task.reason, phase: task.active ? 'active' : 'attention', tone: task.warning ? 'danger' : 'neutral',
  }));
}
