
type RoleRecord = { audioRole?: unknown };
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** Absence and explicit unclassified are intentionally different persisted values. */
export function clipAudioRoleChanged(raw: RoleRecord, saved: RoleRecord): boolean {
  return own(raw, 'audioRole') !== own(saved, 'audioRole') || raw.audioRole !== saved.audioRole;
}
