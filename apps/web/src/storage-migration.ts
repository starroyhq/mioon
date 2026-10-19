// This is a one-time data move, not an alternate runtime namespace. All active
// readers/writers use Mioon keys. Do not parse/re-serialize pending requests:
// their exact bytes and requestId must survive uncertain paid submissions.
export interface MigrationStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type StorageMigrationError=Error&{code: string; cause?: unknown};
export interface MigrationPlanEntry {storage: MigrationStorage; from: string; to: string; raw: string}
export interface MigrationResult {migrated: number}
export interface MigrateBrowserStorageOptions {local?: MigrationStorage|null; session?: MigrationStorage|null}
const localRenames=(key: string): string|null => key === 'frame.project' ? 'mioon.project'
  : key.startsWith('frame.workspace.v1:') ? `mioon.workspace.v1:${key.slice('frame.workspace.v1:'.length)}` : null;
const sessionRenames=(key: string): string|null => key.startsWith('frame.pending.v1:') ? `mioon.pending.v1:${key.slice('frame.pending.v1:'.length)}` : null;
const blocked=(cause: unknown): StorageMigrationError => Object.assign(new Error('Mioon 本地记录迁移未完成。旧记录已保留；为防止覆盖视图或重复提交，请关闭旧版窗口并检查存储冲突后重试。'), { code: 'STORAGE_MIGRATION_BLOCKED', cause });
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorName=(error: unknown): string=>typeof property(error,'name')==='string'?property(error,'name') as string:'';
const errorCode=(error: unknown): string=>typeof property(error,'code')==='string'?property(error,'code') as string:'';

function plan(storage: MigrationStorage|null|undefined,rename: (key: string)=>string|null): MigrationPlanEntry[] {
  if (!storage) return [];
  const result: MigrationPlanEntry[] = [];
  for (let index = 0; index < storage.length; index++) {
    const from = storage.key(index), to = typeof from === 'string' ? rename(from) : null;
    if (!to||from===null) continue;
    const raw = storage.getItem(from), current = storage.getItem(to);
    if (raw === null) continue;
    if (current !== null && current !== raw) throw blocked('destination-conflict');
    result.push({ storage, from, to, raw });
  }
  return result;
}
function migrate(plans: readonly MigrationPlanEntry[]): MigrationResult {
  // Preflight every key before any writes. Conflicting destinations fail closed.
  for (const entry of plans) {
    const { storage, from, to, raw } = entry;
    if (storage.getItem(from) !== raw) throw blocked('source-changed');
    const current = storage.getItem(to);
    if (current !== null && current !== raw) throw blocked('destination-changed');
    if (current === null) storage.setItem(to, raw);
    if (storage.getItem(to) !== raw) throw blocked('copy-verification-failed');
  }
  // Verify all copied values again before removing even the first old key.
  for (const { storage, from, to, raw } of plans) {
    if (storage.getItem(from) !== raw || storage.getItem(to) !== raw) throw blocked('verification-changed');
  }
  for (const { storage, from, to, raw } of plans) {
    if (storage.getItem(from) !== raw || storage.getItem(to) !== raw) throw blocked('removal-conflict');
    storage.removeItem(from);
    if (storage.getItem(from) !== null) throw blocked('removal-failed');
  }
  return { migrated: plans.length };
}
export function migrateBrowserStorage({ local, session }: MigrateBrowserStorageOptions = {}): MigrationResult {
  try {
    // Denied view-cache access cannot overwrite old values. Durable server
    // preferences still work; request recovery storage remains mandatory.
    if (local === undefined) { try { local = globalThis.localStorage; } catch { local = null; } }
    session = session === undefined ? globalThis.sessionStorage : session;
    let localPlan: MigrationPlanEntry[];
    try { localPlan = plan(local, localRenames); }
    catch (error) {
      if (errorName(error) !== 'SecurityError') throw error;
      localPlan = [];
    }
    return migrate([...localPlan, ...plan(session, sessionRenames)]);
  } catch (error) { throw errorCode(error) === 'STORAGE_MIGRATION_BLOCKED' ? error : blocked(errorName(error) || 'storage-unavailable'); }
}
export function migratePendingStorage(storage?: MigrationStorage): MigrationResult {
  try { return migrate(plan(storage === undefined ? globalThis.sessionStorage : storage, sessionRenames)); }
  catch (error) { throw errorCode(error) === 'STORAGE_MIGRATION_BLOCKED' ? error : blocked(errorName(error) || 'storage-unavailable'); }
}
