import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// macOS canonical private temp root (/private/tmp) vs the canonical TMPDIR on
// other platforms. Tests must never hard-code a macOS-only path: the canonical
// Linux Docker gate sets TMPDIR to a real directory (never a symlink).
export function testTempBase(): string {
  return process.platform === 'darwin' ? '/private/tmp' : realpathSync(tmpdir());
}

export function mkdtempPortable(prefix: string): string {
  return mkdtempSync(path.join(testTempBase(), prefix));
}
