/** Pure service filtering/labelling shared by the board and the 21-09 panel.
 * The availability rule is the same as Generation services settings. */
import {providerDisplayName} from './creation-i18n.ts';
import {generationProviderForModel, generationSelection, isGenerationProviderCandidate, providerModels, providerStatus} from './generation-settings.ts';
import type {GenerationModelCapability, GenerationProvider, GenerationSelectionOptions, GenerationSelectionResult, GenerationShot} from './generation-settings.ts';

export type ServicePickerTranslate = (key: string, params?: Record<string, unknown>) => string;
export interface GenerationServiceChoice {
  readonly provider: GenerationProvider;
  readonly model?: GenerationModelCapability;
  readonly key: string;
  readonly testId: string;
  readonly label: string;
  readonly detail?: string;
}
export interface BoardGenerationHistoryRecord {
  readonly shotId?: unknown;
  readonly providerId?: unknown;
  readonly model?: unknown;
  readonly createdAt?: unknown;
  readonly number?: unknown;
  readonly snapshot?: unknown;
}
export interface BoardGenerationHistory {
  readonly shotId?: string;
  readonly jobs?: readonly BoardGenerationHistoryRecord[];
  readonly versions?: readonly BoardGenerationHistoryRecord[];
}
const shortId = (value: string): string => value.replace(/-/gu, '').slice(0, 8);
const modelLabel = (model: GenerationModelCapability): string => String(model.name ?? model.modelId ?? model.id ?? '');

const availableModelsFor = (provider: GenerationProvider): GenerationModelCapability[] => providerModels(provider)
  .filter(model => Boolean(model.id) && providerStatus(generationProviderForModel(provider, model.id!, model.modelEntryId)) === 'available');

const availableGenerationProviders = (providers: readonly GenerationProvider[]): GenerationProvider[] =>
  providers.filter(provider => isGenerationProviderCandidate(provider) && provider.enabled !== false && availableModelsFor(provider).length > 0);

interface RecordedServiceIdentity {
  readonly providerId: string;
  readonly connectionId?: string;
  readonly model?: string;
  readonly modelEntryId?: string;
}

function recordedServiceFrom(record: BoardGenerationHistoryRecord | undefined): RecordedServiceIdentity | null {
  if (!record) return null;
  const snapshot = record.snapshot && typeof record.snapshot === 'object' ? record.snapshot as Record<string, unknown> : null;
  const binding = snapshot?.executionBinding && typeof snapshot.executionBinding === 'object'
    ? snapshot.executionBinding as Record<string, unknown> : null;
  const bindingModel = binding?.model && typeof binding.model === 'object' ? binding.model as Record<string, unknown> : null;
  const connectionId = typeof binding?.connectionId === 'string' && binding.connectionId ? binding.connectionId : undefined;
  const providerId = typeof binding?.providerId === 'string' && binding.providerId
    ? binding.providerId
    : typeof record.providerId === 'string' && record.providerId ? record.providerId : '';
  if (!providerId) return null;
  const modelEntryId = typeof bindingModel?.id === 'string' && bindingModel.id ? bindingModel.id : undefined;
  const model = typeof bindingModel?.modelId === 'string' && bindingModel.modelId
    ? bindingModel.modelId
    : typeof record.model === 'string' && record.model
      ? record.model
      : typeof snapshot?.model === 'string' && snapshot.model ? snapshot.model : undefined;
  return {
    providerId,
    ...(connectionId ? {connectionId} : {}),
    ...(model ? {model} : {}),
    ...(modelEntryId ? {modelEntryId} : {}),
  };
}

function latestShotServiceRecord(history: BoardGenerationHistory | undefined): RecordedServiceIdentity | null {
  const shotId = history?.shotId;
  if (!shotId) return null;
  const jobs = (history.jobs ?? [])
    .filter(job => job.shotId === shotId)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  if (jobs.length > 0) return recordedServiceFrom(jobs[0]);
  const versions = (history.versions ?? [])
    .filter(version => version.shotId === shotId)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''))
      || (Number(right.number) || 0) - (Number(left.number) || 0));
  if (versions.length > 0) return recordedServiceFrom(versions[0]);
  return null;
}

