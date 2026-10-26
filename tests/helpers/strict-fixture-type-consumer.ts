// Compile-only regressions for fixture views that previously overstated their
// runtime contracts. This file belongs to the real strict tests project.
import type {FixtureStore, FixtureCall, FixtureAsset, FixtureExportRecord, FixtureSnapshotAsset} from './strict-timeline-core-types.ts';
import type {TypedStore, MediaJob} from './strict-service-responses.ts';
import type {RootModule} from './strict-root-ui-types.ts';
import type {RootFailure} from './strict-root-error-types.ts';
import type {WorkspaceInspection} from './strict-workspace-boundary-types.ts';
import type {WorkspaceRestoreInspection} from '../../packages/contracts/src/workspace-restore.ts';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;
declare const store: FixtureStore;
declare const mediaStore: TypedStore;
declare const call: FixtureCall;
type AssetRead = ReturnType<typeof store.get<'assets'>>;
type JobRead = ReturnType<typeof mediaStore.get<'jobs'>>;
type Storyboard = Awaited<ReturnType<typeof call<'export.create'>>>;
type ExportRead = Awaited<ReturnType<typeof call<'export.get'>>>;
type MarkModule = typeof import('../../apps/web/src/TargetMarkLayer.tsx');
type MarkView = RootModule<MarkModule>;

export type StrictFixtureChecks = [
  Expect<Equal<IsAny<AssetRead>, false>>,
  Expect<Equal<AssetRead, FixtureAsset | null>>,
  Expect<Equal<IsAny<JobRead>, false>>,
  Expect<Equal<JobRead, MediaJob | null>>,
  Expect<Storyboard['snapshot'] extends readonly unknown[] ? true : false>,
  Expect<Equal<ExportRead, FixtureExportRecord>>,
  Expect<Equal<Extract<keyof FixtureSnapshotAsset, 'name' | 'url' | 'sizeBytes' | 'projectId'>, never>>,
  Expect<Equal<keyof MarkView, keyof MarkModule>>,
  Expect<null extends ReturnType<MarkView['default']> ? true : false>,
  Expect<Equal<WorkspaceInspection, WorkspaceRestoreInspection>>,
  Expect<Equal<RootFailure['details'], Record<string, unknown> | undefined>>,
];
