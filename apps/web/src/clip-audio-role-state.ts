
type RoleRecord = { audioRole?: unknown };
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** Absence and explicit unclassified are intentionally different persisted values. */
export function clipAudioRoleChanged(raw: RoleRecord, saved: RoleRecord): boolean {
  return own(raw, 'audioRole') !== own(saved, 'audioRole') || raw.audioRole !== saved.audioRole;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** A capability is advisory and bound to the already verified workspace/profile.
 * Never derive role access from the generic timeline update operation policy. */
export function clipAudioRoleCapabilityMatches(workspace: unknown, inspection: unknown, validateInspection: (value: unknown) => boolean, canEdit: (value: unknown) => boolean): boolean {
  if (!validateInspection(workspace) || !canEdit(inspection) || !object(workspace) || !object(inspection) || workspace.restored !== inspection.restored) return false;
  if (workspace.restored === false) return true;
  if (!object(workspace.source) || !object(inspection.source)) return false;
  return ['workspaceOrigin', 'restorationId', 'profile', 'schemaVersion'].every(key => workspace[key] === inspection[key]) &&
    ['backupId', 'schemaVersion', 'manifestHash', 'dbHash'].every(key => (workspace.source as Record<string, unknown>)[key] === (inspection.source as Record<string, unknown>)[key]);
}
/** Older servers may reject the opt-in request. That disables only this field. */
export async function readClipAudioRoleCapability(workspace: unknown, read: () => Promise<unknown>, validateInspection: (value: unknown) => boolean, canEdit: (value: unknown) => boolean): Promise<boolean> {
  try { return clipAudioRoleCapabilityMatches(workspace, await read(), validateInspection, canEdit); } catch { return false; }
}

/** Start the optional probe without delaying project loading or ordinary editing. */
export function observeClipAudioRoleCapability(workspace: unknown, read: () => Promise<unknown>, validateInspection: (value: unknown) => boolean, canEdit: (value: unknown) => boolean, isCurrent: () => boolean, publish: (editable: boolean) => void): void {
  void readClipAudioRoleCapability(workspace, read, validateInspection, canEdit).then(editable => { if (isCurrent()) publish(editable); });
}