function optionFromProvider(
  provider: GenerationProvider,
  preferred?: RecordedServiceIdentity | null,
): GenerationSelectionOptions & {readonly configurationRevision?: number} {
  const models = availableModelsFor(provider);
  const matchedModel = preferred && (
    (preferred.modelEntryId ? models.find(item => item.modelEntryId === preferred.modelEntryId) : undefined)
    ?? (preferred.model ? models.find(item => item.id === preferred.model) : undefined)
  ) || models[0];
  return {
    providerId: provider.id,
    ...(provider.connectionId ? {connectionId: provider.connectionId, configurationRevision: provider.configurationRevision} : {}),
    ...(matchedModel?.id ? {model: matchedModel.id} : {}),
    ...(matchedModel?.modelEntryId ? {modelEntryId: matchedModel.modelEntryId} : {}),
  };
}

/** Default service selection for the format-5 board inspector and 21-09 panel:
 * 1. If only 1 available video service exists, select it by default;
 * 2. Otherwise use the service this shot used last time, if still available;
 * 3. Otherwise select nothing. */
export function defaultBoardGenerationOptions(
  providers: readonly GenerationProvider[],
  history?: BoardGenerationHistory,
): (GenerationSelectionOptions & {readonly configurationRevision?: number}) | null {
  const available = availableGenerationProviders(providers);
  if (available.length === 0) return null;
  const last = latestShotServiceRecord(history);
  if (available.length === 1) {
    const only = available[0]!;
    const sameProvider = last && (last.connectionId
      ? only.connectionId === last.connectionId && only.id === last.providerId
      : !only.connectionId && only.id === last.providerId);
    return optionFromProvider(only, sameProvider ? last : null);
  }
  if (!last) return null;
  const matched = last.connectionId
    ? available.find(provider => provider.connectionId === last.connectionId && provider.id === last.providerId)
    : available.find(provider => !provider.connectionId && provider.id === last.providerId);
  return matched ? optionFromProvider(matched, last) : null;
}

/** Resolves the effective generation selection for format-5 board/editing panels
 * without falling back to Mock when multiple services are available. */
export function resolveBoardGenerationSelection(
  providers: readonly GenerationProvider[],
  options: GenerationSelectionOptions = {},
  shot: GenerationShot = {},
  history?: BoardGenerationHistory,
): GenerationSelectionResult {
  if (options.connectionId || options.providerId) return generationSelection(providers, options, shot);
  const resolved = defaultBoardGenerationOptions(providers, history ?? (typeof shot.id === 'string' ? {shotId: shot.id} : undefined));
  if (!resolved) {
    return {
      provider: undefined,
      model: '',
      capabilities: undefined,
      inputMode: shot.referenceAssetIds?.length || shot.lastFrameAssetId ? 'image' : options.inputMode || 'text',
      scenario: options.scenario || 'success',
    };
  }
  return generationSelection(providers, {...options, ...resolved}, shot);
}

export function generationServiceChoices(providers: readonly GenerationProvider[],
  t: ServicePickerTranslate): readonly GenerationServiceChoice[] {
  const available = availableGenerationProviders(providers);
  const baseLabels = new Map(available.map(provider => [provider, providerDisplayName(provider, t as never)]));
  const counts = new Map<string, number>();
  for (const label of baseLabels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  const used = new Set<string>();
  const choices: GenerationServiceChoice[] = [];
  for (const provider of available) {
    const base = baseLabels.get(provider)!;
    let label = base;
    if ((counts.get(base) ?? 0) > 1) {
      label = provider.connectionId
        ? `${base} · ${t('boardUi.servicePicker.connection', {name: provider.name || provider.connectionId})}`
        : `${base} · ${t('boardUi.servicePicker.builtIn')}`;
      if (used.has(label)) label = `${label} · ${shortId(provider.connectionId || provider.id)}`;
    }
    used.add(label);
    for (const model of availableModelsFor(provider)) {
      const modelKey = String(model.modelEntryId ?? model.id ?? provider.id);
      choices.push({provider, model, key: `${provider.connectionId ?? provider.id}:${modelKey}`,
        testId: `${provider.id}-${modelKey}`, label, ...(modelLabel(model) ? {detail: modelLabel(model)} : {})});
    }
  }
  return choices;
}
