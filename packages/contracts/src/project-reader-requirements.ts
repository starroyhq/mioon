import {z} from 'zod';

export const PROJECT_READER_UPDATE_REQUIRED = 'PROJECT_READER_UPDATE_REQUIRED';
export const PROJECT_READER_UPDATE_MESSAGE = '项目使用了当前版本不支持的功能，请更新 Mioon。';
export const TIMELINE_FPS_READER_FEATURE = 'timeline-fps-v1';

export const projectReaderFeatureListSchema = z.array(
  z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
).max(32).refine(features => new Set(features).size === features.length, 'Reader requirements must be unique.');
