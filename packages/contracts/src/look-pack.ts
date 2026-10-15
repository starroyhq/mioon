import {z} from 'zod';
import {LUT_RESOURCE_LIMITS, LUT_RESOURCE_PROFILE, lutMetadataSchema} from './lut-resources.ts';

/** A single declarative Look, carried entirely in ordinary Cube comments. */
export const LOOK_PACK_START = '# MIOON_LOOK_PACK_V1' as const;
export const LOOK_PACK_END = '# MIOON_LOOK_PACK_END' as const;
export const LOOK_PACK_LIMITS = Object.freeze({
  sourceBytes: LUT_RESOURCE_LIMITS.sourceBytes,
  manifestBytes: 16 * 1024,
  manifestLines: 128,
  jsonDepth: 3,
  jsonKeys: 64,
  jsonStringCharacters: 4096,
  titleCharacters: 120,
  licenseCharacters: 2048,
  provenanceCharacters: 512,
} as const);

const identifier = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);
const plainText = (maximum: number) => z.string().min(1).max(maximum)
  .regex(/^[\x20-\x7e]+$/u).refine(value => value.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sizeBytes = z.number().int().min(1).max(LOOK_PACK_LIMITS.sourceBytes);
const provenanceUrl = z.string().min(1).max(LOOK_PACK_LIMITS.provenanceCharacters)
  .regex(/^https:\/\/[\x21-\x7e]+$/u).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !value.includes('\\');
    } catch {return false;}
  });

/** These are publisher claims, not signatures, license authorization, measured
 * colour evidence, a technical input transform, or permission to contact a URL.
 * Only parser-owned JSON is passed to this schema at the file trust boundary.
 */
export const lookPackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('look-pack'),
  id: identifier,
  version: z.string().min(5).max(40).regex(/^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/u),
  title: plainText(LOOK_PACK_LIMITS.titleCharacters),
  publisher: z.object({id: identifier, name: plainText(120)}).strict(),
  provenance: z.object({url: provenanceUrl}).strict(),
  license: z.object({
    identifier: z.string().min(1).max(80).regex(/^[A-Za-z0-9]+(?:[.+-][A-Za-z0-9]+)*$/u),
    text: z.string().min(1).max(LOOK_PACK_LIMITS.licenseCharacters)
      .regex(/^[\x20-\x7e\n]+$/u).refine(value => value.trim().length > 0),
  }).strict(),
  asset: z.object({
    id: identifier,
    purpose: z.literal('rec709-sdr-creative'),
    profile: z.literal(LUT_RESOURCE_PROFILE),
    input: z.literal('rec709-sdr'),
    output: z.literal('rec709-sdr'),
    sha256: hash,
    sizeBytes,
  }).strict(),
}).strict();
export type LookPackManifest = z.infer<typeof lookPackManifestSchema>;

export const lookPackInspectionSchema = z.object({
  manifest: lookPackManifestSchema,
  cubeMetadata: lutMetadataSchema,
  sizeBytes,
  bodyIntegrity: z.literal('verified'),
  provenanceVerification: z.literal('unverified'),
  colourCompatibility: z.literal('unverified'),
  licenseAcknowledgementRequired: z.literal(true),
}).strict().refine(value => value.manifest.asset.sizeBytes < value.sizeBytes);
export type LookPackInspection = z.infer<typeof lookPackInspectionSchema>;
