import { useLayoutEffect, useState } from 'react';
import {
  agentTaskEditingConflictDetailsSchema,
  agentTaskEditingTargetsOverlap,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {
  AgentTaskEditingWrite,
  AgentTaskJson,
  AgentTaskTarget,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { MessageArguments, MessageKey } from '../../../packages/i18n/src/index.ts';
import { readAgentEditingWrites } from './agent-editing-protection.ts';
import type { AgentEditingClaimResult } from './agent-editing-protection.ts';
import { mioFollowColor } from './mio-follow.ts';
import { clipGainDbText } from './clip-audio-state.ts';
import type { ClipDraftRaw } from './clip-draft-state.ts';

export type ClipCoEditingGroup = 'timing' | 'visual' | 'audio';

export type CoEditingConflict =
  | {
      kind: 'revision_changed';
      targetKind: AgentTaskTarget['kind'];
      targetId: string;
      expectedRevision: number;
      currentRevision: number;
      currentValues: Record<string, AgentTaskJson> | null;
      requestId?: string;
    }
  | {
      kind: 'mio_committing';
      targetKind: AgentTaskTarget['kind'];
      targetId: string;
      writes: readonly AgentTaskEditingWrite[];
      requestId?: string;
    }
  | {
      kind: 'outcome_unknown';
      targetKind: AgentTaskTarget['kind'];
      targetId: string;
      writes: readonly AgentTaskEditingWrite[];
      requestId?: string;
    }
  | {
      kind: 'claim_unknown';
      targetKind: AgentTaskTarget['kind'];
      targetId: string;
      revision: number;
      requestId: string;
    };

export interface CoEditingComparisonRow {
  field: string;
  label: string;
  mine: string;
  mio: string;
}

export interface MioMatchedWrite {
  write: AgentTaskEditingWrite;
  color: string;
}

const CLIP_AUDIO_FIELDS = new Set(['gain', 'muted', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope']);
const CLIP_VISUAL_FIELDS = new Set(['rect', 'layout', 'transform', 'transitionIn', 'colour', 'opacity', 'opacityEnvelope', 'blendMode']);
const CLIP_TIMING_FIELDS = new Set(['trackId', 'startFrame', 'durationFrames', 'sourceInFrame', 'sourceSpanFrames', 'anchor', 'timing']);

export function clipGroupTargetKind(group: ClipCoEditingGroup): 'timeline_clip_timing' | 'timeline_clip_visual' | 'timeline_clip_audio' {
  if (group === 'audio') return 'timeline_clip_audio';
  if (group === 'visual') return 'timeline_clip_visual';
  return 'timeline_clip_timing';
}

export function clipFieldTargetKind(field: string): 'timeline_clip' | 'timeline_clip_timing' | 'timeline_clip_visual' | 'timeline_clip_audio' {
  if (CLIP_AUDIO_FIELDS.has(field)) return 'timeline_clip_audio';
  if (CLIP_VISUAL_FIELDS.has(field)) return 'timeline_clip_visual';
  if (CLIP_TIMING_FIELDS.has(field)) return 'timeline_clip_timing';
  return 'timeline_clip';
}

export function clipFieldGroup(field: string): ClipCoEditingGroup {
  if (CLIP_AUDIO_FIELDS.has(field)) return 'audio';
  if (CLIP_VISUAL_FIELDS.has(field)) return 'visual';
  return 'timing';
}

export function findMioWriteForTarget(
  writes: readonly AgentTaskEditingWrite[],
  target: Pick<AgentTaskTarget, 'kind' | 'id'>,
): MioMatchedWrite | null {
  const matched = writes.filter(write => agentTaskEditingTargetsOverlap(write, target));
  if (!matched.length) return null;
  const preferred = matched.find(write => write.state === 'outcome_unknown') ?? matched[0]!;
  return { write: preferred, color: mioFollowColor(preferred.runId) };
}

export function parseCoEditingClaimResult(
  result: AgentEditingClaimResult,
  target: AgentTaskTarget,
): CoEditingConflict | null {
  if (result.status === 'acquired') return null;
  if (result.status === 'unknown') {
    return {
      kind: 'claim_unknown',
      targetKind: target.kind,
      targetId: target.id,
      revision: target.revision,
      requestId: result.requestId,
    };
  }
  const parsed = agentTaskEditingConflictDetailsSchema.safeParse(result.details);
  if (parsed.success) {
    const details = parsed.data;
    if (details.reason === 'revision_changed') {
      const entry = details.targets.find(item => item.kind === target.kind && item.id === target.id)
        ?? details.targets[0];
      return {
        kind: 'revision_changed',
        targetKind: entry?.kind ?? target.kind,
        targetId: entry?.id ?? target.id,
        expectedRevision: entry?.expectedRevision ?? target.revision,
        currentRevision: entry?.currentRevision ?? target.revision + 1,
        currentValues: entry?.currentValues ?? null,
        requestId: result.requestId,
      };
    }
    if (details.reason === 'mio_committing') {
      return {
        kind: 'mio_committing',
        targetKind: target.kind,
        targetId: target.id,
        writes: details.writes,
        requestId: result.requestId,
      };
    }
    if (details.reason === 'outcome_unknown') {
      return {
        kind: 'outcome_unknown',
        targetKind: target.kind,
        targetId: target.id,
        writes: details.writes,
        requestId: result.requestId,
      };
    }
  }
  if (result.code === 'AGENT_TASK_MIO_COMMITTING') {
    return {
      kind: 'mio_committing',
      targetKind: target.kind,
      targetId: target.id,
      writes: [],
      requestId: result.requestId,
    };
  }
  if (result.code === 'AGENT_TASK_UNKNOWN_RESULT') {
    return {
      kind: 'outcome_unknown',
      targetKind: target.kind,
      targetId: target.id,
      writes: [],
      requestId: result.requestId,
    };
  }
  return {
    kind: 'revision_changed',
    targetKind: target.kind,
    targetId: target.id,
    expectedRevision: target.revision,
    currentRevision: target.revision + 1,
    currentValues: null,
    requestId: result.requestId,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  isRecord(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);

const numericEqual = (left: unknown, right: unknown): boolean => {
  const a = typeof left === 'number' ? left : typeof left === 'string' && left.trim() !== '' ? Number(left) : NaN;
  const b = typeof right === 'number' ? right : typeof right === 'string' && right.trim() !== '' ? Number(right) : NaN;
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 1e-4;
  return canonical(left) === canonical(right);
};

function truncateText(value: string, max = 48): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : compact;
}

export interface CoEditingFormatContext {
  fps?: number;
  t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
  formatNumber?: (value: number, options?: Intl.NumberFormatOptions) => string;
  trackName?: (trackId: string) => string | undefined;
}

const tx = (
  t: CoEditingFormatContext['t'],
  key: MessageKey,
  params?: Record<string, string | number>,
): string => (t as (key: MessageKey, params?: Record<string, string | number>) => string)(key, params);

function formatNum(value: number, ctx: CoEditingFormatContext, digits = 1): string {
  const clean = Object.is(value, -0) || Math.abs(value) < 0.05 && digits === 1 ? 0 : value;
  const formatted = ctx.formatNumber
    ? ctx.formatNumber(clean, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
    : clean.toFixed(digits);
  return formatted.replace(/^-/, '−');
}

function formatGain(value: unknown, ctx: CoEditingFormatContext): string {
  if (value === undefined || value === null || value === '') return tx(ctx.t, 'agent.coEdit.value.none');
  const text = clipGainDbText(value as string | number);
  if (text === '−∞' || text === '-∞') return tx(ctx.t, 'agent.coEdit.value.db', { value: '−∞' });
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    const db = formatNum(numeric, ctx, 1);
    return tx(ctx.t, 'agent.coEdit.value.db', { value: db });
  }
  return tx(ctx.t, 'agent.coEdit.value.db', { value: text });
}

function formatFrames(value: unknown, ctx: CoEditingFormatContext): string {
  const frames = Number(value);
  if (!Number.isFinite(frames)) return String(value ?? '');
  if (ctx.fps && ctx.fps > 0) {
    return tx(ctx.t, 'agent.coEdit.value.seconds', { value: formatNum(frames / ctx.fps, ctx, 1) });
  }
  return tx(ctx.t, 'agent.coEdit.value.frames', { count: Math.round(frames) });
}

export function formatCoEditingValue(field: string, value: unknown, ctx: CoEditingFormatContext): string {
  if (value === null || value === undefined) return tx(ctx.t, 'agent.coEdit.value.none');
  if (field === 'gain') return formatGain(value, ctx);
  if (field === 'muted') return tx(ctx.t, value === true ? 'agent.coEdit.value.enabled' : 'agent.coEdit.value.disabled');
  if (field === 'fadeInFrames' || field === 'fadeOutFrames' || field === 'startFrame' || field === 'durationFrames' || field === 'sourceInFrame' || field === 'inFrame' || field === 'outFrame') {
    return formatFrames(value, ctx);
  }
  if (field === 'duration') {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? tx(ctx.t, 'agent.coEdit.value.seconds', { value: formatNum(seconds, ctx, 1) }) : String(value);
  }
  if (field === 'opacity') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? tx(ctx.t, 'agent.coEdit.value.percent', { value: Math.round(numeric * 100) }) : String(value);
  }
  if (field === 'trackId' && typeof value === 'string') {
    return ctx.trackName?.(value) ?? value.slice(0, 8);
  }
  if (field === 'audioRole' && typeof value === 'string') {
    return tx(ctx.t, `audio.role.${value}` as MessageKey);
  }
  if (field === 'disposition' && typeof value === 'string') {
    const map: Record<string, MessageKey> = {
      favorite: 'assets.mark.favorite',
      rejected: 'assets.mark.rejected',
      neutral: 'assets.mark.clear',
    };
    return map[value] ? tx(ctx.t, map[value]) : value;
  }
  if (field === 'volumeEnvelope') {
    if (!isRecord(value) || !Array.isArray(value.points)) return tx(ctx.t, 'agent.coEdit.value.disabled');
    return tx(ctx.t, 'agent.coEdit.value.points', { count: value.points.length });
  }
  if (field === 'rect' && isRecord(value)) {
    return `${value.x ?? 0}, ${value.y ?? 0} · ${value.width ?? 0}×${value.height ?? 0}`;
  }
  if (field === 'transform' && isRecord(value)) {
    const first = Array.isArray(value.keyframes) && isRecord(value.keyframes[0]) ? value.keyframes[0] : null;
    const scale = first && typeof first.scale === 'number' ? tx(ctx.t, 'agent.coEdit.value.percent', { value: Math.round(first.scale * 100) }) : null;
    const rotation = typeof value.rotation === 'number' && value.rotation !== 0 ? `${Math.round(value.rotation)}°` : null;
    return [scale, rotation].filter(Boolean).join(' · ') || tx(ctx.t, 'agent.coEdit.value.enabled');
  }
  if (field === 'transitionIn' && isRecord(value)) {
    const dur = typeof value.durationFrames === 'number' ? formatFrames(value.durationFrames, ctx) : '';
    return [typeof value.kind === 'string' ? value.kind : '', dur].filter(Boolean).join(' · ') || tx(ctx.t, 'agent.coEdit.value.enabled');
  }
  if (field === 'colour' && isRecord(value)) {
    const look = isRecord(value.look) ? value.look : null;
    if (!look || look.enabled === false) return tx(ctx.t, 'agent.coEdit.value.disabled');
    const strength = typeof look.strength === 'number' ? Math.round(look.strength * 100) : 100;
    return tx(ctx.t, 'agent.coEdit.value.look', { strength });
  }
  if (field === 'tags' && Array.isArray(value)) {
    return value.length ? truncateText(value.map(String).join(' · ')) : tx(ctx.t, 'agent.coEdit.value.none');
  }
  if (typeof value === 'string') {
    return value.trim() ? truncateText(value) : tx(ctx.t, 'agent.coEdit.value.none');
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : formatNum(value, ctx, 1);
  }
  if (typeof value === 'boolean') {
    return tx(ctx.t, value ? 'agent.coEdit.value.enabled' : 'agent.coEdit.value.disabled');
  }
  return tx(ctx.t, 'agent.coEdit.value.enabled');
}

const KNOWN_FIELD_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  name: 'agent.coEdit.field.name',
  trackId: 'agent.coEdit.field.trackId',
  startFrame: 'agent.coEdit.field.startFrame',
  durationFrames: 'agent.coEdit.field.durationFrames',
  sourceInFrame: 'agent.coEdit.field.sourceInFrame',
  gain: 'agent.coEdit.field.gain',
  muted: 'agent.coEdit.field.muted',
  fadeInFrames: 'agent.coEdit.field.fadeInFrames',
  fadeOutFrames: 'agent.coEdit.field.fadeOutFrames',
  audioRole: 'agent.coEdit.field.audioRole',
  volumeEnvelope: 'agent.coEdit.field.volumeEnvelope',
  rect: 'agent.coEdit.field.rect',
  transform: 'agent.coEdit.field.transform',
  transitionIn: 'agent.coEdit.field.transitionIn',
  colour: 'agent.coEdit.field.colour',
  opacity: 'agent.coEdit.field.opacity',
  blendMode: 'agent.coEdit.field.blendMode',
  text: 'agent.coEdit.field.text',
  tags: 'agent.coEdit.field.tags',
  note: 'agent.coEdit.field.note',
  inFrame: 'agent.coEdit.field.inFrame',
  outFrame: 'agent.coEdit.field.outFrame',
  disposition: 'agent.coEdit.field.disposition',
  title: 'agent.coEdit.field.title',
  prompt: 'agent.coEdit.field.prompt',
  duration: 'agent.coEdit.field.duration',
  aspectRatio: 'agent.coEdit.field.aspectRatio',
  label: 'agent.coEdit.field.label',
  fps: 'agent.coEdit.field.fps',
  width: 'agent.coEdit.field.width',
  height: 'agent.coEdit.field.height',
};

const COMPARE_ORDER: readonly string[] = [
  'gain', 'muted', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope',
  'rect', 'transform', 'transitionIn', 'colour', 'opacity', 'blendMode',
  'name', 'trackId', 'startFrame', 'durationFrames', 'sourceInFrame',
  'text', 'tags', 'note', 'inFrame', 'outFrame', 'disposition',
  'title', 'label', 'prompt', 'duration', 'aspectRatio', 'width', 'height', 'fps',
];

export function buildCoEditingComparison(options: {
  localValues: Record<string, unknown>;
  serverValues: Record<string, unknown> | null;
  baselineValues?: Record<string, unknown>;
  fields?: readonly string[];
  format: CoEditingFormatContext;
}): { rows: CoEditingComparisonRow[]; conflictedFields: ReadonlySet<string> } {
  const { localValues, serverValues, baselineValues, format } = options;
  if (!serverValues) return { rows: [], conflictedFields: new Set() };
  const candidateKeys = options.fields
    ? options.fields.filter(key => Object.hasOwn(serverValues, key))
    : COMPARE_ORDER.filter(key => Object.hasOwn(serverValues, key) && (Object.hasOwn(localValues, key) || (baselineValues && Object.hasOwn(baselineValues, key))));
  const rows: CoEditingComparisonRow[] = [];
  const conflictedFields = new Set<string>();
  for (const field of candidateKeys) {
    const labelKey = KNOWN_FIELD_LABEL_KEYS[field];
    if (!labelKey) continue;
    const serverVal = serverValues[field];
    const localVal = Object.hasOwn(localValues, field) ? localValues[field] : baselineValues?.[field];
    const baselineVal = baselineValues && Object.hasOwn(baselineValues, field) ? baselineValues[field] : undefined;
    const sameAsLocal = numericEqual(localVal, serverVal);
    const changedByMio = baselineValues !== undefined && !numericEqual(baselineVal, serverVal);
    const changedByUser = baselineValues !== undefined && !numericEqual(baselineVal, localVal);
    if (sameAsLocal && !changedByMio) continue;
    if (sameAsLocal && !changedByUser) continue;
    conflictedFields.add(field);
    rows.push({
      field,
      label: tx(format.t, labelKey),
      mine: formatCoEditingValue(field, localVal, format),
      mio: formatCoEditingValue(field, serverVal, format),
    });
  }
  return { rows, conflictedFields };
}

export function clipDraftPatchFromServerValues(
  group: ClipCoEditingGroup | 'whole',
  serverValues: Record<string, unknown> | null,
): Partial<ClipDraftRaw> {
  if (!serverValues) return {};
  const allowed = group === 'audio'
    ? ['gain', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope']
    : group === 'visual'
      ? ['rect', 'colour']
      : group === 'timing'
        ? ['trackId', 'startFrame', 'durationFrames', 'sourceInFrame']
        : ['name', 'trackId', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope', 'colour'];
  const patch: Record<string, unknown> = {};
  for (const field of allowed) {
    if (!Object.hasOwn(serverValues, field)) continue;
    const value = serverValues[field];
    if (field === 'rect' && isRecord(value)) {
      patch.rect = { x: value.x, y: value.y, width: value.width, height: value.height };
    } else if (value !== undefined) {
      patch[field] = structuredClone(value);
    }
  }
  return patch as Partial<ClipDraftRaw>;
}

// Shared active-writes store per projectId so every inspector group stays in sync
// with GET /api/projects/{projectId}/agent/tasks/v2/editing/writes without redundant polls.
interface WritesChannel {
  projectId: string;
  writes: readonly AgentTaskEditingWrite[];
  listeners: Set<() => void>;
  runActive: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  flight: Promise<void> | null;
  generation: number;
}

const channels = new Map<string, WritesChannel>();
let readWritesImpl: (projectId: string) => Promise<{ writes: AgentTaskEditingWrite[] }> =
  projectId => readAgentEditingWrites(projectId);

export function setMioWritesReaderForTest(
  reader: ((projectId: string) => Promise<{ writes: AgentTaskEditingWrite[] }>) | null,
): void {
  readWritesImpl = reader ?? (projectId => readAgentEditingWrites(projectId));
}

function getChannel(projectId: string): WritesChannel {
  let channel = channels.get(projectId);
  if (!channel) {
    channel = { projectId, writes: [], listeners: new Set(), runActive: false, timer: null, flight: null, generation: 0 };
    channels.set(projectId, channel);
  }
  return channel;
}

function scheduleWritesPoll(channel: WritesChannel): void {
  if (channel.timer) { clearTimeout(channel.timer); channel.timer = null; }
  if (!channel.listeners.size) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const interval = channel.runActive || channel.writes.length > 0 ? 600 : 2000;
  channel.timer = setTimeout(() => {
    channel.timer = null;
    void pollWritesChannel(channel);
  }, interval);
}

async function pollWritesChannel(channel: WritesChannel): Promise<void> {
  if (channel.flight) return channel.flight;
  const gen = ++channel.generation;
  let work!: Promise<void>;
  work = (async () => {
    try {
      const result = await readWritesImpl(channel.projectId);
      if (channel.generation !== gen) return;
      const next = result.writes ?? [];
      if (canonical(next) !== canonical(channel.writes)) {
        channel.writes = next;
        for (const listener of channel.listeners) listener();
      }
    } catch {
      // Transient read failure keeps the last observed writes without clearing locks prematurely.
    } finally {
      if (channel.flight === work) channel.flight = null;
      scheduleWritesPoll(channel);
    }
  })();
  channel.flight = work;
  return work;
}

export function getMioActiveWrites(projectId: string | null | undefined): readonly AgentTaskEditingWrite[] {
  if (!projectId) return [];
  return channels.get(projectId)?.writes ?? [];
}

export function notifyMioRunActivity(projectId: string | null | undefined, active: boolean): void {
  if (!projectId) return;
  const channel = getChannel(projectId);
  const changed = channel.runActive !== active;
  channel.runActive = active;
  if (channel.listeners.size && (active || changed || channel.writes.length > 0)) {
    void pollWritesChannel(channel);
  }
}

export function refreshMioActiveWrites(projectId: string | null | undefined): Promise<void> {
  if (!projectId) return Promise.resolve();
  const channel = getChannel(projectId);
  return pollWritesChannel(channel);
}

export function subscribeMioActiveWrites(projectId: string, listener: () => void): () => void {
  const channel = getChannel(projectId);
  channel.listeners.add(listener);
  void pollWritesChannel(channel);
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      void pollWritesChannel(channel);
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', onVisible);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    channel.listeners.delete(listener);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', onVisible);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisible);
    }
    if (!channel.listeners.size && channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }
  };
}

export function useMioActiveWrites(
  projectId: string | null | undefined,
  enabled = true,
): readonly AgentTaskEditingWrite[] {
  const [writes, setWrites] = useState<readonly AgentTaskEditingWrite[]>(() =>
    enabled && projectId ? getMioActiveWrites(projectId) : [],
  );
  useLayoutEffect(() => {
    if (!enabled || !projectId) {
      setWrites([]);
      return;
    }
    setWrites(getMioActiveWrites(projectId));
    return subscribeMioActiveWrites(projectId, () => {
      setWrites(getMioActiveWrites(projectId));
    });
  }, [projectId, enabled]);
  return writes;
}
