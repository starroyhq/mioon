/**
 * Browser-safe facts checked against the six Mioon adapters and asset.import.
 * These describe implemented app routes, never vendor feature unions or runtime
 * enablement. Actual bytes, ownership, authorization and dispatch stay server-side.
 */
// Discovery-envelope version stays stable. Individual exact profiles version
// independently; archived jobs must never be reinterpreted using active policy.
export const PROFILE_VERSION = 'mioon-input-profiles/1';
export const FRAME_PAIR_PROFILE_VERSION = 'mioon-input-profiles/2';
export const REVIEWED_ON = '2026-10-10';
export const INPUT_ROLES = Object.freeze(['first_frame', 'last_frame', 'subject_reference', 'style_reference', 'motion_reference']);
export const MOCK_SCENARIOS = Object.freeze(['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once', 'rejected_before_accept', 'accepted_then_response_lost', 'poll_timeout_then_recover', 'terminal_failure']);
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
const MiB = 1024 * 1024;
const roles = (min, image, simulation = false) => ({
  minReferences: min, maxReferences: 1,
  combinations: min ? [['first_frame']] : [[], ['first_frame']],
  roles: Object.fromEntries(INPUT_ROLES.map(role => [role, role === 'first_frame'
    ? { implemented: true, semantics: simulation ? 'simulation-only' : 'first-frame-conditioning', min, max: 1, ...image }
    : { implemented: false, min: 0, max: 0, reason: 'No mapping in the current Mioon adapter.' }])),
});
const common = {
  profileVersion: PROFILE_VERSION, reviewedOn: REVIEWED_ON, implemented: true, liveVerified: false,
  // Runtime configuration must come from provider.list. It cannot be inferred here.
  runtimeAvailability: 'not-evaluated', prompt: { required: true, maxCodeUnits: 1000 },
  aspectRatios: ['9:16', '16:9'], durationsSeconds: [4, 8], parameters: {},
  approvalRequired: true, requiresManagedImageVerification: true,
};
const image = { mimeTypes: ['image/png', 'image/jpeg'], maxBytes: 10 * MiB, maxBytesSource: 'Mioon managedImage default', dimensions: null };
const profile = (providerId, model, fields) => ({ ...common, providerId, model, profileId: `${providerId}:${model}:v1`, ...fields });
const legacyProfiles = deepFreeze([
  profile('runway', 'gen4_turbo', {
    regions: ['global'], regionMeaning: 'Fixed Runway API endpoint label; not a data-residency guarantee.',
    apiFamily: 'runway-v1', origins: { global: 'https://api.dev.runwayml.com' },
    adapterSource: 'packages/business/src/providers/runway.mjs',
    inputModes: ['image'], aspectRatios: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'],
    durationsSeconds: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    output: { ratioPixels: { '9:16': '720:1280', '16:9': '1280:720', '1:1': '960:960', '3:4': '832:1104', '4:3': '1104:832', '21:9': '1584:672' }, audio: 'not-configured' },
    parameters: { seed: { type: 'integer', min: 0, max: 4294967295 } },
    inputs: roles(1, { ...image, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5 * MiB * 3 / 4, maxBytesSource: 'Runway adapter raw upper bound; encoded data URI bound also applies', maxDataUriBytes: 5 * MiB }),
  }),
  profile('ark', 'doubao-seedance-2-5-260628', {
    regions: ['cn-beijing'], regionMeaning: 'Fixed mainland-China Ark endpoint.', apiFamily: 'ark-v3',
    origins: { 'cn-beijing': 'https://ark.cn-beijing.volces.com/api/v3' },
    adapterSource: 'packages/business/src/providers/ark.mjs', inputModes: ['text', 'image'],
    output: { resolution: '720p', audio: 'disabled' },
    inputs: roles(0, { ...image, dimensions: { min: 300, max: 6000, matchAspectRatio: true } }),
  }),
  profile('veo', 'veo-3.1-generate-preview', {
    regions: ['global'], regionMeaning: 'Gemini Developer API endpoint; not Vertex AI or a residency guarantee.', apiFamily: 'gemini-developer-v1beta',
    origins: { global: 'https://generativelanguage.googleapis.com/v1beta' },
    adapterSource: 'packages/business/src/providers/veo.mjs', inputModes: ['text', 'image'],
    durationsSeconds: [4, 6, 8], output: { resolution: '720p', audio: 'model-default' },
    inputs: roles(0, image),
    lifecycle: {
      status: 'preview-retirement-announced', earliestShutdownDate: '2026-10-22', checkedOn: REVIEWED_ON,
      source: 'https://ai.google.dev/gemini-api/docs/deprecations',
      replacementImplemented: false,
      policy: 'warn-before-date; require profile revalidation on or after date; never substitute models',
    },
  }),
  profile('minimax', 'MiniMax-H3', {
    regions: ['global', 'cn'], regionMeaning: 'Explicit regional account/API selection; credentials must match.', apiFamily: 'minimax-video-v2',
    origins: { global: 'https://api.minimax.io', cn: 'https://api.minimax.cn' },
    adapterSource: 'packages/business/src/providers/minimax.mjs', inputModes: ['text', 'image'],
    output: { resolution: '768P', audio: 'model-default' },
    inputs: roles(0, { ...image, dimensions: { min: 256, max: 5760, matchAspectRatio: true } }),
  }),
  profile('vidu', 'viduq3-turbo', {
    regions: ['global', 'cn'], regionMeaning: 'Explicit regional account/API selection; credentials must match.', apiFamily: 'vidu-ent-v2',
    origins: { global: 'https://api.vidu.com', cn: 'https://api.vidu.cn' },
    adapterSource: 'packages/business/src/providers/vidu.mjs', inputModes: ['text', 'image'],
    requiresReviewedOutputHosts: true, output: { resolution: '720p', audio: 'disabled', exactImageOutputDimensions: 'live-unverified' },
    inputs: roles(0, { ...image, maxBytes: 9_999_999, maxBytesSource: 'Vidu adapter strict less-than-10,000,000 byte limit', dimensions: { min: 1, max: null, matchAspectRatio: true } }),
  }),
  profile('mock', 'mock-motion-v1', {
    regions: ['local'], regionMeaning: 'Local simulated provider; no external provider.', apiFamily: 'mioon-simulation', origins: {},
    adapterSource: 'packages/business/src/providers/mock.mjs', inputModes: ['text', 'image'], simulationOnly: true,
    prompt: { required: false, maxCodeUnits: 5000 }, aspectRatios: ['9:16'], durationsSeconds: [2, 4, 8],
    approvalRequired: false, requiresManagedImageVerification: false,
    output: { width: 360, height: 640, audio: 'disabled', depictsPromptOrReferences: false },
    parameters: { scenario: { type: 'enum', values: MOCK_SCENARIOS }, delayMs: { type: 'integer', min: 0, max: 120000 }, seed: { type: 'integer', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } },
    inputs: roles(0, { ...image, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 30 * MiB, maxBytesSource: 'Mioon asset.import cap; mock does not read reference image bytes' }, true),
  }),
]);
const withFramePair = legacy => ({
  ...legacy, profileId: `${legacy.providerId}:${legacy.model}:v2`, profileVersion: FRAME_PAIR_PROFILE_VERSION,
  reviewedOn: '2026-10-11',
  inputs: {
    ...legacy.inputs, maxReferences: 2, combinations: [[], ['first_frame'], ['first_frame', 'last_frame']],
    roles: { ...legacy.inputs.roles, last_frame: { ...legacy.inputs.roles.first_frame, min: 0,
      semantics: legacy.simulationOnly ? 'simulation-only' : 'last-frame-conditioning' } },
    distinctAssetsRequired: true,
    distinctAssetsReason: 'Current Mioon app restriction; not a claimed provider requirement.',
  },
});
export const CAPABILITY_PROFILES = deepFreeze(legacyProfiles.map(profile =>
  ['ark', 'mock'].includes(profile.providerId) ? withFramePair(profile) : profile));
