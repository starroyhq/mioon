/** Folder names for new projects (docs/PROJECT-HOST.md, "文件夹名和序号").
 * No imports, so browser code can show the folder a name will get. */

/** Leaves room for the kernel's temporary `<name>.mioon.creating-<UUID>-journal`
 * within 255 bytes, and for the name twice in a 260-character Windows path. */
export const PROJECT_FOLDER_NAME_MAX_BYTES = 80;
export const PROJECT_FOLDER_FALLBACK_NAME = '未命名项目';
export const PROJECT_FOLDER_MAX_SEQUENCE = 999;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;
/** Leading and trailing white space and dots: a leading dot hides the folder
 * from directory listings, Windows drops trailing ones. */
const trimEdges = (text: string): string => text.replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '');
/** Control characters and the characters Windows refuses in file names. */
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/gu;
/** Windows device names, also with an extension (`con.txt`, `nul .txt`). */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

/** Cuts by code point, so no character is split. */
function truncateBytes(text: string, limit: number): string {
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > limit) break;
    result += character;
    used += size;
  }
  return result;
}

/** Folder name (and `.mioon` base name) for a project name: NFC; white space
 * and dots trimmed at both ends; control characters and `<>:"/\|?*` replaced
 * by `-`; at most 80 UTF-8 bytes; `_` before a Windows device name; an empty
 * result becomes 未命名项目. */
export function projectFolderName(projectName: string): string {
  if (typeof projectName !== 'string') throw new TypeError('Project name must be a string');
  let name = trimEdges(projectName.normalize('NFC'));
  name = trimEdges(name.replace(FORBIDDEN, '-'));
  name = trimEdges(truncateBytes(name, PROJECT_FOLDER_NAME_MAX_BYTES));
  if (RESERVED.test(name.split('.')[0].trimEnd())) name = trimEdges(truncateBytes(`_${name}`, PROJECT_FOLDER_NAME_MAX_BYTES));
  return name === '' ? PROJECT_FOLDER_FALLBACK_NAME : name;
}

/** `folderName` for 1, `folderName 2` … `folderName 999` after, the name
 * shortened so the result stays within the byte limit. */
export function numberedProjectFolderName(folderName: string, sequence: number): string {
  if (typeof folderName !== 'string' || folderName === '') throw new TypeError('Folder name must be a non-empty string');
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > PROJECT_FOLDER_MAX_SEQUENCE) throw new RangeError('Sequence must be an integer from 1 to 999');
  if (sequence === 1) return folderName;
  const suffix = ` ${sequence}`;
  const base = truncateBytes(folderName, PROJECT_FOLDER_NAME_MAX_BYTES - byteLength(suffix)).replace(/[.\s]+$/u, '');
  return `${base}${suffix}`;
}
