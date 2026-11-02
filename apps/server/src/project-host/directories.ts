import path from 'node:path';
import {
  DEFAULT_PROJECTS_DIRECTORY, DESKTOP_PROJECTS_FOLDER, isProjectId, projectCacheDirSegments, projectLocalDirSegments,
  SERVER_CACHE_DIRECTORY, SERVER_TEMP_DIRECTORY,
} from '../../../../packages/contracts/src/project-file.ts';
import type {ProjectLocation} from '../../../../packages/business/src/project-file/index.ts';

/** This computer's app directories (docs/PROJECT-HOST.md, "应用级的目录").
 * The kernel creates a project's local, cache and temporary directories under
 * them as private storage: 0700, owned by this account, and no symbolic link
 * anywhere in the path. */
export interface AppDirectories {
  /** App data directory: access-token, server.lock, settings, the app database, records/, tmp/. */
  readonly dataDir: string;
  /** App cache directory; one project's cache is `<cacheDir>/projects/<ID>/`. */
  readonly cacheDir: string;
  /** App temporary directory; one project's staging is `<tempDir>/projects/<ID>/`.
   * It may be on another volume than a project directory. */
  readonly tempDir: string;
  /** Parent of new projects created without a chosen location. */
  readonly projectsDir: string;
}

/** `<tempDir>/projects/<ID>/`: staging with crash receipts stays per project,
 * so one project's cleanup never removes another's files. */
export const PROJECT_TEMP_DIRECTORY = 'projects';

function absolute(value: string, name: string, paths: path.PlatformPath = path): string {
  if (typeof value !== 'string' || !paths.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return paths.resolve(value);
}

/** Web and headless servers: `<dataDir>/{projects,records,cache,tmp}`. The
 * cache and the default projects directory can be moved. */
export function serverAppDirectories(dataDir: string, options: {readonly cacheDir?: string; readonly projectsDir?: string} = {}): AppDirectories {
  const root = absolute(dataDir, 'dataDir');
  return Object.freeze({
    dataDir: root,
    cacheDir: options.cacheDir === undefined ? path.join(root, SERVER_CACHE_DIRECTORY) : absolute(options.cacheDir, 'cacheDir'),
    tempDir: path.join(root, SERVER_TEMP_DIRECTORY),
    projectsDir: options.projectsDir === undefined ? path.join(root, DEFAULT_PROJECTS_DIRECTORY) : absolute(options.projectsDir, 'projectsDir'),
  });
}

export interface SystemCacheInput {
  /** `process.platform` of the target; Windows paths are built with path.win32. */
  readonly platform: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The system cache directory: `~/Library/Caches` on macOS, `%LOCALAPPDATA%`
 * on Windows, `$XDG_CACHE_HOME` or `~/.cache` elsewhere. Variables that are
 * not absolute paths are ignored. */
export function systemCacheDirectory({platform, home, env}: SystemCacheInput): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const base = absolute(home, 'home', paths);
  const variable = (name: string): string | null => {
    const value = env[name];
    return typeof value === 'string' && value !== '' && paths.isAbsolute(value) ? paths.resolve(value) : null;
  };
  if (platform === 'darwin') return paths.join(base, 'Library', 'Caches');
  if (platform === 'win32') return variable('LOCALAPPDATA') ?? paths.join(base, 'AppData', 'Local');
  return variable('XDG_CACHE_HOME') ?? paths.join(base, '.cache');
}

export interface DesktopDirectoriesInput extends SystemCacheInput {
  /** identity.appId, e.g. `app.starroy.mioon` (`.dev` on the dev channel). */
  readonly appId: string;
  /** DesktopPaths.dataDir, private storage: `<userData>/data` once the S0
   * switch changes `dataPaths` in config.ts, `<userData>/workspace` until then. */
  readonly dataDir: string;
  /** Electron's app.getPath('videos'). */
  readonly videosDir: string;
  /** MIOON_DESKTOP_USER_DATA is set (tests, smoke runs): keep the cache and
   * new projects inside dataDir, away from the real cache and videos folders. */
  readonly userDataOverridden: boolean;
}

/** Desktop: records/ and tmp/ in the app data directory, the cache in
 * `<system cache>/<app ID>/`, new projects in `<videos>/Mioon/`. Computed in
 * the main process, which passes cacheDir and projectsDir to the backend. */
export function desktopAppDirectories(input: DesktopDirectoriesInput): AppDirectories {
  const {appId} = input;
  if (typeof appId !== 'string' || appId === '' || appId === '.' || appId === '..' || /[\\/]/u.test(appId)) throw new TypeError('Invalid app ID');
  const paths = input.platform === 'win32' ? path.win32 : path.posix;
  const dataDir = absolute(input.dataDir, 'dataDir', paths);
  const tempDir = paths.join(dataDir, SERVER_TEMP_DIRECTORY);
  if (input.userDataOverridden) {
    return Object.freeze({dataDir, cacheDir: paths.join(dataDir, SERVER_CACHE_DIRECTORY), tempDir, projectsDir: paths.join(dataDir, DEFAULT_PROJECTS_DIRECTORY)});
  }
  return Object.freeze({
    dataDir,
    cacheDir: paths.join(systemCacheDirectory(input), appId),
    tempDir,
    projectsDir: paths.join(absolute(input.videosDir, 'videosDir', paths), DESKTOP_PROJECTS_FOLDER),
  });
}

/** The kernel's `locate` for one project ID: `<dataDir>/records/<ID>`,
 * `<cacheDir>/projects/<ID>`, `<tempDir>/projects/<ID>`. */
export function projectLocation(directories: AppDirectories, projectId: string): ProjectLocation {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  return Object.freeze({
    localDir: path.join(directories.dataDir, ...projectLocalDirSegments(projectId)),
    cacheDir: path.join(directories.cacheDir, ...projectCacheDirSegments(projectId)),
    tempDir: path.join(directories.tempDir, PROJECT_TEMP_DIRECTORY, projectId),
  });
}
