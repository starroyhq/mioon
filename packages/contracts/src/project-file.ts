import {z} from 'zod';
/** Project file v1 (docs/PROJECT-FILE.md). A `.mioon` is one SQLite file that
 * holds exactly one project's current content; this computer's records for it
 * are kept per project ID outside the file.
 * No Node imports: browser code uses the URL helpers. Directory layouts are
 * path segments for the caller's own `path.join`. */

export const PROJECT_FILE_EXTENSION = '.mioon';

// Project directory: the folder that holds the `.mioon`. These names are fixed
// and never follow the interface language.
export const PROJECT_GENERATED_FOLDER = '生成';
export const PROJECT_EXPORTS_FOLDER = '导出';
export const PROJECT_RULES_FILE = 'AGENTS.md';

/** New projects without a chosen location: web and headless servers use
 * `<dataDir>/projects/<name>/`, desktop uses `Mioon/<name>/` in Electron's
 * `app.getPath('videos')` (`~/Movies` on macOS, `Videos` on Windows). A
 * clashing folder name gets a number. Web and headless servers keep their app
 * cache in `<dataDir>/cache/` and temporary files in `<dataDir>/tmp/`, never
 * in `dataDir` itself. */
export const DEFAULT_PROJECTS_DIRECTORY = 'projects';
export const DESKTOP_PROJECTS_FOLDER = 'Mioon';
/** Web and headless servers: `<dataDir>/cache/` and `<dataDir>/tmp/`. */
export const SERVER_CACHE_DIRECTORY = 'cache';
export const SERVER_TEMP_DIRECTORY = 'tmp';

/** localDir is `<app data>/records/<project ID>/`. It is not `projects/`,
 * where web projects are created by default. */
export const PROJECT_RECORDS_DIRECTORY = 'records';
export const PROJECT_HISTORY_FILE = 'history.db';
export const PROJECT_BACKUPS_DIRECTORY = 'backups';
export const PROJECT_IMPORTS_DIRECTORY = 'imports';
/** cacheDir is `<app cache>/projects/<project ID>/`. */
export const PROJECT_CACHE_DIRECTORY = 'projects';
export const PROJECT_CACHE_FILE = 'cache.db';

/** Schema names on the one project connection: the local records are the
 * main database, the project file and the cache are attached. Unqualified
 * statements that create objects or set pragmas land in the local records.
 *
 * A commit that spans files puts its super-journal beside the main database
 * and writes the super-journal's absolute path into each file's journal.
 * Project folders are moved as a matter of course; the local records stay
 * where they are. With the project file as main, a crash in such a commit
 * followed by moving the project folder leaves the super-journal unreachable
 * at the recorded path: SQLite then takes both hot journals as committed and
 * one of the files is corrupted. With the local records as main, both files
 * roll back.
 *
 * Opening order, never reversed:
 * 1. open the project file alone, read its project ID and format version and
 *    let SQLite finish any recovery, then close it;
 * 2. open the local records as main;
 * 3. attach the project file and the cache, check them against the schema
 *    manifest, then create the connection's temporary triggers.
 * Once SQLite has recovered one database, it deletes the super-journal if
 * none of the other journals it lists is still at its recorded path, so the
 * project file has to recover first. Apart from step 1 both files are opened
 * only on this connection; the temporary triggers that stand in for the
 * cross-file constraints exist nowhere else. */
export const PROJECT_DATABASE_NAMES = Object.freeze({history: 'main', project: 'project', cache: 'cache'} as const);

const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Lowercase UUID, as `crypto.randomUUID()` writes it. Other spellings are
 * refused: the ID also names directories, and the default macOS and Windows
 * file systems ignore case. */
export const isProjectId = (value: unknown): value is string => typeof value === 'string' && CANONICAL_ID.test(value);
export const projectIdSchema = z.string().regex(CANONICAL_ID);
function checkedProjectId(value: string): string {
  if (!isProjectId(value)) throw new TypeError('Invalid project ID');
  return value;
}
/** localDir relative to the app data directory. */
export const projectLocalDirSegments = (projectId: string): readonly [string, string] => [PROJECT_RECORDS_DIRECTORY, checkedProjectId(projectId)];
/** cacheDir relative to the app cache directory. */
export const projectCacheDirSegments = (projectId: string): readonly [string, string] => [PROJECT_CACHE_DIRECTORY, checkedProjectId(projectId)];

/** Store-level `openStore(root)` in tests: root is the project directory and
 * the other three directories share one hidden folder under it. */
