import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/types.ts';
import { TimelineUiError, timelineFailure } from './timeline-notices.ts';
import { parseLookPackBytes } from '../../../packages/business/src/look-pack.ts';
import type { LookPackInspection } from '../../../packages/contracts/src/look-pack.ts';
import { LUT_RESOURCE_LIMITS } from '../../../packages/contracts/src/lut-resources.ts';

export type LookPackFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;
export interface LookPackIntakeState {
  phase: 'idle' | 'reading' | 'ready' | 'adopting' | 'adopted' | 'error';
  name: string; inspection: LookPackInspection | null; acknowledged: boolean; error: string; errorMessage?: DisplayMessage;
}
const initial = (): LookPackIntakeState => ({ phase: 'idle', name: '', inspection: null, acknowledged: false, error: '' });

/** Local preview only. A bounded immutable byte snapshot is adopted only after
 * explicit acknowledgement; no paths, downloads, persistence or RPC during
 * preview. Existing LUT admission owns every database/receipt/recovery effect. */
export function createLookPackIntake({ getScope, isBlocked, adopt, onChange = () => {} }: {
  getScope: () => string; isBlocked: () => boolean; adopt: (file: LookPackFile) => Promise<boolean>;
  onChange?: (state: LookPackIntakeState) => void;
}) {
  let scope = getScope(), serial = 0, active = true, state = initial(), selected: LookPackFile | null = null;
  const emit = (patch: Partial<LookPackIntakeState>): void => { state = { ...state, ...patch }; if (active) onChange(state); };
  const sync = (): void => { if (scope !== getScope()) { scope = getScope(); serial++; selected = null; state = initial(); } };
  const owns = (ticket: number): boolean => { sync(); return active && ticket === serial; };
  return {
    getState: (): LookPackIntakeState => state,
    activate(): void { active = true; sync(); },
    refresh(): void { sync(); emit({}); },
    async preview(file: LookPackFile): Promise<boolean> {
      sync(); if (!active || isBlocked() || state.phase === 'adopting') return false;
      const ticket = ++serial; selected = null; emit({ ...initial(), phase: 'reading' });
      try {
        if (!/\.mioon-look\.cube$/iu.test(file.name) || file.name.length > 200) throw new TimelineUiError(message('colour.pack.fileName'));
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > LUT_RESOURCE_LIMITS.sourceBytes) throw new TimelineUiError(message('colour.pack.fileSize'));
        const name = file.name, size = file.size, read = new Uint8Array(await file.arrayBuffer());
        if (!owns(ticket) || isBlocked()) return false;
        if (read.byteLength !== size) throw new TimelineUiError(message('colour.pack.fileChanged'));
        const bytes = read.slice(); // Own the input before asynchronous digest work.
        const inspection = await parseLookPackBytes(bytes);
        if (!owns(ticket) || isBlocked()) return false;
        // Do not retain the caller's mutable File-like object's read function.
        const snapshot = bytes.slice();
        selected = { name, size, arrayBuffer: async () => snapshot.slice().buffer };
        emit({ phase: 'ready', name, inspection, acknowledged: false, error: '' }); return true;
      } catch (error) {
        if (owns(ticket)) emit({ phase: 'error', inspection: null, acknowledged: false, ...timelineFailure('error', error, message('colour.pack.invalid')) });
        return false;
      } finally {
        if (owns(ticket) && state.phase === 'reading') emit({ phase: 'idle', inspection: null, acknowledged: false });
      }
    },
    acknowledge(value: boolean): void { sync(); if (active && !isBlocked() && state.phase === 'ready') emit({ acknowledged: value }); },
    async adopt(): Promise<boolean> {
      sync(); if (!active || isBlocked() || state.phase !== 'ready' || !state.acknowledged || !selected) return false;
      const ticket = serial, file = selected; emit({ phase: 'adopting', error: '' });
      try {
        const success = await adopt(file);
        if (!owns(ticket)) return false;
        // An unknown outcome belongs to the existing original-request recovery
        // controls. Drop this adoption action instead of minting another key.
        selected = null;
        emit({ phase: success ? 'adopted' : 'error', acknowledged: false, error: success ? '' : '本次采用尚未确认。请查看下方 LUT 导入状态；结果未知时只恢复原请求，不重新采用。', errorMessage: success ? undefined : message('colour.pack.unknown') });
        return success;
      } catch (error) {
        if (owns(ticket)) { selected = null; emit({ phase: 'error', acknowledged: false, ...timelineFailure('error', error, message('colour.pack.adoptUnconfirmed')) }); }
        return false;
      }
    },
    cancel(): boolean {
      sync(); if (!active || state.phase === 'adopting') return false;
      serial++; selected = null; emit(initial()); return true;
    },
    dispose(): void { active = false; serial++; selected = null; state = initial(); },
  };
}
