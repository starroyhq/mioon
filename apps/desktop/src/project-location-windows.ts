import path from 'node:path';

/** Windows project paths are validated before any filesystem or native call.
 * The displayed path stays in ordinary form: an extended-length prefix is
 * accepted on input, then added again only for OS calls that need it. */
export const WINDOWS_PROJECT_PATH_LIMIT = 4096;
export const WINDOWS_EXTENDED_PATH_THRESHOLD = 260;
export type WindowsProjectPathReason =
  | 'not-string' | 'too-long' | 'control-character' | 'device-path' | 'relative'
  | 'unc-invalid' | 'invalid-character' | 'reserved-name' | 'trailing-dot-or-space'
  | 'not-normalized' | 'component-too-long';
const DEVICE_NAMES = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const FORBIDDEN = /[<>:"|?*\u0000-\u001f\u007f]/u;

export class WindowsProjectPathError extends Error {
  readonly code = 'PROJECT_LOCATION_INVALID' as const;
  readonly reason: WindowsProjectPathReason;
  constructor(reason: WindowsProjectPathReason) {
    super('The Windows project path cannot be used safely.');
    this.name = 'WindowsProjectPathError';
    this.reason = reason;
  }
}
const fail = (reason: WindowsProjectPathReason): never => { throw new WindowsProjectPathError(reason); };

export interface WindowsProjectPath {readonly path: string; readonly unc: boolean; readonly longPath: boolean}

/** Best-effort device path rejection; returns the ordinary absolute form. */
export function normalizeWindowsProjectPath(value: unknown): WindowsProjectPath {
  if (typeof value !== 'string') return fail('not-string');
  if (value.length === 0 || value.length > WINDOWS_PROJECT_PATH_LIMIT) return fail('too-long');
  if (/[\u0000-\u001f\u007f]/u.test(value)) return fail('control-character');
  let text = value.replaceAll('/', '\\');
  if (text.startsWith('\\\\?\\')) {
    const suffix = text.slice(4);
    if (/^unc\\/iu.test(suffix)) text = '\\\\' + suffix.slice(4);
    else if (/^[a-z]:\\/iu.test(suffix)) text = suffix;
    else return fail('device-path');
  } else if (text.startsWith('\\\\.\\') || text.startsWith('\\\\?\\')) return fail('device-path');
  if (text.startsWith('\\\\.')) return fail('device-path');
  const unc = text.startsWith('\\\\');
  if (!unc && !/^[a-z]:[\\/]/iu.test(text)) return fail(/^[a-z]:$/iu.test(text) ? 'not-normalized' : 'relative');
  if (unc && !/^\\\\[^\\]+\\[^\\]+/u.test(text)) return fail('unc-invalid');
  const prefix = unc ? '\\\\' : text.slice(0, 2).toUpperCase();
  let rest = unc ? text.slice(2) : text.slice(2);
  if (!unc && rest.startsWith('\\')) rest = rest.slice(1);
  const components = rest.split('\\');
  const kept: string[] = [];
  for (const raw of components) {
    if (raw === '') continue;
    if (raw === '.' || raw === '..') return fail('not-normalized');
    if (raw.length > 255) return fail('component-too-long');
    if (FORBIDDEN.test(raw)) return fail('invalid-character');
    if (raw.endsWith(' ') || raw.endsWith('.')) return fail('trailing-dot-or-space');
    if (DEVICE_NAMES.test(raw.split('.')[0]!.trimEnd())) return fail('reserved-name');
    kept.push(raw);
  }
  if (unc && kept.length < 2) return fail('unc-invalid');
  const normalized = unc ? '\\\\' + kept.join('\\') : prefix + '\\' + kept.join('\\');
  return Object.freeze({path: normalized, unc, longPath: normalized.length >= WINDOWS_EXTENDED_PATH_THRESHOLD});
}
/** Case-insensitive identity used only to compare paths, never as display. */
export function windowsProjectPathIdentity(value: string): string {
  return value.replaceAll('/', '\\').replace(/^([a-z]):/iu, (_, drive: string) => drive.toUpperCase() + ':').toLowerCase();
}
/** Prefix an already validated ordinary path for OS calls. */
export function windowsExtendedPath(value: string): string {
  if (value.length < WINDOWS_EXTENDED_PATH_THRESHOLD && !value.startsWith('\\\\')) return value;
  return value.startsWith('\\\\') ? '\\\\?\\UNC\\' + value.slice(2) : '\\\\?\\' + value;
}
/** Remove the extended prefix a Windows API may return. */
export function windowsOrdinaryPath(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return '\\\\' + value.slice(8);
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}
