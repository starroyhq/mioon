/** Exact Gemini Developer API video capability. RI owns opening the later modes. */
export const GEMINI_OMNI_MODEL_ID = 'gemini-omni-1.2-flash';
export const GEMINI_OMNI_PROTOCOL_VERSION = 'gemini-omni-v1';
export const GEMINI_OMNI_PROFILE_VERSION = 'mioon-gemini-omni-input/1';
export const GEMINI_OMNI_REVIEWED_ON = '2026-11-18';
export const GEMINI_OMNI_SOURCE = 'https://aistudio.google.com/docs/omni';

export const GEMINI_OMNI_CAPABILITY = Object.freeze({
  providerId: 'veo', modelId: GEMINI_OMNI_MODEL_ID, region: 'global',
  protocolVersion: GEMINI_OMNI_PROTOCOL_VERSION, profileVersion: GEMINI_OMNI_PROFILE_VERSION,
  apiFamily: 'gemini-interactions-v1beta', source: GEMINI_OMNI_SOURCE, reviewedOn: GEMINI_OMNI_REVIEWED_ON,
  modes: Object.freeze([
    Object.freeze({modeId: 'text_to_video', implemented: true, minImages: 0, maxImages: 0}),
    Object.freeze({modeId: 'image_to_video', implemented: true, minImages: 1, maxImages: 1}),
    Object.freeze({modeId: 'first_last_frame', implemented: false, minImages: 2, maxImages: 2, minSeconds: 3, maxSeconds: 10}),
    Object.freeze({modeId: 'reference_to_video', implemented: false, minImages: 1, maxImages: 6, maxSubjects: 2, maxImagesPerSubject: 3}),
  ]),
  durationsSeconds: Object.freeze(Array.from({length: 13}, (_, index) => index + 3)),
  aspectRatios: Object.freeze(['9:16', '16:9']), resolutions: Object.freeze(['720p', '360p', '1080p', '4k']),
  output: Object.freeze({mimeType: 'video/mp4', fps: 24, audio: 'on'}),
  // Dedicated Omni image byte and geometry limits are unpublished. Keep the
  // existing conservative image boundary until a model-specific limit is known.
  maxImageBytes: 10 * 1024 * 1024, minDimension: 1, maxDimension: 16384,
  mimeTypes: Object.freeze(['image/png', 'image/jpeg']),
  maxImageBytesSource: 'Mioon conservative limit; Omni-specific byte limit unconfirmed',
  imageGeometrySource: 'Mioon conservative limit; Omni-specific geometry limit unconfirmed',
  maxPromptLength: 1000,
});
export function isGeminiOmniBinding(binding: {providerId: string; region: string; model: {modelId: string; templateId: string}}): boolean {
  return binding.providerId === 'veo' && binding.region === 'global'
    && binding.model.modelId === GEMINI_OMNI_MODEL_ID && binding.model.templateId === GEMINI_OMNI_PROTOCOL_VERSION;
}
