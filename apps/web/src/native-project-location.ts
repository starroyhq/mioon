interface NativeProjectHistory {
  readonly location: { readonly href: string };
  readonly history: { replaceState(data: unknown, unused: string, url: string): void };
}
/** Immutable native project binding. Browser history is a Web concern; a native
 * pop never opens another project or lends this document another window's ID. */
export function createNativeProjectLocation(window: NativeProjectHistory, projectId: string) {
  const assigned = new URL(window.location.href);
  if (assigned.protocol !== 'http:' || assigned.hostname !== '127.0.0.1' || !assigned.port || assigned.pathname !== '/' ||
      assigned.username || assigned.password || assigned.hash || [...assigned.searchParams.keys()].length !== 1 ||
      assigned.searchParams.get('project') !== projectId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId)) throw Error('Invalid native project route');
  const href = assigned.href;
  return Object.freeze({ restore() {
    if (window.location.href === href) return true;
    try { window.history.replaceState({projectId}, '', href); return window.location.href === href; } catch { return false; }
  } });
}
