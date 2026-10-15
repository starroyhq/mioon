import {CUBE_3D_LIMITS, parseCube3D} from './cube-lut.ts';
import {LOOK_PACK_END, LOOK_PACK_LIMITS, LOOK_PACK_START, lookPackManifestSchema, lookPackInspectionSchema} from '../../contracts/src/look-pack.ts';
import type {LookPackInspection, LookPackManifest} from '../../contracts/src/look-pack.ts';

export {LOOK_PACK_END, LOOK_PACK_LIMITS, LOOK_PACK_START} from '../../contracts/src/look-pack.ts';
export type {LookPackInspection, LookPackManifest} from '../../contracts/src/look-pack.ts';

export type LookPackErrorCode = 'LOOK_PACK_INPUT_INVALID' | 'LOOK_PACK_RESOURCE_LIMIT' |
  'LOOK_PACK_ENCODING_INVALID' | 'LOOK_PACK_MARKER_INVALID' | 'LOOK_PACK_MANIFEST_INVALID' |
  'LOOK_PACK_DUPLICATE_KEY' | 'LOOK_PACK_BODY_MISMATCH' | 'LOOK_PACK_CUBE_INVALID' |
  'LOOK_PACK_CRYPTO_UNAVAILABLE';
export type LookPackError = Error & {readonly code: LookPackErrorCode};
const failure = (code: LookPackErrorCode): LookPackError => Object.assign(
  new Error('The Look pack does not satisfy the bounded single-Look data profile.'), {code});
const reservedMarker = 'MIOON_LOOK_PACK';

// Intrinsics inspect actual typed-array slots, not user properties, accessors,
// iterators, species constructors or proxies. Reject shared memory so the bytes
// being checked cannot change concurrently; take one owned copy before await.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const copyBytes = Uint8Array.prototype.set;
function snapshotBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(input) || typedArrayTag.call(input) !== 'Uint8Array') throw failure('LOOK_PACK_INPUT_INVALID');
  const length = typedArrayLength.call(input) as number;
  if (length > LOOK_PACK_LIMITS.sourceBytes) throw failure('LOOK_PACK_RESOURCE_LIMIT');
  try {arrayBufferLength.call(typedArrayBuffer.call(input));} catch {throw failure('LOOK_PACK_INPUT_INVALID');}
  const bytes = new Uint8Array(length);
  try {copyBytes.call(bytes, input);} catch {throw failure('LOOK_PACK_INPUT_INVALID');}
  return bytes;
}

function hasMarker(bytes: Uint8Array): boolean {
  // Byte-level bounded detection also catches malformed UTF-8 with a marker.
  // The namespace is reserved anywhere in a file, even in ordinary comments.
  for (let offset = 0; offset <= bytes.length - reservedMarker.length; offset++) {
    let matched = true;
    for (let index = 0; index < reservedMarker.length; index++) {
      if (bytes[offset + index] !== reservedMarker.charCodeAt(index)) {matched = false; break;}
    }
    if (matched) return true;
  }
  return false;
}

/** Detection only, never a claim of validity. Malformed reserved markers still
 * return true so callers cannot silently downgrade them to an ordinary Cube.
 */
export function isLookPackBytes(bytes: Uint8Array): boolean {return hasMarker(snapshotBytes(bytes));}

/** Validate the complete bounded grammar before JSON.parse. No arrays, null,
 * booleans or recursive arbitrary data are part of this closed manifest schema.
 * Decode key escapes here so "id" and "\u0069d" are duplicates too.
 */
function validateJson(source: string): void {
  let offset = 0, keys = 0;
  const invalid = (): never => {throw failure('LOOK_PACK_MANIFEST_INVALID');};
  const whitespace = () => {while (offset < source.length && /[ \t\r\n]/u.test(source[offset]!)) offset++;};
  function string(): string {
    if (source[offset++] !== '"') invalid();
    let decoded = '';
    while (offset < source.length) {
      let character = source[offset++]!;
      if (character === '"') return decoded;
      if (character.charCodeAt(0) < 32) invalid();
      if (character === '\\') {
        const escaped = source[offset++];
        if (escaped === 'u') {
          const hex = source.slice(offset, offset + 4);
          if (!/^[a-fA-F0-9]{4}$/u.test(hex)) invalid();
          character = String.fromCharCode(Number.parseInt(hex, 16));
          offset += 4;
        } else {
          const escapes: Record<string, string> = {'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'};
          if (escaped === undefined || !Object.hasOwn(escapes, escaped)) invalid();
          character = escapes[escaped]!;
        }
      }
      decoded += character;
      if (decoded.length > LOOK_PACK_LIMITS.jsonStringCharacters) throw failure('LOOK_PACK_RESOURCE_LIMIT');
    }
    return invalid();
  }
  function value(depth: number): void {
    whitespace();
    const character = source[offset];
    if (character === '{') {object(depth + 1); return;}
    if (character === '"') {string(); return;}
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
    if (!token) return invalid();
    if (token[0].length > 64 || !Number.isFinite(Number(token[0]))) invalid();
    offset += token[0].length;
  }
  function object(depth: number): void {
    if (depth > LOOK_PACK_LIMITS.jsonDepth) throw failure('LOOK_PACK_RESOURCE_LIMIT');
    offset++;
    whitespace();
    const names = new Set<string>();
    if (source[offset] === '}') {offset++; return;}
    while (offset < source.length) {
      if (++keys > LOOK_PACK_LIMITS.jsonKeys) throw failure('LOOK_PACK_RESOURCE_LIMIT');
      const key = string();
      if (names.has(key)) throw failure('LOOK_PACK_DUPLICATE_KEY');
      // Never create special prototype properties, even on otherwise rejected data.
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid();
      names.add(key);
      whitespace();
      if (source[offset++] !== ':') invalid();
      value(depth);
      whitespace();
      const next = source[offset++];
      if (next === '}') return;
      if (next !== ',') invalid();
      whitespace();
    }
    invalid();
  }
  whitespace();
  if (source[offset] !== '{') invalid();
  object(1);
  whitespace();
  if (offset !== source.length) invalid();
}

