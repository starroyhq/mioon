import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {
  LOCAL_RECORDS_LIMITS, localRecordSchemas, localRecordsDeleteResponseSchema, localRecordsIdentitySchema, localRecordsListResponseSchema,
} from '../../../packages/contracts/src/local-record-operations.ts';
import type {LocalRecordOperation, LocalRecordsDeleteInput, LocalRecordsIdentity} from '../../../packages/contracts/src/local-record-operations.ts';
import type {LocalRecordsStore} from '../../../packages/business/src/app-db/local-records.ts';

export interface LocalRecordRpcPorts {
  readonly store: LocalRecordsStore;
  readonly readIdentity: () => LocalRecordsIdentity;
  readonly assertMutationAllowed: () => void;
}
const sameIdentity = (a: LocalRecordsIdentity, b: LocalRecordsIdentity): boolean =>
  a.appLibraryScope === b.appLibraryScope && a.instanceId === b.instanceId;
const identityChanged = (): AppError => new AppError('LOCAL_RECORDS_IDENTITY_CHANGED', '应用资料库或服务已变化，请刷新后重新确认。', 409);

/** Does not acquire any project or open its history. Both operations inherit
 * B1's recovery sweep, so even listing requires a real mutation owner. */
export function createLocalRecordRpc({store, readIdentity, assertMutationAllowed}: LocalRecordRpcPorts) {
  if (typeof readIdentity !== 'function' || typeof assertMutationAllowed !== 'function') throw new TypeError('Local records require an application identity and owner');
  const identity = (): LocalRecordsIdentity => {
    assertMutationAllowed();
    return localRecordsIdentitySchema.parse(readIdentity());
  };
  return {async call(operation: LocalRecordOperation, raw: unknown): Promise<unknown> {
    const parsed = localRecordSchemas[operation].safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '本机记录参数无效', 400, {issues: parsed.error.issues});
    const before = identity();
    if (operation === 'local.records.list') {
      const records = await store.list();
      if (!sameIdentity(before, identity())) throw identityChanged();
      const response = localRecordsListResponseSchema.safeParse({version: 1, ...before, records});
      if (!response.success) {
        if (records.length > LOCAL_RECORDS_LIMITS.maxRecords) throw new AppError('LOCAL_RECORDS_LIMIT', '本机记录数量超过响应上限', 413);
        throw new AppError('INTERNAL_ERROR', '本机记录返回无效数据', 500);
      }
      if (Buffer.byteLength(JSON.stringify({ok: true, data: response.data}), 'utf8') > LOCAL_RECORDS_LIMITS.responseBytes) {
        throw new AppError('LOCAL_RECORDS_LIMIT', '本机记录响应超过传输上限', 413);
      }
      return response.data;
    }
    const input = parsed.data as LocalRecordsDeleteInput;
    if (before.appLibraryScope !== input.expectedAppLibraryScope || before.instanceId !== input.expectedInstanceId) throw identityChanged();
    // Expected identity is checked before entering B1, including its initial
    // tombstone sweep. No default/current identity may repair an old intent.
    let removed = false;
    try {
      await store.delete(input.projectId);
      removed = true;
      if (!sameIdentity(before, identity())) throw identityChanged();
      return localRecordsDeleteResponseSchema.parse({...before, projectId: input.projectId, deleted: true});
    } catch (error) {
      if (!removed && error instanceof AppError && ['LOCAL_RECORDS_NOT_FOUND', 'LOCAL_RECORDS_IN_USE', 'LOCAL_RECORDS_SUPER_JOURNAL'].includes(error.code)) throw error;
      // There is no deletion receipt or safe automatic replay. A filesystem
      // failure or a lost owner after rename cannot be reported as not-applied.
      throw new AppError('LOCAL_RECORDS_DELETE_UNCERTAIN', '删除结果尚未确认，请刷新本机记录后核对。', 503,
        {...before, projectId: input.projectId, mutationOutcome: 'unknown'});
    }
  }};
}
