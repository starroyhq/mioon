import {IMAGE_SETTINGS_BASE_URL} from '../../../contracts/src/image-settings.ts';
import type {OfficialImageProbe, CustomImageProbe} from '../../../contracts/src/draft-image-probe.ts';
import type {DraftServiceProbeResult} from '../../../contracts/src/draft-service-probe.ts';
import {readDraftServiceModels} from '../draft-service-probe.ts';
import {awaitProvider} from '../operation-lifecycle.ts';
import {createPinnedVideoFetch} from '../video/network.ts';
import {IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_READ_CURRENT, imageSettingsError} from './settings.ts';
import type {createImageSettings} from './settings.ts';
import type {createCustomImageSettingsV2} from './custom-settings-v2.ts';

type ImageSettings = Awaited<ReturnType<typeof createImageSettings>>;
type CustomSettings = Awaited<ReturnType<typeof createCustomImageSettingsV2>>;
type ProbeRequest =
  | {kind: 'official'; input: OfficialImageProbe; settings: ImageSettings}
  | {kind: 'custom'; input: CustomImageProbe; settings: CustomSettings};

function currentCustom(settings: CustomSettings, baseUrl: string, connectionId: string, revision: number) {
  const current = settings.select(connectionId);
  if (current.configurationRevision !== revision || current.configuration.baseUrl !== baseUrl) {
    throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
  }
  return {connectionId, configurationRevision: revision, configuration: current.configuration};
}

async function acquireSaved(request: ProbeRequest, signal: AbortSignal): Promise<string> {
  if (request.kind === 'custom') {
    const {baseUrl, credential} = request.input, {settings} = request;
    if (credential.source !== 'saved') throw imageSettingsError();
    const expected = currentCustom(settings, baseUrl, credential.connectionId, credential.configurationRevision);
    const {apiKey} = await settings.acquire(expected, {signal});
    currentCustom(settings, baseUrl, credential.connectionId, credential.configurationRevision);
    if (!apiKey) throw imageSettingsError('IMAGE_SETTINGS_NOT_CONFIGURED');
    return apiKey;
  }

  const {credential} = request.input, {settings} = request;
  if (credential.source !== 'saved') throw imageSettingsError();
  const snapshot = settings[IMAGE_SETTINGS_READ_CURRENT]();
  if (snapshot.revision !== credential.configurationRevision || snapshot.configuration.baseUrl !== IMAGE_SETTINGS_BASE_URL) {
    throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
  }
  const {apiKey} = await settings[IMAGE_CREDENTIAL_ACQUIRE]({expectedRevision: snapshot.revision, configuration: snapshot.configuration}, {signal});
  if (settings[IMAGE_SETTINGS_READ_CURRENT]().revision !== snapshot.revision) throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
  if (!apiKey) throw imageSettingsError('IMAGE_SETTINGS_NOT_CONFIGURED');
  return apiKey;
}

/** One explicit, read-only model request. Existing generation and saved
 * credentials have separate lifetimes and neither can be updated by a probe. */
export async function probeImageService(request: ProbeRequest, {signal, fetchImpl = createPinnedVideoFetch()}: {
  signal?: AbortSignal; fetchImpl?: typeof fetch;
} = {}): Promise<DraftServiceProbeResult> {
  const deadline = AbortSignal.timeout(10_000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const {input} = request;
  const baseUrl = request.kind === 'custom' ? request.input.baseUrl : IMAGE_SETTINGS_BASE_URL;
  const key = input.credential.source === 'draft' ? input.credential.value : await acquireSaved(request, active);
  if (active.aborted) return {result: 'unreachable'};
  try {
    const response = await awaitProvider(async () => {
      const pending = await fetchImpl(`${baseUrl}/models`, {method: 'GET', signal: active, redirect: 'error',
        headers: {Authorization: `Bearer ${key}`, Accept: 'application/json'}});
      if (active.aborted) void pending.body?.cancel().catch(() => {});
      return pending;
    }, active);
    const status = response.status;
    if (response.redirected) {
      void response.body?.cancel().catch(() => {});
      return {result: 'denied'};
    }
    if (response.ok) {
      const models = await readDraftServiceModels(response, key, active);
      if (active.aborted) return {result: 'unreachable'};
      if (models === null) return {result: 'failed'};
      return input.operation === 'models' ? {result: 'ok', models} : {result: 'ok'};
    }
    void response.body?.cancel().catch(() => {});
    if (active.aborted) return {result: 'unreachable'};
    if (status === 401 || status === 403) return {result: 'unauthorized', httpStatus: status};
    if (status === 404 || status === 405) return {result: 'unsupported', httpStatus: status};
    return {result: 'http_error', httpStatus: status};
  } catch (error) {
    return {result: error !== null && typeof error === 'object' && 'code' in error && error.code === 'VIDEO_NETWORK_DENIED' ? 'denied' : 'unreachable'};
  }
}
