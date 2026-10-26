import type { ClipDraftClient, ClipDraftContext, ClipDraftEnvelope, ClipDraftRecord, ClipDraftState, createClipDraftController } from '../../apps/web/src/clip-draft-state.ts';

export type DraftController = ReturnType<typeof createClipDraftController>;
export type DraftSave = Parameters<DraftController['save']>[0];
export type DraftSaveOptions = Parameters<DraftSave>[3];
export type DraftHooks = { [Key in keyof ClipDraftClient]?: (input: Parameters<ClipDraftClient[Key]>[0], current: ClipDraftEnvelope) => Awaited<ReturnType<ClipDraftClient[Key]>> | ReturnType<ClipDraftClient[Key]> };
export interface DraftHarnessOptions { draft?: ClipDraftRecord | null; ctx?: ClipDraftContext; hooks?: DraftHooks; delay?: number }
export type DraftCall = ['get', Parameters<ClipDraftClient['get']>[0]] | ['put', Parameters<ClipDraftClient['put']>[0]] | ['delete', Parameters<ClipDraftClient['remove']>[0]];
export type { ClipDraftClient, ClipDraftContext, ClipDraftEnvelope, ClipDraftRecord, ClipDraftState };
export interface Gate<T> { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }

export type TestTree = TestNode | string | number | boolean | null | undefined | TestTree[];
export interface TestEvent { currentTarget: {value: string}; target?: {value: string}; preventDefault?(): void }
export interface TestElementProps {
  [key: string]: unknown;
  children: TestTree[];
  'data-testid'?: string;
  id?: string;
  title: string;
  style: Record<string, string | number | undefined>;
  onClick(...arguments_: unknown[]): unknown;
  onChange(...arguments_: unknown[]): unknown;
  onCompositionStart(...arguments_: unknown[]): unknown;
  onCompositionEnd(...arguments_: unknown[]): unknown;
  onCompositionUpdate(...arguments_: unknown[]): unknown;
  onKeyDown(...arguments_: unknown[]): unknown;
  onKeyDownCapture(...arguments_: unknown[]): unknown;
  onKeyUpCapture(...arguments_: unknown[]): unknown;
  onPointerDownCapture(...arguments_: unknown[]): unknown;
  onSubmit(...arguments_: unknown[]): unknown;
  onCompositionChange(...arguments_: unknown[]): unknown;
  onEdit(...arguments_: unknown[]): unknown;
}
export interface TestNode { type: unknown; props: TestElementProps }
export type TestComponent<Props = Record<string, unknown>> = (props: Props) => TestTree;
export interface TestModule<Props = Record<string, unknown>> { exports: { default: TestComponent<Props> } }
export interface HookCell { current?: unknown; value?: unknown; deps?: readonly unknown[]; callback?: () => void | (() => void); cleanup?: void | (() => void) }