export const ARCHIVED_CAPABILITY_PROFILES = deepFreeze(legacyProfiles.filter(profile => ['ark', 'mock'].includes(profile.providerId)));
const exactProfiles = [...CAPABILITY_PROFILES, ...ARCHIVED_CAPABILITY_PROFILES];
/** Exact lookup. Optional pins must be complete; never fall back to current policy. */
export function getCapabilityProfile(providerId, model, region, pin) {
  if (![providerId, model, region].every(value => typeof value === 'string')) return null;
  const matches = p => p.providerId === providerId && p.model === model && p.regions.includes(region);
  if (pin === undefined) return CAPABILITY_PROFILES.find(matches) ?? null;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) || ![Object.prototype, null].includes(Object.getPrototypeOf(pin)) ||
      Object.getOwnPropertySymbols(pin).length || Object.values(Object.getOwnPropertyDescriptors(pin)).some(d => d.get || d.set || !d.enumerable) ||
      Object.keys(pin).length !== 2 || !Object.hasOwn(pin, 'profileId') || !Object.hasOwn(pin, 'profileVersion') || typeof pin.profileId !== 'string' || typeof pin.profileVersion !== 'string') return null;
  return exactProfiles.find(p => matches(p) && p.profileId === pin.profileId && p.profileVersion === pin.profileVersion) ?? null;
}
/** Only for already-frozen jobs that predate profile pins. Never new discovery. */
export function getLegacyCapabilityProfile(providerId, model, region) {
  if (![providerId, model, region].every(value => typeof value === 'string')) return null;
  return legacyProfiles.find(p => p.providerId === providerId && p.model === model && p.regions.includes(region)) ?? null;
}

// Fixed-origin labels are endpoint identities, not selectable browser regions.
export function getGenerationProfileRegion(providerId, capabilities = {}) {
  if (providerId === 'mock') return 'local';
  if (providerId === 'runway' || providerId === 'veo') return 'global';
  if (providerId === 'ark') return 'cn-beijing';
  if (providerId === 'minimax' || providerId === 'vidu') return capabilities?.region ?? null;
  return null;
}
export const INPUT_PROFILE_VERSION = PROFILE_VERSION;
export const GENERATION_INPUT_ROLES = INPUT_ROLES;
export const GENERATION_INPUT_PROFILES = CAPABILITY_PROFILES;
