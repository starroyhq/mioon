import {AppError, hasRequestNotAppliedProof, isTimelineMutationResponse, publicValue, schemas} from '@mioon/contracts';
import {createLocalDrafts, LocalDraftError, safeLocalDraftError} from '@mioon/business/local-drafts';
import {createLocalDelivery, LocalDeliveryError, safeLocalDeliveryError} from '@mioon/business/local-delivery';
import {createLocalShotText, LocalShotTextError, safeLocalShotTextError} from '@mioon/business/local-shot-text';
import {createLocalShotTextDomain} from '@mioon/business/local-shot-text-domain';
import {createLocalMutationServices} from '@mioon/business/local-mutations';
import {validateImageConsumption} from '@mioon/business/image-consumption';
import {canonical, hash} from '@mioon/business/services';
import type {createServices} from '@mioon/business/services';
import {createTimelineRecoveryBoundary, readTimelineReceipt} from '@mioon/business/timeline-recovery';
import {assertProjectStore, ownsStoreLock} from '@mioon/business/store-runtime';
import type {ProjectStore} from '@mioon/business/project-file/index';
import {createLocalDraftHttp} from '../local-drafts-http.ts';
import {createLocalDeliveryHttp} from '../local-delivery-http.ts';
import {createLocalShotTextHttp} from '../local-shot-text-http.ts';
import {projectHandlerTarget} from './request.ts';
import {isDatabaseMovedError, projectIdMismatch} from './errors.ts';
import type {ProjectDraftsFactory, ProjectDraftsPort} from './ports.ts';
import type {ProjectHostContext, ProjectRequest} from './host.ts';

interface ProjectDraftsDependencies {
  readonly store: ProjectStore;
  readonly channel: 'web' | 'production' | 'development';
  readonly services: Pick<ReturnType<typeof createServices>, 'assertMutationAllowed' | 'updateShotInProject'>;
  readonly call: (operation: string, input: unknown) => Promise<unknown>;
  readonly ownsApplicationLock: () => boolean;
}

/** Bound only after the ordinary services exist. The manager supplies their
 * exact store through the real host context; no second connection is opened. */
