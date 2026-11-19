import type {ProjectLocationFacts} from '../../../packages/contracts/src/project-entry-desktop.ts';

/** The single admission policy shared by create/open/restore and the storage
 * panels: network shares and read-only volumes cannot host a project; cloud
 * sync roots and filesystems without ACL permission bits remain usable after a
 * warning. Windows maps exFAT/FAT32 to `permissionBits: false`, macOS keeps the
 * historical exFAT rule. */
export type ProjectLocationDecision =
  | {readonly kind: 'reject'}
  | {readonly kind: 'warning'; readonly cloud: boolean; readonly permissions: boolean}
  | {readonly kind: 'admit'};

export function projectLocationDecision(facts: ProjectLocationFacts): ProjectLocationDecision {
  if (!facts.isLocal || facts.volumeReadOnly) return {kind: 'reject'};
  const cloud = facts.cloud === 'known-icloud' || facts.cloud === 'known-file-provider';
  const permissions = !facts.permissionBits || facts.fileSystem.toLowerCase() === 'exfat';
  return cloud || permissions ? {kind: 'warning', cloud, permissions} : {kind: 'admit'};
}
