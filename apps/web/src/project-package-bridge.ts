/** Fixed desktop bridge for saving a finished project file. The renderer never
 * sees or sends a filesystem path: the main process keeps the chosen location
 * behind an opaque token. In a browser the bridge is absent and the file is
 * downloaded instead. */
export interface ProjectPackageDestination { readonly token: string; readonly fileName: string }
export interface ProjectPackagesBridge {
  chooseDestination(input: { suggestedName: string }): Promise<ProjectPackageDestination | null>;
  save(input: { token: string; exportId: string }): Promise<{ fileName: string }>;
  reveal(input: { token: string }): Promise<unknown>;
}

const callable = (value: unknown, key: string): boolean => typeof (value as Record<string, unknown>)[key] === 'function';

export function projectPackagesBridge(source: unknown = typeof window === 'undefined' ? undefined : window): ProjectPackagesBridge | null {
  const bridge = source && typeof source === 'object' ? (source as { __mioonProjectPackages?: unknown }).__mioonProjectPackages : undefined;
  if (!bridge || typeof bridge !== 'object' || !['chooseDestination', 'save', 'reveal'].every(key => callable(bridge, key))) return null;
  return bridge as ProjectPackagesBridge;
}

export function isProjectPackageDestination(value: unknown): value is ProjectPackageDestination {
  return Boolean(value) && typeof value === 'object' && typeof (value as ProjectPackageDestination).token === 'string' && (value as ProjectPackageDestination).token.length > 0
    && typeof (value as ProjectPackageDestination).fileName === 'string';
}

/** Which label the desktop "reveal" action uses. */
export function revealPlatform(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): 'finder' | 'explorer' | 'files' {
  return /Mac/u.test(userAgent) ? 'finder' : /Windows/u.test(userAgent) ? 'explorer' : 'files';
}
