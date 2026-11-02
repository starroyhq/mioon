import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {PROJECT_FILE_EXTENSION} from '../../../../packages/contracts/src/project-file.ts';
import {projectFileExists} from './errors.ts';
import {numberedProjectFolderName, PROJECT_FOLDER_MAX_SEQUENCE} from './naming.ts';

export interface ClaimedProjectFolder {
  readonly folder: string;
  /** Folder name, also the base name of the `.mioon`. */
  readonly name: string;
  readonly projectFile: string;
}

/** Creates `<parent>/<name>`, else `<name> 2` … `<name> 999`, one
 * non-recursive mkdir each; never reuses an existing entry. The mkdir is the
 * claim, so concurrent creations never share a folder, and file systems that
 * ignore case or Unicode normalization report their own clashes as EEXIST.
 * The parent must exist. Project directories are not private storage: the
 * folder gets the default permissions. */
export function claimProjectFolder(parentDir: string, folderName: string): ClaimedProjectFolder {
  for (let sequence = 1; sequence <= PROJECT_FOLDER_MAX_SEQUENCE; sequence++) {
    const name = numberedProjectFolderName(folderName, sequence);
    const folder = path.join(parentDir, name);
    try {
      mkdirSync(folder);
    } catch (error) {
      if ((error as {code?: unknown} | null | undefined)?.code === 'EEXIST') continue;
      throw error;
    }
    return {folder, name, projectFile: path.join(folder, `${name}${PROJECT_FILE_EXTENSION}`)};
  }
  throw projectFileExists(path.join(parentDir, folderName, `${folderName}${PROJECT_FILE_EXTENSION}`));
}
