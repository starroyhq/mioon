/** Public project names use the same rules in creation requests and the UI.
 * Folder-name cleanup stays separate: invalid input must not silently create
 * a project under a different name. */
export const PROJECT_NAME_MAX_LENGTH = 150;

const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

export function projectNameProblem(name: string): 'empty' | 'invalid' | null {
  if (name.trim() === '') return 'empty';
  if (name.length > PROJECT_NAME_MAX_LENGTH || name !== name.trim() || name.startsWith('.') || name.endsWith('.') || FORBIDDEN.test(name)) return 'invalid';
  return WINDOWS_DEVICE.test(name.split('.')[0].trimEnd()) ? 'invalid' : null;
}
