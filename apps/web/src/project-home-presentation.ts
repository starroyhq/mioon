import type { ProjectHomeProject } from './ProjectHome.tsx';
import type { UiPreferences } from '../../../packages/contracts/src/ui-preferences.ts';
/** Stable tie breakers prevent cards from jumping when summary reads finish. */
export function orderedHomeProjects(projects: readonly ProjectHomeProject[], query: string, sort: UiPreferences['homeSort'], locale: string): ProjectHomeProject[] {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase(locale), collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return projects.filter(project => !needle || project.name.normalize('NFKC').toLocaleLowerCase(locale).includes(needle)).slice().sort((left, right) => {
    const primary = sort === 'name' ? collator.compare(left.name, right.name) : sort === 'recent' ? (right.lastOpenedAt || '').localeCompare(left.lastOpenedAt || '') || right.updatedAt.localeCompare(left.updatedAt) : right.updatedAt.localeCompare(left.updatedAt);
    return primary || collator.compare(left.name, right.name) || left.id.localeCompare(right.id);
  });
}
