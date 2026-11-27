import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {
  PROJECT_READER_UPDATE_MESSAGE, PROJECT_READER_UPDATE_REQUIRED, TIMELINE_FPS_READER_FEATURE,
  projectReaderFeatureListSchema,
} from '../../../contracts/src/project-reader-requirements.ts';
import {isTimelineFps, type TimelineFps} from '../../../contracts/src/timeline-fps.ts';
import {projectFileError} from './errors.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from './schema/databases.ts';

type ProjectSchema = 'main' | 'project';
const supports = (feature: string) => feature === TIMELINE_FPS_READER_FEATURE && process.env.MIOON_FORMAT6_DEV === '1';
const invalid = () => projectFileError('PROJECT_INVALID', {database: 'project', reason: 'metadata'});

function requirements(projectData: unknown): string[] {
  if (!projectData || typeof projectData !== 'object' || !('requiredReaderFeatures' in projectData)) return [];
  const result = projectReaderFeatureListSchema.safeParse(projectData.requiredReaderFeatures);
  if (!result.success) throw invalid();
  const unsupportedFeatures = result.data.filter(feature => !supports(feature));
  if (unsupportedFeatures.length) throw new AppError(PROJECT_READER_UPDATE_REQUIRED, PROJECT_READER_UPDATE_MESSAGE, 409,
    {database: 'project', formatVersion: FORMAT6_PROJECT_SCHEMA_VERSION, unsupportedFeatures});
  return result.data;
}

function assertTimelineRate(fps: unknown, features: readonly string[]): TimelineFps {
  if (!isTimelineFps(fps) || fps !== 30 && !features.includes(TIMELINE_FPS_READER_FEATURE)) throw invalid();
  return fps;
}

/** Validate decoded format-6 content before validating its feature-dependent payloads. */
export function assertProjectReaderRequirementsInData(projectData: unknown, timelineData?: unknown): void {
  const features = requirements(projectData);
  if (timelineData && typeof timelineData === 'object' && 'fps' in timelineData) assertTimelineRate(timelineData.fps, features);
}

function read<T>(query: () => T): T | undefined {
  try {return query();}
  catch (error) {
    // A missing metadata table/column belongs to the normal manifest check.
    if (error instanceof Error && /^no such (table|column): /u.test(error.message)) return undefined;
    throw error;
  }
}

/** The project row is the stable format-6 reader declaration. It is checked
 * before the exact schema manifest or any feature-dependent validation. */
export function assertProjectReaderRequirements(db: Pick<DatabaseSync, 'prepare'>, schema: ProjectSchema, formatVersion: number): TimelineFps | undefined {
  if (formatVersion !== FORMAT6_PROJECT_SCHEMA_VERSION) return;
  const row = read(() => db.prepare(`SELECT p.data FROM ${schema}.projects p
    JOIN ${schema}.project_file f ON p.id=f.projectId LIMIT 1`).get());
  let projectData: unknown;
  if (row) {
    if (typeof row.data !== 'string') throw invalid();
    try {projectData = JSON.parse(row.data);} catch {throw invalid();}
  }
  const features = requirements(projectData);
  const timeline = read(() => db.prepare(`SELECT CASE WHEN json_valid(data)
    THEN json_extract(data,'$.fps') END AS fps FROM ${schema}.timelines LIMIT 1`).get());
  if (timeline) return assertTimelineRate(timeline.fps, features);
}

export function assertHeldProjectReaderRequirements({db}: {readonly db: Pick<DatabaseSync, 'prepare'>}): void {
  const version = db.prepare('PRAGMA project.user_version').get()?.user_version;
  if (typeof version === 'number') assertProjectReaderRequirements(db, 'project', version);
}
