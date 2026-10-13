/** Renderer-local observations only. These are never sent through the native
 * bridge. Reading a snapshot must not synchronize a controller or start work. */
export interface EditorCloseOwnerSnapshot {
  readonly dirty: boolean;
  readonly inflight: boolean;
  readonly unknown: boolean;
  readonly identity: readonly (string | number | boolean | null | undefined)[];
}
interface RetainedIdentity {
  readonly workspaceScope: string; readonly instanceId: string; readonly projectId: string;
  readonly shotId?: string; readonly timelineId?: string; readonly draftId?: string; readonly intentId?: string;
  readonly expectedDraftRevision?: number; readonly expectedIntentRevision?: number; readonly expectedIntentId?: string | null;
  readonly baseRevision?: number;
}
/** The contracts cap each retained owner map at 128 slots. Overflow remains an
 * unknown blocker; its payload is never copied into a close snapshot. Project,
 * target, request IDs and original CAS identify a retained request without its
 * name, prompt, raw draft, parameters, path or credentials. */
export function readEditorRetentionIdentity(...maps: readonly ReadonlyMap<string, RetainedIdentity>[]): readonly (string | number | null | undefined)[] {
  const identity: (string | number | null | undefined)[] = [];
  for (const map of maps) {
    identity.push(map.size);
    let count = 0;
    for (const value of map.values()) {
      if (count++ === 128) break;
      identity.push(value.workspaceScope, value.instanceId, value.projectId, value.shotId, value.timelineId,
        value.draftId, value.intentId, value.expectedDraftRevision, value.expectedIntentRevision, value.expectedIntentId, value.baseRevision);
    }
  }
  return Object.freeze(identity);
}
interface LocalOwner { getEditorCloseSnapshot(): EditorCloseOwnerSnapshot }
export interface EditorCloseExternalSnapshot extends EditorCloseOwnerSnapshot {
  /** Opaque mounted owner identity; no draft or request payload. */
  readonly owner?: object | null;
}
export type EditorWindowCloseReason = 'clip-inflight' | 'clip-unknown' | 'shot-inflight' | 'shot-unknown' |
  'delivery-inflight' | 'delivery-unknown' | 'import-inflight' | 'import-unknown' | 'mutation-inflight' | 'mutation-unknown';
export interface EditorWindowCloseSnapshot {
  readonly dirty: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly EditorWindowCloseReason[];
  readonly identity: readonly unknown[];
}
interface Owners {
  readonly clip?: LocalOwner | null;
  readonly shot?: LocalOwner | null;
  readonly delivery?: LocalOwner | null;
  readonly importState?: EditorCloseExternalSnapshot | null;
  readonly mutationState?: EditorCloseExternalSnapshot | null;
  readonly exportSettings?: EditorCloseExternalSnapshot | null;
  readonly exportRange?: EditorCloseExternalSnapshot | null;
}

/** Additional editor destruction guards, independent of P0's original dirty
 * predicates. A false dirty flag never proves persistence. App must still use
 * its original fixed drain and dirty confirmation; drain failure cannot waive
 * an unresolved owner. Accepted backend jobs are deliberately not an input.
 *
 * Owner getters project counters and flags, including all retained-map slots,
 * rather than request payloads. Their bounded identity excludes sidecar ACK
 * metadata so an exact successful close drain can retain its admission. */
export function readEditorWindowClose({ clip, shot, delivery, importState, mutationState, exportSettings, exportRange }: Owners = {}): EditorWindowCloseSnapshot {
  const reasons: EditorWindowCloseReason[] = [], identity: unknown[] = [];
  let dirty = false;
  const local = (name: 'clip' | 'shot' | 'delivery' | 'import' | 'mutation', owner: object | null | undefined, snapshot?: EditorCloseOwnerSnapshot | null) => {
    identity.push(name, owner ?? null, snapshot?.identity.length ?? 0, ...(snapshot?.identity ?? []));
    dirty ||= snapshot?.dirty === true;
    if (snapshot?.inflight) reasons.push(`${name}-inflight`);
    if (snapshot?.unknown) reasons.push(`${name}-unknown`);
  };
  local('clip', clip, clip?.getEditorCloseSnapshot());
  local('shot', shot, shot?.getEditorCloseSnapshot());
  local('delivery', delivery, delivery?.getEditorCloseSnapshot());
  local('import', importState?.owner, importState);
  local('mutation', mutationState?.owner, mutationState);
  for (const [name, value] of [['export-settings', exportSettings], ['export-range', exportRange]] as const) {
    identity.push(name, value?.owner ?? null, value?.identity.length ?? 0, ...(value?.identity ?? []));
    dirty ||= value?.dirty === true;
  }
  return Object.freeze({ dirty, blocked: reasons.length > 0, reasons: Object.freeze(reasons), identity: Object.freeze(identity) });
}
