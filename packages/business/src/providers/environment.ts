function providerEnvironment<Region extends string | null>(credential: string, prefix: string, region: Region) {
  return Object.freeze({
    credential,
    prefix,
    region,
    approvedAssetSha256: `${prefix}_APPROVED_ASSET_SHA256`,
    outputHosts: `${prefix}_OUTPUT_HOSTS`,
  });
}

// The legacy factories use these names to read environment configuration.
// Configured video, image and Mio connections receive settings from the host.
export const providerSettings = Object.freeze({
  runway: providerEnvironment('RUNWAYML_API_SECRET', 'RUNWAY', null),
  ark: providerEnvironment('ARK_API_KEY', 'ARK', null),
  veo: providerEnvironment('GEMINI_API_KEY', 'VEO', null),
  minimax: providerEnvironment('MINIMAX_API_KEY', 'MINIMAX', 'MINIMAX_REGION'),
  vidu: providerEnvironment('VIDU_API_KEY', 'VIDU', 'VIDU_REGION'),
});

const settings = Object.values(providerSettings);
export const providerEnvironmentKeys = Object.freeze([
  ...settings.flatMap(({region}) => region === null ? [] : [region]),
  ...settings.flatMap(({credential, approvedAssetSha256, outputHosts}) => [credential, approvedAssetSha256, outputHosts]),
]);
