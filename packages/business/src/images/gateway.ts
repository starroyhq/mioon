import {lookup as lookupDns} from 'node:dns/promises';
import {request as requestHttps} from 'node:https';
import {DEFAULT_IMAGE_CONFIGURATION, customImageConfigurationSchema, isCompleteCustomImageConfiguration} from '../../../contracts/src/image-settings.ts';
import {IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT, imageSettingsError, sanitizeImageCredentialResult, sanitizeCustomImageCredentialResult, createImageSettings} from './settings.ts';
import type {AcquiredImageCredential} from './settings.ts';
import {IMAGE_EDIT_LIMITS} from '../../../contracts/src/images.ts';
import {createOpenAIImageAdapter, createCompatibleImageAdapter} from './adapter.ts';
import type {ImageAdapterResult} from './adapter.ts';
import {createImageJsonTransport, createImageEditJsonTransport, createCompatibleImageJsonTransport} from './network.ts';
import {imageAdapterError, parseImageAdapterInput} from './profiles.ts';

type ImageSettingsService = Awaited<ReturnType<typeof createImageSettings>>;
export interface ReviewedImageGatewayOptions {settings?: ImageSettingsService; lookup?: typeof lookupDns; httpsRequest?: typeof requestHttps}
export interface GatewayTransportOptions {lookup: typeof lookupDns; httpsRequest: typeof requestHttps; apiKey: string; baseUrl?: unknown}
export interface GatewayAdapter {
  generate(snapshot: unknown, context: {signal?: AbortSignal; sourceBytes?: Buffer; beforeDispatch: () => unknown}): Promise<ImageAdapterResult>;
}
interface GatewaySlot {
  input?: (input: unknown) => Record<string, unknown>;
  configuration: (configuration: unknown, snapshot: unknown) => Record<string, unknown>;
  credential?: (value: unknown, expected: unknown) => AcquiredImageCredential;
  transport: (options: GatewayTransportOptions, snapshot: unknown) => unknown;
  adapter: (options: {transport?: unknown}) => GatewayAdapter;
}
export interface Gateways {generate(input: unknown, options?: {signal?: AbortSignal; beforeDispatch?: unknown; settingsRevision?: unknown; configuration?: unknown; sourceBytes?: unknown}): Promise<ImageAdapterResult>}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const isEdit = (snapshot: unknown): boolean => record(snapshot)?.purpose === 'edit';
function reviewedCustomConfiguration(configuration: unknown, input: unknown) {
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
function createReviewedImageGateway({settings, lookup = lookupDns, httpsRequest = requestHttps}: ReviewedImageGatewayOptions, slot: GatewaySlot): Gateways {
  const service = settings;
  return Object.freeze({
    async generate(input: unknown, {signal, beforeDispatch, settingsRevision, configuration, sourceBytes}: {signal?: AbortSignal; beforeDispatch?: unknown; settingsRevision?: unknown; configuration?: unknown; sourceBytes?: unknown} = {}): Promise<ImageAdapterResult> {
      if (!service || typeof settingsRevision !== 'number' || !Number.isSafeInteger(settingsRevision) || settingsRevision < 1 || typeof beforeDispatch !== 'function') throw imageSettingsError('IMAGE_SETTINGS_DISABLED');
      const dispatch = beforeDispatch as () => unknown;
      const snapshot: unknown = slot.input ? slot.input(input) : input;
      const snapshotRecord = record(snapshot);
      let privateSource: Buffer | undefined;
      if (snapshotRecord?.purpose === 'edit') {
        const sourceImage = record(snapshotRecord.sourceImage);
        if (!Buffer.isBuffer(sourceBytes) || !sourceBytes.length || sourceBytes.length > IMAGE_EDIT_LIMITS.sourceBytes || sourceBytes.length !== sourceImage?.byteLength) throw imageAdapterError('IMAGE_INVALID_REQUEST');
        privateSource = Buffer.from(sourceBytes);
      } else if (sourceBytes !== undefined) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      const expected = Object.freeze({expectedRevision: settingsRevision, configuration: slot.configuration(configuration, snapshot)});
      const acquired = await service[IMAGE_CREDENTIAL_ACQUIRE](expected, {signal});
      if (signal?.aborted) throw imageSettingsError('IMAGE_SETTINGS_CLOSED');
      const credential = slot.credential ? slot.credential(acquired, expected) : acquired;
      if (!credential.apiKey) throw imageSettingsError('IMAGE_SETTINGS_NOT_CONFIGURED');
      const transport = slot.transport({lookup, httpsRequest, apiKey: credential.apiKey, baseUrl: expected.configuration.baseUrl}, snapshot);
      return slot.adapter({transport}).generate(snapshot, {signal, ...(privateSource === undefined ? {} : {sourceBytes: privateSource}), beforeDispatch: () => {
        // No await after this current-config assertion. The caller immediately
        // commits its review/task dispatch fence, then transport calls end().
        const confirmed = service[IMAGE_SETTINGS_ASSERT_CURRENT](expected);
        if (confirmed !== true) {
          if (confirmed && typeof (confirmed as {then?: unknown}).then === 'function') Promise.resolve(confirmed).catch(() => {});
          throw imageSettingsError('IMAGE_SETTINGS_CONFLICT');
        }
        return dispatch();
      }});
    },
  });
}
export function createLiveImageGateway(options: ReviewedImageGatewayOptions = {}): Gateways {
  return createReviewedImageGateway(options, {
    input: (input: unknown) => {
      const snapshot = parseImageAdapterInput(input, 'openai');
      Object.freeze(snapshot.options);
      if ('sourceImage' in snapshot) { Object.freeze(snapshot.inputImage); Object.freeze(snapshot.sourceImage.origin); Object.freeze(snapshot.sourceImage); }
      return Object.freeze(snapshot);
    },
    configuration: () => Object.freeze({...DEFAULT_IMAGE_CONFIGURATION, enabled: true}),
    credential: sanitizeImageCredentialResult,
    transport: (options, snapshot) => isEdit(snapshot) ? createImageEditJsonTransport(options) : createImageJsonTransport(options),
    adapter: createOpenAIImageAdapter,
  });
}
export function createCompatibleImageGateway(options: ReviewedImageGatewayOptions = {}): Gateways {
  return createReviewedImageGateway(options, {
    input: (input: unknown) => {
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
