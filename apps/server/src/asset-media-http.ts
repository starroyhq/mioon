import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError} from '@mioon/contracts';
import {createAssetMediaServices} from '@mioon/business/asset-media-services';
import type {ProjectStore} from '@mioon/business/project-file/store';
import type {OutsidePathConfirmationStore} from '@mioon/business/app-db/stores';
import {body, field, json} from './http-json.ts';

/** The project host calls this after the server's bearer and origin checks.
 * The fixed user-action route is absent from RPC/MCP discovery; no RPC input
 * or model-provided boolean can select the trusted service entry. */
export function createAssetMediaHttp({store, outsidePaths, signal, assertMutationAllowed}: {store: ProjectStore; outsidePaths: OutsidePathConfirmationStore; signal?: AbortSignal; assertMutationAllowed(): void}) {
  return {async handle(req: IncomingMessage, res: ServerResponse, _url: URL, route: {kind: string; segments?: readonly string[]}): Promise<boolean> {
    if (route.kind !== 'other' || route.segments?.join('/') !== 'asset-media/trusted') return false;
    if (req.method !== 'POST' || req.headers['x-mioon-user-action'] !== 'asset-media') throw new AppError('FORBIDDEN', '需要明确的用户操作', 403);
    const data = await body(req, 64 * 1024), operation = field(data, 'operation'), input = field(data, 'input');
    if (typeof operation !== 'string' || field(input, 'projectId') !== store.projectId) throw new AppError('VALIDATION_ERROR', '素材操作的项目范围无效');
    if (operation !== 'asset.media.location.list') assertMutationAllowed();
    const service = createAssetMediaServices(store, {outsidePaths, signal, ...(operation !== 'asset.media.location.list' ? {beforeEffect: assertMutationAllowed} : {})});
    const result = await service.trustedCall(operation, input);
    if (!res.destroyed && !res.writableEnded) json(res, 200, {ok: true, data: result});
    return true;
  }};
}
