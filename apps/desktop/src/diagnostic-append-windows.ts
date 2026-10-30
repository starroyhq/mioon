import { ensurePrivateDirectory, validateManagedFile, readPrivateFile, writePrivateFileAtomic, removePrivateFile } from '@mioon/contracts/private-storage';

/** The private-storage operations a Windows diagnostic append uses. */
export interface WindowsDiagnosticStorage {
  ensurePrivateDirectory: typeof ensurePrivateDirectory;
  validateManagedFile: typeof validateManagedFile;
  readPrivateFile: typeof readPrivateFile;
  writePrivateFileAtomic: typeof writePrivateFileAtomic;
  removePrivateFile: typeof removePrivateFile;
}
const facade: WindowsDiagnosticStorage = { ensurePrivateDirectory, validateManagedFile, readPrivateFile, writePrivateFileAtomic, removePrivateFile };

/** Appends one bounded JSONL line on Windows. The ACL backend opens files only
 * through its verified handles, with no in-place append or rename, so the
 * current file is read, extended and atomically replaced; rotation copies each
 * older slot up before removing its source. Like the POSIX path, an oversized
 * slot is dropped and the oldest slot leaves first. Main is the only writer. */
export function appendWindowsDiagnostic(dataDir: string, directory: string, file: string, line: Buffer,
  { maxBytes, fileCount }: { readonly maxBytes: number; readonly fileCount: number }, storage: WindowsDiagnosticStorage = facade): void {
  const options = { root: dataDir, maxBytes, private: true };
  storage.ensurePrivateDirectory(dataDir, { create: true });
  storage.ensurePrivateDirectory(directory, { create: true });
  const targets = [file];
  for (let index = 1; index < fileCount; index++) targets.push(`${file}.${index}`);
  const read = (target: string): Buffer | null => {
    const stat = storage.validateManagedFile(target, { root: dataDir, private: true, allowMissing: true });
    if (!stat) return null;
    if (stat.size > maxBytes) { storage.removePrivateFile(target, { ...options, maxBytes: stat.size }); return null; }
    const bytes = storage.readPrivateFile(target, { ...options, allowMissing: true });
    return bytes === null ? null : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  };
  let current = read(file) ?? Buffer.alloc(0);
  if (current.length + line.length > maxBytes) {
    if (read(targets[fileCount - 1]!)) storage.removePrivateFile(targets[fileCount - 1]!, options);
    for (let source = fileCount - 2; source >= 0; source--) {
      const bytes = source === 0 ? current : read(targets[source]!);
      if (!bytes?.length) continue;
      storage.writePrivateFileAtomic(targets[source + 1]!, bytes, { root: dataDir, maxBytes, replace: true });
      storage.removePrivateFile(targets[source]!, options);
    }
    current = Buffer.alloc(0);
  }
  storage.writePrivateFileAtomic(file, Buffer.concat([current, line]), { root: dataDir, maxBytes, replace: true });
}
