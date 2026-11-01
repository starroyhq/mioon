import {isProjectStoreInternalEntry, PROJECT_FILE_EXTENSION} from '../../../contracts/src/project-file.ts';
import {isSkippedEntry} from '../app-db/identity.ts';

// What counts as media (plan 8.4): a file is read only when its extension is
// in the table below and its first bytes match that extension's format. The
// table holds what can be imported today, the MOV the plan names and common
// camera formats (MTS, MXF, AVI, MKV), all of them decoded by ffmpeg; HEIC
// needs a decoder of its own. S1 may narrow what can be imported.

export const MEDIA_KINDS = Object.freeze(['video', 'audio', 'image'] as const);
export type MediaKind = typeof MEDIA_KINDS[number];
export interface MediaType {
  readonly kind: MediaKind;
  readonly mimeType: string;
}
/** Bytes read from the start of a file to detect its type. */
export const MEDIA_HEADER_BYTES = 1024;

type Detector = (header: Uint8Array) => boolean;
const bytesAt = (header: Uint8Array, start: number, expected: readonly number[]): boolean =>
  header.length >= start + expected.length && expected.every((value, index) => header[start + index] === value);
const asciiAt = (header: Uint8Array, start: number, text: string): boolean => bytesAt(header, start, [...text].map(char => char.charCodeAt(0)));

const png: Detector = header => bytesAt(header, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg: Detector = header => bytesAt(header, 0, [0xff, 0xd8, 0xff]);
const riff = (form: string): Detector => header => asciiAt(header, 0, 'RIFF') && asciiAt(header, 8, form);
const isoMedia: Detector = header => asciiAt(header, 4, 'ftyp');
// QuickTime files from before `ftyp` start with another top-level atom.
const QUICKTIME_ATOMS = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'];
const quickTime: Detector = header => QUICKTIME_ATOMS.some(atom => asciiAt(header, 4, atom));
const ebml: Detector = header => bytesAt(header, 0, [0x1a, 0x45, 0xdf, 0xa3]);
// MPEG transport streams: 188-byte packets, or 192 bytes with a 4-byte
// timestamp in front (M2TS, AVCHD's .mts).
const transportStream: Detector = header =>
  [0, 188, 376].every(offset => header[offset] === 0x47) || [4, 196, 388].every(offset => header[offset] === 0x47);
const mxf: Detector = header => bytesAt(header, 0, [0x06, 0x0e, 0x2b, 0x34]);
const wave: Detector = header => ['RIFF', 'RF64', 'BW64'].some(form => asciiAt(header, 0, form)) && asciiAt(header, 8, 'WAVE');
const id3: Detector = header => asciiAt(header, 0, 'ID3');
// An MPEG audio frame header, as managed-asset-import.ts checks it: sync bits,
// a known version and layer, and a valid bitrate and sample rate.
const mpegAudioFrame: Detector = header => header.length >= 4 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0 &&
  (header[1] & 0x18) !== 0x08 && (header[1] & 0x06) !== 0 && (header[2] & 0xf0) !== 0xf0 && (header[2] & 0x0c) !== 0x0c;
const adts: Detector = header => header.length >= 2 && header[0] === 0xff && (header[1] & 0xf6) === 0xf0;
const flac: Detector = header => asciiAt(header, 0, 'fLaC');
const aiff: Detector = header => asciiAt(header, 0, 'FORM') && (asciiAt(header, 8, 'AIFF') || asciiAt(header, 8, 'AIFC'));

interface MediaFormat extends MediaType {
  readonly detect: Detector;
}
const format = (kind: MediaKind, mimeType: string, detect: Detector): MediaFormat => Object.freeze({kind, mimeType, detect});
const IMAGE_JPEG = format('image', 'image/jpeg', jpeg);
const VIDEO_MP4 = format('video', 'video/mp4', isoMedia);
const TRANSPORT_STREAM = format('video', 'video/mp2t', transportStream);
const AIFF = format('audio', 'audio/aiff', aiff);
const FORMATS: ReadonlyMap<string, MediaFormat> = new Map([
  ['png', format('image', 'image/png', png)],
  ['jpg', IMAGE_JPEG],
  ['jpeg', IMAGE_JPEG],
  ['webp', format('image', 'image/webp', riff('WEBP'))],
  ['mp4', VIDEO_MP4],
  ['m4v', VIDEO_MP4],
  ['m4a', format('audio', 'audio/mp4', isoMedia)],
  ['mov', format('video', 'video/quicktime', quickTime)],
  ['webm', format('video', 'video/webm', ebml)],
  ['mkv', format('video', 'video/x-matroska', ebml)],
  ['avi', format('video', 'video/x-msvideo', riff('AVI '))],
  ['mts', TRANSPORT_STREAM],
  ['m2ts', TRANSPORT_STREAM],
  ['mxf', format('video', 'application/mxf', mxf)],
  ['wav', format('audio', 'audio/wav', wave)],
  ['mp3', format('audio', 'audio/mpeg', header => id3(header) || mpegAudioFrame(header))],
  ['aac', format('audio', 'audio/aac', header => id3(header) || adts(header))],
  ['flac', format('audio', 'audio/flac', flac)],
  ['aif', AIFF],
  ['aiff', AIFF],
]);

function formatOfName(name: string): MediaFormat | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? FORMATS.get(name.slice(dot + 1).toLowerCase()) ?? null : null;
}
const typeOf = ({kind, mimeType}: MediaFormat): MediaType => ({kind, mimeType});

/** The type an extension in the table stands for, in any case; null otherwise. */
export function mediaTypeOfName(name: string): MediaType | null {
  const known = formatOfName(name);
  return known === null ? null : typeOf(known);
}

/** The type of `name` when the file's first bytes (up to MEDIA_HEADER_BYTES)
 * match its extension's format; null otherwise. */
export function detectMediaType(name: string, header: Uint8Array): MediaType | null {
  const known = formatOfName(name);
  return known !== null && known.detect(header.subarray(0, MEDIA_HEADER_BYTES)) ? typeOf(known) : null;
}

/** Names that are never media, whatever their content: those every listing
 * of a project directory skips (`.` first, `*.mioon-journal`), the test
 * store's entries and super-journals, and project files. */
export function isProtectedName(name: string): boolean {
  return isSkippedEntry(name) || isProjectStoreInternalEntry(name) || name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);
}
