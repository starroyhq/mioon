import type { BrowserWindow } from 'electron';
import { installNativeCloseAdmission } from '../../apps/desktop/src/native-close.ts';
import type { NativeCloseInspection } from '../../apps/desktop/src/native-close.ts';

function desktopConsumer(window: BrowserWindow): void {
  const close = installNativeCloseAdmission(window, { isCurrent: () => true, confirmDiscard: () => false,
    confirmClose: async () => false, onBlocked: reason => { const fixed: 'blocked' | 'unavailable' | 'changed' = reason; void fixed; }, onCancel() {}, requestQuit: () => true });
  close.dispose();
  // @ts-expect-error A close decision cannot be a truthy string.
  installNativeCloseAdmission(window, { isCurrent: () => true, confirmDiscard: () => 'yes', confirmClose: () => false, onBlocked() {}, onCancel() {}, requestQuit: () => true });
  const summary: NativeCloseInspection = { version: 1, token: 'opaque', disposition: 'dirty' };
  // @ts-expect-error This protocol has no business-execution disposition.
  const unsafe: NativeCloseInspection = { ...summary, disposition: 'approve' };
  // @ts-expect-error It carries no prompt or credential payload.
  const payload: NativeCloseInspection = { ...summary, prompt: 'private' };
  void unsafe; void payload;
}
void desktopConsumer;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
export type InspectionIsChecked = Assert<IsAny<NativeCloseInspection> extends false ? true : false>;
