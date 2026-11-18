import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GEMINI_OMNI_CAPABILITY, GEMINI_OMNI_MODEL_ID, GEMINI_OMNI_PROFILE_VERSION, GEMINI_OMNI_PROTOCOL_VERSION} from '../packages/contracts/src/gemini-omni-video.ts';
import {defaultVideoModels, migrateGoogleVideoConfiguration, newVideoModelEntry, parseVideoBinding, validateVideoSnapshot, videoBindingCapabilities, videoConnectionConfigurationSchema, videoInputProfile, videoTemplate} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding, VideoModelEntry} from '../packages/contracts/src/video-providers.ts';
import {getCapabilityProfile} from '../packages/contracts/src/generation-input-profiles.ts';
import {newVideoConnection} from '../apps/web/src/video-settings.ts';
import {generationProfileSelection, generationSelection, isGenerationProviderCandidate, videoConnectionProviders} from '../apps/web/src/generation-settings.ts';

const legacyModel = (): VideoModelEntry => ({id: randomUUID(), name: 'veo-3.1-generate-preview', modelId: 'veo-3.1-generate-preview', templateId: 'veo-v1', enabled: true, archived: false, inputModes: ['text', 'image'], aspectRatios: ['9:16', '16:9'], durationResolutionMap: [{duration: [4, 6, 8], resolution: ['720p']}], audio: 'on', seed: false});
const binding = (model: VideoModelEntry = defaultVideoModels('veo')[0]!): VideoExecutionBinding => ({version: 1, connectionId: randomUUID(), configurationRevision: 5, providerId: 'veo', region: 'global', workspaceId: '', endpoint: 'https://generativelanguage.googleapis.com/v1beta', credentialRef: randomUUID(), model, outputHosts: []});
const snapshot = (model: VideoModelEntry) => ({providerId: 'veo', model: model.modelId, prompt: 'A synthetic paper bird slowly turns on a pedestal.', aspectRatio: '9:16', duration: 3, parameters: {resolution: '720p'}, referenceAssets: []});

test('Omni has its own exact protocol and active profile while future documented modes stay closed', () => {
  const selected = binding(), profile = videoInputProfile(selected), template = videoTemplate(GEMINI_OMNI_PROTOCOL_VERSION);
  assert.deepEqual([selected.model.modelId, selected.model.templateId, profile.profileVersion, profile.apiFamily], [GEMINI_OMNI_MODEL_ID, GEMINI_OMNI_PROTOCOL_VERSION, GEMINI_OMNI_PROFILE_VERSION, GEMINI_OMNI_PROTOCOL_VERSION]);
  assert.deepEqual(template.inputModes, ['text', 'image']);
  assert.deepEqual(profile.inputs.combinations, [[], ['first_frame']]);
  assert.equal(profile.inputs.roles.last_frame!.implemented, false);
  assert.equal(profile.inputs.roles.reference_image?.implemented ?? false, false);
  assert.deepEqual(profile.durationsSeconds, Array.from({length: 13}, (_, index) => index + 3));
  assert.deepEqual(selected.model.durationResolutionMap[0]!.resolution, ['720p', '360p', '1080p', '4k']);
  assert.deepEqual(profile.output, {audio: 'on', mimeType: 'video/mp4', fps: 24});
  assert.match(profile.inputs.roles.first_frame!.maxBytesSource!, /unconfirmed/);
  assert.equal(profile.inputs.roles.first_frame!.maxBytes, 10 * 1024 * 1024);
  assert.deepEqual(GEMINI_OMNI_CAPABILITY.modes.filter(mode => !mode.implemented), [
    {modeId: 'first_last_frame', implemented: false, minImages: 2, maxImages: 2, minSeconds: 3, maxSeconds: 10},
    {modeId: 'reference_to_video', implemented: false, minImages: 1, maxImages: 6, maxSubjects: 2, maxImagesPerSubject: 3},
  ]);
  const configuration = {...newVideoConnection('veo'), archived: false};
  assert.equal(videoConnectionConfigurationSchema.safeParse(configuration).success, true);
  for (const model of [{...selected.model, modelId: 'gemini-omni-future'}, {...selected.model, inputModes: ['frames']}, {...selected.model, audio: 'off'}]) {
    assert.equal(videoConnectionConfigurationSchema.safeParse({...configuration, models: [model]}).success, false);
  }
});

