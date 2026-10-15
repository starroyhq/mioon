/** Text catalogs are presentation data only, never business payloads. */
export type Locale = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja';
export type LanguagePreference = Locale | 'system';
export type MessageTemplate = string | Readonly<{ one: string; other: string }>;
export type MessageTranslations = Readonly<Record<Locale, MessageTemplate>>;
export type MessageCatalog = Readonly<Record<string, MessageTranslations>>;
export type MessageParameter = string | number;
export type MessageParameters = Readonly<Record<string, MessageParameter>>;
export interface DisplayMessage { readonly key: string; readonly params?: MessageParameters }
