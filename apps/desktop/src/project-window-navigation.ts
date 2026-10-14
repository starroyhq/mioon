interface NavigationEvent {
  readonly url?: unknown;
  readonly isMainFrame?: unknown;
  preventDefault(): void;
}
type Listener = (event: NavigationEvent, legacyUrl?: unknown) => void;
interface NavigationContents {
  on(name: string, listener: Listener): unknown;
  removeListener(name: string, listener: Listener): unknown;
}
export interface AssignedProjectNavigation {
  readonly url: string;
  isCurrent(): boolean;
}

/** Additional native-role fence, on top of the shared same-origin policy.
 * Project switching opens another owner; it never navigates this document into
 * a different project's slot or turns settings into an editor. */
export function installAssignedProjectNavigation(contents: NavigationContents, owner: AssignedProjectNavigation): () => void {
  const assignedUrl = owner.url;
  const permits = (value: unknown): boolean => {
    try { return typeof assignedUrl === 'string' && assignedUrl.length > 0 && assignedUrl.length <= 2048 && value === assignedUrl && owner.isCurrent() === true; }
    catch { return false; }
  };
  const main: Listener = (event, legacyUrl) => {
    if (!permits(event.url ?? legacyUrl)) event.preventDefault();
  };
  const frame: Listener = event => {
    if (event.isMainFrame !== true || !permits(event.url)) event.preventDefault();
  };
  contents.on('will-navigate', main);
  contents.on('will-redirect', main);
  contents.on('will-frame-navigate', frame);
  return () => {
    contents.removeListener('will-navigate', main);
    contents.removeListener('will-redirect', main);
    contents.removeListener('will-frame-navigate', frame);
  };
}
