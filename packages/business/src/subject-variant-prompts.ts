import type {SubjectVariantSpec} from '../../contracts/src/subject-variants.ts';

// Prompts and image names for angle and lighting variants. The subject's look
// comes from the source image; the prompt only names the subject and asks for
// one controlled change. Prompts are English for the image model; names follow
// the server's other generated asset names.
const POSITIONS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  front: ['正面', 'a straight front view, the subject facing the camera'],
  'front-left': ['左前', 'a three-quarter view from the front left, the camera in front of the subject and to its left'],
  left: ['左', 'a side profile from the subject\'s left, the camera at its left side'],
  'back-left': ['左后', 'a three-quarter rear view from the back left, the camera behind the subject and to its left'],
  back: ['背', 'a straight back view, the camera directly behind the subject'],
  'back-right': ['右后', 'a three-quarter rear view from the back right, the camera behind the subject and to its right'],
  right: ['右', 'a side profile from the subject\'s right, the camera at its right side'],
  'front-right': ['右前', 'a three-quarter view from the front right, the camera in front of the subject and to its right'],
  high: ['俯拍', 'a high-angle front view, the camera above the subject looking down'],
  low: ['仰拍', 'a low-angle front view, the camera below the subject looking up'],
});
const FOCALS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  standard: ['标准', 'Use a standard 50mm lens with natural perspective.'],
  wide: ['广角', 'Use a wide-angle 24mm lens with noticeable perspective.'],
});
const QUALITIES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  soft: ['柔光', 'soft, diffused light with gentle shadows'],
  hard: ['硬光', 'hard, direct light with crisp shadows'],
  back: ['逆光', 'strong backlight that rims the subject from behind'],
});
const SUBJECTS: Readonly<Record<string, string>> = Object.freeze({character: 'character', product: 'product'});
const quoted = (name: string): string => JSON.stringify(name.replace(/\s+/g, ' ').trim());

function lightDirection(azimuth: number, elevation: number): string {
  const side = azimuth === 0 ? 'from the camera direction' : Math.abs(azimuth) === 180 ? 'from directly behind the subject'
    : `${Math.abs(azimuth)} degrees to the subject's ${azimuth > 0 ? 'right' : 'left'} of the camera direction`;
  const height = elevation === 0 ? 'at eye level' : `${Math.abs(elevation)} degrees ${elevation > 0 ? 'above' : 'below'} eye level`;
  return `${side}, ${height}`;
}

export function subjectVariantPrompt(subject: {kind: string; name: string}, spec: SubjectVariantSpec): string {
  const noun = SUBJECTS[subject.kind] ?? 'subject';
  if (spec.kind === 'angle') {
    return [`Re-photograph the exact same ${noun} shown in the input image, ${quoted(subject.name)}, from a new camera position: ${POSITIONS[spec.position]![1]}.`,
      FOCALS[spec.focal]![1],
      `Keep the identity, face, hairstyle, clothing, materials, colours, markings and proportions exactly as in the input image, with the same art style and lighting mood.`,
      'Use a plain, uncluttered background. Do not add text, logos or other people.'].join(' ');
  }
  return [`Keep the input image of the ${noun} ${quoted(subject.name)} the same in pose, framing, background and colours, and change only the lighting.`,
    `The key light comes ${lightDirection(spec.azimuth, spec.elevation)}, with ${QUALITIES[spec.quality]![1]}, at a colour temperature of about ${spec.kelvin}K.`,
    'Do not add text, logos or other people.'].join(' ');
}

/** Short Chinese label of a spec, as used in the image names. */
export function subjectVariantLabel(spec: SubjectVariantSpec): string {
  if (spec.kind === 'angle') return spec.focal === 'standard' ? POSITIONS[spec.position]![0] : `${POSITIONS[spec.position]![0]} · ${FOCALS[spec.focal]![0]}`;
  return `打光 · ${QUALITIES[spec.quality]![0]} · ${spec.kelvin}K`;
}

export function subjectVariantImageName(subject: {name: string}, spec: SubjectVariantSpec): string {
  const label = `${spec.kind === 'angle' ? '补角度 · ' : ''}${subjectVariantLabel(spec)}`, suffix = ` · ${label}`;
  // Image names are at most 120 UTF-16 units; the subject name gives way first.
  let head = '';
  for (const character of subject.name.trim()) { if (head.length + character.length > 120 - suffix.length) break; head += character; }
  return `${head}${suffix}`;
}
