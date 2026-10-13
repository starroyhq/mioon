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

import { createProjectWindowHost } from '../../apps/desktop/src/project-window-host.ts';
import { createProjectWindowBridge } from '../../apps/desktop/src/project-window-preload.ts';
import type { IpcMainInvokeEvent } from 'electron';
function windowsConsumer(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  const host = createProjectWindowHost({backendId:'11111111-1111-4111-8111-111111111111',launcherUrl:'http://127.0.0.1:5000/',
    editorUrl: projectId => `http://127.0.0.1:5000/?project=${projectId}`,isCurrent:()=>true,canInteract:()=>true,createWindow:()=>window});
  host.dispatch(event,{action:'describe'});
  // @ts-expect-error Window actions cannot carry arbitrary URL navigation.
  host.showSettings('https://evil.invalid');
  const bridge = createProjectWindowBridge({invoke:async()=>null,on(){},removeListener(){}});
  // @ts-expect-error The fixed renderer bridge has no file-reading permission.
  bridge.readFile('/tmp/private');
}
void windowsConsumer;