export const TEST_STORE_DIRECTORY = '.mioon-store';
export const TEST_STORE_LAYOUT = Object.freeze({
  projectFile: Object.freeze(['project.mioon'] as const),
  localDir: Object.freeze([TEST_STORE_DIRECTORY, 'local'] as const),
  cacheDir: Object.freeze([TEST_STORE_DIRECTORY, 'cache'] as const),
  tempDir: Object.freeze([TEST_STORE_DIRECTORY, 'tmp'] as const),
});
// SQLite names a super-journal `<main database>-mj` + 6 hex + `9` + 2 hex
// (checked with the SQLite 3.53 in Node 24). It exists while a commit spans
// attached databases, and after a crash in the middle of one. The local
// records are the main database, so it sits beside history.db, which is
// inside `.mioon-store/` in the test layout; a project directory does not get
// one. The name check stays as a safeguard.
const SUPER_JOURNAL = /-mj[0-9A-F]{6}9[0-9A-F]{2}$/u;
/** For directory snapshots in tests: true for the test store folder, the
 * project file's rollback journal and super-journals. `entry` is a path
 * relative to the project directory, with `/` or `\` separators. Production
 * code that lists a project directory skips every entry starting with `.`
 * instead, which also covers `.DS_Store` and the like. */
export function isProjectStoreInternalEntry(entry: string): boolean {
  const parts = entry.split(/[\\/]/u).filter(part => part !== '' && part !== '.');
  const name = parts.at(-1) ?? '';
  return parts[0] === TEST_STORE_DIRECTORY || name.endsWith(`${PROJECT_FILE_EXTENSION}-journal`) || SUPER_JOURNAL.test(name);
}

/** The local records compared with the project file by content sequence. */
export const PROJECT_HISTORY_STATES = Object.freeze(['fresh', 'current', 'file-older', 'file-newer'] as const);
export type ProjectHistoryState = typeof PROJECT_HISTORY_STATES[number];

/** What the project store adds to the existing store surface. `Db` is
 * `DatabaseSync` in the backend; as a parameter it keeps Node types out of
 * this module. `ProjectStore<DatabaseSync>` is a business `ServiceStore`. */
export interface ProjectStore<Db = unknown> {
  readonly db: Db;
  /** Equals projectDir while `store.root` users move to the four directories. */
  readonly root: string;
  readonly projectId: string;
  /** The `.mioon` itself. */
  readonly projectFile: string;
  /** Folder of the `.mioon`: base of relative media paths; holds 生成/, 导出/, AGENTS.md. */
  readonly projectDir: string;
  /** `<app data>/records/<project ID>/`: history.db, backups/, imports/. */
  readonly localDir: string;
  /** `<app cache>/projects/<project ID>/`: cache.db. */
  readonly cacheDir: string;
  /** App temp directory for staging. It may be on another volume than projectDir. */
  readonly tempDir: string;
  readonly historyState: ProjectHistoryState;
  close(): void;
}

/** Why a project cannot be opened. */
export const PROJECT_OPEN_ERROR_CODES = Object.freeze(['PROJECT_MISSING', 'PROJECT_LOCKED', 'PROJECT_FORMAT_NEWER', 'PROJECT_INVALID'] as const);
export type ProjectOpenErrorCode = typeof PROJECT_OPEN_ERROR_CODES[number];
/** Store-level `project.create` on a file that already has its project. */
export const PROJECT_FILE_SINGLE_PROJECT = 'PROJECT_FILE_SINGLE_PROJECT';
/** Project-addressed requests. An operation addressed only by entity ID keeps
 * answering NOT_FOUND when the entity belongs to another project. */
export const PROJECT_ADDRESS_ERROR_CODES = Object.freeze(['PROJECT_NOT_FOUND', 'PROJECT_ID_MISMATCH', 'PROJECT_UNAVAILABLE'] as const);
export type ProjectAddressErrorCode = typeof PROJECT_ADDRESS_ERROR_CODES[number];
export const PROJECT_FILE_ERROR_CODES = Object.freeze([...PROJECT_OPEN_ERROR_CODES, PROJECT_FILE_SINGLE_PROJECT, ...PROJECT_ADDRESS_ERROR_CODES] as const);
export type ProjectFileErrorCode = typeof PROJECT_FILE_ERROR_CODES[number];

