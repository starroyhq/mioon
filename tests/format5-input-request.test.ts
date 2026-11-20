import assert from 'node:assert/strict';
import test from 'node:test';
import {format5GenerationInputService} from '../apps/web/src/board-ui/generation-input-request.ts';
import {FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION, FORMAT5_MOCK_INPUT_CONNECTION_ID, FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID} from '../packages/contracts/src/sequence-inspection.ts';

test('Mock sends the reserved projection identity instead of pretending no service is selected', () => {
  assert.deepEqual(format5GenerationInputService({id: 'mock', mock: true}, {modelEntryId: undefined}),
    {connectionId: FORMAT5_MOCK_INPUT_CONNECTION_ID,
      configurationRevision: FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,
      modelEntryId: FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID});
});
test('a configured video connection keeps the exact binding triple and a non-Mock provider sends none', () => {
  assert.deepEqual(format5GenerationInputService({id: 'ark', connectionId: 'connection-1',
    configurationRevision: 3}, {modelEntryId: 'model-1'}),
  {connectionId: 'connection-1', configurationRevision: 3, modelEntryId: 'model-1'});
  assert.deepEqual(format5GenerationInputService({id: 'ark', name: 'Ark'}, {modelEntryId: undefined}), {});
});
