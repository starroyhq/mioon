import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const appIdPrefix = 'com.adobe.PremierePro';
const bundleIdPattern = /^com\.adobe\.PremierePro[A-Za-z0-9.-]*$/iu;
const options = {encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024} as const;
type RunFile = (file: string, args: string[], commandOptions: typeof options) => Promise<{stdout: string}>;
const canonicalAppScript = `ObjC.import("AppKit");
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(${JSON.stringify(appIdPrefix)});
  url.isNil() ? "" : ObjC.unwrap(url.path);`;
const spotlightQuery = `kMDItemContentType == "com.apple.application-bundle" && kMDItemCFBundleIdentifier ==[c] "${appIdPrefix}*"`;

export function createPremiereMacLauncher(runFile: RunFile = run, platform: NodeJS.Platform = process.platform) {
  async function verifiedApp(file: string): Promise<string | undefined> {
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.app') return;
    try {
      const {stdout} = await runFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(file, 'Contents', 'Info.plist')], options);
      if (bundleIdPattern.test(stdout.trim())) return file;
    } catch {
      // Indexed paths can refer to a removed application.
    }
  }
  async function installedApp(): Promise<string | undefined> {
    if (platform !== 'darwin') return;
    const canonical = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', canonicalAppScript], options)
      .then(({stdout}) => verifiedApp(stdout.trimEnd()), () => undefined);
    if (canonical) return canonical;
    const {stdout} = await runFile('/usr/bin/mdfind', ['-0', spotlightQuery], options);
    const candidates = [...new Set(stdout.split('\0').filter(Boolean))].slice(0, 16);
    return (await Promise.all(candidates.map(verifiedApp))).find(Boolean);
  }
  return {
    async premiereInstalled(): Promise<boolean> {
      return (await installedApp()) !== undefined;
    },
    async openInPremiere(xml: string, beforeOpen: () => boolean): Promise<boolean> {
      try {
        const application = await installedApp();
        if (!application || !beforeOpen()) return false;
        await runFile('/usr/bin/open', ['-a', application, xml], options);
        return true;
      } catch {return false;}
    },
  };
}

export const {premiereInstalled, openInPremiere} = createPremiereMacLauncher();
