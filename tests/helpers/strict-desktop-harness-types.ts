import type {EventEmitter} from 'node:events';
import type {BackendSupervisor} from '../../apps/desktop/src/supervisor.ts';
import type {createDesktopStartup} from '../../apps/desktop/src/startup.ts';
import type {createDesktopWindowAppearance} from '../../apps/desktop/src/window-appearance.ts';

// Named OS-boundary views for the in-memory main-process harnesses. They expose
// only fields the synthetic app/session/window constructors actually provide.
export interface DesktopHarnessMessage {type: string; [key: string]: unknown}
export interface DesktopHarnessChild<M = DesktopHarnessMessage> extends EventEmitter {
  pid: number; messages: M[]; kills: number; hardKills: number;
  ready(): void; postMessage(message: DesktopHarnessMessage): void; kill(): unknown;
}
export interface DesktopHarnessSettings {closes: number; close(): Promise<void>}
export type DesktopHarnessBackend<M = DesktopHarnessMessage> = BackendSupervisor & {
  child: DesktopHarnessChild<M> | null; agentSettings: DesktopHarnessSettings | null;
};
export interface DesktopHarnessConnection {url: string; token: string; pid: number; tokenFile?: string}
export interface DesktopHarnessDialog {title: string; detail?: string; message?: string; buttons?: string[]; [key: string]: unknown}
export interface DesktopHarnessMenu {
  id?: string; label?: string; role?: string; type?: string; enabled?: boolean; checked?: boolean;
  accelerator?: string; click?(): unknown; submenu?: DesktopHarnessMenuList;
}
export interface DesktopHarnessMenuList extends Array<DesktopHarnessMenu> {
  getMenuItemById(id: string): DesktopHarnessMenu | null;
}
export interface DesktopHarnessFrame {
  url: string;
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>;
}
export interface DesktopHarnessContents extends EventEmitter {
  mainFrame: DesktopHarnessFrame; send(...values: unknown[]): void; getURL(): string;
  loadURL(url: string): Promise<void>; executeJavaScript(script: string): Promise<unknown>;
}
export interface DesktopHarnessSession extends EventEmitter {
  clears: number; clearFinished: boolean; cookieStarted: boolean; cookieReady: boolean;
  cookie: {value: string; [key: string]: unknown};
  cookies: {set(cookie: {value: string; [key: string]: unknown}): Promise<void>};
  clearStorageData(): Promise<void>;
  permissionRequest(...values: unknown[]): unknown; permissionCheck(...values: unknown[]): boolean;
  devicePermission(...values: unknown[]): unknown; displayPermission(...values: unknown[]): unknown;
  beforeRequest(request: {url: string; resourceType: string}, callback: (decision: {cancel: boolean}) => void): void;
  beforeSendHeaders(...values: unknown[]): unknown;
}
export interface DesktopHarnessWindowConfig {
  webPreferences: {session: DesktopHarnessSession; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; [key: string]: unknown};
  titleBarStyle?: string; trafficLightPosition?: {x: number; y: number}; [key: string]: unknown;
}
export interface DesktopHarnessWindow extends EventEmitter {
  config: DesktopHarnessWindowConfig; destroyed: boolean; urls: string[]; webContents: DesktopHarnessContents;
  backgroundColor?: string; isDestroyed(): boolean; close(): void; destroy(): void; loadURL(url: string): Promise<void>;
}
export interface DesktopHarnessApp extends EventEmitter {
  isPackaged: boolean; enableSandbox(): void; setName(): void; setAppUserModelId(): void;
  getPath(): string; getAppPath(): string; requestSingleInstanceLock(): boolean;
  quit(): void; exit(code: number): void;
}
export interface DesktopHarnessOptions<W extends DesktopHarnessWindow> {
  child?(index: number): {ready?: boolean; exit?: boolean; media?: boolean; exitCode?: number};
  disposition?(index: number): string; holdClosed?(index: number): boolean;
  focusedWindow?(windows: W[]): unknown;
  flush?(index: number): unknown; drain?(index: number): unknown; validate?(index: number): unknown;
  remove?(count: number): unknown; clear?(index: number): unknown; cookie?(index: number): unknown;
  connection?(index: number): unknown; load?(index: number, count?: number, url?: string): unknown;
  menuFrameExecute?(index: number, perform: () => unknown): unknown;
  dialog?(value: DesktopHarnessDialog, parent: W | null): unknown;
  syncDialog?(window: W, value: DesktopHarnessDialog): number;
  release?(): void; settings?(index: number, value: DesktopHarnessSettings): unknown;
  storage?: Partial<Parameters<typeof createDesktopWindowAppearance>[0]['storage']>;
}
export interface DesktopHarnessRecords<W extends DesktopHarnessWindow, M = DesktopHarnessMessage> {
  scopes: ReturnType<typeof createDesktopStartup>[]; validations: AbortSignal[];
  backends: DesktopHarnessBackend<M>[]; children: DesktopHarnessChild<M>[]; sessions: DesktopHarnessSession[]; windows: W[];
  connections: DesktopHarnessConnection[]; connectionWrites: DesktopHarnessConnection[];
  dialogs: DesktopHarnessDialog[]; dialogParents: (W | null)[]; syncDialogs: {window: W; value: DesktopHarnessDialog}[];
  nativeChecks: W[]; drains: number; removals: number; quits: number; finished: number; exits: number[];
  settingsCloses: number; lutStoreCalls: string[]; settings: DesktopHarnessSettings[]; starts: unknown[];
  diagnosticEvents?: {event: string; [key: string]: unknown}[];
  ipcHandlers?: Map<string, (...values: unknown[]) => unknown>;
  bridge?: (...values: unknown[]) => unknown; audioBridge?: (...values: unknown[]) => unknown;
}
