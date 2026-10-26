import type {createLocalDrafts} from '../../packages/business/src/local-drafts.ts';

export interface LegacySchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): {success: true; data: unknown} | {success: false; error: unknown};
}
export interface LegacyDraftContracts {
  clipDraftRawSchema: LegacySchema;
  clipDraftDiskSchema: LegacySchema;
}
// The frozen v1 reader has the same public methods and storage/guard options.
// Keep its implementation outside the current Zod compiler graph.
export interface LegacyDraftReader {createLocalDrafts: typeof createLocalDrafts}

export type ElementTree = ElementNode | string | number | boolean | null | undefined | ElementTree[];
export interface ElementNode {
  type: unknown;
  props: ElementProps;
}
export interface ElementProps {
  [key: string]: unknown;
  children: ElementTree[];
  'data-testid'?: string;
  'aria-label'?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  value?: unknown;
  title?: string;
  style?: Record<string, string | number | undefined>;
  render?: ElementNode;
  canRelease(): boolean;
  onOpenChange(...args: unknown[]): unknown;
  onClick(...args: unknown[]): unknown;
  onPage(...args:unknown[]):unknown;
  onReplay(...args:unknown[]):unknown;
  onCheckedChange(...args:unknown[]):unknown;
  onChange(...args: unknown[]): unknown;
  onValueChange(...args: unknown[]): unknown;
  onKeyDown(...args: unknown[]): unknown;
  onKeyUp(...args: unknown[]): unknown;
  onSubmit(...args: unknown[]): unknown;
  onInput(...args: unknown[]): unknown;
  onBlur(...args: unknown[]): unknown;
  onDragStart(...args: unknown[]): unknown;
  onPointerDown(...args: unknown[]): unknown;
  onFilter(...args: unknown[]): unknown;
  onFocus(...args: unknown[]): unknown;
  onCompositionStart(...args: unknown[]): unknown;
  onCompositionEnd(...args: unknown[]): unknown;
}
export interface HookSlot {
  current?: unknown;
  value?: unknown;
  deps?: readonly unknown[];
  dependencies?: readonly unknown[];
  kind?: string;
  callback?: () => void | (() => void);
  fn?: () => void | (() => void);
  cleanup?: void | (() => void);
}
export interface ElementModule<Props = Record<string, unknown>> {
  exports: {default: (props: Props) => ElementTree; __esModule?: boolean};
}
