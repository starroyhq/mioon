import {z} from 'zod';

export const uiPreferencesSchema=z.object({
  theme:z.enum(['dark','light','system']),scalePercent:z.number().int().min(90).max(125),
  density:z.enum(['standard','compact']),timecodeFormat:z.enum(['timecode','seconds']),
  reduceMotion:z.boolean(),homeSort:z.enum(['recent','updated','name']),homeView:z.enum(['grid','list']),
}).strict();
export type UiPreferences=z.infer<typeof uiPreferencesSchema>;
export const DEFAULT_UI_PREFERENCES:Readonly<UiPreferences>=Object.freeze({
  theme:'dark',scalePercent:100,density:'standard',timecodeFormat:'timecode',reduceMotion:false,homeSort:'recent',homeView:'grid',
});
export const UI_PREFERENCES_LIMITS=Object.freeze({fileBytes:1024*1024,recentProjects:8192});
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uiPreferencesProjectIdSchema=z.string().uuid();
export const uiPreferencesOpenedAtSchema=z.string().datetime();
export const uiPreferencesPutSchema=z.object({expectedRevision:revision,requestId:z.string().min(8).max(200),preferences:uiPreferencesSchema}).strict();
export const uiPreferencesResponseSchema=z.object({revision,preferences:uiPreferencesSchema,
  recentOpened:z.record(z.string().uuid(),z.string().datetime()).refine(value=>Object.keys(value).length<=UI_PREFERENCES_LIMITS.recentProjects),
  recoveredDefaults:z.boolean(),writable:z.boolean(),
}).strict();
export type UiPreferencesPut=z.infer<typeof uiPreferencesPutSchema>;
export type UiPreferencesResponse=z.infer<typeof uiPreferencesResponseSchema>;
export const uiPreferencesDiskSchema=z.object({version:z.literal(1),workspaceScope:z.string().regex(/^[a-f0-9]{64}$/u),revision,
  preferences:z.unknown(),recentOpened:z.unknown().optional(),
  lastWrite:z.object({requestId:z.string().min(8).max(200),digest:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().optional(),
}).strict();

/** Old or invalid stored values fall back independently; writes stay strict. */
export function normalizeUiPreferences(value:unknown):UiPreferences{
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const result={...DEFAULT_UI_PREFERENCES};
  for(const key of Object.keys(uiPreferencesSchema.shape) as (keyof UiPreferences)[]){
    const parsed=uiPreferencesSchema.shape[key].safeParse(source[key]);
    if(parsed.success)Object.assign(result,{[key]:parsed.data});
  }
  return result;
}
