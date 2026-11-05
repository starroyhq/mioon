import path from 'node:path';

const FILES_AND_FOLDERS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
const SYSTEM_SETTINGS = 'x-apple.systempreferences:';
interface Options {
  readonly platform?: NodeJS.Platform;
  openExternal(url: string): Promise<void>;
  showItemInFolder(file: string): void;
}
const unavailable = () => Object.assign(new Error('Project location help is unavailable.'), {code: 'PROJECT_LOCATION_HELP_UNAVAILABLE', status: 503});

/** Main-only fixed OS actions. The project-entry host must resolve a verified
 * registration or its own selection ticket before supplying a reveal path. */
export function createProjectLocationHelp({platform = process.platform, openExternal, showItemInFolder}: Options) {
  return {
    async openPrivacySettings(): Promise<void> {
      if (platform !== 'darwin') throw unavailable();
      try {await openExternal(FILES_AND_FOLDERS);}
      catch {
        try {await openExternal(SYSTEM_SETTINGS);}
        catch {throw unavailable();}
      }
    },
    revealVerifiedPath(file: string): void {
      if (typeof file !== 'string' || file.length < 1 || file.length > 4096 || /[\u0000-\u001f\u007f]/u.test(file) || !path.isAbsolute(file) || path.resolve(file) !== file) throw unavailable();
      try {showItemInFolder(file);} catch {throw unavailable();}
    },
  };
}
