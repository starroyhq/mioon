import {verifyProjectExampleResources} from '../../../../packages/business/src/project-example-resources.ts';
import type {ProjectTemplateCatalogEntry} from './templates.ts';

/** Installation resources are optional to editing. An absent or damaged
 * catalog provides no templates; never fall back to a source checkout or
 * regenerate files in the installation. Packaging verifies these strictly. */
export function loadInstalledProjectTemplates(directory: string | undefined): readonly ProjectTemplateCatalogEntry[] {
  if (directory === undefined) return [];
  try {return verifyProjectExampleResources(directory);}
  catch {return [];}
}
