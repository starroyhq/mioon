import {sameProjectFileIdentity} from '@mioon/business/app-db/index';
import type {ProjectFileIdentity, RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ProjectRegistryPort} from './ports.ts';

export function matchesRegisteredInode(entry: RecentProject, observed: ProjectFileIdentity | null): observed is ProjectFileIdentity {
  return observed !== null && observed.ino !== '0' && observed.ino === entry.fileIdentity.ino;
}

/** The device number may change after a reboot. The observation here must be
 * from the registered path. Live file ownership and operation tickets still
 * require a full identity match. */
export function refreshRegisteredIdentity(
  registry: ProjectRegistryPort, entry: RecentProject, observed: ProjectFileIdentity | null,
): RecentProject | null {
  if (!matchesRegisteredInode(entry, observed)) return null;
  if (sameProjectFileIdentity(entry.fileIdentity, observed)) return entry;
  // An observation of the old path must not invalidate another registration.
  if (registry.list().some(other => other.projectId !== entry.projectId && sameProjectFileIdentity(other.fileIdentity, observed))) return null;
  const updated = {...entry, fileIdentity: observed};
  registry.upsert(updated);
  return updated;
}
