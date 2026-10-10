import {lookup as lookupDns} from 'node:dns/promises';
import {request as requestHttps} from 'node:https';
import {DEFAULT_IMAGE_CONFIGURATION} from '../../../contracts/src/image-settings.mjs';
import {IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT, imageSettingsError} from './settings.mjs';
import {createOpenAIImageAdapter} from './adapter.mjs';
import {createImageJsonTransport} from './network.mjs';

/** Trusted backend composition only. UI/RPC cannot inject a transport, endpoint
 * or credential. Each invocation owns one key and one nonretrying request. */
export function createLiveImageGateway({settings, lookup = lookupDns, httpsRequest = requestHttps} = {}) {
  return Object.freeze({
    async generate(input, {signal, beforeDispatch, settingsRevision} = {}) {
      if (!settings || !Number.isSafeInteger(settingsRevision) || settingsRevision < 1 || typeof beforeDispatch !== 'function') throw imageSettingsError('IMAGE_SETTINGS_DISABLED');
      const expected = {expectedRevision: settingsRevision, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}};
      const credential = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected, {signal});
      if (signal?.aborted) throw imageSettingsError('IMAGE_SETTINGS_CLOSED');
      if (!credential.apiKey) throw imageSettingsError('IMAGE_SETTINGS_NOT_CONFIGURED');
      const transport = createImageJsonTransport({lookup, httpsRequest, apiKey: credential.apiKey});
      return createOpenAIImageAdapter({transport}).generate(input, {signal, beforeDispatch: () => {
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
