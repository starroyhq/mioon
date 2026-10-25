import type {DatabaseSync} from 'node:sqlite';

type HistoricalConstructor = (db: DatabaseSync) => void;

/**
 * A restore profile builds its fixed historical catalogs once per instance, by replaying the whole historical
 * schema chain in memory. Ordinary upgrades run each time a workspace is created or an older one is opened, so
 * they share one instance per exact application-owned constructor, as the schema dispatcher binds its restored
 * profiles once, instead of rebuilding every catalog for each workspace a process opens.
 */
export function oneProfilePerConstructor<Profile extends object>(create: (initializeThrough24: HistoricalConstructor) => Profile): (initializeThrough24: HistoricalConstructor) => Profile {
  const profiles = new WeakMap<HistoricalConstructor, Profile>();
  return initializeThrough24 => {
    let profile = profiles.get(initializeThrough24);
    if (!profile) {profile = create(initializeThrough24); profiles.set(initializeThrough24, profile);}
    return profile;
  };
}
