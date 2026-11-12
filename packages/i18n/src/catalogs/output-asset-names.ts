import type {MessageCatalog} from '../types.ts';

export const outputAssetNameMessages = {
  'outputAsset.timelinePreview': {'zh-Hans': '多轨时间线-预览-{ratio}', 'zh-Hant': '多軌時間軸-預覽-{ratio}', en: 'Timeline preview · {ratio}', ja: 'タイムラインプレビュー · {ratio}'},
  'outputAsset.timelineExport': {'zh-Hans': '多轨时间线-导出-{ratio}', 'zh-Hant': '多軌時間軸-匯出-{ratio}', en: 'Timeline export · {ratio}', ja: 'タイムライン書き出し · {ratio}'},
  'outputAsset.storyboard': {'zh-Hans': '分镜拼接-{ratio}', 'zh-Hant': '分鏡拼接-{ratio}', en: 'Storyboard export · {ratio}', ja: '絵コンテ書き出し · {ratio}'},
  'outputAsset.mockVideo': {'zh-Hans': '{title} 模拟视频', 'zh-Hant': '{title} 模擬影片', en: '{title} · Mock video', ja: '{title} · 模擬動画'},
  'outputAsset.generatedVideo': {'zh-Hans': '{title} 生成视频', 'zh-Hant': '{title} 生成影片', en: '{title} · Generated video', ja: '{title} · 生成動画'},
  'outputAsset.image': {'zh-Hans': '{title} · 图像 {number}', 'zh-Hant': '{title} · 圖像 {number}', en: '{title} · Image {number}', ja: '{title} · 画像 {number}'},
} as const satisfies MessageCatalog;
