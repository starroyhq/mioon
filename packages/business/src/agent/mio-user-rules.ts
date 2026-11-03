import {createHash} from 'node:crypto';
import type {AppLibrary} from '../app-db/index.ts';
import {
  RULES_MAX_BYTES, userRulesSaveInputSchema, userRulesSnapshotSchema,
  rulesRequestIdSchema, MIO_RULES_ERROR_STATUS,
} from '../../../contracts/src/mio-rules.ts';
import type {MioRulesErrorCode, UserRulesSnapshot, UserRulesRequestLookup} from '../../../contracts/src/mio-rules.ts';

export const USER_RULES_SAVE_OPERATION = 'user_rules.save';
type UserRulesLibrary = Pick<AppLibrary, 'userRules' | 'receipts' | 'tx'>;
function fail(code: MioRulesErrorCode): never {throw Object.assign(new Error(code), {code});}
function safe(error: unknown): never {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'MIO_RULES_REVISION_CONFLICT') return fail('MIO_RULES_CONFLICT');
  if (code === 'APP_OPERATION_RECEIPT_CONFLICT') return fail('MIO_RULES_REQUEST_CONFLICT');
  return fail(typeof code === 'string' && Object.hasOwn(MIO_RULES_ERROR_STATUS, code) ? code as MioRulesErrorCode : 'MIO_RULES_UNAVAILABLE');
}
/** The application library owns both CAS and receipt. No project connection,
 * trust row or file publication participates in these synchronous writes. */
export function createMioUserRules(library: UserRulesLibrary, {signal}: {signal?: AbortSignal} = {}) {
  const active = (): void => {if (signal?.aborted) fail('MIO_RULES_UNAVAILABLE');};
  function snapshot(value: unknown): UserRulesSnapshot {
    const parsed = userRulesSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : fail('MIO_RULES_UNAVAILABLE');
  }
  function read(): UserRulesSnapshot {
    try {active(); return snapshot({...library.userRules.get(), maxBytes: RULES_MAX_BYTES});} catch (error) {return safe(error);}
  }
  function lookup(requestId: string): UserRulesRequestLookup {
    if (!rulesRequestIdSchema.safeParse(requestId).success) fail('MIO_RULES_INVALID');
    try {
      active(); const saved = library.receipts.read(USER_RULES_SAVE_OPERATION, requestId);
      return saved ? {requestId, status: 'applied', result: snapshot(saved.response)} : {requestId, status: 'not_applied', result: null};
    } catch (error) {return safe(error);}
  }
  function save(value: unknown): UserRulesSnapshot {
    const parsed = userRulesSaveInputSchema.safeParse(value); if (!parsed.success) fail('MIO_RULES_INVALID');
    const input = parsed.data, digest = createHash('sha256').update(JSON.stringify({expectedRevision: input.expectedRevision, text: input.text}), 'utf8').digest('hex');
    try {
      active();
      // tx refuses nesting: a returned success always acknowledges this
      // application's committed transaction, never a caller's open savepoint.
      return library.tx(() => {
        active(); const saved = library.receipts.read(USER_RULES_SAVE_OPERATION, input.requestId);
        if (saved) {if (saved.digest !== digest) fail('MIO_RULES_REQUEST_CONFLICT'); return snapshot(saved.response);}
        if (input.expectedRevision >= Number.MAX_SAFE_INTEGER) fail('MIO_RULES_CONFLICT');
        const at = new Date().toISOString();
        const result = snapshot({...library.userRules.cas(input.expectedRevision, input.text, at), maxBytes: RULES_MAX_BYTES});
        library.receipts.write({operation: USER_RULES_SAVE_OPERATION, requestId: input.requestId, digest, response: result, createdAt: at});
        return result;
      });
    } catch (error) {return safe(error);}
  }
  return {read, save, lookup};
}
