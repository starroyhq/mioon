import { nativeMessages } from '../../../packages/i18n/src/catalogs/native.ts';
import type { Locale, MessageParameters, MessageTemplate } from '../../../packages/i18n/src/types.ts';
let locale: () => Locale = () => 'zh-Hans';
/** Only the main-process owner installs this reader. No window can provide code. */
export function setNativeLanguageReader(reader: () => Locale): void { locale = reader; }
type NativeKey = keyof typeof nativeMessages;
type Placeholders<T extends string> = T extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
type Parameters<K extends NativeKey> = { readonly [P in Placeholders<(typeof nativeMessages)[K]['zh-Hans']>]: string | number };
type Arguments<K extends NativeKey> = keyof Parameters<K> extends never ? [params?: never] : [params: Parameters<K>];
export function nativeText<K extends NativeKey>(key: K, ...args: Arguments<K>): string {
  const params: MessageParameters = args[0] ?? {};
  const entry = nativeMessages[key] as Readonly<Record<Locale, MessageTemplate>>;
  const value = entry[locale()];
  if (typeof value !== 'string') throw new Error('Native messages must be plain templates.');
  return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(params, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !['string', 'number'].includes(typeof descriptor.value) || typeof descriptor.value === 'number' && !Number.isFinite(descriptor.value)) throw new Error('Invalid native message parameter.');
    return String(descriptor.value);
  });
}
