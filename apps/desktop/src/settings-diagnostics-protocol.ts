export const SETTINGS_DIAGNOSTICS_CHANNEL = 'mioon:settings-diagnostics:v1';

const readStages = ['workspace-directory', 'appearance', 'workspace-storage', 'workspace-settings', 'workspace-records',
  'video-tools', 'video-tools-status', 'video-tools-check', 'agent-settings', 'agent-policy', 'agent-connection-test', 'agent-authorizations',
  'generation-live', 'generation-provider-list', 'generation-video', 'generation-image-official', 'generation-image-custom',
  'generation-comfy', 'generation-comfy-availability', 'about'] as const;
export type SettingsDiagnosticsRead = typeof readStages[number];
type BootPhase = 'start' | 'import' | 'ready' | 'failed';
export interface SettingsDiagnosticsBridge {
  markClick(eventTimeMs: number): void;
  markBoot(phase: BootPhase): Promise<boolean>;
  markRead(page: SettingsDiagnosticsRead, phase: 'start' | 'end', requestId: number, atMs: number): void;
}
export type SettingsDiagnosticRequest =
  | {kind: 'click'; eventAt: number; handledAt: number}
  | {kind: 'boot'; phase: BootPhase; at: number}
  | {kind: 'read'; page: SettingsDiagnosticsRead; phase: 'start' | 'end'; requestId: number; at: number};

const modeValues = ['cold', 'warm', 'warm-fallback', 'existing'] as const;
export type SettingsOpenMode = typeof modeValues[number];
export const settingsOpenPhases = ['rendererEvent', 'rendererHandled', 'mainReceived', 'createStarted', 'created',
  'promoted', 'didFinishLoad', 'readyToShow', 'showRequested', 'show', 'showReturned', 'bootAck', 'bootStarted', 'bootReady', 'bootFailed', 'warmFallback'] as const;
export type SettingsOpenPhase = typeof settingsOpenPhases[number];
const outcomes = ['ready', 'failed', 'closed', 'pending', 'shown'] as const;
export type SettingsOpenOutcome = typeof outcomes[number];
type SettingsTimingRecord = {schemaVersion: 1; at: string; attempt: number; event: 'settings-open-timing' | 'settings-open-slow';
  mode: SettingsOpenMode; outcome: SettingsOpenOutcome; elapsedMs: number; utilityMaxDelayMs: number | null;
  phases: Partial<Record<SettingsOpenPhase, number>>};
type SettingsReadRecord = {schemaVersion: 1; at: string; attempt: number; event: 'settings-page-read'; page: SettingsDiagnosticsRead;
  startedMs: number; endedMs: number; durationMs: number; utilityMaxDelayMs: number | null};
export type SettingsDiagnosticRecord = SettingsTimingRecord | SettingsReadRecord;

const member = <T extends string>(values: readonly T[], value: unknown): value is T => values.some(item => item === value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const epoch = (value: unknown): value is number => integer(value, 1, 8_640_000_000_000_000);
const bootPhases = ['start', 'import', 'ready', 'failed'] as const;
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseSettingsDiagnosticRequest(input: unknown): SettingsDiagnosticRequest | null {
  if (!object(input)) return null;
  const count = Object.keys(input).length;
  if (input.kind === 'click' && count === 3 && epoch(input.eventAt) && epoch(input.handledAt) && input.eventAt <= input.handledAt) {
    return {kind: 'click', eventAt: input.eventAt, handledAt: input.handledAt};
  }
  if (input.kind === 'boot' && count === 3 && member(bootPhases, input.phase) && epoch(input.at)) return {kind: 'boot', phase: input.phase, at: input.at};
  if (input.kind === 'read' && count === 5 && member(readStages, input.page) && (input.phase === 'start' || input.phase === 'end') &&
    integer(input.requestId, 1, 2 ** 31 - 1) && epoch(input.at)) {
    return {kind: 'read', page: input.page, phase: input.phase, requestId: input.requestId, at: input.at};
  }
  return null;
}

export function sanitizeSettingsDiagnosticRecord(value: unknown): SettingsDiagnosticRecord | null {
  if (!object(value) || value.schemaVersion !== 1 || !iso(value.at) || !integer(value.attempt, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (value.utilityMaxDelayMs !== null && !integer(value.utilityMaxDelayMs, 0, 120_000)) return null;
  const base = {schemaVersion: 1 as const, at: value.at, attempt: value.attempt, utilityMaxDelayMs: value.utilityMaxDelayMs};
  if (value.event === 'settings-page-read' && member(readStages, value.page) && integer(value.startedMs, 0, 120_000) &&
    integer(value.endedMs, value.startedMs, 120_000) && value.durationMs === value.endedMs - value.startedMs &&
    (value.utilityMaxDelayMs === null || value.utilityMaxDelayMs <= value.durationMs)) {
    return {...base, event: value.event, page: value.page, startedMs: value.startedMs, endedMs: value.endedMs, durationMs: value.durationMs};
  }
  if (value.event !== 'settings-open-timing' && value.event !== 'settings-open-slow' || !member(modeValues, value.mode) ||
    !member(outcomes, value.outcome) || !integer(value.elapsedMs, 0, 120_000) ||
    value.utilityMaxDelayMs !== null && value.utilityMaxDelayMs > value.elapsedMs || !object(value.phases)) return null;
  const phases: SettingsTimingRecord['phases'] = {};
  for (const phase of settingsOpenPhases) {
    const timestamp = value.phases[phase];
    if (integer(timestamp, -120_000, 120_000)) phases[phase] = timestamp;
  }
  return {...base, event: value.event, mode: value.mode, outcome: value.outcome, elapsedMs: value.elapsedMs, phases};
}