function decode(bytes: Uint8Array<ArrayBuffer>): string {
  try {return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
  catch {throw failure('LOOK_PACK_ENCODING_INVALID');}
}

async function parseOwnedBytes(bytes: Uint8Array<ArrayBuffer>): Promise<LookPackInspection> {
  const source = decode(bytes);
  let offset = 0, lineNumber = 0, manifestLines = 0, manifestText = '', bodyOffset = -1;
  while (offset < source.length) {
    const end = source.indexOf('\n', offset);
    // Both markers need an LF or CRLF terminator; a bare CR is never rewritten.
    if (end === -1) throw failure('LOOK_PACK_MARKER_INVALID');
    const contentEnd = source.charCodeAt(end - 1) === 13 ? end - 1 : end;
    if (contentEnd - offset > CUBE_3D_LIMITS.lineBytes) throw failure('LOOK_PACK_RESOURCE_LIMIT');
    const line = source.slice(offset, contentEnd);
    if (/[^\x20-\x7e]/u.test(line)) throw failure('LOOK_PACK_ENCODING_INVALID');
    offset = end + 1;
    lineNumber++;
    if (lineNumber === 1) {
      if (line !== LOOK_PACK_START) throw failure('LOOK_PACK_MARKER_INVALID');
      continue;
    }
    if (line === LOOK_PACK_END) {bodyOffset = offset; break;}
    if (line.includes(reservedMarker) || !line.startsWith('# ')) throw failure('LOOK_PACK_MARKER_INVALID');
    if (++manifestLines > LOOK_PACK_LIMITS.manifestLines) throw failure('LOOK_PACK_RESOURCE_LIMIT');
    if (manifestText.length + line.length - 2 > LOOK_PACK_LIMITS.manifestBytes) throw failure('LOOK_PACK_RESOURCE_LIMIT');
    manifestText += line.slice(2); // Comment chunks concatenate without any added bytes.
  }
  if (bodyOffset < 0 || !manifestLines || bodyOffset === source.length || source.slice(bodyOffset).includes(reservedMarker))
    throw failure('LOOK_PACK_MARKER_INVALID');
  validateJson(manifestText);
  let manifest: LookPackManifest;
  try {
    const parsed = lookPackManifestSchema.safeParse(JSON.parse(manifestText));
    if (!parsed.success) throw failure('LOOK_PACK_MANIFEST_INVALID');
    manifest = parsed.data;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw failure('LOOK_PACK_MANIFEST_INVALID');
  }
  let cubeMetadata;
  try {cubeMetadata = parseCube3D(source).metadata;}
  catch {throw failure('LOOK_PACK_CUBE_INVALID');}
  // Full Cube admission above proves ASCII, so string offsets equal byte offsets.
  const body = bytes.subarray(bodyOffset);
  if (body.length !== manifest.asset.sizeBytes) throw failure('LOOK_PACK_BODY_MISMATCH');
  if (!globalThis.crypto?.subtle) throw failure('LOOK_PACK_CRYPTO_UNAVAILABLE');
  let digest: ArrayBuffer;
  try {digest = await globalThis.crypto.subtle.digest('SHA-256', body);}
  catch {throw failure('LOOK_PACK_CRYPTO_UNAVAILABLE');}
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.asset.sha256) throw failure('LOOK_PACK_BODY_MISMATCH');
  const result = lookPackInspectionSchema.parse({manifest, cubeMetadata, sizeBytes: bytes.length,
    bodyIntegrity: 'verified', provenanceVerification: 'unverified',
    colourCompatibility: 'unverified', licenseAcknowledgementRequired: true});
  Object.freeze(result.manifest.publisher);
  Object.freeze(result.manifest.provenance);
  Object.freeze(result.manifest.license);
  Object.freeze(result.manifest.asset);
  Object.freeze(result.manifest);
  Object.freeze(result.cubeMetadata.domainMin);
  Object.freeze(result.cubeMetadata.domainMax);
  Object.freeze(result.cubeMetadata);
  return Object.freeze(result);
}

/** Strict pack admission. The caller retains its original bytes unchanged for
 * existing lut.import; this returns metadata only, never reconstructed bytes.
 */
export async function parseLookPackBytes(bytes: Uint8Array): Promise<LookPackInspection> {
  return parseOwnedBytes(snapshotBytes(bytes));
}
export const inspectLookPackBytes = parseLookPackBytes;

/** Ordinary Cube files remain ordinary: null means no reserved pack marker,
 * not that the Cube itself has been validated. No malformed pack downgrade.
 */
export async function inspectLookPack(bytes: Uint8Array): Promise<LookPackInspection | null> {
  const snapshot = snapshotBytes(bytes);
  return hasMarker(snapshot) ? parseOwnedBytes(snapshot) : null;
}
