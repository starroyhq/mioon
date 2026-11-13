import {randomUUID} from 'node:crypto';
import {lstat, open, realpath, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {readPrivateFile, validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {RENDERER_DIAGNOSTIC_LIMITS, sanitizeRendererHealthRecord} from './renderer-diagnostics.ts';
import {sanitizeSettingsDiagnosticRecord} from './settings-diagnostics-protocol.ts';

function readDiagnostics(directory: string): string[] {
  const records: string[] = [];
  const {maxBytes, fileCount} = RENDERER_DIAGNOSTIC_LIMITS;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  for (let slot = fileCount - 1; slot >= 0; slot--) {
    const file = path.join(directory, slot === 0 ? 'renderer-health.jsonl' : `renderer-health.jsonl.${slot}`);
    const bytes = readPrivateFile(file, {root: directory, maxBytes, allowMissing: true});
    if (!Buffer.isBuffer(bytes)) continue;
    for (const line of decoder.decode(bytes).split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {raw = JSON.parse(line);} catch {continue;}
      const record = sanitizeSettingsDiagnosticRecord(raw) ?? sanitizeRendererHealthRecord(raw);
      if (record) records.push(JSON.stringify(record));
    }
  }
  return records;
}

/** Save the bounded, redacted renderer logs after an explicit native save
 * selection. The destination is owned by main and never comes from IPC. */
export async function exportDesktopDiagnostics({dataDir, destination, check = () => {}}: {
  readonly dataDir: string;
  readonly destination: string;
  readonly check?: () => void;
}): Promise<'saved' | 'empty'> {
  check();
  if (!path.isAbsolute(destination)) throw new Error('Invalid diagnostic export destination.');
  const directory = path.join(dataDir, 'diagnostics');
  if (!validatePrivateDirectory(directory, {allowMissing: true})) return 'empty';
  const records = readDiagnostics(directory);
  if (!records.length) return 'empty';

  const parent = await realpath(path.dirname(destination));
  const relative = path.relative(dataDir, parent);
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) {
    throw new Error('The diagnostic export destination is inside private application storage.');
  }
  const target = path.join(parent, path.basename(destination));
  const existing = await lstat(target).catch((error: unknown) => {
    if ((error as {code?: string})?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && !existing.isFile()) throw new Error('Invalid diagnostic export destination.');
  const temporary = path.join(parent, `.mioon-diagnostics-${randomUUID()}.part`);
  check();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(records.join('\n') + '\n');
      await handle.sync();
    } finally {await handle.close();}
    check();
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return 'saved';
}
