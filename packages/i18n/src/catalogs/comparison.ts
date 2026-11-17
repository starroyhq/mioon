import type { MessageCatalog } from '../types.ts';
export const comparisonMessages = {
  'comparison.help': { 'zh-Hans': '明确选择两个已保存的视频版本，独立检查原始素材。不会生成新内容', 'zh-Hant': '明確選擇兩個已儲存的影片版本，獨立檢查原始素材。不會產生新內容', en: 'Choose two saved video versions to inspect their original media. No new content is generated', ja: '保存済みの動画を2つ選び、元の素材を比較します。新しいコンテンツは生成しません' },
  "comparison.insufficient": {
    "zh-Hans": "可用的本地 MP4 版本不足两个",
    "zh-Hant": "可用的本機 MP4 版本不足兩個",
    "en": "Fewer than two local MP4 versions are available",
    "ja": "利用可能なローカル MP4 バージョンが 2 つ未満です"
  },
  "comparison.chooseBoth": {
    "zh-Hans": "请选择两个不同版本",
    "zh-Hant": "請選擇兩個不同版本",
    "en": "Choose two different versions",
    "ja": "異なる 2 つのバージョンを選択"
  },
  'comparison.choose': { 'zh-Hans': '选择版本', 'zh-Hant': '選擇版本', en: 'Choose a version', ja: 'バージョンを選択' },
  "comparison.unavailable": {
    "zh-Hans": "当前连接或工作区无法进行版本对比",
    "zh-Hant": "目前的連線或工作區無法進行版本比較",
    "en": "Comparison is unavailable in the current connection or workspace",
    "ja": "現在の接続またはワークスペースでは比較できません"
  },
  "comparison.stale": {
    "zh-Hans": "所选版本的来源已无法确认",
    "zh-Hant": "所選版本的來源已無法確認",
    "en": "The source of the selected version can no longer be confirmed",
    "ja": "選択したバージョンのソースを確認できなくなりました"
  },
  'comparison.reset': { 'zh-Hans': '清空对比选择', 'zh-Hant': '清空比較選擇', en: 'Clear comparison choices', ja: '比較の選択をクリア' },
  'comparison.unknown': { 'zh-Hans': '未记录', 'zh-Hant': '未記錄', en: 'Not recorded', ja: '記録なし' },
  'comparison.identity': { 'zh-Hans': '固定版本身份', 'zh-Hant': '固定版本識別資訊', en: 'Fixed version identity', ja: '固定バージョンの識別情報' },
  'comparison.project': { 'zh-Hans': '项目：{id}', 'zh-Hant': '專案：{id}', en: 'Project: {id}', ja: 'プロジェクト: {id}' },
  'comparison.shot': { 'zh-Hans': '镜头：{id}', 'zh-Hant': '鏡頭：{id}', en: 'Shot: {id}', ja: 'ショット: {id}' },
  'comparison.version': { 'zh-Hans': '版本：{id}', 'zh-Hant': '版本：{id}', en: 'Version: {id}', ja: 'バージョン: {id}' },
  'comparison.asset': { 'zh-Hans': '素材：{id}', 'zh-Hant': '素材：{id}', en: 'Asset: {id}', ja: '素材: {id}' },
  'comparison.player': { 'zh-Hans': '{label} 侧，版本 {number}', 'zh-Hant': '{label} 側，版本 {number}', en: 'Side {label}, version {number}', ja: '{label} 側、バージョン {number}' },
  'comparison.hash': { 'zh-Hans': 'SHA-256：{hash}', 'zh-Hant': 'SHA-256：{hash}', en: 'SHA-256: {hash}', ja: 'SHA-256: {hash}' },
  'comparison.hashBoundary': { 'zh-Hans': '此摘要匹配已保存的版本与素材记录；播放时不会重新计算整个文件摘要', 'zh-Hant': '此摘要符合已儲存的版本與素材記錄；播放時不會重新計算整個檔案摘要', en: 'This hash matches saved version and asset records; playback does not rehash the whole file', ja: 'このハッシュは保存済みのバージョンと素材の記録に一致します。再生時にファイル全体を再ハッシュしません' },
  'comparison.mediaError': { 'zh-Hans': "无法播放固定素材", 'zh-Hant': "無法播放固定素材", en: "Pinned media cannot play", ja: "固定素材を再生できません" },
} as const satisfies MessageCatalog;
