/** Renderer-local, read-only composition. Opening another project owns a
 * separate form and must participate in this window's exact P0 admission. */
export interface NativeEntryCloseSnapshot {
  readonly dirty: boolean; readonly busy: boolean; readonly unknown: boolean;
  readonly identity: readonly unknown[];
}
export function combineNativeEntryClose(editor: NativeEntryCloseSnapshot, entry?: NativeEntryCloseSnapshot | null): NativeEntryCloseSnapshot {
  return Object.freeze({ dirty: editor.dirty || entry?.dirty === true, busy: editor.busy || entry?.busy === true,
    unknown: editor.unknown || entry?.unknown === true,
    identity: Object.freeze(['editor', editor.identity.length, ...editor.identity, 'project-entry', entry?.identity.length ?? 0, ...(entry?.identity ?? [])]) });
}