const filePath = z.string().min(1).max(4096);
const formatVersion = z.number().int().min(1).max(1_000_000);
/** projectId is null when the file could not be read and is not registered. */
const failure = {projectFile: filePath, projectId: projectIdSchema.nullable()};
export const projectOpenFailureSchema = z.discriminatedUnion('code', [
  z.object({code: z.literal('PROJECT_MISSING'), ...failure}).strict(),
  z.object({code: z.literal('PROJECT_LOCKED'), ...failure}).strict(),
  z.object({code: z.literal('PROJECT_FORMAT_NEWER'), ...failure, database: z.enum(['project', 'history', 'cache']), formatVersion, supportedFormatVersion: formatVersion}).strict(),
  z.object({code: z.literal('PROJECT_INVALID'), ...failure}).strict(),
]).refine(value => value.code !== 'PROJECT_FORMAT_NEWER' || value.formatVersion > value.supportedFormatVersion,
  'A newer format must exceed the supported version.');
export type ProjectOpenFailure = z.infer<typeof projectOpenFailureSchema>;
export const projectOpenResultSchema = z.discriminatedUnion('ok', [
  z.object({ok: z.literal(true), projectId: projectIdSchema, projectFile: filePath, projectDir: filePath,
    historyState: z.enum(PROJECT_HISTORY_STATES)}).strict(),
  z.object({ok: z.literal(false), error: projectOpenFailureSchema}).strict(),
]);
export type ProjectOpenResult = z.infer<typeof projectOpenResultSchema>;
/** `details` of the addressing errors. PROJECT_UNAVAILABLE carries the open failure code. */
export const projectAddressErrorDetailsSchemas = Object.freeze({
  PROJECT_NOT_FOUND: z.object({projectId: projectIdSchema}).strict(),
  PROJECT_ID_MISMATCH: z.object({projectId: projectIdSchema}).strict(),
  PROJECT_UNAVAILABLE: z.object({projectId: projectIdSchema, reason: z.enum(PROJECT_OPEN_ERROR_CODES)}).strict(),
});

/** Project-level endpoints live under `/api/projects/<project ID>/`. */
export const PROJECT_API_PREFIX = '/api/projects/';
function routeSegment(value: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || /[\\/\u0000]/u.test(value)) throw new TypeError('Invalid project route segment');
  return encodeURIComponent(value);
}
/** `/api/projects/<project ID>/<segment>/…`. Segments are percent-encoded and
 * may not contain slashes, so every built path parses back unchanged. */
export function projectApiPath(projectId: string, ...route: readonly [string, ...string[]]): string {
  return `${PROJECT_API_PREFIX}${checkedProjectId(projectId)}/${route.map(routeSegment).join('/')}`;
}
export const projectRpcPath = (projectId: string): string => projectApiPath(projectId, 'rpc');
/** Media is addressed by asset ID, never by path. The existing queries
 * (`?preview=1&exportId=…`, `?download=1&exportId=…`, `?download`) are
 * appended by the caller unchanged. */
export function projectMediaPath(projectId: string, assetId: string): string {
  if (typeof assetId !== 'string' || !CANONICAL_ID.test(assetId)) throw new TypeError('Invalid asset ID');
  return projectApiPath(projectId, 'media', assetId);
}
export type ProjectApiRoute =
  | {readonly kind: 'rpc'; readonly projectId: string}
  | {readonly kind: 'media'; readonly projectId: string; readonly assetId: string}
  | {readonly kind: 'other'; readonly projectId: string; readonly segments: readonly string[]};
/** Strict parse of a request pathname (`URL.pathname`, no query). Null unless
 * the project ID is a lowercase UUID and every later segment is non-empty,
 * decodes, and is neither `.` nor `..` nor holds a slash, backslash or NUL
 * once decoded; so `%2F`, `%5C` and `%2E%2E` are refused. `rpc` takes no
 * further segment and `media` exactly one asset ID. */
export function parseProjectApiPath(pathname: string): ProjectApiRoute | null {
  if (typeof pathname !== 'string' || !pathname.startsWith(PROJECT_API_PREFIX)) return null;
  const [projectId, ...raw] = pathname.slice(PROJECT_API_PREFIX.length).split('/');
  if (!isProjectId(projectId) || raw.length === 0) return null;
  const segments: string[] = [];
  for (const part of raw) {
    if (part === '' || /[?#\\]/u.test(part)) return null;
    let value: string;
    try { value = decodeURIComponent(part); } catch { return null; }
    if (value === '.' || value === '..' || /[\\/\u0000]/u.test(value)) return null;
    segments.push(value);
  }
  if (segments[0] === 'rpc') return segments.length === 1 ? {kind: 'rpc', projectId} : null;
  if (segments[0] === 'media') return segments.length === 2 && CANONICAL_ID.test(segments[1]) ? {kind: 'media', projectId, assetId: segments[1]} : null;
  return {kind: 'other', projectId, segments: Object.freeze(segments)};
}
