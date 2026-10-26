import {copyFile, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';

/** Only these final, fixed-name images belong in the desktop runtime. Source
 * art, generation manifests and documentation remain outside the package. */
export const TRAY_RESOURCE_FILES = Object.freeze([
  'trayTemplate.png', 'trayTemplate@2x.png', 'tray.ico', 'tray-color.png', 'tray-color@2x.png',
] as const);

export async function stageTrayResources(sourceDirectory: string, outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, {recursive: true});
  for (const name of TRAY_RESOURCE_FILES) await copyFile(path.join(sourceDirectory, name), path.join(outputDirectory, name));
}

interface TrayAsar {
  listPackage(file: string): string[];
  statFile(file: string, entry: string, follow: false): {link?: string; files?: unknown};
  extractFile(file: string, entry: string): Buffer;
}

/** Validate the delivered archive, including directory membership. Comparing
 * only listed images would miss an omitted density or an accidentally bundled
 * source master that happens to match the same staging directory. */
export async function verifyPackagedTrayResources(archive: string, asar: TrayAsar, stagingRoot: string): Promise<void> {
  const required = new Set<string>(TRAY_RESOURCE_FILES.map(name => `icons/tray/${name}`));
  for (const raw of asar.listPackage(archive)) {
    const entry = raw.replace(/^\//u, '');
    if (entry.startsWith('icons/tray/') && !required.has(entry)) throw new Error('Unexpected packaged tray resource.');
  }
  for (const entry of required) {
    const stat = asar.statFile(archive, entry, false);
    if (stat.link || stat.files) throw new Error('Packaged tray resources must be regular files.');
    if (!asar.extractFile(archive, entry).equals(await readFile(path.join(stagingRoot, entry)))) {
      throw new Error(`Packaged tray resource must equal verified staging: ${entry}`);
    }
  }
}
