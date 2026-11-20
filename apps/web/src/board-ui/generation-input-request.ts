import {FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION, FORMAT5_MOCK_INPUT_CONNECTION_ID, FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID} from '../../../../packages/contracts/src/sequence-inspection.ts';
import type {GenerationProvider, GenerationSelectionResult} from '../generation-settings.ts';

/** The exact service fields sent to `sequence.generation-inputs.get`.
 *
 * Video connections use their real binding triple. The built-in Mock provider
 * has no configured connection, but the projection still needs an explicit
 * selected-service identity; the reserved triple is mapped to Mock's reviewed
 * capabilities by the service. */
export function format5GenerationInputService(provider: GenerationProvider | undefined,
  selection: Pick<GenerationSelectionResult, 'modelEntryId'>): {connectionId?: string; configurationRevision?: number; modelEntryId?: string} {
  if (provider?.connectionId && Number.isSafeInteger(provider.configurationRevision) && selection.modelEntryId) {
    return {connectionId: provider.connectionId, configurationRevision: Number(provider.configurationRevision),
      modelEntryId: selection.modelEntryId};
  }
  if (provider?.mock || provider?.id === 'mock') {
    return {connectionId: FORMAT5_MOCK_INPUT_CONNECTION_ID,
      configurationRevision: FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,
      modelEntryId: FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID};
  }
  return {};
}
