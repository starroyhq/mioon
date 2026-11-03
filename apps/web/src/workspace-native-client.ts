export interface WorkspaceNativeBridge { restart(): Promise<unknown> }
/** The host owns restart admission; the renderer only requests it. */
export function workspaceNativeBridge(): WorkspaceNativeBridge | undefined {
  return (window as Window & { __mioonWorkspaceNative?: WorkspaceNativeBridge }).__mioonWorkspaceNative;
}
