import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
const fadeKeys = ['fadeInFrames', 'fadeOutFrames'];
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Missing metadata is deliberately distinct from an explicitly saved zero.
// Rendering a default must never add fields to an unrelated clip update.
export function clipAudioDraft(clip) {
  return Object.fromEntries(fadeKeys.filter(key => owns(clip, key)).map(key => [key, clip[key]]));
}

export function clipAudioPatch(draft) {
  return Object.fromEntries(fadeKeys.filter(key => owns(draft, key)).map(key => [key, Number(draft[key])]));
}

export function supportsClipAudioFades(asset) {
  return asset?.hasAudio === true && ['audio', 'video'].includes(asset?.mimeType?.split('/')[0]);
}

function frameValue(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  return Number(value);
}

export function clipAudioMessage(draft, asset) {
  const fades = fadeKeys.map(key => owns(draft, key) ? frameValue(draft[key]) : 0);
  if (fades.some(value => !Number.isSafeInteger(value) || value < 0)) return message('audio.clip.integerFrames');
  const duration = frameValue(draft.durationFrames);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 18000) return message('audio.clip.durationFirst');
  if (fades.some(value => value > duration) || fades[0] + fades[1] > duration) return message('audio.clip.totalTooLong', { duration });
  if (fades.some(value => value > 0) && !supportsClipAudioFades(asset)) return message('audio.clip.requiresAudio');
  return null;
}

export function clipAudioIssue(draft, asset) { return renderMessage('zh-Hans', clipAudioMessage(draft, asset)); }
