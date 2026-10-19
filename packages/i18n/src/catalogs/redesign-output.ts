import type {MessageCatalog} from '../types.ts';
export const redesignOutputMessages={
  'timeline.format.preset.portrait_1080':{'zh-Hans':'竖屏 9:16','zh-Hant':'直向 9:16',en:'Portrait 9:16',ja:'縦 9:16'},
  'timeline.format.preset.landscape_1080':{'zh-Hans':'横屏 16:9','zh-Hant':'橫向 16:9',en:'Landscape 16:9',ja:'横 16:9'},
  'timeline.format.preset.square_1080':{'zh-Hans':'方屏 1:1','zh-Hant':'方形 1:1',en:'Square 1:1',ja:'正方形 1:1'},
  'export.settings.short720':{'zh-Hans':'短边 720 · 保持比例','zh-Hant':'短邊 720 · 保持比例',en:'720 short edge · Preserve ratio',ja:'短辺 720 · 縦横比を維持'},
} as const satisfies MessageCatalog;