export function createProjectDraftsFactory({store, channel, services, call, ownsApplicationLock}: ProjectDraftsDependencies): ProjectDraftsFactory {
  let bound: {readonly context: ProjectHostContext; readonly port: ProjectDraftsPort} | undefined;
  return context => {
    assertProjectStore(context.store);
    if (context.store !== store || context.projectId !== store.projectId) throw new TypeError('Drafts require their bound project host');
    if (bound) {
      if (bound.context !== context) throw new TypeError('Drafts already belong to another host context');
      return bound.port;
    }
    const admission = new AbortController();
    const signal = AbortSignal.any([context.signal, admission.signal]);
    const common = {store, channel, signal, relocate: () => context.relocate()};
    const ownsLock = () => ownsStoreLock(store) && ownsApplicationLock();
    const fixedBusinessCall = async <Result>(invoke: () => Promise<Result>): Promise<Result> => {
      try {return await invoke();}
      catch (error) {
        // The engines retain an unknown business failure as pending. Notify
        // the host before that safe boundary can hide a native moved error.
        let cause: unknown = error;
        for (let depth = 0; depth < 5 && cause !== null && typeof cause === 'object'; depth++) {
          const failure = cause as {code?: unknown; cause?: unknown};
          if (isDatabaseMovedError(cause) || failure.code === 'PROJECT_FILE_MOVED' || failure.code === 'SQLITE_READONLY_DBMOVED') {
            context.relocate();
            break;
          }
          cause = failure.cause;
        }
        throw error;
      }
    };
    const clip = createLocalDrafts({...common, guards: {ownsLock,
      readTimeline: projectId => createTimelineRecoveryBoundary(store.db, {projectId}).read(),
      readClipAsset: (projectId, value) => createTimelineRecoveryBoundary(store.db, {projectId}).clipSource(value)}});
    const delivery = createLocalDelivery({...common, guards: {ownsLock,
      readTimeline: projectId => createTimelineRecoveryBoundary(store.db, {projectId}).read({sourceSemantics: false}),
      isRenderInput: value => schemas['timeline.render'].safeParse(value).success,
      isRenderResponse: (input, value) => isTimelineMutationResponse('timeline.render', input, value),
      isNotApplied: (input, error) => hasRequestNotAppliedProof(error, input, {operation: 'timeline.render'}),
      readReceipt: input => {
        const saved = readTimelineReceipt(store.db, input, 'timeline.render');
        if (!saved) return null;
        if (saved.requestHash !== hash({operation: 'timeline.render', input})) throw new AppError('IDEMPOTENCY_CONFLICT', '原导出请求身份与内容不一致。', 409);
        return publicValue(createTimelineRecoveryBoundary(store.db, input).replay('timeline.render', saved.response as string));
      },
      render: input => fixedBusinessCall(() => call('timeline.render', input))}});
    const neverMutate = (): never => {throw new Error('Read-only shot receipt boundary');};
    const shotReplay = createLocalMutationServices(store, {canonical, readOnly: true, check: neverMutate, now: neverMutate, references: {guardManualUpdate: neverMutate}});
    const shotDomain = createLocalShotTextDomain({db: store.db, canonical,
      replay: (projectId, input) => shotReplay.updateShotInProject(projectId, input),
      validateAsset: (projectId, asset) => validateImageConsumption(store.db, asset as Record<string, unknown> & {id: string}, projectId),
      isRevisionConflict: error => error instanceof AppError && error.code === 'REVISION_CONFLICT',
      updateShotInProject: (projectId, input) => fixedBusinessCall(() => services.updateShotInProject(projectId, input))});
    const shot = createLocalShotText({...common, guards: {...shotDomain, ownsLock,
      isShotUpdateInput: value => schemas['shot.update'].safeParse(value).success}});
    // Pure local saves also need the application's live write admission. Reads
    // do not invoke a mutation guard or initialize missing project contents.
    const mutate = <Result>(invoke: (input: unknown) => Result) => (input: unknown): Result => {
      services.assertMutationAllowed();
      return invoke(input);
    };
    const handlers = [
      createLocalDraftHttp({drafts: {...clip, put: mutate(clip.put), discard: mutate(clip.discard)}, signal}),
      createLocalDeliveryHttp({delivery: {...delivery, put: mutate(delivery.put), discard: mutate(delivery.discard),
        prepare: mutate(delivery.prepare), execute: mutate(delivery.execute), recover: mutate(delivery.recover)}, signal}),
      createLocalShotTextHttp({shotText: {...shot, put: mutate(shot.put), discard: mutate(shot.discard),
        prepare: mutate(shot.prepare), execute: mutate(shot.execute), recover: mutate(shot.recover)}, signal}),
    ];
    const admitted = new Set<Promise<boolean>>();
    let closed = false;
    let draining: Promise<void> | undefined;
    const port: ProjectDraftsPort = {
      handle(request: ProjectRequest): Promise<boolean> {
        const target = projectHandlerTarget(request.route);
        if (!target || !/^\/api\/local-(?:drafts|delivery|shot-text)(?:\/|$)/u.test(target.pathname)) return Promise.resolve(false);
        if (request.route.projectId !== context.projectId) return Promise.reject(projectIdMismatch(context.projectId));
        const local = new URL(request.url);
        local.pathname = target.pathname;
        request.req.url = local.pathname + local.search;
        if (closed) {
          // Do not enter a handler or read its body after the drain snapshot.
          // Preserve the family's safe wire error without any service/SQL work.
          const safe = target.pathname.startsWith('/api/local-drafts') ? safeLocalDraftError(new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE'))
            : target.pathname.startsWith('/api/local-delivery') ? safeLocalDeliveryError(new LocalDeliveryError('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'))
            : safeLocalShotTextError(new LocalShotTextError('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE'));
          const res = request.res;
          if (!res.destroyed && !res.writableEnded) {
            if (res.headersSent) res.destroy();
            else {
              res.writeHead(safe.status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
              res.end(JSON.stringify({ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}}));
            }
          }
          return Promise.resolve(true);
        }
        // Register before the first await. A disconnected response releases
        // its request lease, but it does not end this admitted continuation.
        const pending = Promise.resolve().then(async () => {
          for (const handle of handlers) if (await handle(request.req, request.res, local, {projectId: context.projectId})) return true;
          return false;
        }).finally(() => admitted.delete(pending));
        admitted.add(pending);
        return pending;
      },
      isBusy: () => admitted.size > 0 || delivery.isBusy() || shot.isBusy(),
      drain(): Promise<void> {
        if (draining) return draining;
        closed = true;
        admission.abort();
        const work = [...admitted, ...[() => delivery.drain(), () => shot.drain()].map(close => {
          try {return Promise.resolve(close());} catch (error) {return Promise.reject(error);}
        })];
        draining = Promise.allSettled(work).then(results => {
          const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (failures.length) throw new AggregateError(failures, 'Project drafts could not finish safely');
        });
        return draining;
      },
    };
    bound = {context, port};
    return port;
  };
}
