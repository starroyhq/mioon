import {z} from 'zod';
/** Media references (project file v1, docs/PROJECT-FILE.md). An asset points
 * at the user's file wherever it is kept instead of at a managed copy. The
 * fields are fixed here once; L1 resolves, fingerprints and relinks them. */

export const MEDIA_PATH_FORMS = Object.freeze(['relative', 'absolute'] as const);
export type MediaPathForm = typeof MEDIA_PATH_FORMS[number];
/** online: the file matches its fingerprint. missing: nothing at the path.
 * changed: a file is there but its fingerprint differs. */
export const MEDIA_STATUSES = Object.freeze(['online', 'missing', 'changed'] as const);
export type MediaStatus = typeof MEDIA_STATUSES[number];
export const MEDIA_PATH_MAX_LENGTH = 4096;

/** Relative to the project directory, with `/` on every platform. Leading
 * `..` segments reach folders beside the project; `.`, empty segments and a
 * `..` after a name are refused, as are backslashes and drive letters. */
export function isPortableRelativePath(value: string): boolean {
  if (typeof value !== 'string' || value === '' || value.length > MEDIA_PATH_MAX_LENGTH || /[\\\u0000]/u.test(value) ||
    value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  let named = false;
  for (const part of value.split('/')) {
    if (part === '' || part === '.' || part === '..' && named) return false;
    if (part !== '..') named = true;
  }
  return named;
}
/** POSIX `/…`, a Windows drive `C:\…` or a UNC share `\\server\share\…`,
 * without empty, `.` or `..` segments. `\\?\` and `\\.\` paths are refused. */
export function isNormalizedAbsolutePath(value: string): boolean {
  if (typeof value !== 'string' || value.length > MEDIA_PATH_MAX_LENGTH || value.includes('\u0000')) return false;
  const unc = value.startsWith('\\\\');
  const rest = unc ? value.slice(2) : /^[A-Za-z]:[\\/]/u.test(value) ? value.slice(3) : value.startsWith('/') ? value.slice(1) : null;
  if (rest === null || rest === '') return rest === '' && !unc;
  const parts = rest.split(/[\\/]/u);
  return (!unc || parts.length >= 2 && parts[0] !== '?') && parts.every(part => part !== '' && part !== '.' && part !== '..');
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const volume = z.string().min(1).max(255);
const fingerprint = {
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mtimeMs: z.number().finite().nonnegative(),
  /** Hash of sampled ranges; L1 fixes which bytes are sampled. */
  sampledSha256: sha256,
  /** Hash of the whole file, computed when needed, e.g. before a paid generation uses it. */
  fullSha256: sha256.nullable(),
};
export const mediaFingerprintSchema = z.object(fingerprint).strict();
export type MediaFingerprint = z.infer<typeof mediaFingerprintSchema>;
/** Same volume as the project file: a relative path and no volume name.
 * Another volume: an absolute path and, when known, the volume name. */
export const mediaReferenceSchema = z.object({
  pathForm: z.enum(MEDIA_PATH_FORMS),
  path: z.string().min(1).max(MEDIA_PATH_MAX_LENGTH),
  volume: volume.nullable(),
  ...fingerprint,
}).strict().refine(value => value.pathForm === 'relative' ? value.volume === null && isPortableRelativePath(value.path) : isNormalizedAbsolutePath(value.path),
  'Relative paths use / and carry no volume; absolute paths are normalized.');
export type MediaReference = z.infer<typeof mediaReferenceSchema>;

/** A folder outside the project directory that references point into. For a
 * project from another computer it is read only after the user confirms it
 * (the confirmation lives in the app database, project-registry.ts). */
export const outsideProjectLocationSchema = z.object({
  directory: z.string().min(1).max(MEDIA_PATH_MAX_LENGTH).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.'),
  volume: volume.nullable(),
  assetCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Whether the folder exists on this computer. */
  available: z.boolean(),
}).strict();
export type OutsideProjectLocation = z.infer<typeof outsideProjectLocationSchema>;
