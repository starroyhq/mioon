import {lookup as lookupDns} from 'node:dns/promises';
import {request as requestHttps} from 'node:https';
import {DEFAULT_IMAGE_CONFIGURATION, customImageConfigurationSchema, isCompleteCustomImageConfiguration} from '../../../contracts/src/image-settings.mjs';
import {IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT, imageSettingsError, sanitizeCustomImageCredentialResult} from './settings.mjs';
import {createOpenAIImageAdapter, createCompatibleImageAdapter} from './adapter.mjs';
import {createImageJsonTransport, createCompatibleImageJsonTransport} from './network.mjs';
import {parseImageAdapterInput} from './profiles.mjs';

function reviewedCustomConfiguration(configuration, input) {
  const parsed = customImageConfigurationSchema.safeParse(configuration);
  if (!parsed.success || !isCompleteCustomImageConfiguration(parsed.data)) throw imageSettingsError('IMAGE_SETTINGS_VALIDATION');
  if (!parsed.data.enabled) throw imageSettingsError('IMAGE_SETTINGS_DISABLED');
  const generation = parseImageAdapterInput(input, 'openai-compatible');
  if (generation.model !== parsed.data.model) throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
  // Zod owns a fresh copy. Neither a caller nor an async credential operation can
  // replace the reviewed destination/model while DNS or TLS is in progress.
  Object.freeze(parsed.data.options);
  return Object.freeze(parsed.data);
}

/** Trusted backend composition only. UI/RPC cannot inject a transport or key.
 * Every call acquires one revision-bound credential and makes one nonretrying
 * request. The caller owns the immutable review and durable task-dispatch fence. */
function createReviewedImageGateway({settings, lookup = lookupDns, httpsRequest = requestHttps}, slot) {
  return Object.freeze({
    async generate(input, {signal, beforeDispatch, settingsRevision, configuration} = {}) {
      if (!settings || !Number.isSafeInteger(settingsRevision) || settingsRevision < 1 || typeof beforeDispatch !== 'function') throw imageSettingsError('IMAGE_SETTINGS_DISABLED');
      const snapshot = slot.input ? slot.input(input) : input;
      const expected = Object.freeze({expectedRevision: settingsRevision, configuration: slot.configuration(configuration, snapshot)});
      const acquired = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected, {signal});
      if (signal?.aborted) throw imageSettingsError('IMAGE_SETTINGS_CLOSED');
      const credential = slot.credential ? slot.credential(acquired, expected) : acquired;
      if (!credential.apiKey) throw imageSettingsError('IMAGE_SETTINGS_NOT_CONFIGURED');
      const transport = slot.transport({lookup, httpsRequest, apiKey: credential.apiKey, baseUrl: expected.configuration.baseUrl});
      return slot.adapter({transport}).generate(snapshot, {signal, beforeDispatch: () => {
        // No await after this current-config assertion. The caller immediately
        // commits its review/task dispatch fence, then transport calls end().
        const confirmed = settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected);
        if (confirmed !== true) {
          if (confirmed && typeof confirmed.then === 'function') Promise.resolve(confirmed).catch(() => {});
          throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
        }
        return beforeDispatch();
      }});
    },
  });
}
export function createLiveImageGateway(options = {}) {
  return createReviewedImageGateway(options, {
    configuration: () => ({...DEFAULT_IMAGE_CONFIGURATION, enabled: true}),
    transport: createImageJsonTransport,
    adapter: createOpenAIImageAdapter,
  });
}
export function createCompatibleImageGateway(options = {}) {
  return createReviewedImageGateway(options, {
    input: input => {
      const snapshot = parseImageAdapterInput(input, 'openai-compatible');
      Object.freeze(snapshot.options);
      return Object.freeze(snapshot);
    },
    configuration: reviewedCustomConfiguration,
    credential: sanitizeCustomImageCredentialResult,
    transport: createCompatibleImageJsonTransport,
    adapter: createCompatibleImageAdapter,
  });
}
