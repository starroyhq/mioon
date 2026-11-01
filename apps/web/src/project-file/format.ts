import { PROJECT_FILE_EXTENSION } from '../../../../packages/contracts/src/project-file.ts';
import type { HostPlatform } from './types.ts';

/** Pure helpers for the project file screens. They return structured values;
 * components translate them with `t()`. Paths may be POSIX, a Windows drive
 * (`C:\…`) or a UNC share (`\\server\share\…`). */

const TRAILING_SEPARATORS = /[\\/]+$/u;

/** `/`, `C:\` or `\\server\share`; empty for a relative path. */
function rootOf(path: string): string {
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+/u.exec(path);
  if (unc) return unc[0];
  const drive = /^[A-Za-z]:[\\/]?/u.exec(path);
  if (drive) return drive[0];
  return path.startsWith('/') ? '/' : '';
}
function lastSeparator(value: string): number {
  return Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
}

export function fileNameOf(path: string): string {
  const rest = path.slice(rootOf(path).length).replace(TRAILING_SEPARATORS, '');
  return rest.slice(lastSeparator(rest) + 1);
}
/** The file name without `.mioon`. */
export function stemOf(path: string): string {
  const name = fileNameOf(path);
  return name.length > PROJECT_FILE_EXTENSION.length && name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? name.slice(0, -PROJECT_FILE_EXTENSION.length) : name;
}
/** The folder that holds `path`; a root stays a root. */
export function folderOf(path: string): string {
  const root = rootOf(path);
  const rest = path.slice(root.length).replace(TRAILING_SEPARATORS, '');
  const index = lastSeparator(rest);
  return index < 0 ? root : root + rest.slice(0, index);
}
/** The home directory prefix shown as `~`. */
export function displayPath(path: string, homeDirectory?: string | null): string {
  const home = homeDirectory?.replace(TRAILING_SEPARATORS, '') ?? '';
  if (!home) return path;
  if (path === home) return '~';
  const next = path.charAt(home.length);
  return path.startsWith(home) && (next === '/' || next === '\\') ? `~${path.slice(home.length)}` : path;
}
/** Where a missing project was last seen: the volume, drive or share when the
 * file was on one, otherwise its folder. */
export function lastSeenLabel(projectFile: string, homeDirectory?: string | null): string {
  const volume = /^\/Volumes\/[^/]+/u.exec(projectFile);
  if (volume) return volume[0];
  const drive = /^([A-Za-z]:)[\\/]/u.exec(projectFile);
  if (drive) return drive[1];
  const share = /^\\\\[^\\/]+[\\/][^\\/]+/u.exec(projectFile);
  if (share) return share[0];
  return displayPath(folderOf(projectFile), homeDirectory);
}

/** What creating a project writes, for the new project dialog. Uses the
 * separator the location already uses. */
export function projectFilePathPreview(location: string, name: string, createFolder: boolean): string {
  const separator = location.includes('\\') && !location.includes('/') ? '\\' : '/';
  const base = location.replace(TRAILING_SEPARATORS, '');
  const file = `${name}${PROJECT_FILE_EXTENSION}`;
  return [base, ...(createFolder ? [name] : []), file].join(separator);
}
const NAME_FORBIDDEN = /[/\\:*?"<>|]/u;
/** Why a new project name cannot be used: empty, or with characters the file
 * systems refuse or with spaces around it. */
export function projectNameProblem(name: string): 'empty' | 'invalid' | null {
  if (name.trim() === '') return 'empty';
  return NAME_FORBIDDEN.test(name) || name !== name.trim() ? 'invalid' : null;
}

export type ByteUnit = 'b' | 'kb' | 'mb' | 'gb' | 'tb';
const BYTE_UNITS: readonly ByteUnit[] = ['b', 'kb', 'mb', 'gb', 'tb'];
/** Decimal units (1 KB = 1000 bytes), as the Finder shows them. The value is
 * rounded to one decimal place; the unit moves up once it would reach 1000. */
export function byteSize(bytes: number): { readonly value: number; readonly unit: ByteUnit } {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  for (let index = 0; index < BYTE_UNITS.length; index++) {
    const value = safe / 1000 ** index;
    const rounded = index === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    if (rounded < 1000 || index === BYTE_UNITS.length - 1) return { value: rounded, unit: BYTE_UNITS[index] };
  }
  return { value: 0, unit: 'b' };
}

/** Calendar day of `iso` relative to `now`, in local time. */
export function dayBucket(iso: string, now: Date): 'today' | 'yesterday' | 'earlier' {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'earlier';
  const same = (day: Date) => date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
  if (same(now)) return 'today';
  return same(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) ? 'yesterday' : 'earlier';
}
export function sameYear(iso: string, now: Date): boolean {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.getFullYear() === now.getFullYear();
}

/** `00:42` under an hour, `1:02:05` from an hour on. */
export function clockTime(frames: number, fps: number): string {
  const total = fps > 0 && Number.isFinite(frames) && frames > 0 ? Math.floor(frames / fps) : 0;
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
/** Reduced width:height, e.g. `9:16`. */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '';
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

export function revealLabelKey(platform: HostPlatform): 'projectPackage.revealFinder' | 'projectPackage.revealExplorer' | 'projectPackage.revealFiles' {
  return platform === 'mac' ? 'projectPackage.revealFinder' : platform === 'windows' ? 'projectPackage.revealExplorer' : 'projectPackage.revealFiles';
}