test('Omni submit bounds reject unsupported modes and sizes before transport', () => {
  const selected = binding(), input = snapshot(selected.model);
  assert.equal(validateVideoSnapshot(selected, input), true);
  for (const duration of [3, 15]) for (const resolution of ['360p', '720p', '1080p', '4k']) assert.equal(validateVideoSnapshot(selected, {...input, duration, parameters: {resolution}}), true);
  for (const duration of [2, 16]) assert.throws(() => validateVideoSnapshot(selected, {...input, duration}), {code: 'UNSUPPORTED_PARAMETERS'});
  const first = {id: randomUUID(), role: 'first_frame', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), width: 9, height: 16};
  assert.equal(validateVideoSnapshot(selected, {...input, referenceAssets: [first]}), true);
  for (const image of [{...first, sizeBytes: 10 * 1024 * 1024 + 1}, {...first, mimeType: 'image/webp'}]) assert.throws(() => validateVideoSnapshot(selected, {...input, referenceAssets: [image]}), {code: 'INVALID_REFERENCE_METADATA'});
  for (const role of ['last_frame', 'reference_image', 'subject_reference']) assert.throws(() => validateVideoSnapshot(selected, {...input, referenceAssets: [{...first, role}]}));
  assert.throws(() => validateVideoSnapshot(selected, {...input, referenceAssets: [first, {...first, id: randomUUID(), role: 'last_frame'}]}), {code: 'UNSUPPORTED_INPUT_ROLE'});
  assert.throws(() => validateVideoSnapshot(selected, {...input, parameters: {resolution: '720p', generateAudio: false}}), {code: 'UNSUPPORTED_PARAMETERS'});
});

test('the deterministic Google migration retains connection and model identity and user bounds', () => {
  const configuration = {...newVideoConnection('veo'), models: [legacyModel()]}, before = structuredClone(configuration);
  const projected = migrateGoogleVideoConfiguration(configuration);
  assert.deepEqual(configuration, before);
  assert.deepEqual(projected, {...configuration, models: [{...configuration.models[0]!, modelId: GEMINI_OMNI_MODEL_ID, name: GEMINI_OMNI_MODEL_ID, templateId: GEMINI_OMNI_PROTOCOL_VERSION}]});
  assert.deepEqual(migrateGoogleVideoConfiguration(projected), projected);
  const named = {...configuration, models: [{...configuration.models[0]!, name: 'My selected Google model'}]};
  assert.equal(migrateGoogleVideoConfiguration(named).models[0]!.name, named.models[0]!.name);
  assert.equal(migrateGoogleVideoConfiguration({...configuration, providerId: 'compatible'}).models[0]!.modelId, before.models[0]!.modelId);
  const historical = getCapabilityProfile('veo', 'veo-3.1-generate-preview', 'global')!;
  assert.equal(historical.apiFamily, 'gemini-developer-v1beta');
  assert.equal(historical.profileId, 'veo:veo-3.1-generate-preview:v1');
  assert.equal(parseVideoBinding(binding(legacyModel())).model.templateId, 'veo-v1');
  const customHistorical = binding({...legacyModel(), modelId: 'veo-custom-historical'});
  assert.throws(() => validateVideoSnapshot(customHistorical, {...snapshot(customHistorical.model), duration: 4}), {code: 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED'});
});

test('configured Omni serializes an exact ready profile and retired Veo is absent from new candidates', () => {
  const selected = binding(), capabilities = videoBindingCapabilities(selected);
  const [provider] = videoConnectionProviders([{connectionId: selected.connectionId, configurationRevision: 5, providerId: 'veo', name: 'Google Veo', region: 'global', enabled: true, configured: true, models: [{entry: selected.model, capabilities}]}]);
  assert.equal(generationProfileSelection(provider, GEMINI_OMNI_MODEL_ID).state, 'ready');
  assert.equal(generationSelection([provider!], {connectionId: selected.connectionId}).model, GEMINI_OMNI_MODEL_ID);
  assert.equal(isGenerationProviderCandidate({id: 'veo', models: ['veo-3.1-generate-preview']}), false);
  const oldModel = legacyModel(), old = videoBindingCapabilities(binding(oldModel));
  const [legacy] = videoConnectionProviders([{connectionId: selected.connectionId, configurationRevision: 5, providerId: 'veo', name: 'Google Veo', region: 'global', enabled: true, configured: true, models: [{entry: oldModel, capabilities: old}]}]);
  assert.deepEqual(legacy!.models, []);
});

test('new compatible connections need an explicit model while saved gateway names are preserved', () => {
  assert.deepEqual(defaultVideoModels('compatible'), []);
  assert.deepEqual(newVideoConnection('compatible').models, []);
  const draft = newVideoModelEntry('compatible');
  assert.deepEqual([draft.modelId, draft.name, draft.templateId], ['', '', 'openai-video-v1']);
  const saved = {...newVideoConnection('compatible'), baseUrl: 'https://gateway.example.com/v1', archived: false, models: [newVideoModelEntry('compatible', 'sora-2')]};
  const result = videoConnectionConfigurationSchema.parse(saved);
  assert.equal(result.models[0]!.modelId, 'sora-2');
  assert.deepEqual(migrateGoogleVideoConfiguration(result), result);
});
