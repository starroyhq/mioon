/** Pure service filtering/labelling shared by the board and the 21-09 panel.
 * The availability rule is the same as Generation services settings. */
import {providerDisplayName} from './creation-i18n.ts';
import {generationProviderForModel, isGenerationProviderCandidate, providerModels, providerStatus} from './generation-settings.ts';
import type {GenerationModelCapability, GenerationProvider} from './generation-settings.ts';

export type ServicePickerTranslate = (key: string, params?: Record<string, unknown>) => string;
export interface GenerationServiceChoice {
  readonly provider: GenerationProvider;
  readonly model?: GenerationModelCapability;
  readonly key: string;
  readonly testId: string;
  readonly label: string;
  readonly detail?: string;
}
const shortId = (value: string): string => value.replace(/-/gu, '').slice(0, 8);
const modelLabel = (model: GenerationModelCapability): string => String(model.name ?? model.modelId ?? model.id ?? '');

export function generationServiceChoices(providers: readonly GenerationProvider[],
  t: ServicePickerTranslate): readonly GenerationServiceChoice[] {
  const availableModels = (provider: GenerationProvider): GenerationModelCapability[] => providerModels(provider)
    .filter(model => Boolean(model.id) && providerStatus(generationProviderForModel(provider, model.id!, model.modelEntryId)) === 'available');
  const available = providers.filter(provider => isGenerationProviderCandidate(provider) && provider.enabled !== false
    && availableModels(provider).length > 0);
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
    for (const model of availableModels(provider)) {
      const modelKey = String(model.modelEntryId ?? model.id ?? provider.id);
      choices.push({provider, model, key: `${provider.connectionId ?? provider.id}:${modelKey}`,
        testId: `${provider.id}-${modelKey}`, label, ...(modelLabel(model) ? {detail: modelLabel(model)} : {})});
    }
  }
  return choices;
}
