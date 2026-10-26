import type {SceneDetectTaskResponse, SceneShotsTaskResponse, SceneResultResponse, SceneResultSummary} from '../../packages/contracts/src/scene-tasks.ts';
import type {SceneService} from '../../packages/business/src/scene-tasks.ts';
import type {ServiceResponse, TypedServices} from './strict-service-responses.ts';
export type SceneTaskFor<K extends 'detect' | 'shots'> = K extends 'detect' ? SceneDetectTaskResponse : SceneShotsTaskResponse;
export type SceneResponse<O extends string, K extends 'detect' | 'shots' = 'detect'> =
 O extends 'scene.detect' ? SceneDetectTaskResponse :
 O extends 'scene.shots.create' | 'scene.shots.undo' ? SceneShotsTaskResponse :
 O extends 'scene.task.get' | 'scene.task.cancel' ? SceneTaskFor<K> :
 O extends 'scene.task.list' ? {projectId: string; items: SceneTaskFor<K>[]; nextCursor: string | null} :
 O extends 'scene.request.get' ? {projectId: string; requestId: string; operation: string; response: SceneTaskFor<K> | SceneResultSummary} | null :
 O extends 'scene.result.get' ? SceneResultResponse :
 O extends 'scene.cuts.save' ? SceneResultSummary : ServiceResponse<O>;
// Each test file selects the kind its get/list helpers observe. Detection and
// shot creation retain their separate concrete response contracts.
export type SceneCall<K extends 'detect' | 'shots' = 'detect'> = <O extends string>(operation: O, input: unknown) => Promise<SceneResponse<O, K>>;
export type SceneServices<K extends 'detect' | 'shots' = 'detect'> = Omit<TypedServices, 'call'> & {call: SceneCall<K>};
export type SceneHandlerService<K extends 'detect' | 'shots' = 'detect'> = Omit<SceneService, 'handlers'> & {
 handlers: Record<string, (input: unknown) => unknown> & {[O in 'scene.detect' | 'scene.shots.create' | 'scene.shots.undo' | 'scene.task.get' | 'scene.task.cancel' | 'scene.task.list' | 'scene.request.get' | 'scene.result.get' | 'scene.cuts.save']: (input: unknown) => SceneResponse<O, K>}
};
