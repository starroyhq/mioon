import {fixture as originalFixture, typedFrame as originalTypedFrame, typedImage as originalTypedImage, rowBytes} from '../subject-video-fixture.mjs';
import type {TestContext} from 'node:test';
import type {createArkProvider} from '../../packages/business/src/providers/ark.ts';
import type {createMockProvider} from '../../packages/business/src/providers/mock.ts';
import type {Provider} from '../../packages/business/src/provider-registry.ts';
import type {ProviderContext} from '../../packages/business/src/providers/live-common.ts';
import type {SubjectResponse} from '../../packages/contracts/src/subjects.ts';
import type {FixtureProject} from './strict-timeline-core-types.ts';
import type {TypedStore, TypedServices, TypedCall, MediaShot, MediaJob} from './strict-service-responses.ts';

export interface SubjectAsset {
  id: string; projectId: string; name: string; mimeType: string; relativePath: string; sha256: string; sizeBytes: number;
  width: number; height: number; provenance: string; createdAt: string; duration?: number; hasVideo?: boolean; hasAudio?: boolean;
}
export interface SubjectGenerationInput {
  shotId: string; expectedRevision: number; providerId: string; requestId: string; subjectVersionId?: string;
  [key: string]: unknown;
}
export type WorkerProviderContext = ProviderContext & {validateReferenceState(): void; beforeSubmit(): void};
type SubjectProviders = Omit<Map<string, Provider>, 'get'> & {
  get(id: 'mock'): ReturnType<typeof createMockProvider>;
  get(id: string): Provider | undefined;
};
export interface SubjectVideoFixture {
  root: string; store: TypedStore; services: TypedServices; call: TypedCall; project: FixtureProject; other: FixtureProject;
  env: NodeJS.ProcessEnv; providers: SubjectProviders;
  asset(patch?: Record<string, unknown>): Promise<SubjectAsset>;
  subject(asset: Pick<SubjectAsset, 'id' | 'projectId'>, kind?: string): Promise<SubjectResponse>;
  shot(patch?: Record<string, unknown>): Promise<MediaShot>;
  input(shot: Pick<MediaShot, 'id' | 'revision'>, version?: string | null, patch?: Record<string, unknown>): SubjectGenerationInput;
  submit(shot: Pick<MediaShot, 'id' | 'revision'>, version?: string | null, patch?: Record<string, unknown>): Promise<MediaJob>;
  ark(options?: {hook?: (provider: ReturnType<typeof createArkProvider>, snapshot: unknown, context: WorkerProviderContext) => unknown; reply?: typeof fetch}): ReturnType<typeof createArkProvider>;
  posts(): number; setDate(value: string): void; tick(): Promise<void>; stop(): Promise<void>;
}
export interface TypedFrameFixture {asset: SubjectAsset; source: SubjectAsset; taskId: string; groupId?: undefined; versionId?: undefined}
export interface TypedImageFixture {asset: SubjectAsset; groupId: string; taskId: string; versionId: string; source?: undefined}

// The aliases expose the existing fixture functions without replacing their data or execution.
export const fixture = originalFixture as unknown as (t: TestContext) => Promise<SubjectVideoFixture>;
export const typedFrame = originalTypedFrame as unknown as (fixture: SubjectVideoFixture) => Promise<TypedFrameFixture>;
export const typedImage = originalTypedImage as unknown as (fixture: SubjectVideoFixture) => Promise<TypedImageFixture>;
export {rowBytes};
