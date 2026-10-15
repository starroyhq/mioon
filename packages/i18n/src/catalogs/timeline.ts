import type { MessageCatalog } from '../types.ts';
import { assertNoDuplicateMessageKeys } from '../catalog-integrity.ts';
import { timelineDeliveryMessages } from './timeline-delivery.ts';
const timelineCoreMessages = {
  "colour.lut.title": {
    "zh-Hans": "Rec.709 SDR · 创意 LUT",
    "zh-Hant": "Rec.709 SDR · 創意 LUT",
    "en": "Rec.709 SDR · Creative LUT",
    "ja": "Rec.709 SDR · クリエイティブ LUT"
  },
  "colour.lut.renderDisclosure": {
    "zh-Hans": "保存片段后，重新渲染的时间线预览与导出才会应用。源素材快速查看始终是原始、未调色画面。",
    "zh-Hant": "儲存片段後，重新算繪的時間軸預覽與匯出才會套用。來源素材快速查看始終是原始、未調色畫面。",
    "en": "After saving the clip, changes apply only to newly rendered timeline previews and exports. Quick source previews always show the original, ungraded image.",
    "ja": "クリップを保存した後、新たにレンダリングするタイムラインのプレビューと書き出しにのみ適用されます。ソース素材のクイックプレビューは常に未調整の元の映像です。"
  },
  "colour.lut.adoptionWarning": {
    "zh-Hans": "当前保持原有色彩路径，不会自动迁移。明确启用后，整条时间线使用 Rec.709 SDR 流程：所有可见视频都必须逐一确认 Rec.709 解释，图片必须是已检查并明确声明为 sRGB 的受支持 PNG 或基线 JFIF JPEG。HDR / Log、ICC、EXIF（包括旋转信息）、渐进式 JPEG 与技术转换 LUT 不在此范围内。",
    "zh-Hant": "目前保留原有色彩處理方式，不會自動轉換。明確啟用後，整條時間軸使用 Rec.709 SDR 流程：所有可見影片都須逐一確認 Rec.709 解讀；圖片必須是已檢查並明確聲明為 sRGB 的受支援 PNG 或基線 JFIF JPEG。不支援 HDR / Log、ICC、EXIF（包括旋轉資訊）、漸進式 JPEG 或技術轉換 LUT。",
    "en": "The existing color pipeline is preserved without automatic migration. Explicitly enabling this switches the entire timeline to Rec.709 SDR: every visible video must have its Rec.709 interpretation confirmed, and images must be inspected, supported PNG or baseline JFIF JPEG files explicitly declared as sRGB. HDR / Log, ICC, EXIF (including rotation), progressive JPEG, and technical-conversion LUTs are not supported.",
    "ja": "既存の色処理を維持し、自動移行は行いません。明示的に有効にすると、タイムライン全体が Rec.709 SDR 処理になります。表示される各動画の Rec.709 解釈を個別に確認する必要があります。画像は検査済みの対応 PNG またはベースライン JFIF JPEG で、sRGB と明示的に宣言する必要があります。HDR / Log、ICC、EXIF（回転情報を含む）、プログレッシブ JPEG、技術変換 LUT は対象外です。"
  },
  "colour.lut.reconfirmSource": {
    "zh-Hans": "来源已替换，色彩解释已失效。LUT、启用状态与强度保留；请重新检查并确认新来源，否则不能渲染。",
    "zh-Hant": "來源已替換，色彩解讀已失效。LUT、啟用狀態與強度保留；請重新檢查並確認新來源，否則無法算繪。",
    "en": "The source was replaced, invalidating its color interpretation. The LUT, enabled state, and strength are preserved. Inspect and confirm the new source before rendering.",
    "ja": "ソースの差し替えにより、色の解釈が無効になりました。LUT、有効状態、強度は保持されています。レンダリングするには、新しいソースを再検査して確認してください。"
  },
  "colour.lut.sourceImage": {
    "zh-Hans": "已声明：sRGB {format} · {width} × {height} · {alpha}。这是用户解释，文件检查不会自动替你声明。",
    "zh-Hant": "已聲明：sRGB {format} · {width} × {height} · {alpha}。這是使用者的解讀，檔案檢查不會自動代為聲明。",
    "en": "Declared: sRGB {format} · {width} × {height} · {alpha}. This is your interpretation; inspecting the file does not declare it for you.",
    "ja": "宣言済み：sRGB {format} · {width} × {height} · {alpha}。これはユーザーによる解釈です。ファイル検査では自動的に宣言されません。"
  },
  "colour.lut.sourceVideo": {
    "zh-Hans": "已声明：Rec.709 SDR · {range} · 视频流 {stream}。这是用户解释，文件检查不会自动替你声明。",
    "zh-Hant": "已聲明：Rec.709 SDR · {range} · 影片串流 {stream}。這是使用者的解讀，檔案檢查不會自動代為聲明。",
    "en": "Declared: Rec.709 SDR · {range} · Video stream {stream}. This is your interpretation; inspecting the file does not declare it for you.",
    "ja": "宣言済み：Rec.709 SDR · {range} · 動画ストリーム {stream}。これはユーザーによる解釈です。ファイル検査では自動的に宣言されません。"
  },
  "colour.lut.alphaPreserved": {
    "zh-Hans": "透明通道独立保留",
    "zh-Hant": "透明色版獨立保留",
    "en": "Alpha preserved separately",
    "ja": "アルファを個別に保持"
  },
  "colour.lut.opaque": {
    "zh-Hans": "不透明",
    "zh-Hant": "不透明",
    "en": "Opaque",
    "ja": "不透明"
  },
  "colour.lut.imageDisclosure": {
    "zh-Hans": "JPEG 仅支持无 EXIF、无 ICC 的基线 JFIF，标记本身不代表 sRGB。图片按 sRGB 解释，并转换到 Rec.709 / Gamma 2.4 相对参考显示（黑位 0、白位 1），再应用创意 LUT。透明度不参与调色，预乘后以双线性方式缩放。同一时段最多显示 2 个受管理的图片片段（PNG 与 JPEG 合计），可错开放置更多图片。当前合成是 8 位编码 RGB，不是线性光或 HDR；实际预览观感受播放器、系统和显示器设置影响。",
    "zh-Hant": "JPEG 僅支援不含 EXIF、ICC 的基線 JFIF，標記本身不代表 sRGB。圖片按 sRGB 解讀，轉換至 Rec.709 / Gamma 2.4 相對參考顯示（黑位 0、白位 1）後，再套用創意 LUT。透明度不參與調色，預乘後以雙線性方式縮放。同一時段最多顯示 2 個受管理的圖片片段（PNG 與 JPEG 合計），可錯開放置更多圖片。目前合成為 8 位元編碼 RGB，並非線性光或 HDR；實際預覽觀感受播放器、系統與顯示器設定影響。",
    "en": "JPEG support is limited to baseline JFIF without EXIF or ICC; its markers do not establish sRGB. Images are interpreted as sRGB and converted to Rec.709 / Gamma 2.4 relative reference display (black 0, white 1) before applying the creative LUT. Alpha is not color graded; scaling is bilinear after premultiplication. At most 2 managed image clips (PNG and JPEG combined) may be visible at once; more can be placed at different times. Compositing uses 8-bit encoded RGB, not linear light or HDR. Actual preview appearance depends on the player, system, and display settings.",
    "ja": "JPEG は EXIF と ICC を含まないベースライン JFIF のみ対応します。マーカーだけでは sRGB と確認できません。画像を sRGB と解釈し、Rec.709 / Gamma 2.4 の相対参照表示（黒 0、白 1）に変換してからクリエイティブ LUT を適用します。アルファは色調整せず、乗算済みにした後にバイリニアで拡大縮小します。同時に表示できる管理対象画像クリップは PNG と JPEG 合計で 2 個までです。時間をずらせばさらに配置できます。合成は 8 ビット符号化 RGB で、リニアライトや HDR ではありません。実際のプレビューの見え方はプレーヤー、システム、ディスプレイの設定に依存します。"
  },
  "colour.lut.restoredReadOnly": {
    "zh-Hans": "恢复工作区中这里只显示已保存设置，不提供 LUT 导入或修改。",
    "zh-Hant": "還原工作區中僅顯示已儲存設定，不提供 LUT 匯入或修改。",
    "en": "In a restored workspace, only saved settings are shown. LUT import and editing are unavailable.",
    "ja": "復元したワークスペースでは保存済み設定のみを表示します。LUT の読み込みや編集はできません。"
  },
  "colour.lut.inspectAdjust": {
    "zh-Hans": "检查来源与调整 LUT",
    "zh-Hant": "檢查來源與調整 LUT",
    "en": "Inspect source and adjust LUT",
    "ja": "ソースを検査して LUT を調整"
  },
  "colour.lut.inspectEnable": {
    "zh-Hans": "检查并启用 Rec.709 SDR",
    "zh-Hant": "檢查並啟用 Rec.709 SDR",
    "en": "Inspect and enable Rec.709 SDR",
    "ja": "検査して Rec.709 SDR を有効化"
  },
  "colour.lut.sourceLegend": {
    "zh-Hans": "1. 明确源素材解释",
    "zh-Hant": "1. 明確指定來源素材解讀",
    "en": "1. Declare the source interpretation",
    "ja": "1. ソース素材の解釈を宣言"
  },
  "colour.lut.inspecting": {
    "zh-Hans": "正在检查来源…",
    "zh-Hant": "正在檢查來源…",
    "en": "Inspecting source…",
    "ja": "ソースを検査中…"
  },
  "colour.lut.inspectAgain": {
    "zh-Hans": "重新检查当前来源",
    "zh-Hant": "重新檢查目前來源",
    "en": "Inspect current source again",
    "ja": "現在のソースを再検査"
  },
  "colour.lut.untagged": {
    "zh-Hans": "未标记",
    "zh-Hant": "未標記",
    "en": "Untagged",
    "ja": "タグなし"
  },
  "colour.lut.unknown": {
    "zh-Hans": "未知",
    "zh-Hant": "未知",
    "en": "Unknown",
    "ja": "不明"
  },
  "colour.lut.hdrMetadata": {
    "zh-Hans": "含 HDR 元数据",
    "zh-Hant": "含 HDR 中繼資料",
    "en": "Contains HDR metadata",
    "ja": "HDR メタデータあり"
  },
  "colour.lut.noHdrMetadata": {
    "zh-Hans": "无 HDR 元数据",
    "zh-Hant": "無 HDR 中繼資料",
    "en": "No HDR metadata",
    "ja": "HDR メタデータなし"
  },
  "colour.lut.rangeLabel": {
    "zh-Hans": "源素材范围（必须明确选择）",
    "zh-Hant": "來源素材範圍（必須明確選擇）",
    "en": "Source range (explicit selection required)",
    "ja": "ソースのレンジ（明示的な選択が必要）"
  },
  "colour.lut.chooseRange": {
    "zh-Hans": "请选择范围",
    "zh-Hant": "請選擇範圍",
    "en": "Select a range",
    "ja": "レンジを選択"
  },
  "colour.lut.limited": {
    "zh-Hans": "Limited · 视频范围",
    "zh-Hant": "Limited · 影片範圍",
    "en": "Limited · Video range",
    "ja": "Limited · ビデオレンジ"
  },
  "colour.lut.full": {
    "zh-Hans": "Full · 全范围",
    "zh-Hant": "Full · 全範圍",
    "en": "Full · Full range",
    "ja": "Full · フルレンジ"
  },
  "colour.lut.confirmSource": {
    "zh-Hans": "将来源确认写入片段草稿",
    "zh-Hant": "將來源確認寫入片段草稿",
    "en": "Add source confirmation to clip draft",
    "ja": "ソースの確認をクリップの下書きに反映"
  },
  "colour.lut.enableSource": {
    "zh-Hans": "明确启用并写入片段草稿",
    "zh-Hant": "明確啟用並寫入片段草稿",
    "en": "Explicitly enable and add to clip draft",
    "ja": "明示的に有効化してクリップの下書きに反映"
  },
  "colour.lut.lookLegend": {
    "zh-Hans": "2. 选择 Rec.709 → Rec.709 创意外观",
    "zh-Hant": "2. 選擇 Rec.709 → Rec.709 創意外觀",
    "en": "2. Choose a Rec.709 → Rec.709 creative look",
    "ja": "2. Rec.709 → Rec.709 のクリエイティブ Look を選択"
  },
  "colour.lut.importLabel": {
    "zh-Hans": "导入项目 LUT（.cube，最多 7 MiB）",
    "zh-Hant": "匯入專案 LUT（.cube，最多 7 MiB）",
    "en": "Import project LUT (.cube, up to 7 MiB)",
    "ja": "プロジェクトに LUT を読み込み（.cube、最大 7 MiB）"
  },
  "colour.lut.importing": {
    "zh-Hans": "正在读取或导入所选文件…",
    "zh-Hant": "正在讀取或匯入所選檔案…",
    "en": "Reading or importing the selected file…",
    "ja": "選択したファイルを読み取りまたは追加中…"
  },
  "colour.lut.checkingRecovery": {
    "zh-Hans": "正在核对工作区与原请求恢复记录…",
    "zh-Hant": "正在核對工作區與原請求還原記錄…",
    "en": "Checking the workspace and original-request recovery record…",
    "ja": "ワークスペースと元のリクエストの復元記録を確認中…"
  },
  "colour.lut.recheckRecovery": {
    "zh-Hans": "重新检查恢复记录",
    "zh-Hant": "重新檢查還原記錄",
    "en": "Check recovery record again",
    "ja": "復元記録を再確認"
  },
  "colour.lut.reselect": {
    "zh-Hans": "重新选择原 .cube 文件（只核验，不会提交）",
    "zh-Hant": "重新選擇原 .cube 檔案（僅核驗，不會提交）",
    "en": "Reselect the original .cube file (verification only, no submission)",
    "ja": "元の .cube ファイルを再選択（検証のみ、送信しません）"
  },
  "colour.lut.retryOriginal": {
    "zh-Hans": "用核验后的原文件与原编号重试",
    "zh-Hant": "使用核驗後的原檔案與原編號重試",
    "en": "Retry with the verified original file and request ID",
    "ja": "検証済みの元ファイルと元のリクエスト ID で再試行"
  },
  "colour.lut.clearConfirmed": {
    "zh-Hans": "清理已确认请求的恢复记录",
    "zh-Hant": "清理已確認請求的還原記錄",
    "en": "Clear the confirmed request’s recovery record",
    "ja": "結果が確認できたリクエストの復元記録を削除"
  },
  "colour.lut.projectLuts": {
    "zh-Hans": "项目中的 LUT",
    "zh-Hant": "專案中的 LUT",
    "en": "Project LUTs",
    "ja": "プロジェクト内の LUT"
  },
  "colour.lut.chooseLut": {
    "zh-Hans": "请选择 LUT",
    "zh-Hant": "請選擇 LUT",
    "en": "Select a LUT",
    "ja": "LUT を選択"
  },
  "colour.lut.refresh": {
    "zh-Hans": "刷新列表",
    "zh-Hant": "重新整理清單",
    "en": "Refresh list",
    "ja": "一覧を更新"
  },
  "colour.lut.more": {
    "zh-Hans": "加载更多",
    "zh-Hant": "載入更多",
    "en": "Load more",
    "ja": "さらに読み込む"
  },
  "colour.lut.verifyingLut": {
    "zh-Hans": "正在核验所选 LUT…",
    "zh-Hant": "正在核驗所選 LUT…",
    "en": "Verifying the selected LUT…",
    "ja": "選択した LUT を検証中…"
  },
  "colour.lut.verifyingPack": {
    "zh-Hans": "正在核验包声明…",
    "zh-Hant": "正在核驗資料包聲明…",
    "en": "Verifying package declarations…",
    "ja": "パッケージの申告内容を検証中…"
  },
  "colour.lut.inspectPack": {
    "zh-Hans": "查看此项目 LUT 的数据包声明",
    "zh-Hant": "查看此專案 LUT 的資料包聲明",
    "en": "View this project LUT’s package declarations",
    "ja": "このプロジェクト LUT のパッケージ申告内容を表示"
  },
  "colour.lut.notPack": {
    "zh-Hans": "这是普通 Cube 资源，没有单 Look 数据包声明。",
    "zh-Hant": "這是一般 Cube 資源，沒有單一 Look 資料包聲明。",
    "en": "This is a regular Cube resource with no single-Look package declarations.",
    "ja": "これは通常の Cube リソースで、単一 Look パッケージの申告内容はありません。"
  },
  "colour.lut.apply": {
    "zh-Hans": "将所选 LUT 写入片段草稿",
    "zh-Hant": "將所選 LUT 寫入片段草稿",
    "en": "Add selected LUT to clip draft",
    "ja": "選択した LUT をクリップの下書きに反映"
  },
  "colour.lut.enableLut": {
    "zh-Hans": "启用此 LUT",
    "zh-Hant": "啟用此 LUT",
    "en": "Enable this LUT",
    "ja": "この LUT を有効化"
  },
  "colour.lut.remove": {
    "zh-Hans": "从片段移除 LUT（保留项目资源）",
    "zh-Hant": "從片段移除 LUT（保留專案資源）",
    "en": "Remove LUT from clip (keep project resource)",
    "ja": "クリップから LUT を削除（プロジェクトのリソースは保持）"
  },
  "colour.lut.disableColour": {
    "zh-Hans": "此片段返回原有色彩路径",
    "zh-Hant": "此片段返回原有色彩處理方式",
    "en": "Return this clip to its original color pipeline",
    "ja": "このクリップを元の色処理に戻す"
  },
  "colour.lut.videoEvidence": {
    "zh-Hans": "文件标签：原色 {primaries} · 转换 {transfer} · 矩阵 {matrix} · 范围 {range} · 像素 {pixel} · {hdr}",
    "zh-Hant": "檔案標記：原色 {primaries} · 轉換 {transfer} · 矩陣 {matrix} · 範圍 {range} · 像素 {pixel} · {hdr}",
    "en": "File tags: primaries {primaries} · transfer {transfer} · matrix {matrix} · range {range} · pixels {pixel} · {hdr}",
    "ja": "ファイルのタグ：原色 {primaries} · 伝達関数 {transfer} · マトリクス {matrix} · レンジ {range} · ピクセル {pixel} · {hdr}"
  },
  "colour.lut.jpegVerified": {
    "zh-Hans": "已核验 JFIF JPEG 原始字节、完整编码结构与有边界的 RGB24 解码",
    "zh-Hant": "已核驗 JFIF JPEG 原始位元組、完整編碼結構與有限制的 RGB24 解碼",
    "en": "JFIF JPEG original bytes, full encoding structure, and bounded RGB24 decoding verified",
    "ja": "JFIF JPEG の元バイト列、符号化構造全体、制限付き RGB24 デコードを検証済み"
  },
  "colour.lut.pngVerified": {
    "zh-Hans": "已核验 PNG 原始字节与结构",
    "zh-Hant": "已核驗 PNG 原始位元組與結構",
    "en": "PNG original bytes and structure verified",
    "ja": "PNG の元バイト列と構造を検証済み"
  },
  "colour.lut.noAlpha": {
    "zh-Hans": "无透明通道",
    "zh-Hant": "無透明色版",
    "en": "No alpha channel",
    "ja": "アルファチャンネルなし"
  },
  "colour.lut.srgbTag": {
    "zh-Hans": "sRGB 标签",
    "zh-Hant": "sRGB 標記",
    "en": "sRGB tag",
    "ja": "sRGB タグあり"
  },
  "colour.lut.noSrgbTag": {
    "zh-Hans": "没有 sRGB 标签，必须由你明确解释",
    "zh-Hant": "沒有 sRGB 標記，必須由你明確解讀",
    "en": "No sRGB tag; you must explicitly declare the interpretation",
    "ja": "sRGB タグなし。解釈を明示的に宣言する必要があります"
  },
  "colour.lut.imageEvidence": {
    "zh-Hans": "{verification}：{width} × {height} · 8 位 · {alpha} · {tag}。当前上限为 2,073,600 像素、单边 4096、文件 32 MiB。ICC / P3 / HDR、动画、16 位及未支持元数据不会被自动去除。",
    "zh-Hant": "{verification}：{width} × {height} · 8 位元 · {alpha} · {tag}。目前上限為 2,073,600 像素、單邊 4096、檔案 32 MiB。ICC / P3 / HDR、動畫、16 位元及未支援的中繼資料不會被自動移除。",
    "en": "{verification}: {width} × {height} · 8-bit · {alpha} · {tag}. Limits: 2,073,600 pixels, 4096 per edge, 32 MiB per file. ICC / P3 / HDR, animation, 16-bit data, and unsupported metadata will not be removed automatically.",
    "ja": "{verification}：{width} × {height} · 8 ビット · {alpha} · {tag}。上限は 2,073,600 ピクセル、各辺 4096、ファイル 32 MiB です。ICC / P3 / HDR、アニメーション、16 ビット、非対応のメタデータを自動で除去することはありません。"
  },
  "colour.lut.declareImage": {
    "zh-Hans": "我确认这张图片按 sRGB 解释；没有标签也不是自动推断，不把 ICC / P3 / HDR 当作 sRGB。",
    "zh-Hant": "我確認這張圖片按 sRGB 解讀；沒有標記也不會自動推斷，不將 ICC / P3 / HDR 當作 sRGB。",
    "en": "I confirm that this image should be interpreted as sRGB. An absent tag is not an automatic inference; ICC / P3 / HDR must not be treated as sRGB.",
    "ja": "この画像を sRGB と解釈することを確認します。タグがなくても自動推定ではありません。ICC / P3 / HDR を sRGB として扱いません。"
  },
  "colour.lut.declareVideo": {
    "zh-Hans": "我确认此来源是 Rec.709 SDR，并确认以上范围；不把 HDR / Log 作为 SDR 解释。",
    "zh-Hant": "我確認此來源為 Rec.709 SDR，並確認以上範圍；不將 HDR / Log 解讀為 SDR。",
    "en": "I confirm that this source is Rec.709 SDR with the range selected above. HDR / Log must not be interpreted as SDR.",
    "ja": "このソースが Rec.709 SDR で、上記のレンジであることを確認します。HDR / Log を SDR として解釈しません。"
  },
  "colour.lut.creativeOnly": {
    "zh-Hans": "资源格式验证不代表色彩适用性。只使用输入、输出均为 Rec.709 SDR 的创意 LUT，不使用 Log 转换或 HDR 色调映射 LUT。",
    "zh-Hant": "資源格式驗證不代表色彩適用性。僅使用輸入與輸出皆為 Rec.709 SDR 的創意 LUT，不使用 Log 轉換或 HDR 色調映射 LUT。",
    "en": "Validating the resource format does not establish color suitability. Use only creative LUTs with Rec.709 SDR input and output, not LUTs for Log conversion or HDR tone mapping.",
    "ja": "リソース形式の検証は、色の扱いが適切であることを保証するものではありません。入出力ともに Rec.709 SDR のクリエイティブ LUT のみを使用してください。Log 変換や HDR トーンマッピング用の LUT は使用しないでください。"
  },
  "colour.lut.domainDisclosure": {
    "zh-Hans": "创意 LUT 会将归一化 RGB 中小于 0 或大于 1 的值裁到 0–1 范围，不适合保留 HDR / Log 高光细节。关闭 LUT 或设为 0% 只绕过创意外观，已启用的 Rec.709 SDR 转换仍会执行。",
    "zh-Hant": "創意 LUT 會將正規化 RGB 中小於 0 或大於 1 的值裁至 0–1 範圍，不適合保留 HDR / Log 高光細節。關閉 LUT 或設為 0% 僅略過創意外觀，已啟用的 Rec.709 SDR 轉換仍會執行。",
    "en": "The creative LUT clips normalized RGB values below 0 or above 1 to the 0–1 range, so it is unsuitable for preserving HDR / Log highlight detail. Disabling the LUT or setting it to 0% bypasses only the creative look; enabled Rec.709 SDR conversion still runs.",
    "ja": "クリエイティブ LUT は正規化 RGB の 0 未満または 1 超の値を 0–1 にクリップするため、HDR / Log のハイライトの詳細を保持する用途には適しません。LUT の無効化や 0% 設定で省略されるのはクリエイティブ Look のみです。有効になっている Rec.709 SDR 変換は引き続き実行されます。"
  },
  "colour.lut.imported": {
    "zh-Hans": "资源“{name}”已导入项目，尚未应用或保存到片段。请在下方选择、声明用途并保存片段。",
    "zh-Hant": "資源「{name}」已匯入專案，尚未套用或儲存至片段。請在下方選擇、聲明用途並儲存片段。",
    "en": "“{name}” was imported into the project but has not been applied or saved to the clip. Select it below, declare its purpose, and save the clip.",
    "ja": "「{name}」をプロジェクトに追加しました。まだクリップへの適用や保存はされていません。下で選択し、用途を宣言してクリップを保存してください。"
  },
  "colour.lut.importRejected": {
    "zh-Hans": "文件未导入。",
    "zh-Hant": "檔案未匯入。",
    "en": "The file was not imported.",
    "ja": "ファイルは追加されませんでした。"
  },
  "colour.lut.recoveryDisclosure": {
    "zh-Hans": "导入前会在当前站点的浏览器存储中保存原请求编号、文件名、大小、SHA-256 与项目/工作区标识，不保存 LUT 文件内容或路径。在同一站点地址关闭重开后，可重新选择同一文件，再明确重试原请求；不会自动导入或应用。清除浏览器数据或更换站点地址会丢失这条恢复记录。桌面应用完全退出后本地地址可能变化，暂不能保证跨应用重启找回。",
    "zh-Hant": "匯入前會在目前網站的瀏覽器儲存空間中保存原請求編號、檔名、大小、SHA-256 與專案／工作區識別碼，不保存 LUT 檔案內容或路徑。在同一網站位址關閉重開後，可重新選擇同一檔案，再明確重試原請求；不會自動匯入或套用。清除瀏覽器資料或更換網站位址會遺失這筆還原記錄。桌面應用程式完全結束後，本機位址可能改變，目前無法保證重新啟動後找回。",
    "en": "Before import, browser storage for this site saves the original request ID, filename, size, SHA-256, and project/workspace IDs, but not LUT contents or paths. After reopening at the same site address, reselect the same file and explicitly retry the original request; nothing is imported or applied automatically. Clearing browser data or changing the site address loses this recovery record. The local address may change after fully quitting the desktop app, so recovery across app restarts is not guaranteed.",
    "ja": "読み込み前に、このサイトのブラウザーストレージへ元のリクエスト ID、ファイル名、サイズ、SHA-256、プロジェクト／ワークスペース ID を保存します。LUT の内容やパスは保存しません。同じサイトのアドレスで開き直した後、同じファイルを再選択し、元のリクエストを明示的に再試行できます。自動で追加や適用はしません。ブラウザーのデータを消去したりサイトのアドレスを変更したりすると、この復元記録は失われます。デスクトップアプリを完全に終了するとローカルアドレスが変わる場合があり、アプリ再起動後の復元は保証できません。"
  },
  "colour.lut.pendingOriginal": {
    "zh-Hans": "原导入请求待核对：{name} · {bytes} 字节。不会创建新编号；先恢复这一条请求，再导入其他文件。",
    "zh-Hant": "原匯入請求待核對：{name} · {bytes} 位元組。不會建立新編號；先還原這筆請求，再匯入其他檔案。",
    "en": "Original import request awaiting verification: {name} · {bytes} bytes. No new ID will be created. Recover this request before importing other files.",
    "ja": "元の読み込みリクエストの確認待ち：{name} · {bytes} バイト。新しい ID は作成しません。他のファイルを追加する前に、このリクエストを復元してください。"
  },
  "colour.lut.declareLook": {
    "zh-Hans": "我确认所选 LUT 是 Rec.709 SDR → Rec.709 SDR 创意外观，不是技术转换。",
    "zh-Hant": "我確認所選 LUT 為 Rec.709 SDR → Rec.709 SDR 創意外觀，並非技術轉換。",
    "en": "I confirm that the selected LUT is a Rec.709 SDR → Rec.709 SDR creative look, not a technical conversion.",
    "ja": "選択した LUT は Rec.709 SDR → Rec.709 SDR のクリエイティブ Look であり、技術変換ではないことを確認します。"
  },
  "colour.lut.bound": {
    "zh-Hans": "当前片段外观：{name}",
    "zh-Hant": "目前片段外觀：{name}",
    "en": "Current clip look: {name}",
    "ja": "現在のクリップの Look：{name}"
  },
  "colour.lut.strength": {
    "zh-Hans": "LUT 强度 · {percent}%",
    "zh-Hant": "LUT 強度 · {percent}%",
    "en": "LUT strength · {percent}%",
    "ja": "LUT 強度 · {percent}%"
  },
  "colour.lut.strengthHint": {
    "zh-Hans": "0% 为无创意外观，100% 为完整 LUT；关闭 LUT 不会取消已确认的 SDR 来源流程。",
    "zh-Hant": "0% 為無創意外觀，100% 為完整 LUT；關閉 LUT 不會取消已確認的 SDR 來源流程。",
    "en": "0% means no creative look; 100% applies the full LUT. Disabling the LUT does not cancel the confirmed SDR source pipeline.",
    "ja": "0% はクリエイティブ Look なし、100% は LUT を完全適用します。LUT を無効にしても、確認済みの SDR ソース処理は無効になりません。"
  },
  "colour.lut.saveReminder": {
    "zh-Hans": "所有片段设置仍是草稿。使用下方“保存片段”提交；保存后的调整可通过时间线撤销恢复。若其他片段仍启用 SDR，返回原有路径的可见片段会阻止整条时间线渲染。",
    "zh-Hant": "所有片段設定仍為草稿。使用下方「儲存片段」提交；儲存後的調整可透過時間軸復原。如果其他片段仍啟用 SDR，返回原有處理方式的可見片段會阻止整條時間軸算繪。",
    "en": "All clip settings are still drafts. Submit them with “Save clip” below; saved adjustments can be undone through timeline history. If other clips still use SDR, a visible clip returned to its original pipeline will block rendering of the entire timeline.",
    "ja": "すべてのクリップ設定はまだ下書きです。下の「クリップを保存」で送信してください。保存後の調整はタイムラインの取り消しで戻せます。他のクリップで SDR が有効なままの場合、元の色処理に戻した可視クリップがあると、タイムライン全体をレンダリングできません。"
  },
  "colour.error.inspectFirst": {
    "zh-Hans": "请先检查当前来源。",
    "zh-Hant": "請先檢查目前來源。",
    "en": "Inspect the current source first.",
    "ja": "まず現在のソースを検査してください。"
  },
  "colour.error.invalidImageEvidence": {
    "zh-Hans": "图片证据无效，请重新检查。",
    "zh-Hant": "圖片證據無效，請重新檢查。",
    "en": "Image evidence is invalid. Inspect it again.",
    "ja": "画像の検証情報が無効です。再検査してください。"
  },
  "colour.error.unsupportedSource": {
    "zh-Hans": "此来源不支持当前 Rec.709 SDR 流程；HDR / Log、冲突标签、RGB / alpha 与不受支持的像素格式不能通过声明覆盖。",
    "zh-Hant": "此來源不支援目前的 Rec.709 SDR 流程；HDR / Log、衝突標記、RGB / alpha 與不支援的像素格式，均無法透過聲明覆寫。",
    "en": "This source does not support the current Rec.709 SDR pipeline. Declarations cannot override HDR / Log, conflicting tags, RGB / alpha, or unsupported pixel formats.",
    "ja": "このソースは現在の Rec.709 SDR 処理に対応していません。HDR / Log、矛盾するタグ、RGB / alpha、非対応のピクセル形式を宣言で上書きすることはできません。"
  },
  "colour.error.conflictingTags": {
    "zh-Hans": "来源存在 HDR、Log 或非 Rec.709 标签，不能用手动声明覆盖。",
    "zh-Hant": "來源含有 HDR、Log 或非 Rec.709 標記，無法以手動聲明覆寫。",
    "en": "The source has HDR, Log, or non-Rec.709 tags. A manual declaration cannot override them.",
    "ja": "ソースに HDR、Log、または Rec.709 以外のタグがあります。手動宣言では上書きできません。"
  },
  "colour.error.unsupportedRange": {
    "zh-Hans": "来源范围标签不受支持。",
    "zh-Hant": "來源範圍標記不受支援。",
    "en": "The source range tag is unsupported.",
    "ja": "ソースのレンジタグは対応していません。"
  },
  "colour.error.rangeRequired": {
    "zh-Hans": "请明确选择源素材的 Limited 或 Full 范围。",
    "zh-Hant": "請明確選擇來源素材的 Limited 或 Full 範圍。",
    "en": "Explicitly select Limited or Full range for the source.",
    "ja": "ソースの Limited または Full レンジを明示的に選択してください。"
  },
  "colour.error.rangeConflict": {
    "zh-Hans": "所选范围与来源已知标签冲突，不能覆盖。",
    "zh-Hant": "所選範圍與來源已知標記衝突，無法覆寫。",
    "en": "The selected range conflicts with known source tags and cannot override them.",
    "ja": "選択したレンジは既知のソースタグと矛盾するため、上書きできません。"
  },
  "colour.error.fileName": {
    "zh-Hans": "请选择名称不超过 200 字符的 .cube 文件。",
    "zh-Hant": "請選擇檔名不超過 200 字元的 .cube 檔案。",
    "en": "Select a .cube file with a filename of at most 200 characters.",
    "ja": "ファイル名が 200 文字以内の .cube ファイルを選択してください。"
  },
  "colour.error.fileSize": {
    "zh-Hans": "仅支持非空且不超过 7 MiB 的 .cube 文件；不会自动改写或缩小原文件。",
    "zh-Hant": "僅支援非空且不超過 7 MiB 的 .cube 檔案；不會自動改寫或縮小原檔案。",
    "en": "Only nonempty .cube files up to 7 MiB are supported. The original file will not be rewritten or reduced automatically.",
    "ja": "空ではない 7 MiB 以下の .cube ファイルのみ対応します。元のファイルを自動で書き換えたり縮小したりしません。"
  },
  "colour.error.fileChanged": {
    "zh-Hans": "读取的文件大小已变化，请重新选择文件。",
    "zh-Hant": "讀取的檔案大小已變更，請重新選擇檔案。",
    "en": "The size of the file read has changed. Select the file again.",
    "ja": "読み取ったファイルのサイズが変わりました。ファイルを再選択してください。"
  },
  "colour.error.requestUnconfirmed": {
    "zh-Hans": "请求尚未确认，请重试原请求。",
    "zh-Hant": "請求尚未確認，請重試原請求。",
    "en": "The request is not yet confirmed. Retry only the original request.",
    "ja": "リクエストの結果はまだ確認できていません。元のリクエストのみを再試行してください。"
  },
  "colour.error.ownerChanged": {
    "zh-Hans": "项目或片段已变化，未提交导入。",
    "zh-Hant": "專案或片段已變更，未提交匯入。",
    "en": "The project or clip changed. Import was not submitted.",
    "ja": "プロジェクトまたはクリップが変わったため、読み込みリクエストは送信していません。"
  },
  "colour.error.workspaceUnverified": {
    "zh-Hans": "无法核对当前工作区身份，已阻止导入。",
    "zh-Hant": "無法核對目前工作區識別資訊，已阻止匯入。",
    "en": "The current workspace identity could not be verified. Import is blocked.",
    "ja": "現在のワークスペースの識別情報を確認できないため、読み込みをブロックしました。"
  },
  "colour.error.workspaceChanged": {
    "zh-Hans": "工作区身份已变化，已阻止导入。请重新打开项目核对，原恢复记录不会转移。",
    "zh-Hant": "工作區識別資訊已變更，已阻止匯入。請重新開啟專案核對，原還原記錄不會轉移。",
    "en": "The workspace identity changed. Import is blocked. Reopen the project to verify it; the original recovery record will not be transferred.",
    "ja": "ワークスペースの識別情報が変わったため、読み込みをブロックしました。プロジェクトを開き直して確認してください。元の復元記録は移動しません。"
  },
  "colour.error.recordRetained": {
    "zh-Hans": "原请求记录已保留，但当前不可提交；请恢复连接后核对原请求。",
    "zh-Hant": "原請求記錄已保留，但目前無法提交；請恢復連線後核對原請求。",
    "en": "The original request record is retained, but submission is unavailable. Reconnect and verify the original request.",
    "ja": "元のリクエスト記録は保持されていますが、現在は送信できません。再接続後に元のリクエストを確認してください。"
  },
  "colour.error.recordSaveFailed": {
    "zh-Hans": "无法保存原请求恢复记录，未提交导入。",
    "zh-Hant": "無法儲存原請求還原記錄，未提交匯入。",
    "en": "The original-request recovery record could not be saved. Import was not submitted.",
    "ja": "元のリクエストの復元記録を保存できなかったため、読み込みリクエストは送信していません。"
  },
  "colour.error.replyMismatch": {
    "zh-Hans": "导入回复与原请求不一致，结果仍待确认。",
    "zh-Hant": "匯入回覆與原請求不符，結果仍待確認。",
    "en": "The import response does not match the original request. The outcome remains unconfirmed.",
    "ja": "読み込みの応答が元のリクエストと一致しません。結果は引き続き未確認です。"
  },
  "colour.error.fingerprintMismatch": {
    "zh-Hans": "导入回复与原文件指纹不一致，结果仍待确认。",
    "zh-Hant": "匯入回覆與原檔案指紋不符，結果仍待確認。",
    "en": "The import response does not match the original file fingerprint. The outcome remains unconfirmed.",
    "ja": "読み込みの応答が元のファイルのフィンガープリントと一致しません。結果は引き続き未確認です。"
  },
  "colour.error.importUnconfirmed": {
    "zh-Hans": "导入结果尚未确认，请仅重试原请求。",
    "zh-Hant": "匯入結果尚未確認，請僅重試原請求。",
    "en": "The import outcome is unconfirmed. Retry only the original request.",
    "ja": "読み込みの結果は未確認です。元のリクエストのみを再試行してください。"
  },
  "colour.error.cleanupFailed": {
    "zh-Hans": "原请求已确认，但恢复记录尚未安全清除。",
    "zh-Hant": "原請求已確認，但還原記錄尚未安全清除。",
    "en": "The original request is confirmed, but its recovery record has not been safely cleared.",
    "ja": "元のリクエストの結果は確認できましたが、復元記録はまだ安全に削除されていません。"
  },
  "colour.error.recoveryChanged": {
    "zh-Hans": "LUT 恢复记录已变化，已停止导入；请核对原请求。",
    "zh-Hant": "LUT 還原記錄已變更，已停止匯入；請核對原請求。",
    "en": "The LUT recovery record changed. Import is stopped; verify the original request.",
    "ja": "LUT の復元記録が変わったため、読み込みを停止しました。元のリクエストを確認してください。"
  },
  "colour.error.recoveryCheckFailed": {
    "zh-Hans": "无法核对导入恢复记录。",
    "zh-Hant": "無法核對匯入還原記錄。",
    "en": "The import recovery record could not be verified.",
    "ja": "読み込みの復元記録を確認できませんでした。"
  },
  "colour.error.confirmedCleanupFailed": {
    "zh-Hans": "已确认请求的恢复记录尚未安全清除。",
    "zh-Hant": "已確認請求的還原記錄尚未安全清除。",
    "en": "The confirmed request’s recovery record has not been safely cleared.",
    "ja": "結果を確認済みのリクエストの復元記録は、まだ安全に削除されていません。"
  },
  "colour.error.sourceReplyMismatch": {
    "zh-Hans": "来源检查回复与当前素材或文件指纹不一致。",
    "zh-Hant": "來源檢查回覆與目前素材或檔案指紋不符。",
    "en": "The source inspection response does not match the current asset or file fingerprint.",
    "ja": "ソース検査の応答が現在の素材またはファイルのフィンガープリントと一致しません。"
  },
  "colour.error.sourceCheckFailed": {
    "zh-Hans": "来源检查失败。",
    "zh-Hant": "來源檢查失敗。",
    "en": "Source inspection failed.",
    "ja": "ソースの検査に失敗しました。"
  },
  "colour.error.listMismatch": {
    "zh-Hans": "LUT 列表回复与当前项目不一致。",
    "zh-Hant": "LUT 清單回覆與目前專案不符。",
    "en": "The LUT list response does not match the current project.",
    "ja": "LUT 一覧の応答が現在のプロジェクトと一致しません。"
  },
  "colour.error.listFailed": {
    "zh-Hans": "LUT 列表读取失败。",
    "zh-Hant": "LUT 清單讀取失敗。",
    "en": "The LUT list could not be read.",
    "ja": "LUT 一覧を読み取れませんでした。"
  },
  "colour.error.resourceMismatch": {
    "zh-Hans": "LUT 核验回复与当前选择不一致。",
    "zh-Hant": "LUT 核驗回覆與目前選擇不符。",
    "en": "The LUT verification response does not match the current selection.",
    "ja": "LUT 検証の応答が現在の選択と一致しません。"
  },
  "colour.error.resourceChanged": {
    "zh-Hans": "LUT 指纹已变化，请重新读取列表。",
    "zh-Hant": "LUT 指紋已變更，請重新讀取清單。",
    "en": "The LUT fingerprint changed. Read the list again.",
    "ja": "LUT のフィンガープリントが変わりました。一覧を読み直してください。"
  },
  "colour.error.resourceFailed": {
    "zh-Hans": "LUT 核验失败。",
    "zh-Hant": "LUT 核驗失敗。",
    "en": "LUT verification failed.",
    "ja": "LUT の検証に失敗しました。"
  },
  "colour.error.packMismatch": {
    "zh-Hans": "数据包检查回复与所选项目资源不一致。",
    "zh-Hant": "資料包檢查回覆與所選專案資源不符。",
    "en": "The package inspection response does not match the selected project resource.",
    "ja": "パッケージ検査の応答が選択したプロジェクトのリソースと一致しません。"
  },
  "colour.error.packChanged": {
    "zh-Hans": "数据包资源指纹已变化，请重新读取列表。",
    "zh-Hant": "資料包資源指紋已變更，請重新讀取清單。",
    "en": "The package resource fingerprint changed. Read the list again.",
    "ja": "パッケージのリソースのフィンガープリントが変わりました。一覧を読み直してください。"
  },
  "colour.error.packFailed": {
    "zh-Hans": "无法核验所选资源的数据包声明。",
    "zh-Hant": "無法核驗所選資源的資料包聲明。",
    "en": "The selected resource’s package declarations could not be verified.",
    "ja": "選択したリソースのパッケージ申告内容を検証できませんでした。"
  },
  "colour.error.pendingImport": {
    "zh-Hans": "已有导入请求待确认，请重新选择原文件恢复原请求。",
    "zh-Hant": "已有匯入請求待確認，請重新選擇原檔案以還原原請求。",
    "en": "An import request is already awaiting confirmation. Reselect the original file to recover the original request.",
    "ja": "確認待ちの読み込みリクエストがあります。元のファイルを再選択して元のリクエストを復元してください。"
  },
  "colour.error.usePackPreview": {
    "zh-Hans": "这是单 Look 数据包，请使用“预览单 Look 数据包”入口查看声明后明确采用。",
    "zh-Hant": "這是單一 Look 資料包，請使用「預覽單一 Look 資料包」入口查看聲明後明確採用。",
    "en": "This is a single-Look package. Use “Preview single-Look package” to review its declarations and explicitly adopt it.",
    "ja": "これは単一 Look パッケージです。「単一 Look パッケージをプレビュー」で申告内容を確認してから、明示的に追加してください。"
  },
  "colour.error.fileReadFailed": {
    "zh-Hans": "文件读取失败。",
    "zh-Hant": "檔案讀取失敗。",
    "en": "The file could not be read.",
    "ja": "ファイルを読み取れませんでした。"
  },
  "colour.error.reselectExact": {
    "zh-Hans": "必须重新选择原文件：文件名与字节数必须完全一致，不会更换原请求编号。",
    "zh-Hant": "必須重新選擇原檔案：檔名與位元組數須完全一致，不會更換原請求編號。",
    "en": "Reselect the original file: its filename and byte count must match exactly. The original request ID will not change.",
    "ja": "元のファイルを再選択してください。ファイル名とバイト数は完全に一致する必要があります。元のリクエスト ID は変更しません。"
  },
  "colour.error.reselectHashMismatch": {
    "zh-Hans": "文件 SHA-256 与原文件不一致，未恢复或提交原请求。",
    "zh-Hant": "檔案 SHA-256 與原檔案不符，未還原或提交原請求。",
    "en": "The file’s SHA-256 does not match the original. The original request was not restored or submitted.",
    "ja": "ファイルの SHA-256 が元のファイルと一致しません。元のリクエストの復元や送信はしていません。"
  },
  "colour.error.reselectFailed": {
    "zh-Hans": "原文件核验失败，未提交导入。",
    "zh-Hant": "原檔案核驗失敗，未提交匯入。",
    "en": "Original-file verification failed. Import was not submitted.",
    "ja": "元のファイルの検証に失敗したため、読み込みリクエストは送信していません。"
  },
  "colour.recovery.unavailable": {
    "zh-Hans": "无法安全读写浏览器的 LUT 恢复记录，已阻止导入。请允许此站点的本地存储后重新检查；不要清除待确认记录。",
    "zh-Hant": "無法安全讀寫瀏覽器的 LUT 還原記錄，已阻止匯入。請允許此網站使用本機儲存空間後重新檢查；不要清除待確認記錄。",
    "en": "The browser’s LUT recovery record cannot be accessed safely. Import is blocked. Allow local storage for this site and check again; do not clear records awaiting confirmation.",
    "ja": "ブラウザーの LUT 復元記録を安全に読み書きできないため、読み込みをブロックしました。このサイトのローカルストレージを許可してから再確認してください。確認待ちの記録は削除しないでください。"
  },
  "colour.recovery.conflict": {
    "zh-Hans": "LUT 恢复记录已变化或存在另一条待确认请求。请重新检查并恢复原请求，不会覆盖记录。",
    "zh-Hant": "LUT 還原記錄已變更，或另有待確認的請求。請重新檢查並還原原請求，不會覆寫記錄。",
    "en": "The LUT recovery record changed or another request is awaiting confirmation. Check again and recover the original request; records will not be overwritten.",
    "ja": "LUT 復元記録が変わったか、別の確認待ちリクエストがあります。再確認して元のリクエストを復元してください。記録は上書きしません。"
  },
  "colour.recovery.corrupt": {
    "zh-Hans": "LUT 恢复记录损坏、重复或超出限制，已停止导入且保留原记录；请勿清除记录后重复导入。",
    "zh-Hant": "LUT 還原記錄損毀、重複或超出限制，已停止匯入並保留原記錄；請勿清除記錄後重複匯入。",
    "en": "The LUT recovery record is corrupt, duplicated, or over its limit. Import is stopped and the original record is retained. Do not clear it and import again.",
    "ja": "LUT 復元記録が破損、重複、または上限超過しています。読み込みを停止し、元の記録を保持しています。記録を消して再度読み込まないでください。"
  },
  "colour.error.originalDiagnostic": {
    "zh-Hans": "原始诊断",
    "zh-Hant": "原始診斷",
    "en": "Original diagnostic",
    "ja": "元の診断情報"
  },
  "colour.pack.title": {
    "zh-Hans": "单 Look 数据包",
    "zh-Hant": "單一 Look 資料包",
    "en": "Single-Look package",
    "ja": "単一 Look パッケージ"
  },
  "colour.pack.previewLabel": {
    "zh-Hans": "预览单 Look 数据包（.mioon-look.cube，最多 7 MiB）",
    "zh-Hant": "預覽單一 Look 資料包（.mioon-look.cube，最多 7 MiB）",
    "en": "Preview single-Look package (.mioon-look.cube, up to 7 MiB)",
    "ja": "単一 Look パッケージをプレビュー（.mioon-look.cube、最大 7 MiB）"
  },
  "colour.pack.previewDisclosure": {
    "zh-Hans": "按需选取一个 Look，不安装预设库。预览只读取所选文件，不导入、不应用、不访问声明来源。普通 .cube 仍可用下方入口。",
    "zh-Hant": "按需選取一個 Look，不安裝預設庫。預覽僅讀取所選檔案，不會匯入、套用或存取聲明的來源。一般 .cube 仍可使用下方入口。",
    "en": "Choose one Look as needed without installing a preset library. Preview only reads the selected file; it does not import or apply it, or access its declared source. Regular .cube files can still use the input below.",
    "ja": "プリセットライブラリをインストールせず、必要な Look を 1 つ選択します。プレビューでは選択したファイルを読み取るだけです。プロジェクトへの追加、適用、記載された提供元へのアクセスは行いません。通常の .cube は下の入力欄から引き続き読み込めます。"
  },
  "colour.pack.claims": {
    "zh-Hans": "已校验包结构和字节完整性；作者、来源、许可与色彩适用性是包内声明，未经 Mioon 认证。请自行确认有权使用。没有脚本、模型或运行时需要安装。",
    "zh-Hant": "已驗證資料包結構與位元組完整性；作者、來源、許可與色彩適用性均為包內聲明，未經 Mioon 認證。請自行確認有權使用。不需要安裝腳本、模型或執行環境。",
    "en": "Package structure and byte integrity are verified. Author, source, license, and color suitability are package declarations, not certified by Mioon. Confirm your right to use it. No scripts, models, or runtimes need to be installed.",
    "ja": "パッケージの構造とバイト列の完全性を検証済みです。作者、提供元、ライセンス、色の適合性はパッケージ内の申告であり、Mioon が認証したものではありません。使用する権利をご自身で確認してください。スクリプト、モデル、ランタイムのインストールは不要です。"
  },
  "colour.pack.checking": {
    "zh-Hans": "正在校验数据包和 Cube 正文…",
    "zh-Hant": "正在驗證資料包與 Cube 本文…",
    "en": "Validating package and Cube data…",
    "ja": "パッケージと Cube データを検証中…"
  },
  "colour.pack.acknowledge": {
    "zh-Hans": "我已查看声明许可，并确认有权将这个 Look 复制到当前项目。",
    "zh-Hant": "我已查看聲明的許可，並確認有權將此 Look 複製到目前專案。",
    "en": "I have reviewed the declared license and confirm my right to copy this Look into the current project.",
    "ja": "申告されたライセンスを確認し、この Look を現在のプロジェクトへコピーする権利があることを確認します。"
  },
  "colour.pack.adopt": {
    "zh-Hans": "采用到项目 LUT（不自动应用）",
    "zh-Hant": "採用為專案 LUT（不會自動套用）",
    "en": "Add to project LUTs (do not apply automatically)",
    "ja": "プロジェクトの LUT に追加（自動適用なし）"
  },
  "colour.pack.adopting": {
    "zh-Hans": "正在采用到当前项目，请等待原请求结果…",
    "zh-Hant": "正在採用至目前專案，請等待原請求結果…",
    "en": "Adding to the current project. Wait for the original request’s result…",
    "ja": "現在のプロジェクトに追加中です。元のリクエストの結果をお待ちください…"
  },
  "colour.pack.adopted": {
    "zh-Hans": "已按原字节采用。源数据包移走后，项目仍保有 Look 与包内声明。请在项目 LUT 列表选择，再声明用途并保存片段。",
    "zh-Hant": "已依原始位元組採用。來源資料包移走後，專案仍保留 Look 與包內聲明。請在專案 LUT 清單選擇，再聲明用途並儲存片段。",
    "en": "Added using the original bytes. The project retains the Look and its declarations even if the source package is moved. Select it in the project LUT list, declare its purpose, and save the clip.",
    "ja": "元のバイト列のまま追加しました。元のパッケージを移動しても、プロジェクトには Look と申告内容が保持されます。プロジェクトの LUT 一覧で選択し、用途を宣言してクリップを保存してください。"
  },
  "colour.pack.cancelPreview": {
    "zh-Hans": "取消预览",
    "zh-Hant": "取消預覽",
    "en": "Cancel preview",
    "ja": "プレビューをキャンセル"
  },
  "colour.pack.closePreview": {
    "zh-Hans": "关闭包预览",
    "zh-Hant": "關閉資料包預覽",
    "en": "Close package preview",
    "ja": "パッケージのプレビューを閉じる"
  },
  "colour.pack.storageDisclosure": {
    "zh-Hans": "整份文件与来源/许可声明随项目 LUT 保存并参与现有备份。采用不会接受新的服务协议，也不会证明第三方拥有授权；不支持批量目录、安装器或可执行插件。",
    "zh-Hant": "完整檔案與來源／許可聲明會隨專案 LUT 儲存並納入既有備份。採用不會接受新的服務協議，也不代表第三方擁有授權；不支援批次目錄、安裝程式或可執行外掛。",
    "en": "The entire file and its source/license declarations are saved with the project LUT and included in existing backups. Adding it does not accept new service agreements or establish third-party authorization. Bulk directories, installers, and executable plugins are unsupported.",
    "ja": "ファイル全体と提供元／ライセンスの申告内容は、プロジェクトの LUT とともに保存され、既存のバックアップに含まれます。追加によって新しいサービス規約に同意することはなく、第三者が許諾を持つ証明にもなりません。ディレクトリの一括読み込み、インストーラー、実行可能プラグインには対応していません。"
  },
  "colour.pack.fileName": {
    "zh-Hans": "请选择名称不超过 200 字符的 .mioon-look.cube 单 Look 数据包。",
    "zh-Hant": "請選擇檔名不超過 200 字元的 .mioon-look.cube 單一 Look 資料包。",
    "en": "Select a .mioon-look.cube single-Look package with a filename of at most 200 characters.",
    "ja": "ファイル名が 200 文字以内の .mioon-look.cube 単一 Look パッケージを選択してください。"
  },
  "colour.pack.fileSize": {
    "zh-Hans": "单 Look 数据包必须非空且不超过 7 MiB。",
    "zh-Hant": "單一 Look 資料包必須非空且不超過 7 MiB。",
    "en": "A single-Look package must be nonempty and no larger than 7 MiB.",
    "ja": "単一 Look パッケージは空ではなく、7 MiB 以下である必要があります。"
  },
  "colour.pack.fileChanged": {
    "zh-Hans": "文件读取大小已变化，未采用。请重新选择。",
    "zh-Hant": "讀取的檔案大小已變更，未採用。請重新選擇。",
    "en": "The file size changed during reading. It was not added. Select it again.",
    "ja": "読み取り中にファイルサイズが変わりました。追加していません。再選択してください。"
  },
  "colour.pack.invalid": {
    "zh-Hans": "数据包未通过校验，未采用。",
    "zh-Hant": "資料包未通過驗證，未採用。",
    "en": "Package validation failed. It was not added.",
    "ja": "パッケージの検証に失敗しました。追加していません。"
  },
  "colour.pack.unknown": {
    "zh-Hans": "本次采用尚未确认。请查看下方 LUT 导入状态；结果未知时只恢复原请求，不重新采用。",
    "zh-Hant": "本次採用尚未確認。請查看下方 LUT 匯入狀態；結果未知時僅還原原請求，不要重新採用。",
    "en": "This addition is not yet confirmed. Check the LUT import status below. If the outcome is unknown, recover only the original request; do not add it again.",
    "ja": "追加の結果はまだ確認できていません。下の LUT 読み込み状況を確認してください。結果が不明な場合は元のリクエストのみを復元し、再度追加しないでください。"
  },
  "colour.pack.adoptUnconfirmed": {
    "zh-Hans": "采用结果尚未确认，请核对原 LUT 导入请求。",
    "zh-Hant": "採用結果尚未確認，請核對原 LUT 匯入請求。",
    "en": "The addition outcome is unconfirmed. Verify the original LUT import request.",
    "ja": "追加の結果は未確認です。元の LUT 読み込みリクエストを確認してください。"
  },
  "colour.pack.identity": {
    "zh-Hans": "包 ID：{id} · 声明发布者：{publisher}（{publisherId}）",
    "zh-Hant": "資料包 ID：{id} · 聲明發布者：{publisher}（{publisherId}）",
    "en": "Package ID: {id} · Declared publisher: {publisher} ({publisherId})",
    "ja": "パッケージ ID：{id} · 申告された発行者：{publisher}（{publisherId}）"
  },
  "colour.pack.content": {
    "zh-Hans": "1 个创意 Look · Rec.709 SDR → Rec.709 SDR · Cube 正文：{bytes} 字节 · SHA-256：",
    "zh-Hant": "1 個創意 Look · Rec.709 SDR → Rec.709 SDR · Cube 本文：{bytes} 位元組 · SHA-256：",
    "en": "1 creative Look · Rec.709 SDR → Rec.709 SDR · Cube data: {bytes} bytes · SHA-256:",
    "ja": "クリエイティブ Look 1 個 · Rec.709 SDR → Rec.709 SDR · Cube データ：{bytes} バイト · SHA-256："
  },
  "colour.pack.source": {
    "zh-Hans": "声明来源（仅文字，不自动访问）：{url}",
    "zh-Hant": "聲明來源（僅文字，不會自動存取）：{url}",
    "en": "Declared source (text only, not accessed automatically): {url}",
    "ja": "申告された提供元（テキストのみ、自動アクセスなし）：{url}"
  },
  "colour.pack.license": {
    "zh-Hans": "声明许可：{license}",
    "zh-Hant": "聲明許可：{license}",
    "en": "Declared license: {license}",
    "ja": "申告されたライセンス：{license}"
  },
  "audio.clip.gain": {
    "zh-Hans": "音量增益（0–2）",
    "zh-Hant": "音量增益（0–2）",
    "en": "Volume gain (0–2)",
    "ja": "音量ゲイン（0–2）"
  },
  "audio.clip.fades": {
    "zh-Hans": "音频淡入/淡出（帧）",
    "zh-Hant": "音訊淡入／淡出（影格）",
    "en": "Audio fade in/out (frames)",
    "ja": "音声のフェードイン／アウト（フレーム）"
  },
  "audio.clip.fadeIn": {
    "zh-Hans": "淡入（帧）",
    "zh-Hant": "淡入（影格）",
    "en": "Fade in (frames)",
    "ja": "フェードイン（フレーム）"
  },
  "audio.clip.fadeOut": {
    "zh-Hans": "淡出（帧）",
    "zh-Hant": "淡出（影格）",
    "en": "Fade out (frames)",
    "ja": "フェードアウト（フレーム）"
  },
  "audio.clip.effect": {
    "zh-Hans": "淡入/淡出在重新渲染时间线预览与导出时生效；源素材快速查看播放原始声音。",
    "zh-Hant": "淡入／淡出在重新算繪時間軸預覽與匯出時生效；來源素材快速查看播放原始聲音。",
    "en": "Fades apply to newly rendered timeline previews and exports. Quick source previews play the original audio.",
    "ja": "フェードは新たにレンダリングするタイムラインのプレビューと書き出しに適用されます。ソース素材のクイックプレビューでは元の音声を再生します。"
  },
  "audio.clip.noAudio": {
    "zh-Hans": "此素材不含音轨，音频淡入/淡出不会产生效果。",
    "zh-Hant": "此素材不含音軌，音訊淡入／淡出不會產生效果。",
    "en": "This asset has no audio track, so audio fades have no effect.",
    "ja": "この素材には音声トラックがないため、音声のフェードは効果がありません。"
  },
  "audio.clip.unverifiedAudio": {
    "zh-Hans": "尚未确认此素材含音轨，无法启用音频淡入/淡出。",
    "zh-Hant": "尚未確認此素材含有音軌，無法啟用音訊淡入／淡出。",
    "en": "An audio track has not been confirmed for this asset, so audio fades cannot be enabled.",
    "ja": "この素材の音声トラックが確認できていないため、音声のフェードを有効にできません。"
  },
  "audio.clip.integerFrames": {
    "zh-Hans": "淡入与淡出帧数必须为大于或等于 0 的整数。",
    "zh-Hant": "淡入與淡出影格數必須為大於或等於 0 的整數。",
    "en": "Fade-in and fade-out lengths must be integers of 0 frames or greater.",
    "ja": "フェードインとフェードアウトの長さは 0 以上の整数フレームで指定してください。"
  },
  "audio.clip.durationFirst": {
    "zh-Hans": "请先将片段持续帧数设为 1–18000 的整数。",
    "zh-Hant": "請先將片段持續影格數設為 1–18000 的整數。",
    "en": "First set the clip duration to an integer from 1 to 18000 frames.",
    "ja": "まずクリップの長さを 1–18000 の整数フレームに設定してください。"
  },
  "audio.clip.requiresAudio": {
    "zh-Hans": "只有已确认含音轨的视频或音频素材可以设置非零音频淡入/淡出。",
    "zh-Hant": "只有已確認含音軌的影片或音訊素材，才可設定非零音訊淡入／淡出。",
    "en": "Nonzero audio fades are available only for video or audio assets with a confirmed audio track.",
    "ja": "0 以外の音声フェードを設定できるのは、音声トラックを確認済みの動画または音声素材のみです。"
  },
  "audio.clip.bounds": {
    "zh-Hans": "30 帧 = 1 秒 · 每项 0–{maximum} 帧，两项合计不得超过片段时长。0 表示关闭。",
    "zh-Hant": "30 影格 = 1 秒 · 每項 0–{maximum} 影格，兩項合計不得超過片段時長。0 表示關閉。",
    "en": "30 frames = 1 second · Each fade is 0–{maximum} frames; their combined length must not exceed the clip duration. 0 disables the fade.",
    "ja": "30 フレーム = 1 秒 · 各フェードは 0–{maximum} フレームで、合計はクリップの長さを超えられません。0 で無効になります。"
  },
  "audio.clip.totalTooLong": {
    "zh-Hans": "淡入与淡出合计不能超过片段时长（{duration} 帧）。缩短片段后，请同时检查并调整两项。",
    "zh-Hant": "淡入與淡出合計不可超過片段時長（{duration} 影格）。縮短片段後，請同時檢查並調整兩項。",
    "en": "The combined fades must not exceed the clip duration ({duration} frames). After shortening the clip, check and adjust both fades.",
    "ja": "フェードの合計はクリップの長さ（{duration} フレーム）を超えられません。クリップを短くした場合は、両方のフェードを確認して調整してください。"
  },
  "timeline.view.region": {
    "zh-Hans": "04 多轨时间线",
    "zh-Hant": "04 多軌時間軸",
    "en": "04 Multitrack timeline",
    "ja": "04 マルチトラックタイムライン"
  },
  "timeline.view.title": {
    "zh-Hans": "多轨时间线",
    "zh-Hant": "多軌時間軸",
    "en": "Multitrack timeline",
    "ja": "マルチトラックタイムライン"
  },
  "timeline.view.unsaved": {
    "zh-Hans": "尚未保存时间线",
    "zh-Hant": "尚未儲存時間軸",
    "en": "Timeline not saved yet",
    "ja": "タイムラインは未保存です"
  },
  "timeline.view.rendering": {
    "zh-Hans": "正在渲染…",
    "zh-Hant": "正在算繪…",
    "en": "Rendering…",
    "ja": "レンダリング中…"
  },
  "timeline.view.renderPreview": {
    "zh-Hans": "渲染预览",
    "zh-Hant": "算繪預覽",
    "en": "Render preview",
    "ja": "プレビューをレンダリング"
  },
  "timeline.view.expand": {
    "zh-Hans": "展开多轨时间线",
    "zh-Hant": "展開多軌時間軸",
    "en": "Expand multitrack timeline",
    "ja": "マルチトラックタイムラインを展開"
  },
  "timeline.view.collapse": {
    "zh-Hans": "收起多轨时间线",
    "zh-Hant": "收合多軌時間軸",
    "en": "Collapse multitrack timeline",
    "ja": "マルチトラックタイムラインを折りたたむ"
  },
  "timeline.view.playhead": {
    "zh-Hans": "播放头",
    "zh-Hant": "播放頭",
    "en": "Playhead",
    "ja": "再生ヘッド"
  },
  "timeline.view.playheadFrame": {
    "zh-Hans": "时间线播放头帧",
    "zh-Hant": "時間軸播放頭影格",
    "en": "Timeline playhead frame",
    "ja": "タイムラインの再生ヘッドのフレーム"
  },
  "timeline.view.frames": {
    "zh-Hans": "帧",
    "zh-Hant": "影格",
    "en": "frames",
    "ja": "フレーム"
  },
  "timeline.view.snapOn": {
    "zh-Hans": "吸附开",
    "zh-Hant": "吸附開",
    "en": "Snapping on",
    "ja": "スナップ：オン"
  },
  "timeline.view.snapOff": {
    "zh-Hans": "吸附关",
    "zh-Hant": "吸附關",
    "en": "Snapping off",
    "ja": "スナップ：オフ"
  },
  "timeline.view.snapHint": {
    "zh-Hans": "吸附到片段边界、播放头与起点（8px）；按住 Alt 临时关闭。本项目自动保存。",
    "zh-Hant": "吸附至片段邊界、播放頭與起點（8px）；按住 Alt 暫時關閉。此專案會自動儲存。",
    "en": "Snap to clip edges, playhead, and start (8px). Hold Alt to disable temporarily. Saved automatically for this project.",
    "ja": "クリップの端、再生ヘッド、開始位置にスナップします（8px）。Alt を押している間は無効になります。このプロジェクトに自動保存されます。"
  },
  "timeline.view.videoTrack": {
    "zh-Hans": "画面轨",
    "zh-Hant": "畫面軌",
    "en": "Video track",
    "ja": "映像トラック"
  },
  "timeline.view.audioTrack": {
    "zh-Hans": "音频轨",
    "zh-Hant": "音訊軌",
    "en": "Audio track",
    "ja": "音声トラック"
  },
  "timeline.view.seedHint": {
    "zh-Hans": "将每个镜头的当前选用版本冻结复制到空时间线",
    "zh-Hant": "將每個鏡頭目前選用的版本固定複製到空時間軸",
    "en": "Copy each shot’s currently selected version into the empty timeline as a fixed source",
    "ja": "各ショットの現在選択されているバージョンを、固定ソースとして空のタイムラインにコピー"
  },
  "timeline.view.seed": {
    "zh-Hans": "从分镜建立时间线",
    "zh-Hant": "從分鏡建立時間軸",
    "en": "Build timeline from storyboard",
    "ja": "ストーリーボードからタイムラインを作成"
  },
  "timeline.view.zoom": {
    "zh-Hans": "时间线缩放",
    "zh-Hant": "時間軸縮放",
    "en": "Timeline zoom",
    "ja": "タイムラインのズーム"
  },
  "timeline.view.track": {
    "zh-Hans": "轨道",
    "zh-Hant": "軌道",
    "en": "Track",
    "ja": "トラック"
  },
  "timeline.view.stacking": {
    "zh-Hans": "上层覆盖下层",
    "zh-Hant": "上層覆蓋下層",
    "en": "Upper tracks cover lower tracks",
    "ja": "上のトラックが下のトラックに重なります"
  },
  "timeline.view.ruler": {
    "zh-Hans": "时间标尺",
    "zh-Hant": "時間尺規",
    "en": "Time ruler",
    "ja": "タイムルーラー"
  },
  "timeline.view.pictureOnly": {
    "zh-Hans": "仅控制画面，不影响音轨",
    "zh-Hant": "僅控制畫面，不影響音軌",
    "en": "Controls picture only, not audio",
    "ja": "映像のみを制御し、音声には影響しません"
  },
  "timeline.view.hidden": {
    "zh-Hans": "隐藏中",
    "zh-Hant": "隱藏中",
    "en": "Hidden",
    "ja": "非表示"
  },
  "timeline.view.pictureOn": {
    "zh-Hans": "画面开",
    "zh-Hant": "畫面開",
    "en": "Video on",
    "ja": "映像オン"
  },
  "timeline.view.allTrackSound": {
    "zh-Hans": "控制本轨全部声音（包括视频内嵌声音）",
    "zh-Hant": "控制本軌全部聲音（包括影片內嵌聲音）",
    "en": "Controls all sound on this track, including embedded video audio",
    "ja": "動画内の音声を含め、このトラックのすべての音声を制御"
  },
  "timeline.view.muted": {
    "zh-Hans": "静音中",
    "zh-Hant": "靜音中",
    "en": "Muted",
    "ja": "ミュート中"
  },
  "timeline.view.soundOn": {
    "zh-Hans": "声音开",
    "zh-Hant": "聲音開",
    "en": "Audio on",
    "ja": "音声オン"
  },
  "timeline.view.mediaClip": {
    "zh-Hans": "媒体片段",
    "zh-Hant": "媒體片段",
    "en": "Media clip",
    "ja": "メディアクリップ"
  },
  "timeline.view.dropAudio": {
    "zh-Hans": "拖入音频 · 混音",
    "zh-Hant": "拖入音訊 · 混音",
    "en": "Drop audio · Mix",
    "ja": "音声をドロップ · ミックス"
  },
  "timeline.view.dropVisual": {
    "zh-Hans": "拖入图片或视频 · 叠加画面",
    "zh-Hant": "拖入圖片或影片 · 疊加畫面",
    "en": "Drop images or video · Layer visuals",
    "ja": "画像や動画をドロップ · 映像を重ねる"
  },
  "timeline.view.empty": {
    "zh-Hans": "创建或打开项目后，开始编排画面与声音。",
    "zh-Hant": "建立或開啟專案後，即可開始編排畫面與聲音。",
    "en": "Create or open a project to arrange visuals and sound.",
    "ja": "プロジェクトを作成または開いて、映像と音声を配置しましょう。"
  },
  "timeline.view.positionUnchanged": {
    "zh-Hans": "位置未改变",
    "zh-Hant": "位置未變更",
    "en": "Position unchanged",
    "ja": "位置の変更なし"
  },
  "timeline.view.releaseToDrop": {
    "zh-Hans": "松开放置",
    "zh-Hant": "放開以放置",
    "en": "Release to place",
    "ja": "離して配置"
  },
  "timeline.view.cannotDrop": {
    "zh-Hans": "不能放置",
    "zh-Hant": "無法放置",
    "en": "Cannot place",
    "ja": "配置できません"
  },
  "timeline.view.altNoSnap": {
    "zh-Hans": "Alt：暂不吸附",
    "zh-Hant": "Alt：暫不吸附",
    "en": "Alt: snapping paused",
    "ja": "Alt：スナップを一時停止"
  },
  "timeline.view.outsideSnap": {
    "zh-Hans": "吸附范围外",
    "zh-Hant": "吸附範圍外",
    "en": "Outside snapping range",
    "ja": "スナップ範囲外"
  },
  "timeline.view.snapDisabled": {
    "zh-Hans": "吸附已关闭",
    "zh-Hant": "吸附已關閉",
    "en": "Snapping disabled",
    "ja": "スナップ無効"
  },
  "timeline.view.dragHint": {
    "zh-Hans": "拖动片段可跨兼容轨道移动 · Alt 临时关闭吸附 · 同轨不允许重叠",
    "zh-Hant": "拖曳片段可在相容軌道之間移動 · Alt 暫時關閉吸附 · 同軌不可重疊",
    "en": "Drag clips between compatible tracks · Alt temporarily disables snapping · No overlaps on the same track",
    "ja": "クリップを互換トラック間でドラッグ移動 · Alt でスナップを一時停止 · 同じトラック上の重なりは不可"
  },
  "timeline.view.clipCount": {
    "zh-Hans": {
      "one": "{duration} · {count} 个片段",
      "other": "{duration} · {count} 个片段"
    },
    "zh-Hant": {
      "one": "{duration} · {count} 個片段",
      "other": "{duration} · {count} 個片段"
    },
    "en": {
      "one": "{duration} · {count} clip",
      "other": "{duration} · {count} clips"
    },
    "ja": {
      "one": "{duration} · {count} クリップ",
      "other": "{duration} · {count} クリップ"
    }
  },
  "timeline.view.showTrack": {
    "zh-Hans": "显示 {name}",
    "zh-Hant": "顯示 {name}",
    "en": "Show {name}",
    "ja": "{name} を表示"
  },
  "timeline.view.muteTrack": {
    "zh-Hans": "静音 {name}",
    "zh-Hant": "靜音 {name}",
    "en": "Mute {name}",
    "ja": "{name} をミュート"
  },
  "timeline.view.dropArea": {
    "zh-Hans": "{name}放置区域",
    "zh-Hant": "{name} 放置區域",
    "en": "Drop area for {name}",
    "ja": "{name} のドロップ領域"
  },
  "timeline.view.clipTooltip": {
    "zh-Hans": "{name} · {start}–{end} 帧；拖动移动，点击编辑{stale}",
    "zh-Hant": "{name} · {start}–{end} 影格；拖曳移動，點按編輯{stale}",
    "en": "{name} · Frames {start}–{end}. Drag to move; click to edit.{stale}",
    "ja": "{name} · {start}–{end} フレーム。ドラッグで移動、クリックで編集。{stale}"
  },
  "timeline.view.clipAria": {
    "zh-Hans": "时间线片段 {name}{stale}",
    "zh-Hant": "時間軸片段 {name}{stale}",
    "en": "Timeline clip {name}{stale}",
    "ja": "タイムラインクリップ {name}{stale}"
  },
  "timeline.view.newVersion": {
    "zh-Hans": "，镜头已选用新版本",
    "zh-Hant": "，鏡頭已選用新版本",
    "en": ", the shot now uses a newer version",
    "ja": "、ショットは新しいバージョンを選択済み"
  },
  "timeline.view.clipDuration": {
    "zh-Hans": "{frames} 帧 · {seconds}s",
    "zh-Hant": "{frames} 影格 · {seconds}s",
    "en": "{frames} frames · {seconds}s",
    "ja": "{frames} フレーム · {seconds}s"
  },
  "timeline.view.dropStatus": {
    "zh-Hans": "{action} · {start}–{end} 帧 · {reason}{note}",
    "zh-Hant": "{action} · {start}–{end} 影格 · {reason}{note}",
    "en": "{action} · Frames {start}–{end} · {reason}{note}",
    "ja": "{action} · {start}–{end} フレーム · {reason}{note}"
  },
  "timeline.view.revision": {
    "zh-Hans": "时间线 修订版 {revision} · 分镜与画布独立",
    "zh-Hant": "時間軸 修訂版 {revision} · 分鏡與畫布各自獨立",
    "en": "Timeline revision {revision} · Independent of storyboard and canvas",
    "ja": "タイムライン リビジョン {revision} · ストーリーボードやキャンバスとは独立"
  },
  "timeline.history.trackAdd": {
    "zh-Hans": "添加轨道",
    "zh-Hant": "新增軌道",
    "en": "Add track",
    "ja": "トラックを追加"
  },
  "timeline.history.trackUpdate": {
    "zh-Hans": "修改轨道",
    "zh-Hant": "修改軌道",
    "en": "Edit track",
    "ja": "トラックを編集"
  },
  "timeline.history.clipAdd": {
    "zh-Hans": "添加片段",
    "zh-Hant": "新增片段",
    "en": "Add clip",
    "ja": "クリップを追加"
  },
  "timeline.history.clipUpdate": {
    "zh-Hans": "修改片段",
    "zh-Hant": "修改片段",
    "en": "Edit clip",
    "ja": "クリップを編集"
  },
  "timeline.history.clipReplace": {
    "zh-Hans": "替换片段来源",
    "zh-Hant": "替換片段來源",
    "en": "Replace clip source",
    "ja": "クリップのソースを差し替え"
  },
  "timeline.history.clipRemove": {
    "zh-Hans": "移除片段",
    "zh-Hant": "移除片段",
    "en": "Remove clip",
    "ja": "クリップを削除"
  },
  "timeline.history.clipSplit": {
    "zh-Hans": "分割片段",
    "zh-Hant": "分割片段",
    "en": "Split clip",
    "ja": "クリップを分割"
  },
  "timeline.history.subtitleAdd": {
    "zh-Hans": "新增字幕",
    "zh-Hant": "新增字幕",
    "en": "Add subtitle",
    "ja": "字幕を追加"
  },
  "timeline.history.subtitleUpdate": {
    "zh-Hans": "修改字幕",
    "zh-Hant": "修改字幕",
    "en": "Edit subtitle",
    "ja": "字幕を編集"
  },
  "timeline.history.subtitleRemove": {
    "zh-Hans": "移除字幕",
    "zh-Hant": "移除字幕",
    "en": "Remove subtitle",
    "ja": "字幕を削除"
  },
  "timeline.history.edit": {
    "zh-Hans": "时间线编辑",
    "zh-Hant": "時間軸編輯",
    "en": "Timeline edit",
    "ja": "タイムラインの編集"
  },
  "timeline.history.pending": {
    "zh-Hans": "上一条时间线操作待确认，请先到任务面板恢复请求",
    "zh-Hant": "上一筆時間軸操作待確認，請先至工作面板還原請求",
    "en": "The previous timeline operation is unconfirmed. Recover its request in the task panel first.",
    "ja": "前のタイムライン操作は未確認です。まずタスクパネルでリクエストを復元してください。"
  },
  "timeline.history.busy": {
    "zh-Hans": "正在同步时间线，请稍候",
    "zh-Hant": "正在同步時間軸，請稍候",
    "en": "Synchronizing timeline. Please wait.",
    "ja": "タイムラインを同期中です。お待ちください。"
  },
  "timeline.history.dirty": {
    "zh-Hans": "请先保存或放弃时间线的未保存修改",
    "zh-Hant": "請先儲存或捨棄時間軸的未儲存修改",
    "en": "Save or discard unsaved timeline changes first.",
    "ja": "先にタイムラインの未保存の変更を保存するか破棄してください。"
  },
  "timeline.history.offline": {
    "zh-Hans": "连接中断，等待重新同步时间线",
    "zh-Hant": "連線中斷，等待重新同步時間軸",
    "en": "Connection interrupted. Waiting to resynchronize the timeline.",
    "ja": "接続が切れました。タイムラインの再同期を待っています。"
  },
  "timeline.history.syncing": {
    "zh-Hans": "正在同步时间线历史",
    "zh-Hant": "正在同步時間軸歷史",
    "en": "Synchronizing timeline history",
    "ja": "タイムラインの履歴を同期中"
  },
  "timeline.history.group": {
    "zh-Hans": "时间线编辑历史",
    "zh-Hant": "時間軸編輯歷史",
    "en": "Timeline edit history",
    "ja": "タイムラインの編集履歴"
  },
  "timeline.history.undo": {
    "zh-Hans": "撤销",
    "zh-Hant": "復原",
    "en": "Undo",
    "ja": "取り消す"
  },
  "timeline.history.redo": {
    "zh-Hans": "重做",
    "zh-Hant": "重做",
    "en": "Redo",
    "ja": "やり直す"
  },
  "timeline.history.nothingUndo": {
    "zh-Hans": "没有可撤销的时间线编辑",
    "zh-Hant": "沒有可復原的時間軸編輯",
    "en": "No timeline edits to undo",
    "ja": "取り消せるタイムラインの編集はありません"
  },
  "timeline.history.nothingRedo": {
    "zh-Hans": "没有可重做的时间线编辑",
    "zh-Hant": "沒有可重做的時間軸編輯",
    "en": "No timeline edits to redo",
    "ja": "やり直せるタイムラインの編集はありません"
  },
  "timeline.history.history": {
    "zh-Hans": "历史",
    "zh-Hant": "歷史",
    "en": "History",
    "ja": "履歴"
  },
  "timeline.history.undoAria": {
    "zh-Hans": "撤销时间线：{label}",
    "zh-Hant": "復原時間軸：{label}",
    "en": "Undo timeline: {label}",
    "ja": "タイムラインの操作を取り消す：{label}"
  },
  "timeline.history.redoAria": {
    "zh-Hans": "重做时间线：{label}",
    "zh-Hant": "重做時間軸：{label}",
    "en": "Redo timeline: {label}",
    "ja": "タイムラインの操作をやり直す：{label}"
  },
  "timeline.history.undoHint": {
    "zh-Hans": "撤销：{label} · Ctrl/⌘+Z",
    "zh-Hant": "復原：{label} · Ctrl/⌘+Z",
    "en": "Undo: {label} · Ctrl/⌘+Z",
    "ja": "取り消す：{label} · Ctrl/⌘+Z"
  },
  "timeline.history.redoHint": {
    "zh-Hans": "重做：{label} · Ctrl/⌘+Shift+Z 或 Ctrl+Y",
    "zh-Hant": "重做：{label} · Ctrl/⌘+Shift+Z 或 Ctrl+Y",
    "en": "Redo: {label} · Ctrl/⌘+Shift+Z or Ctrl+Y",
    "ja": "やり直す：{label} · Ctrl/⌘+Shift+Z または Ctrl+Y"
  },
  "timeline.history.count": {
    "zh-Hans": "时间线历史：已应用 {cursor} 步，共 {length} 步",
    "zh-Hant": "時間軸歷史：已套用 {cursor} 步，共 {length} 步",
    "en": "Timeline history: {cursor} of {length} steps applied",
    "ja": "タイムライン履歴：{length} ステップ中 {cursor} ステップを適用済み"
  },
  "timeline.history.countHint": {
    "zh-Hans": "已应用 {cursor} 步，共 {length} 步；新编辑会清除可重做历史",
    "zh-Hant": "已套用 {cursor} 步，共 {length} 步；新編輯會清除可重做的歷史",
    "en": "{cursor} of {length} steps applied; new edits clear redo history",
    "ja": "{length} ステップ中 {cursor} ステップを適用済み。新しく編集すると、やり直し履歴は消去されます"
  },
  "timeline.split.editingRequired": {
    "zh-Hans": "请切换到剪辑工作区",
    "zh-Hant": "請切換至剪輯工作區",
    "en": "Switch to the editing workspace.",
    "ja": "編集ワークスペースに切り替えてください。"
  },
  "timeline.split.selectClip": {
    "zh-Hans": "请先选择要分割的时间线片段",
    "zh-Hant": "請先選擇要分割的時間軸片段",
    "en": "Select the timeline clip to split first.",
    "ja": "分割するタイムラインのクリップを選択してください。"
  },
  "timeline.split.integer": {
    "zh-Hans": "播放头必须是整数帧",
    "zh-Hant": "播放頭必須為整數影格",
    "en": "The playhead must be on an integer frame.",
    "ja": "再生ヘッドは整数フレームに置いてください。"
  },
  "timeline.split.inside": {
    "zh-Hans": "将播放头移到所选片段内部，起止帧不能分割",
    "zh-Hant": "將播放頭移至所選片段內部，起止影格無法分割",
    "en": "Move the playhead inside the selected clip. It cannot be split at its start or end.",
    "ja": "再生ヘッドを選択したクリップの内側に移動してください。開始位置と終了位置では分割できません。"
  },
  "timeline.split.fade": {
    "zh-Hans": "播放头位于音频淡入/淡出内；请移到淡入结束与淡出开始之间（含边界）",
    "zh-Hant": "播放頭位於音訊淡入／淡出內；請移至淡入結束與淡出開始之間（包含邊界）",
    "en": "The playhead is inside an audio fade. Move it between the end of fade-in and start of fade-out, including the boundaries.",
    "ja": "再生ヘッドが音声フェード内にあります。フェードインの終了からフェードアウトの開始までの間（境界を含む）に移動してください。"
  },
  "timeline.split.limit": {
    "zh-Hans": "时间线已达到100个片段上限",
    "zh-Hant": "時間軸已達 100 個片段上限",
    "en": "The timeline has reached its 100-clip limit.",
    "ja": "タイムラインは上限の 100 クリップに達しています。"
  },
  "timeline.split.unselected": {
    "zh-Hans": "未选择片段",
    "zh-Hant": "未選擇片段",
    "en": "No clip selected",
    "ja": "クリップ未選択"
  },
  "timeline.split.group": {
    "zh-Hans": "分割所选片段",
    "zh-Hant": "分割所選片段",
    "en": "Split selected clip",
    "ja": "選択したクリップを分割"
  },
  "timeline.split.action": {
    "zh-Hans": "分割",
    "zh-Hant": "分割",
    "en": "Split",
    "ja": "分割"
  },
  "timeline.split.aria": {
    "zh-Hans": "分割所选片段：{name}，播放头 {frame} 帧",
    "zh-Hant": "分割所選片段：{name}，播放頭 {frame} 影格",
    "en": "Split selected clip: {name}, playhead at frame {frame}",
    "ja": "選択したクリップを分割：{name}、再生ヘッド {frame} フレーム"
  },
  "timeline.split.hint": {
    "zh-Hans": "分割为 {left} + {right} 帧 · Ctrl/⌘+B · 不移动其他片段",
    "zh-Hant": "分割為 {left} + {right} 影格 · Ctrl/⌘+B · 不移動其他片段",
    "en": "Split into {left} + {right} frames · Ctrl/⌘+B · Other clips are not moved",
    "ja": "{left} + {right} フレームに分割 · Ctrl/⌘+B · 他のクリップは移動しません"
  },
  "timeline.split.target": {
    "zh-Hans": "{name} · 在第 {frame} 帧分割",
    "zh-Hant": "{name} · 在第 {frame} 影格分割",
    "en": "{name} · Split at frame {frame}",
    "ja": "{name} · {frame} フレームで分割"
  },
  "timeline.snap.imageDefault": {
    "zh-Hans": "图片默认 90 帧",
    "zh-Hant": "圖片預設 90 影格",
    "en": "Images default to 90 frames",
    "ja": "画像の既定値は 90 フレーム"
  },
  "timeline.snap.unknownDuration": {
    "zh-Hans": "素材时长未知，60 帧仅为示意；不能放置",
    "zh-Hant": "素材時長未知，60 影格僅為示意；無法放置",
    "en": "Asset duration is unknown. The 60-frame preview is illustrative only; placement is blocked.",
    "ja": "素材の長さが不明です。60 フレームは仮表示であり、配置できません。"
  },
  "timeline.snap.zero": {
    "zh-Hans": "时间线起点",
    "zh-Hant": "時間軸起點",
    "en": "Timeline start",
    "ja": "タイムラインの開始"
  },
  "timeline.snap.clipStart": {
    "zh-Hans": "片段起点",
    "zh-Hant": "片段起點",
    "en": "Clip start",
    "ja": "クリップの開始"
  },
  "timeline.snap.clipEnd": {
    "zh-Hans": "片段终点",
    "zh-Hant": "片段終點",
    "en": "Clip end",
    "ja": "クリップの終了"
  },
  "timeline.snap.unavailable": {
    "zh-Hans": "素材或轨道已不可用",
    "zh-Hant": "素材或軌道已無法使用",
    "en": "Asset or track is no longer available",
    "ja": "素材またはトラックを利用できません"
  },
  "timeline.snap.incompatible": {
    "zh-Hans": "片段类型与目标轨道不兼容",
    "zh-Hant": "片段類型與目標軌道不相容",
    "en": "Clip type is incompatible with the target track",
    "ja": "クリップの種類は移動先のトラックに対応していません"
  },
  "timeline.snap.tooLong": {
    "zh-Hans": "片段超过时间线 18000 帧上限",
    "zh-Hant": "片段超出時間軸 18000 影格上限",
    "en": "Clip exceeds the timeline’s 18000-frame limit",
    "ja": "クリップがタイムラインの上限 18000 フレームを超えています"
  },
  "timeline.snap.clipLimit": {
    "zh-Hans": "时间线最多容纳 100 个片段",
    "zh-Hant": "時間軸最多容納 100 個片段",
    "en": "The timeline allows at most 100 clips",
    "ja": "タイムラインのクリップ数は最大 100 個です"
  },
  "timeline.snap.overlap": {
    "zh-Hans": "同一轨道不允许重叠",
    "zh-Hant": "同一軌道不可重疊",
    "en": "Clips cannot overlap on the same track",
    "ja": "同じトラック上でクリップを重ねることはできません"
  },
  "timeline.source.otherVersion": {
    "zh-Hans": "其他版本",
    "zh-Hant": "其他版本",
    "en": "another version",
    "ja": "別のバージョン"
  },
  "timeline.source.unnamedShot": {
    "zh-Hans": "镜头",
    "zh-Hant": "鏡頭",
    "en": "Shot",
    "ja": "ショット"
  },
  "timeline.source.stale": {
    "zh-Hans": "镜头「{title}」已改选 {selected}，此片段仍是 {original}。",
    "zh-Hant": "鏡頭「{title}」已改選 {selected}，此片段仍為 {original}。",
    "en": "Shot “{title}” now selects {selected}; this clip still uses {original}.",
    "ja": "ショット「{title}」は {selected} に変更されていますが、このクリップはまだ {original} を使用しています。"
  },
  "timeline.inspector.draftInvalid": {
    "zh-Hans": "请完整填写名称与有效数值；空白数值不会自动转换为 0。",
    "zh-Hant": "請完整填寫名稱與有效數值；空白數值不會自動轉換為 0。",
    "en": "Enter a name and valid values. Blank numeric fields are not automatically converted to 0.",
    "ja": "名前と有効な数値を入力してください。空の数値欄は自動で 0 にはなりません。"
  },
  "timeline.inspector.title": {
    "zh-Hans": "时间线片段",
    "zh-Hant": "時間軸片段",
    "en": "Timeline clip",
    "ja": "タイムラインクリップ"
  },
  "timeline.inspector.fixedAsset": {
    "zh-Hans": "固定素材",
    "zh-Hant": "固定素材",
    "en": "Fixed asset",
    "ja": "固定された素材"
  },
  "timeline.inspector.audioClip": {
    "zh-Hans": "音频片段",
    "zh-Hant": "音訊片段",
    "en": "Audio clip",
    "ja": "音声クリップ"
  },
  "timeline.inspector.visualClip": {
    "zh-Hans": "画面片段",
    "zh-Hant": "映像片段",
    "en": "Visual clip",
    "ja": "映像クリップ"
  },
  "timeline.inspector.unsaved": {
    "zh-Hans": "未保存",
    "zh-Hant": "未儲存",
    "en": "Unsaved",
    "ja": "未保存"
  },
  "timeline.inspector.synced": {
    "zh-Hans": "已同步",
    "zh-Hant": "已同步",
    "en": "Synced",
    "ja": "同期済み"
  },
  "timeline.inspector.name": {
    "zh-Hans": "片段名称",
    "zh-Hant": "片段名稱",
    "en": "Clip name",
    "ja": "クリップ名"
  },
  "timeline.inspector.track": {
    "zh-Hans": "所在轨道",
    "zh-Hant": "所在軌道",
    "en": "Track",
    "ja": "トラック"
  },
  "timeline.inspector.start": {
    "zh-Hans": "开始帧",
    "zh-Hant": "開始影格",
    "en": "Start frame",
    "ja": "開始フレーム"
  },
  "timeline.inspector.duration": {
    "zh-Hans": "持续帧数",
    "zh-Hant": "持續影格數",
    "en": "Duration in frames",
    "ja": "長さ（フレーム）"
  },
  "timeline.inspector.sourceIn": {
    "zh-Hans": "素材入点（源素材帧）",
    "zh-Hant": "素材入點（來源素材影格）",
    "en": "Source in point (source frames)",
    "ja": "素材のイン点（ソースフレーム）"
  },
  "timeline.inspector.imageIn": {
    "zh-Hans": "静态图片入点固定为 0。",
    "zh-Hant": "靜態圖片入點固定為 0。",
    "en": "The in point for still images is fixed at 0.",
    "ja": "静止画像のイン点は 0 に固定されています。"
  },
  "timeline.inspector.frozen": {
    "zh-Hans": "来源已冻结",
    "zh-Hant": "來源已固定",
    "en": "Source is fixed",
    "ja": "ソースは固定されています"
  },
  "timeline.inspector.frozenHint": {
    "zh-Hans": "后续生成或切换镜头版本，不会替换此片段。",
    "zh-Hant": "後續生成或切換鏡頭版本，不會替換此片段。",
    "en": "Later generation or changing the shot version will not replace this clip.",
    "ja": "後から生成したりショットのバージョンを変更したりしても、このクリップは差し替わりません。"
  },
  "timeline.inspector.staleHint": {
    "zh-Hans": "可在下方“替换片段来源”核对改用。",
    "zh-Hant": "可在下方「替換片段來源」核對並改用。",
    "en": "Review and change it using “Replace clip source” below.",
    "ja": "下の「クリップのソースを差し替え」で確認して変更できます。"
  },
  "timeline.inspector.returnSource": {
    "zh-Hans": "返回来源",
    "zh-Hant": "返回來源",
    "en": "Return to source",
    "ja": "ソースに戻る"
  },
  "timeline.inspector.previewSource": {
    "zh-Hans": "查看原始源素材（未调色）",
    "zh-Hant": "查看原始來源素材（未調色）",
    "en": "View original source (ungraded)",
    "ja": "元のソース素材を表示（未調整）"
  },
  "timeline.inspector.rect": {
    "zh-Hans": "画面位置与尺寸",
    "zh-Hant": "畫面位置與尺寸",
    "en": "Picture position and size",
    "ja": "映像の位置とサイズ"
  },
  "timeline.inspector.width": {
    "zh-Hans": "宽",
    "zh-Hant": "寬",
    "en": "Width",
    "ja": "幅"
  },
  "timeline.inspector.height": {
    "zh-Hans": "高",
    "zh-Hant": "高",
    "en": "Height",
    "ja": "高さ"
  },
  "timeline.inspector.rectHint": {
    "zh-Hans": "偶数像素，画面完整包含于矩形内。矩形留白透明，会显示下层；无任何画面的时间段为黑色。",
    "zh-Hant": "使用偶數像素，畫面完整包含於矩形內。矩形留白透明，會顯示下層；沒有任何畫面的時段為黑色。",
    "en": "Use even pixel values. The picture fits entirely within the rectangle. Empty space is transparent and shows lower tracks; intervals with no picture are black.",
    "ja": "偶数ピクセルを使用し、映像全体が矩形内に収まるようにします。矩形内の余白は透明で下のトラックが表示され、映像のない時間帯は黒になります。"
  },
  "timeline.inspector.rectInvalid": {
    "zh-Hans": "画面位置与尺寸必须是有效偶数像素。",
    "zh-Hant": "畫面位置與尺寸必須為有效的偶數像素。",
    "en": "Picture position and size must be valid even pixel values.",
    "ja": "映像の位置とサイズには有効な偶数ピクセル値を指定してください。"
  },
  "timeline.inspector.rectBounds": {
    "zh-Hans": "画面矩形不能超出当前时间线输出尺寸。",
    "zh-Hant": "畫面矩形不可超出目前時間軸的輸出尺寸。",
    "en": "The picture rectangle must stay within the current timeline output dimensions.",
    "ja": "映像の矩形は現在のタイムラインの出力サイズ内に収めてください。"
  },
  "timeline.inspector.conflict": {
    "zh-Hans": "草稿的时间线版本或来源已变化。你的输入仍保留，不会自动改用新版本；放弃草稿后可载入最新片段。",
    "zh-Hant": "草稿的時間軸版本或來源已變更。你的輸入仍保留，不會自動改用新版本；捨棄草稿後可載入最新片段。",
    "en": "The draft’s timeline revision or source has changed. Your input is retained and will not switch to the new version automatically. Discard the draft to load the latest clip.",
    "ja": "下書きのタイムラインのリビジョンまたはソースが変わりました。入力は保持され、自動で新しいバージョンには切り替わりません。下書きを破棄すると最新のクリップを読み込めます。"
  },
  "timeline.inspector.reload": {
    "zh-Hans": "载入最新片段",
    "zh-Hant": "載入最新片段",
    "en": "Load latest clip",
    "ja": "最新のクリップを読み込む"
  },
  "timeline.inspector.save": {
    "zh-Hans": "保存片段",
    "zh-Hant": "儲存片段",
    "en": "Save clip",
    "ja": "クリップを保存"
  },
  "timeline.inspector.discard": {
    "zh-Hans": "放弃修改",
    "zh-Hant": "捨棄修改",
    "en": "Discard changes",
    "ja": "変更を破棄"
  },
  "timeline.inspector.saveBeforeRemove": {
    "zh-Hans": "先保存或放弃片段草稿，再移除此片段。",
    "zh-Hant": "請先儲存或捨棄片段草稿，再移除此片段。",
    "en": "Save or discard the clip draft before removing this clip.",
    "ja": "クリップを削除する前に、下書きを保存するか破棄してください。"
  },
  "timeline.inspector.removeConfirm": {
    "zh-Hans": "从时间线移除此片段？原素材与镜头版本会保留。",
    "zh-Hant": "要從時間軸移除此片段嗎？原素材與鏡頭版本會保留。",
    "en": "Remove this clip from the timeline? The original asset and shot versions will be kept.",
    "ja": "このクリップをタイムラインから削除しますか？元の素材とショットのバージョンは保持されます。"
  },
  "timeline.inspector.remove": {
    "zh-Hans": "从时间线移除片段",
    "zh-Hant": "從時間軸移除片段",
    "en": "Remove clip from timeline",
    "ja": "タイムラインからクリップを削除"
  },
  "timeline.inspector.timeRange": {
    "zh-Hans": "30 帧 = 1 秒 · 时间线 {start} → {end}",
    "zh-Hant": "30 影格 = 1 秒 · 時間軸 {start} → {end}",
    "en": "30 frames = 1 second · Timeline {start} → {end}",
    "ja": "30 フレーム = 1 秒 · タイムライン {start} → {end}"
  },
  "timeline.inspector.sourceDuration": {
    "zh-Hans": "源素材 {duration} 秒；入点与时间线开始帧各自独立。",
    "zh-Hant": "來源素材 {duration} 秒；入點與時間軸開始影格各自獨立。",
    "en": "Source: {duration} seconds. The source in point and timeline start frame are independent.",
    "ja": "ソース素材：{duration} 秒。ソースのイン点とタイムラインの開始フレームは独立しています。"
  },
  "timeline.inspector.sourceDurationUnknown": {
    "zh-Hans": "源素材时长未知；入点与时间线开始帧各自独立。",
    "zh-Hant": "來源素材時長未知；入點與時間軸開始影格各自獨立。",
    "en": "Source duration is unknown. The source in point and timeline start frame are independent.",
    "ja": "ソース素材の長さは不明です。ソースのイン点とタイムラインの開始フレームは独立しています。"
  },
  "audio.waveform.disclosure": {
    "zh-Hans": "原始源音轨（首条） · 固定满刻度 · 不反映音量、静音或淡入/淡出",
    "zh-Hant": "原始來源音軌（第一條） · 固定滿刻度 · 不反映音量、靜音或淡入／淡出",
    "en": "Original source audio (first stream) · Fixed full scale · Does not reflect gain, mute, or fades",
    "ja": "元のソース音声（最初のストリーム） · 固定フルスケール · ゲイン、ミュート、フェードは反映しません"
  },
  "audio.waveform.background": {
    "zh-Hans": "关闭、收起或切换面板后停止请求；已接受的本地解码可能继续完成。",
    "zh-Hant": "關閉、收合或切換面板後會停止請求；已接受的本機解碼可能繼續完成。",
    "en": "Requests stop when the panel is closed, collapsed, or switched. Accepted local decoding may continue to completion.",
    "ja": "パネルを閉じる、折りたたむ、切り替えるとリクエストは停止します。受理済みのローカルデコードは完了まで続く場合があります。"
  },
  "audio.waveform.waiting": {
    "zh-Hans": "等待可见片段",
    "zh-Hant": "等待可見片段",
    "en": "Waiting for visible clips",
    "ja": "表示範囲のクリップを待機中"
  },
  "audio.waveform.durationLimit": {
    "zh-Hans": "超过10分钟暂不支持波形",
    "zh-Hant": "超過 10 分鐘暫不支援波形",
    "en": "Waveforms are not supported beyond 10 minutes",
    "ja": "10 分を超える波形には現在対応していません"
  },
  "audio.waveform.missing": {
    "zh-Hans": "波形未生成",
    "zh-Hant": "波形尚未產生",
    "en": "Waveform not generated",
    "ja": "波形未生成"
  },
  "audio.waveform.loading": {
    "zh-Hans": "检查波形…",
    "zh-Hant": "檢查波形…",
    "en": "Checking waveform…",
    "ja": "波形を確認中…"
  },
  "audio.waveform.queued": {
    "zh-Hans": "波形排队中…",
    "zh-Hant": "波形佇列中…",
    "en": "Waveform queued…",
    "ja": "波形は待機中…"
  },
  "audio.waveform.running": {
    "zh-Hans": "本地分析中…",
    "zh-Hant": "本機分析中…",
    "en": "Analyzing locally…",
    "ja": "ローカルで解析中…"
  },
  "audio.waveform.ready": {
    "zh-Hans": "原始源音轨波形",
    "zh-Hant": "原始來源音軌波形",
    "en": "Original source audio waveform",
    "ja": "元のソース音声の波形"
  },
  "audio.waveform.interrupted": {
    "zh-Hans": "波形分析已中断，请重试",
    "zh-Hant": "波形分析已中斷，請重試",
    "en": "Waveform analysis was interrupted. Retry explicitly.",
    "ja": "波形解析が中断されました。明示的に再試行してください。"
  },
  "audio.waveform.error": {
    "zh-Hans": "波形暂不可用，请重试",
    "zh-Hant": "波形暫時無法使用，請重試",
    "en": "Waveform unavailable. Try again.",
    "ja": "波形を利用できません。再試行してください。"
  },
  "audio.waveform.unsupported": {
    "zh-Hans": "此素材暂不支持波形",
    "zh-Hant": "此素材暫不支援波形",
    "en": "Waveforms are not supported for this asset",
    "ja": "この素材の波形には対応していません"
  },
  "audio.waveform.unavailable": {
    "zh-Hans": "波形暂不可用",
    "zh-Hant": "波形暫時無法使用",
    "en": "Waveform unavailable",
    "ja": "波形を利用できません"
  },
  "audio.waveform.readOnly": {
    "zh-Hans": "仅查看已保存波形；新解码及历史任务执行不可用",
    "zh-Hant": "僅查看已儲存波形；新的解碼與歷史工作執行無法使用",
    "en": "View saved waveforms only; new decoding and running historical tasks are unavailable",
    "ja": "保存済み波形の表示のみ可能です。新規デコードと過去のタスクの実行はできません"
  },
  "audio.waveform.defaultOff": {
    "zh-Hans": "本次会话默认关闭",
    "zh-Hant": "此工作階段預設關閉",
    "en": "Off by default for this session",
    "ja": "このセッションでは既定でオフ"
  },
  "audio.waveform.visibleLimit": {
    "zh-Hans": "仅显示前32个可见片段波形",
    "zh-Hant": "僅顯示前 32 個可見片段的波形",
    "en": "Only the first 32 visible clip waveforms are shown",
    "ja": "表示範囲の最初の 32 クリップのみ波形を表示"
  },
  "audio.waveform.attemptLimit": {
    "zh-Hans": "已达64个素材，请手动重试",
    "zh-Hant": "已達 64 個素材，請手動重試",
    "en": "64-asset limit reached. Retry manually.",
    "ja": "64 素材の上限に達しました。手動で再試行してください。"
  },
  "audio.waveform.visibleOnly": {
    "zh-Hans": "仅分析可见片段…",
    "zh-Hant": "僅分析可見片段…",
    "en": "Analyzing visible clips only…",
    "ja": "表示範囲のクリップのみ解析中…"
  },
  "audio.waveform.sourceScale": {
    "zh-Hans": "原始源音轨 · 固定满刻度",
    "zh-Hant": "原始來源音軌 · 固定滿刻度",
    "en": "Original source audio · Fixed full scale",
    "ja": "元のソース音声 · 固定フルスケール"
  },
  "audio.waveform.noAudio": {
    "zh-Hans": "当前视区无已确认音轨",
    "zh-Hant": "目前視區內沒有已確認的音軌",
    "en": "No confirmed audio tracks in the current view",
    "ja": "現在の表示範囲に確認済み音声トラックはありません"
  },
  "audio.waveform.on": {
    "zh-Hans": "波形开",
    "zh-Hant": "波形開",
    "en": "Waveforms on",
    "ja": "波形オン"
  },
  "audio.waveform.off": {
    "zh-Hans": "波形关",
    "zh-Hant": "波形關",
    "en": "Waveforms off",
    "ja": "波形オフ"
  },
  "audio.waveform.savedOn": {
    "zh-Hans": "已有波形开",
    "zh-Hant": "既有波形開",
    "en": "Saved waveforms on",
    "ja": "保存済み波形オン"
  },
  "audio.waveform.savedOff": {
    "zh-Hans": "已有波形关",
    "zh-Hant": "既有波形關",
    "en": "Saved waveforms off",
    "ja": "保存済み波形オフ"
  },
  "audio.waveform.clipped": {
    "zh-Hans": "满刻度峰值",
    "zh-Hant": "滿刻度峰值",
    "en": "Full-scale peak",
    "ja": "フルスケールのピーク"
  },
  "audio.waveform.clippedHint": {
    "zh-Hans": "原始源音轨检测到满刻度峰值；不反映片段音量、静音或淡入/淡出",
    "zh-Hant": "原始來源音軌偵測到滿刻度峰值；不反映片段音量、靜音或淡入／淡出",
    "en": "A full-scale peak was detected in the original source audio. Clip gain, mute, and fades are not reflected.",
    "ja": "元のソース音声でフルスケールのピークを検出しました。クリップのゲイン、ミュート、フェードは反映しません。"
  },
  "audio.waveform.retry": {
    "zh-Hans": "重试波形",
    "zh-Hant": "重試波形",
    "en": "Retry waveforms",
    "ja": "波形を再試行"
  },
  "audio.waveform.retryHint": {
    "zh-Hans": "先查询状态，仅在仍未完成时重试可见片段",
    "zh-Hant": "先查詢狀態，僅在仍未完成時重試可見片段",
    "en": "Check status first, then retry visible clips only if still incomplete",
    "ja": "先に状態を確認し、未完了の場合にのみ表示範囲のクリップを再試行"
  },
  "audio.waveform.defaultDisclosure": {
    "zh-Hans": "每次打开项目默认关闭，仅在手动开启后按可见片段分析。",
    "zh-Hant": "每次開啟專案預設關閉，僅在手動開啟後分析可見片段。",
    "en": "Off by default whenever a project opens. Only visible clips are analyzed after you enable it manually.",
    "ja": "プロジェクトを開くたびに既定でオフになります。手動で有効にした後、表示範囲のクリップのみを解析します。"
  },
  "audio.waveform.held": {
    "zh-Hans": "历史状态 {status} · 恢复分支不解码",
    "zh-Hant": "歷史狀態 {status} · 還原分支不會解碼",
    "en": "Historical status: {status} · Restored branches do not decode",
    "ja": "履歴の状態：{status} · 復元ブランチではデコードしません"
  },
  "timeline.replace.still": {
    "zh-Hans": "静态图片",
    "zh-Hant": "靜態圖片",
    "en": "Still image",
    "ja": "静止画像"
  },
  "timeline.replace.unknownDuration": {
    "zh-Hans": "时长未知",
    "zh-Hant": "時長未知",
    "en": "Duration unknown",
    "ja": "長さ不明"
  },
  "timeline.replace.title": {
    "zh-Hans": "替换片段来源",
    "zh-Hant": "替換片段來源",
    "en": "Replace clip source",
    "ja": "クリップのソースを差し替え"
  },
  "timeline.replace.scope": {
    "zh-Hans": "只更新这个片段的来源。名称、位置、时长、入点、画面、音量及淡入/淡出保持原值。",
    "zh-Hant": "僅更新此片段的來源。名稱、位置、時長、入點、畫面、音量及淡入／淡出保持原值。",
    "en": "Only this clip’s source is updated. Its name, position, duration, in point, picture, gain, and fades remain unchanged.",
    "ja": "このクリップのソースのみを更新します。名前、位置、長さ、イン点、映像、ゲイン、フェードは変更しません。"
  },
  "timeline.replace.choose": {
    "zh-Hans": "选择替换来源",
    "zh-Hant": "選擇替換來源",
    "en": "Choose replacement source",
    "ja": "差し替えソースを選択"
  },
  "timeline.replace.candidates": {
    "zh-Hans": "当前项目的兼容素材或版本",
    "zh-Hant": "目前專案中的相容素材或版本",
    "en": "Compatible assets or versions in this project",
    "ja": "このプロジェクトの互換素材またはバージョン"
  },
  "timeline.replace.select": {
    "zh-Hans": "请选择来源",
    "zh-Hant": "請選擇來源",
    "en": "Select a source",
    "ja": "ソースを選択"
  },
  "timeline.replace.candidatesHint": {
    "zh-Hans": "仅列出可保留原范围与淡入/淡出的同类素材，最终由服务端验证。选择“仅素材”不会绑定镜头版本。",
    "zh-Hant": "僅列出可保留原範圍與淡入／淡出的同類素材，最後由伺服器驗證。選擇「僅素材」不會綁定鏡頭版本。",
    "en": "Only same-type assets that can preserve the range and fades are listed. The server performs final validation. “Asset only” does not bind a shot version.",
    "ja": "元の範囲とフェードを保持できる同種の素材のみを表示します。最終検証はサーバーで行います。「素材のみ」ではショットのバージョンを関連付けません。"
  },
  "timeline.replace.noCandidates": {
    "zh-Hans": "没有已知兼容的其他来源。需要同类素材覆盖原入点与片段时长；非零淡入/淡出还需已确认音轨。",
    "zh-Hant": "沒有已知相容的其他來源。需要同類素材涵蓋原入點與片段時長；非零淡入／淡出還需要已確認的音軌。",
    "en": "No other known compatible sources are available. A same-type asset must cover the original in point and clip duration. Nonzero fades also require a confirmed audio track.",
    "ja": "互換性を確認できる別のソースはありません。同種の素材が元のイン点とクリップの長さをカバーする必要があります。0 以外のフェードには確認済みの音声トラックも必要です。"
  },
  "timeline.replace.review": {
    "zh-Hans": "核对替换",
    "zh-Hant": "核對替換",
    "en": "Review replacement",
    "ja": "差し替えを確認"
  },
  "timeline.replace.cancel": {
    "zh-Hans": "取消",
    "zh-Hant": "取消",
    "en": "Cancel",
    "ja": "キャンセル"
  },
  "timeline.replace.target": {
    "zh-Hans": "目标片段",
    "zh-Hant": "目標片段",
    "en": "Target clip",
    "ja": "対象クリップ"
  },
  "timeline.replace.previous": {
    "zh-Hans": "当前来源",
    "zh-Hant": "目前來源",
    "en": "Current source",
    "ja": "現在のソース"
  },
  "timeline.replace.replacement": {
    "zh-Hans": "替换为",
    "zh-Hant": "替換為",
    "en": "Replace with",
    "ja": "差し替え先"
  },
  "timeline.replace.assetOnly": {
    "zh-Hans": "仅素材，不绑定镜头版本",
    "zh-Hant": "僅素材，不綁定鏡頭版本",
    "en": "Asset only; no shot-version binding",
    "ja": "素材のみ。ショットのバージョンとの関連付けなし"
  },
  "timeline.replace.keepIn": {
    "zh-Hans": "保留素材入点",
    "zh-Hant": "保留素材入點",
    "en": "Preserve source in point",
    "ja": "素材のイン点を保持"
  },
  "timeline.replace.keepDuration": {
    "zh-Hans": "保留片段时长",
    "zh-Hant": "保留片段時長",
    "en": "Preserve clip duration",
    "ja": "クリップの長さを保持"
  },
  "timeline.replace.keepPosition": {
    "zh-Hans": "保留时间线位置",
    "zh-Hant": "保留時間軸位置",
    "en": "Preserve timeline position",
    "ja": "タイムラインの位置を保持"
  },
  "timeline.replace.colourWarning": {
    "zh-Hans": "LUT、启用状态与强度会保留；新来源的色彩解释将清除。替换后必须重新核对并确认 Rec.709 SDR 与范围，才能渲染。",
    "zh-Hant": "LUT、啟用狀態與強度會保留；新來源的色彩解讀將清除。替換後必須重新核對並確認 Rec.709 SDR 與範圍，才能算繪。",
    "en": "The LUT, enabled state, and strength are preserved; the source color interpretation is cleared. After replacement, recheck and confirm Rec.709 SDR and range before rendering.",
    "ja": "LUT、有効状態、強度は保持しますが、ソースの色解釈は消去します。差し替え後にレンダリングするには、Rec.709 SDR とレンジを再確認してください。"
  },
  "timeline.replace.preserveHint": {
    "zh-Hans": "不会自动裁短或清除淡入/淡出。不修改镜头选用版本、其他片段或已有导出。",
    "zh-Hant": "不會自動裁短或清除淡入／淡出。不修改鏡頭選用的版本、其他片段或既有匯出。",
    "en": "Fades will not be trimmed or cleared automatically. The selected shot version, other clips, and existing exports are unchanged.",
    "ja": "フェードを自動で短縮したり消去したりしません。選択されたショットのバージョン、他のクリップ、既存の書き出しは変更しません。"
  },
  "timeline.replace.approve": {
    "zh-Hans": "确认替换此片段来源",
    "zh-Hant": "確認替換此片段來源",
    "en": "Confirm this clip’s source replacement",
    "ja": "このクリップのソース差し替えを確定"
  },
  "timeline.replace.sending": {
    "zh-Hans": "正在提交本次核对的替换请求…",
    "zh-Hant": "正在提交本次核對的替換請求…",
    "en": "Submitting the reviewed replacement request…",
    "ja": "確認した差し替えリクエストを送信中…"
  },
  "timeline.replace.applied": {
    "zh-Hans": "本次来源替换已确认。后续编辑或撤销可能改变当前片段，请以上方来源为准。",
    "zh-Hant": "本次來源替換已確認。後續編輯或復原可能改變目前片段，請以上方來源為準。",
    "en": "This source replacement is confirmed. Later edits or undo may change the current clip; refer to the source shown above.",
    "ja": "このソースの差し替えは確認済みです。その後の編集や取り消しで現在のクリップが変わる場合があります。上に表示されたソースを確認してください。"
  },
  "timeline.replace.sessionRecovery": {
    "zh-Hans": "原请求恢复记录只保留在当前浏览器会话中。关闭窗口或重建应用会话可能丢失记录，无法保证自动找回。",
    "zh-Hant": "原請求還原記錄僅保留在目前瀏覽器工作階段中。關閉視窗或重建應用程式工作階段可能遺失記錄，無法保證自動找回。",
    "en": "The original-request recovery record is retained only in this browser session. Closing the window or recreating the app session may lose it; automatic recovery is not guaranteed.",
    "ja": "元のリクエストの復元記録は、このブラウザーセッション内にのみ保持されます。ウィンドウを閉じたりアプリのセッションを作り直したりすると失われる場合があり、自動復元は保証できません。"
  },
  "timeline.replace.recover": {
    "zh-Hans": "在任务面板恢复原请求",
    "zh-Hant": "在工作面板還原原請求",
    "en": "Recover original request in task panel",
    "ja": "タスクパネルで元のリクエストを復元"
  },
  "timeline.replace.restart": {
    "zh-Hans": "重新选择并核对",
    "zh-Hant": "重新選擇並核對",
    "en": "Select again and review",
    "ja": "選択し直して確認"
  },
  "timeline.replace.close": {
    "zh-Hans": "结束本次核对",
    "zh-Hant": "結束本次核對",
    "en": "Close this review",
    "ja": "この確認を終了"
  },
  "timeline.replace.duration": {
    "zh-Hans": "{seconds} 秒",
    "zh-Hant": "{seconds} 秒",
    "en": "{seconds} seconds",
    "ja": "{seconds} 秒"
  },
  "timeline.replace.suggested": {
    "zh-Hans": "核对改用镜头当前选用的 V{version}",
    "zh-Hant": "核對並改用鏡頭目前選用的 V{version}",
    "en": "Review switching to the shot’s selected V{version}",
    "ja": "ショットで選択中の V{version} への変更を確認"
  },
  "timeline.replace.revision": {
    "zh-Hans": "本次核对 · 时间线修订 {revision}",
    "zh-Hant": "本次核對 · 時間軸修訂 {revision}",
    "en": "This review · Timeline revision {revision}",
    "ja": "今回の確認 · タイムラインのリビジョン {revision}"
  },
  "timeline.replace.frames": {
    "zh-Hans": "{frames} 帧",
    "zh-Hant": "{frames} 影格",
    "en": "{frames} frames",
    "ja": "{frames} フレーム"
  },
  "timeline.replace.durationFrames": {
    "zh-Hans": "{frames} 帧 · {seconds} 秒",
    "zh-Hant": "{frames} 影格 · {seconds} 秒",
    "en": "{frames} frames · {seconds} seconds",
    "ja": "{frames} フレーム · {seconds} 秒"
  },
  "timeline.replace.position": {
    "zh-Hans": "{start} → {end} 帧",
    "zh-Hant": "{start} → {end} 影格",
    "en": "Frames {start} → {end}",
    "ja": "{start} → {end} フレーム"
  },
  "timeline.replace.assetChoice": {
    "zh-Hans": "{name} · 仅素材",
    "zh-Hant": "{name} · 僅素材",
    "en": "{name} · Asset only",
    "ja": "{name} · 素材のみ"
  },
  "timeline.replace.error.owner": {
    "zh-Hans": "项目或所选片段已变化，请重新选择片段。",
    "zh-Hant": "專案或所選片段已變更，請重新選擇片段。",
    "en": "The project or selected clip changed. Select the clip again.",
    "ja": "プロジェクトまたは選択したクリップが変わりました。クリップを再選択してください。"
  },
  "timeline.replace.error.dirty": {
    "zh-Hans": "请先保存或放弃片段的未保存修改，再替换来源。",
    "zh-Hant": "請先儲存或捨棄片段的未儲存修改，再替換來源。",
    "en": "Save or discard unsaved clip changes before replacing the source.",
    "ja": "ソースを差し替える前にクリップの未保存の変更を保存するか破棄してください。"
  },
  "timeline.replace.error.offline": {
    "zh-Hans": "请等待连接恢复后再核对来源。",
    "zh-Hant": "請等待連線恢復後再核對來源。",
    "en": "Wait for the connection to recover before reviewing the source.",
    "ja": "接続が回復してからソースを確認してください。"
  },
  "timeline.replace.error.pending": {
    "zh-Hans": "上一条时间线请求结果待确认，请先在任务面板恢复同一请求。",
    "zh-Hant": "上一筆時間軸請求的結果待確認，請先在工作面板還原同一請求。",
    "en": "The previous timeline request is unconfirmed. Recover that same request in the task panel first.",
    "ja": "前のタイムラインリクエストの結果は未確認です。まずタスクパネルで同じリクエストを復元してください。"
  },
  "timeline.replace.error.busy": {
    "zh-Hans": "正在保存时间线，请稍后再核对来源。",
    "zh-Hant": "正在儲存時間軸，請稍後再核對來源。",
    "en": "The timeline is being saved. Review the source afterward.",
    "ja": "タイムラインを保存中です。完了後にソースを確認してください。"
  },
  "timeline.replace.error.hidden": {
    "zh-Hans": "请在片段属性中核对并确认替换。",
    "zh-Hant": "請在片段屬性中核對並確認替換。",
    "en": "Review and confirm the replacement in clip properties.",
    "ja": "クリップのプロパティで差し替えを確認して確定してください。"
  },
  "timeline.replace.error.project": {
    "zh-Hans": "来源必须属于当前项目。",
    "zh-Hant": "來源必須屬於目前專案。",
    "en": "Sources must belong to the current project.",
    "ja": "ソースは現在のプロジェクトに属している必要があります。"
  },
  "timeline.replace.error.same": {
    "zh-Hans": "不能替换为当前来源；不会生成重复历史。",
    "zh-Hant": "不能替換為目前來源；不會產生重複歷史。",
    "en": "The replacement cannot be the current source. Duplicate history will not be created.",
    "ja": "現在と同じソースには差し替えられません。重複する履歴は作成しません。"
  },
  "timeline.replace.error.kind": {
    "zh-Hans": "新旧来源必须同为视频、音频或图片。",
    "zh-Hant": "新舊來源必須同為影片、音訊或圖片。",
    "en": "Both sources must have the same type: video, audio, or image.",
    "ja": "新旧ソースは動画、音声、画像のいずれか同じ種類である必要があります。"
  },
  "timeline.replace.error.range": {
    "zh-Hans": "片段范围无效，请先检查片段。",
    "zh-Hant": "片段範圍無效，請先檢查片段。",
    "en": "The clip range is invalid. Check the clip first.",
    "ja": "クリップの範囲が無効です。先にクリップを確認してください。"
  },
  "timeline.replace.error.imageIn": {
    "zh-Hans": "图片片段的素材入点必须为 0。",
    "zh-Hant": "圖片片段的素材入點必須為 0。",
    "en": "An image clip’s source in point must be 0.",
    "ja": "画像クリップの素材のイン点は 0 にしてください。"
  },
  "timeline.replace.error.durationUnknown": {
    "zh-Hans": "新来源时长尚未确认，无法保留片段范围。",
    "zh-Hant": "新來源時長尚未確認，無法保留片段範圍。",
    "en": "The new source duration is unconfirmed, so the clip range cannot be preserved.",
    "ja": "新しいソースの長さが未確認のため、クリップの範囲を保持できません。"
  },
  "timeline.replace.error.tooShort": {
    "zh-Hans": "新来源不足以覆盖原入点与片段时长；不会自动裁短。",
    "zh-Hant": "新來源不足以涵蓋原入點與片段時長；不會自動裁短。",
    "en": "The new source does not cover the original in point and clip duration. It will not be trimmed automatically.",
    "ja": "新しいソースでは元のイン点とクリップの長さをカバーできません。自動で短縮することはありません。"
  },
  "timeline.replace.error.reviewOwner": {
    "zh-Hans": "项目或所选片段已变化，请重新选择并核对。",
    "zh-Hant": "專案或所選片段已變更，請重新選擇並核對。",
    "en": "The project or selected clip changed. Select again and review.",
    "ja": "プロジェクトまたは選択したクリップが変わりました。選択し直して確認してください。"
  },
  "timeline.replace.error.reviewStale": {
    "zh-Hans": "时间线或片段已变化。本次核对已失效，请重新选择并核对。",
    "zh-Hant": "時間軸或片段已變更。本次核對已失效，請重新選擇並核對。",
    "en": "The timeline or clip changed, invalidating this review. Select again and review.",
    "ja": "タイムラインまたはクリップが変わり、今回の確認は無効になりました。選択し直して確認してください。"
  },
  "timeline.replace.error.candidateStale": {
    "zh-Hans": "来源或候选素材信息已变化。本次核对已失效，请重新选择并核对。",
    "zh-Hant": "來源或候選素材資訊已變更。本次核對已失效，請重新選擇並核對。",
    "en": "Source or candidate metadata changed, invalidating this review. Select again and review.",
    "ja": "ソースまたは候補素材の情報が変わり、今回の確認は無効になりました。選択し直して確認してください。"
  },
  "timeline.replace.error.inputMismatch": {
    "zh-Hans": "替换参数与核对内容不一致，请重新选择并核对。",
    "zh-Hant": "替換參數與核對內容不符，請重新選擇並核對。",
    "en": "Replacement parameters do not match the review. Select again and review.",
    "ja": "差し替えのパラメーターが確認内容と一致しません。選択し直して確認してください。"
  },
  "timeline.replace.error.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后重新核对。",
    "zh-Hant": "工作階段已過期，請重新登入後再次核對。",
    "en": "Your session expired. Sign in again, then review again.",
    "ja": "セッションの有効期限が切れました。再ログインして確認し直してください。"
  },
  "timeline.replace.error.conflict": {
    "zh-Hans": "时间线已变化，未按本次核对替换。请重新选择并核对。",
    "zh-Hant": "時間軸已變更，未依本次核對替換。請重新選擇並核對。",
    "en": "The timeline changed. This reviewed replacement was not applied. Select again and review.",
    "ja": "タイムラインが変わったため、今回確認した差し替えは適用していません。選択し直して確認してください。"
  },
  "timeline.replace.error.unchanged": {
    "zh-Hans": "所选素材已是当前来源，未新增历史记录。",
    "zh-Hant": "所選素材已是目前來源，未新增歷史記錄。",
    "en": "The selected asset is already the current source. No history entry was added.",
    "ja": "選択した素材はすでに現在のソースです。履歴は追加していません。"
  },
  "timeline.replace.error.invalidKind": {
    "zh-Hans": "新旧来源必须同为视频、音频或图片，请重新选择。",
    "zh-Hant": "新舊來源必須同為影片、音訊或圖片，請重新選擇。",
    "en": "Both sources must have the same type: video, audio, or image. Select again.",
    "ja": "新旧ソースは動画、音声、画像のいずれか同じ種類である必要があります。選択し直してください。"
  },
  "timeline.replace.error.unavailable": {
    "zh-Hans": "新来源或版本不可用，请重新选择并核对。",
    "zh-Hant": "新來源或版本無法使用，請重新選擇並核對。",
    "en": "The new source or version is unavailable. Select again and review.",
    "ja": "新しいソースまたはバージョンを利用できません。選択し直して確認してください。"
  },
  "timeline.replace.error.bounds": {
    "zh-Hans": "新来源无法保留原入点与片段时长，未进行自动裁短。",
    "zh-Hant": "新來源無法保留原入點與片段時長，未進行自動裁短。",
    "en": "The new source cannot preserve the original in point and duration. No automatic trimming was performed.",
    "ja": "新しいソースでは元のイン点と長さを保持できません。自動短縮はしていません。"
  },
  "timeline.replace.error.fades": {
    "zh-Hans": "新来源无法保留已有音频淡入/淡出，请重新核对。",
    "zh-Hant": "新來源無法保留既有的音訊淡入／淡出，請重新核對。",
    "en": "The new source cannot preserve the existing audio fades. Review again.",
    "ja": "新しいソースでは既存の音声フェードを保持できません。確認し直してください。"
  },
  "timeline.replace.error.failed": {
    "zh-Hans": "替换未完成，请检查片段与来源后重新选择并核对。",
    "zh-Hant": "替換未完成，請檢查片段與來源後重新選擇並核對。",
    "en": "Replacement did not complete. Check the clip and source, then select again and review.",
    "ja": "差し替えは完了していません。クリップとソースを調べ、選択し直して確認してください。"
  },
  "timeline.replace.error.unknown": {
    "zh-Hans": "替换结果尚未确认。请在任务面板恢复同一请求，不要重复替换。",
    "zh-Hant": "替換結果尚未確認。請在工作面板還原同一請求，不要重複替換。",
    "en": "The replacement outcome is unconfirmed. Recover the same request in the task panel; do not repeat the replacement.",
    "ja": "差し替えの結果は未確認です。タスクパネルで同じリクエストを復元してください。差し替えを繰り返さないでください。"
  },
  "timeline.range.title": {
    "zh-Hans": "源素材范围",
    "zh-Hant": "來源素材範圍",
    "en": "Source range",
    "ja": "ソース素材の範囲"
  },
  "timeline.range.audio": {
    "zh-Hans": "音频",
    "zh-Hant": "音訊",
    "en": "Audio",
    "ja": "音声"
  },
  "timeline.range.video": {
    "zh-Hans": "视频",
    "zh-Hant": "影片",
    "en": "Video",
    "ja": "動画"
  },
  "timeline.range.supported": {
    "zh-Hans": "只有视频和音频可保存源范围。图片仍可整段加入剪辑。",
    "zh-Hant": "只有影片與音訊可儲存來源範圍。圖片仍可整段加入剪輯。",
    "en": "Source ranges can be saved only for video and audio. Images can still be added as whole clips.",
    "ja": "ソース範囲を保存できるのは動画と音声のみです。画像は引き続きクリップ全体として追加できます。"
  },
  "timeline.range.loading": {
    "zh-Hans": "正在读取范围…",
    "zh-Hant": "正在讀取範圍…",
    "en": "Reading range…",
    "ja": "範囲を読み取り中…"
  },
  "timeline.range.saving": {
    "zh-Hans": "正在保存范围…",
    "zh-Hant": "正在儲存範圍…",
    "en": "Saving range…",
    "ja": "範囲を保存中…"
  },
  "timeline.range.updatedElsewhere": {
    "zh-Hans": "范围已在别处更新",
    "zh-Hant": "範圍已在其他地方更新",
    "en": "Range updated elsewhere",
    "ja": "範囲は別の場所で更新されました"
  },
  "timeline.range.dirty": {
    "zh-Hans": "有未保存修改",
    "zh-Hant": "有未儲存修改",
    "en": "Unsaved changes",
    "ja": "未保存の変更あり"
  },
  "timeline.range.default": {
    "zh-Hans": "默认全源范围 · 尚未保存",
    "zh-Hant": "預設完整來源範圍 · 尚未儲存",
    "en": "Full source by default · Not saved",
    "ja": "既定のソース全体 · 未保存"
  },
  "timeline.range.in": {
    "zh-Hans": "入点",
    "zh-Hant": "入點",
    "en": "In point",
    "ja": "イン点"
  },
  "timeline.range.out": {
    "zh-Hans": "出点（不含）",
    "zh-Hant": "出點（不含）",
    "en": "Out point (exclusive)",
    "ja": "アウト点（含まない）"
  },
  "timeline.range.setIn": {
    "zh-Hans": "以当前位置设入点",
    "zh-Hant": "將目前位置設為入點",
    "en": "Set in point at current position",
    "ja": "現在位置をイン点に設定"
  },
  "timeline.range.setOut": {
    "zh-Hans": "以当前位置设出点",
    "zh-Hant": "將目前位置設為出點",
    "en": "Set out point at current position",
    "ja": "現在位置をアウト点に設定"
  },
  "timeline.range.seekIn": {
    "zh-Hans": "跳到入点",
    "zh-Hant": "跳至入點",
    "en": "Go to in point",
    "ja": "イン点へ移動"
  },
  "timeline.range.seekOut": {
    "zh-Hans": "跳到出点",
    "zh-Hant": "跳至出點",
    "en": "Go to out point",
    "ja": "アウト点へ移動"
  },
  "timeline.range.previous": {
    "zh-Hans": "前 1 帧",
    "zh-Hant": "前 1 影格",
    "en": "Previous frame",
    "ja": "1 フレーム前"
  },
  "timeline.range.next": {
    "zh-Hans": "后 1 帧",
    "zh-Hant": "後 1 影格",
    "en": "Next frame",
    "ja": "1 フレーム後"
  },
  "timeline.range.needsFix": {
    "zh-Hans": "待修正",
    "zh-Hant": "待修正",
    "en": "Needs correction",
    "ja": "修正が必要"
  },
  "timeline.range.conflict": {
    "zh-Hans": "你的输入仍保留。放弃修改并载入已读取的最新范围后，才可继续保存。",
    "zh-Hant": "你的輸入仍保留。請捨棄修改並載入已讀取的最新範圍後，再繼續儲存。",
    "en": "Your input is retained. Discard changes and load the latest range already read before saving again.",
    "ja": "入力は保持されています。変更を破棄して、読み取り済みの最新範囲を読み込んでから再度保存してください。"
  },
  "timeline.range.save": {
    "zh-Hans": "保存源范围",
    "zh-Hant": "儲存來源範圍",
    "en": "Save source range",
    "ja": "ソース範囲を保存"
  },
  "timeline.range.add": {
    "zh-Hans": "将已保存范围加入时间线",
    "zh-Hant": "將已儲存範圍加入時間軸",
    "en": "Add saved range to timeline",
    "ja": "保存済み範囲をタイムラインに追加"
  },
  "timeline.range.discard": {
    "zh-Hans": "放弃修改并载入已读取范围",
    "zh-Hant": "捨棄修改並載入已讀取範圍",
    "en": "Discard changes and load the range already read",
    "ja": "変更を破棄して読み取り済みの範囲を読み込む"
  },
  "timeline.range.refresh": {
    "zh-Hans": "重新读取已保存范围",
    "zh-Hant": "重新讀取已儲存範圍",
    "en": "Read saved range again",
    "ja": "保存済み範囲を再読み込み"
  },
  "timeline.range.recovery": {
    "zh-Hans": "响应丢失时，请在任务面板恢复同一请求，不会自动重试。恢复凭据保存在当前窗口会话；关闭并重建原生窗口可能丢失凭据，请先核对已保存范围。",
    "zh-Hant": "回應遺失時，請在工作面板還原同一請求，不會自動重試。還原憑據儲存在目前視窗工作階段；關閉並重建原生視窗可能遺失憑據，請先核對已儲存範圍。",
    "en": "If the response is lost, recover the same request in the task panel. No automatic retry occurs. Recovery evidence is kept in this window session; closing and recreating a native window may lose it. Check the saved range first.",
    "ja": "応答が失われた場合はタスクパネルで同じリクエストを復元してください。自動で再試行はしません。復元情報は現在のウィンドウセッションに保持されるため、ネイティブウィンドウを閉じて作り直すと失われる場合があります。まず保存済み範囲を確認してください。"
  },
  "timeline.range.timebase": {
    "zh-Hans": "按固定 {fps} fps 编辑时基换算；不是原生帧率或 VFR 的逐帧精度。",
    "zh-Hant": "依固定 {fps} fps 編輯時基換算；不是原生影格率或 VFR 的逐影格精度。",
    "en": "Converted using a fixed {fps} fps editing timebase; not native-frame-rate or VFR frame-by-frame precision.",
    "ja": "固定 {fps} fps の編集タイムベースで換算します。ネイティブフレームレートや VFR のフレーム単位の精度ではありません。"
  },
  "timeline.range.saved": {
    "zh-Hans": "已保存范围 · 修订版 {revision}",
    "zh-Hant": "已儲存範圍 · 修訂版 {revision}",
    "en": "Saved range · revision {revision}",
    "ja": "保存済み範囲 · リビジョン {revision}"
  },
  "timeline.range.bounds": {
    "zh-Hans": "源长度：{length} · 出点不包含在范围内",
    "zh-Hant": "來源長度：{length} · 出點不包含在範圍內",
    "en": "Source length: {length} · Out point is excluded",
    "ja": "ソースの長さ：{length} · アウト点は範囲に含まれません"
  },
  "timeline.range.position": {
    "zh-Hans": "当前源位置 {frame} 帧",
    "zh-Hant": "目前來源位置 {frame} 影格",
    "en": "Current source position: frame {frame}",
    "ja": "現在のソース位置：{frame} フレーム"
  },
  "timeline.range.selection": {
    "zh-Hans": "选取长度：{length}。保存范围不会修改媒体文件或已有片段。",
    "zh-Hant": "選取長度：{length}。儲存範圍不會修改媒體檔案或既有片段。",
    "en": "Selected length: {length}. Saving the range does not change media files or existing clips.",
    "ja": "選択した長さ：{length}。範囲を保存してもメディアファイルや既存のクリップは変更されません。"
  },
  "timeline.range.error.durationUnknown": {
    "zh-Hans": "素材时长未知，无法设置源范围。",
    "zh-Hant": "素材時長未知，無法設定來源範圍。",
    "en": "Asset duration is unknown; the source range cannot be set.",
    "ja": "素材の長さが不明なため、ソース範囲を設定できません。"
  },
  "timeline.range.error.required": {
    "zh-Hans": "请填写整数入点和出点。",
    "zh-Hant": "請填寫整數入點與出點。",
    "en": "Enter integer in and out points.",
    "ja": "イン点とアウト点を整数で入力してください。"
  },
  "timeline.range.error.integer": {
    "zh-Hans": "入点和出点必须为整数帧。",
    "zh-Hant": "入點與出點必須為整數影格。",
    "en": "In and out points must be integer frames.",
    "ja": "イン点とアウト点は整数フレームにしてください。"
  },
  "timeline.range.error.invalidReply": {
    "zh-Hans": "源范围响应无效，草稿仍保留。",
    "zh-Hant": "來源範圍回應無效，草稿仍保留。",
    "en": "The source-range response is invalid. Your draft is retained.",
    "ja": "ソース範囲の応答が無効です。下書きは保持されています。"
  },
  "timeline.range.error.inconsistentReply": {
    "zh-Hans": "源范围确认不一致，请重新核对。",
    "zh-Hant": "來源範圍確認不一致，請重新核對。",
    "en": "The source-range acknowledgement is inconsistent. Check again.",
    "ja": "ソース範囲の確認応答が一致しません。再確認してください。"
  },
  "timeline.range.error.readFailed": {
    "zh-Hans": "无法读取源范围，草稿仍保留。",
    "zh-Hant": "無法讀取來源範圍，草稿仍保留。",
    "en": "The source range could not be read. Your draft is retained.",
    "ja": "ソース範囲を読み取れませんでした。下書きは保持されています。"
  },
  "timeline.range.error.saveUnconfirmed": {
    "zh-Hans": "保存尚未确认；草稿已保留。请检查任务中的原请求或重新读取范围。",
    "zh-Hant": "儲存尚未確認；草稿已保留。請檢查工作中的原請求或重新讀取範圍。",
    "en": "Saving is unconfirmed; your draft is retained. Check the original request in tasks or read the range again.",
    "ja": "保存は未確認で、下書きは保持されています。タスクの元のリクエストを確認するか、範囲を再読み込みしてください。"
  },
  "timeline.range.error.saveMismatch": {
    "zh-Hans": "保存确认与原请求不一致；草稿已保留。",
    "zh-Hant": "儲存確認與原請求不符；草稿已保留。",
    "en": "The save acknowledgement does not match the original request. Your draft is retained.",
    "ja": "保存の確認応答が元のリクエストと一致しません。下書きは保持されています。"
  },
  "timeline.range.error.newerRange": {
    "zh-Hans": "范围已出现更新版本；已保留当前输入，请核对后继续。",
    "zh-Hant": "範圍已有更新版本；目前輸入已保留，請核對後繼續。",
    "en": "A newer range version is available. Your current input is retained; review it before continuing.",
    "ja": "範囲に新しいバージョンがあります。現在の入力は保持されています。確認してから続けてください。"
  },
  "timeline.range.error.saveFailed": {
    "zh-Hans": "保存未完成，草稿已保留。",
    "zh-Hant": "儲存未完成，草稿已保留。",
    "en": "Saving did not complete. Your draft is retained.",
    "ja": "保存は完了していません。下書きは保持されています。"
  },
  "timeline.range.error.pending": {
    "zh-Hans": "请先确认正在处理的范围或时间线请求。",
    "zh-Hant": "請先確認正在處理的範圍或時間軸請求。",
    "en": "Confirm the range or timeline request currently in progress first.",
    "ja": "先に処理中の範囲またはタイムラインのリクエストを確認してください。"
  },
  "timeline.range.error.saveFirst": {
    "zh-Hans": "请先明确保存源范围，且确保没有未保存修改。",
    "zh-Hant": "請先明確儲存來源範圍，並確保沒有未儲存修改。",
    "en": "Explicitly save the source range first and ensure there are no unsaved changes.",
    "ja": "先にソース範囲を明示的に保存し、未保存の変更がないことを確認してください。"
  },
  "timeline.range.error.changed": {
    "zh-Hans": "源素材或时间线已变化，请重新选择。",
    "zh-Hant": "來源素材或時間軸已變更，請重新選擇。",
    "en": "The source asset or timeline changed. Select again.",
    "ja": "ソース素材またはタイムラインが変わりました。選択し直してください。"
  },
  "timeline.range.error.savedInteger": {
    "zh-Hans": "已保存范围必须使用整数帧。",
    "zh-Hant": "已儲存範圍必須使用整數影格。",
    "en": "The saved range must use integer frames.",
    "ja": "保存済み範囲は整数フレームである必要があります。"
  },
  "timeline.range.error.audioTrack": {
    "zh-Hans": "请先创建兼容的音频轨道。",
    "zh-Hant": "請先建立相容的音訊軌道。",
    "en": "Create a compatible audio track first.",
    "ja": "先に互換性のある音声トラックを作成してください。"
  },
  "timeline.range.error.videoTrack": {
    "zh-Hans": "请先创建兼容的画面轨道。",
    "zh-Hant": "請先建立相容的畫面軌道。",
    "en": "Create a compatible video track first.",
    "ja": "先に互換性のある映像トラックを作成してください。"
  },
  "timeline.range.error.tooLong": {
    "zh-Hans": "追加后的终点超过时间线 18000 帧上限；请缩短已保存范围或调整轨道。",
    "zh-Hant": "追加後的終點超出時間軸 18000 影格上限；請縮短已儲存範圍或調整軌道。",
    "en": "Appending would exceed the timeline’s 18000-frame limit. Shorten the saved range or adjust the track.",
    "ja": "追加後の終了位置がタイムラインの上限 18000 フレームを超えます。保存済み範囲を短くするか、トラックを調整してください。"
  },
  "timeline.range.error.clipLimit": {
    "zh-Hans": "时间线最多容纳 100 个片段。",
    "zh-Hant": "時間軸最多容納 100 個片段。",
    "en": "The timeline allows at most 100 clips.",
    "ja": "タイムラインのクリップ数は最大 100 個です。"
  },
  "timeline.range.error.bounds": {
    "zh-Hans": "范围必须满足 0 ≤ 入点 < 出点 ≤ {count}。",
    "zh-Hant": "範圍必須符合 0 ≤ 入點 < 出點 ≤ {count}。",
    "en": "The range must satisfy 0 ≤ in point < out point ≤ {count}.",
    "ja": "範囲は 0 ≤ イン点 < アウト点 ≤ {count} を満たす必要があります。"
  },
  "audio.preview.retirementFailed": {
    "zh-Hans": "上一次声音资源未能确认释放，已阻止再次准备。请重新打开编辑器后再试。",
    "zh-Hant": "上一次聲音資源尚未確認釋放，已阻止再次準備。請重新開啟編輯器後再試。",
    "en": "Release of the previous audio resources is unconfirmed, so preparing again is blocked. Reopen the editor and try again.",
    "ja": "前の音声リソースの解放を確認できないため、再準備をブロックしました。エディターを開き直して再試行してください。"
  },
  "audio.preview.retirementClosing": {
    "zh-Hans": "正在释放上一次声音资源，确认完成后可明确重新准备。",
    "zh-Hant": "正在釋放上一次聲音資源，確認完成後可明確重新準備。",
    "en": "Releasing previous audio resources. After release is confirmed, you can explicitly prepare again.",
    "ja": "前の音声リソースを解放中です。完了が確認された後、明示的に再準備できます。"
  },
  "audio.preview.restored": {
    "zh-Hans": "恢复分支暂不支持已保存时间线声音试听。",
    "zh-Hant": "還原分支暫不支援已儲存時間軸的聲音試聽。",
    "en": "Saved-timeline audio preview is unavailable in restored branches.",
    "ja": "復元ブランチでは、保存済みタイムラインの音声プレビューを利用できません。"
  },
  "audio.preview.offline": {
    "zh-Hans": "连接恢复后可明确准备声音。",
    "zh-Hant": "連線恢復後可明確準備聲音。",
    "en": "You can explicitly prepare audio after reconnecting.",
    "ja": "再接続後に音声を明示的に準備できます。"
  },
  "audio.preview.hidden": {
    "zh-Hans": "试听面板隐藏后已释放声音，请重新准备。",
    "zh-Hant": "試聽面板隱藏後已釋放聲音，請重新準備。",
    "en": "Audio was released when the preview panel was hidden. Prepare it again.",
    "ja": "試聴パネルが非表示になったため音声を解放しました。再準備してください。"
  },
  "audio.preview.nativeBlocked": {
    "zh-Hans": "上一窗口的声音资源尚未确认释放，当前试听已被阻止。",
    "zh-Hant": "上一個視窗的聲音資源尚未確認釋放，目前試聽已被阻止。",
    "en": "Release of the previous window’s audio resources is unconfirmed. This preview is blocked.",
    "ja": "前のウィンドウの音声リソースの解放が未確認のため、今回の試聴をブロックしました。"
  },
  "audio.preview.nativeWaiting": {
    "zh-Hans": "正在等待另一窗口释放声音资源，尚未开始准备当前声音。",
    "zh-Hant": "正在等待另一個視窗釋放聲音資源，尚未開始準備目前聲音。",
    "en": "Waiting for another window to release audio resources. Preparation of this audio has not started.",
    "ja": "別のウィンドウによる音声リソースの解放を待っています。現在の音声の準備はまだ開始していません。"
  },
  "audio.preview.checking": {
    "zh-Hans": "正在核对已保存区间与声音容量…",
    "zh-Hant": "正在核對已儲存區間與聲音容量…",
    "en": "Checking the saved interval and audio capacity…",
    "ja": "保存済み区間と音声の容量を確認中…"
  },
  "audio.preview.starting": {
    "zh-Hans": "正在启动声音播放…",
    "zh-Hant": "正在啟動聲音播放…",
    "en": "Starting audio playback…",
    "ja": "音声再生を開始中…"
  },
  "audio.preview.playing": {
    "zh-Hans": "正在播放本区间的声音。",
    "zh-Hant": "正在播放此區間的聲音。",
    "en": "Playing audio for this interval.",
    "ja": "この区間の音声を再生中です。"
  },
  "audio.preview.paused": {
    "zh-Hans": "声音已暂停，可继续或在本区间定位。",
    "zh-Hant": "聲音已暫停，可繼續或在此區間定位。",
    "en": "Audio is paused. Resume or seek within this interval.",
    "ja": "音声は一時停止中です。再開するか、この区間内の位置を指定できます。"
  },
  "audio.preview.ended": {
    "zh-Hans": "本区间已结束；这不代表整条时间线已播放完。",
    "zh-Hant": "此區間已結束；不代表整條時間軸已播放完畢。",
    "en": "This interval has ended. This does not mean the entire timeline has finished playing.",
    "ja": "この区間は終了しました。タイムライン全体の再生が終わったことを意味するものではありません。"
  },
  "audio.preview.ready": {
    "zh-Hans": "完整区间已准备，请明确播放。",
    "zh-Hant": "完整區間已準備，請明確播放。",
    "en": "The full interval is prepared. Start playback explicitly.",
    "ja": "区間全体を準備しました。明示的に再生を開始してください。"
  },
  "audio.preview.silentReady": {
    "zh-Hans": "本区间为静音；已准备，可明确播放。",
    "zh-Hant": "此區間為靜音；已準備，可明確播放。",
    "en": "This interval is silent. It is prepared and can be played explicitly.",
    "ja": "この区間は無音です。準備済みなので、明示的に再生できます。"
  },
  "audio.preview.released": {
    "zh-Hans": "声音已释放，需要时请重新准备。",
    "zh-Hant": "聲音已釋放，需要時請重新準備。",
    "en": "Audio has been released. Prepare it again when needed.",
    "ja": "音声を解放しました。必要に応じて再準備してください。"
  },
  "audio.preview.idle": {
    "zh-Hans": "从当前播放头准备声音，每次最多 20 秒。",
    "zh-Hant": "從目前播放頭準備聲音，每次最多 20 秒。",
    "en": "Prepare audio from the current playhead, up to 20 seconds at a time.",
    "ja": "現在の再生ヘッドから、一度に最大 20 秒の音声を準備します。"
  },
  "audio.preview.region": {
    "zh-Hans": "已保存时间线声音试听",
    "zh-Hant": "已儲存時間軸聲音試聽",
    "en": "Saved-timeline audio preview",
    "ja": "保存済みタイムラインの音声試聴"
  },
  "audio.preview.title": {
    "zh-Hans": "声音试听",
    "zh-Hant": "聲音試聽",
    "en": "Audio preview",
    "ja": "音声試聴"
  },
  "audio.preview.empty": {
    "zh-Hans": "已保存时间线暂无可试听区间。",
    "zh-Hant": "已儲存時間軸尚無可試聽區間。",
    "en": "The saved timeline has no interval available for audio preview.",
    "ja": "保存済みタイムラインには試聴できる区間がありません。"
  },
  "audio.preview.outside": {
    "zh-Hans": "当前播放头不在已保存时间线内，暂无可准备区间。",
    "zh-Hant": "目前播放頭不在已儲存時間軸內，尚無可準備區間。",
    "en": "The current playhead is outside the saved timeline. No interval can be prepared.",
    "ja": "現在の再生ヘッドは保存済みタイムラインの外にあるため、準備できる区間がありません。"
  },
  "audio.preview.draftWarning": {
    "zh-Hans": "尚未保存的编辑不包含在试听中；草稿会保留。",
    "zh-Hant": "尚未儲存的編輯不包含在試聽中；草稿會保留。",
    "en": "Unsaved edits are not included in audio preview. Your drafts are retained.",
    "ja": "未保存の編集内容は試聴に含まれません。下書きは保持されます。"
  },
  "audio.preview.prepareAgain": {
    "zh-Hans": "重新准备当前区间",
    "zh-Hant": "重新準備目前區間",
    "en": "Prepare current interval again",
    "ja": "現在の区間を再準備"
  },
  "audio.preview.prepare": {
    "zh-Hans": "准备当前区间",
    "zh-Hant": "準備目前區間",
    "en": "Prepare current interval",
    "ja": "現在の区間を準備"
  },
  "audio.preview.cancel": {
    "zh-Hans": "取消准备",
    "zh-Hant": "取消準備",
    "en": "Cancel preparation",
    "ja": "準備をキャンセル"
  },
  "audio.preview.resume": {
    "zh-Hans": "继续播放",
    "zh-Hant": "繼續播放",
    "en": "Resume playback",
    "ja": "再生を再開"
  },
  "audio.preview.replay": {
    "zh-Hans": "重播本区间",
    "zh-Hant": "重播此區間",
    "en": "Replay this interval",
    "ja": "この区間を再再生"
  },
  "audio.preview.play": {
    "zh-Hans": "播放本区间",
    "zh-Hant": "播放此區間",
    "en": "Play this interval",
    "ja": "この区間を再生"
  },
  "audio.preview.pause": {
    "zh-Hans": "暂停",
    "zh-Hant": "暫停",
    "en": "Pause",
    "ja": "一時停止"
  },
  "audio.preview.stop": {
    "zh-Hans": "停止并释放",
    "zh-Hant": "停止並釋放",
    "en": "Stop and release",
    "ja": "停止して解放"
  },
  "audio.preview.position": {
    "zh-Hans": "本区间定位",
    "zh-Hant": "此區間定位",
    "en": "Seek within interval",
    "ja": "区間内の位置を指定"
  },
  "audio.preview.seek": {
    "zh-Hans": "声音试听区间定位",
    "zh-Hant": "聲音試聽區間定位",
    "en": "Seek within audio preview interval",
    "ja": "音声試聴区間内の位置を指定"
  },
  "audio.preview.disclosure": {
    "zh-Hans": "已渲染视频单独播放，不与此声音试听同步。48 kHz 双声道；不做响度归一化或限幅。试听采用浮点混音，旧版 16 位导出可能在混音中削波；float-v2 导出会拒绝超过满幅的混音。",
    "zh-Hant": "已算繪影片獨立播放，不會與此聲音試聽同步。48 kHz 雙聲道；不做響度正規化或限幅。試聽採用浮點混音，舊版 16 位元匯出可能在混音時削波；float-v2 匯出會拒絕超過滿幅的混音。",
    "en": "Rendered video plays separately and is not synchronized with this audio preview. 48 kHz stereo, with no loudness normalization or limiting. Preview uses floating-point mixing; legacy 16-bit exports may clip during mixing. float-v2 export rejects mixes above full scale.",
    "ja": "レンダリング済み動画は別に再生され、この音声試聴とは同期しません。48 kHz ステレオで、ラウドネスの正規化やリミッター処理は行いません。試聴では浮動小数点ミックスを使用します。旧 16 ビット書き出しではミックス時にクリッピングする場合があります。float-v2 書き出しはフルスケールを超えるミックスを拒否します。"
  },
  "audio.preview.preparing": {
    "zh-Hans": "正在准备完整区间的声音 {prepared}/{total}…",
    "zh-Hant": "正在準備完整區間的聲音 {prepared}/{total}…",
    "en": "Preparing audio for the full interval {prepared}/{total}…",
    "ja": "区間全体の音声を準備中 {prepared}/{total}…"
  },
  "audio.preview.revision": {
    "zh-Hans": "仅声音 · 已保存 修订版 {revision}",
    "zh-Hant": "僅聲音 · 已儲存 修訂版 {revision}",
    "en": "Audio only · Saved revision {revision}",
    "ja": "音声のみ · 保存済み リビジョン {revision}"
  },
  "audio.preview.range": {
    "zh-Hans": "区间 [{fromTime}, {toTime}) · 帧 {from}–{to} · 最多 20 秒",
    "zh-Hant": "區間 [{fromTime}, {toTime}) · 影格 {from}–{to} · 最多 20 秒",
    "en": "Interval [{fromTime}, {toTime}) · Frames {from}–{to} · Up to 20 seconds",
    "ja": "区間 [{fromTime}, {toTime}) · {from}–{to} フレーム · 最大 20 秒"
  },
  "audio.preview.positionValue": {
    "zh-Hans": "{time}，第 {frame} 帧",
    "zh-Hant": "{time}，第 {frame} 影格",
    "en": "{time}, frame {frame}",
    "ja": "{time}、{frame} フレーム"
  },
  "audio.preview.error.nativeBusy": {
    "zh-Hans": "另一个窗口正在等待声音资源，请稍后明确准备。",
    "zh-Hant": "另一個視窗正在等待聲音資源，請稍後明確準備。",
    "en": "Another window is waiting for audio resources. Explicitly prepare again later.",
    "ja": "別のウィンドウが音声リソースを待っています。後で明示的に準備してください。"
  },
  "audio.preview.error.nativeUnavailable": {
    "zh-Hans": "当前原生试听身份无法确认，未开始解码，请重新打开此编辑器后再试。",
    "zh-Hant": "無法確認目前原生試聽的識別資訊，尚未開始解碼，請重新開啟此編輯器後再試。",
    "en": "This native preview’s identity cannot be verified. Decoding has not started. Reopen this editor and try again.",
    "ja": "現在のネイティブ試聴の識別情報を確認できないため、デコードは開始していません。このエディターを開き直して再試行してください。"
  },
  "audio.preview.error.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后明确准备声音。",
    "zh-Hant": "工作階段已過期，請重新登入後明確準備聲音。",
    "en": "Your session expired. Sign in again and explicitly prepare audio.",
    "ja": "セッションの有効期限が切れました。再ログインして、音声を明示的に準備してください。"
  },
  "audio.preview.error.memory": {
    "zh-Hans": "此完整区间超出声音试听容量，未省略音轨。可使用单独的已渲染视频预览。",
    "zh-Hant": "此完整區間超出聲音試聽容量，未省略音軌。可使用獨立的已算繪影片預覽。",
    "en": "The full interval exceeds audio preview capacity. No tracks were omitted. You can use the separate rendered video preview.",
    "ja": "区間全体が音声試聴の容量を超えています。トラックは省略していません。別のレンダリング済み動画プレビューを使用できます。"
  },
  "audio.preview.error.timeout": {
    "zh-Hans": "声音准备超过 120 秒预算，未保留部分音轨。请重新准备。",
    "zh-Hant": "聲音準備超過 120 秒限制，未保留部分音軌。請重新準備。",
    "en": "Audio preparation exceeded its 120-second budget. Partial tracks were not retained. Prepare again.",
    "ja": "音声の準備が 120 秒の制限を超えました。一部だけのトラックは保持していません。再準備してください。"
  },
  "audio.preview.error.busy": {
    "zh-Hans": "另一声音准备尚未结束，请稍后明确重试。",
    "zh-Hant": "另一個聲音準備尚未結束，請稍後明確重試。",
    "en": "Another audio preparation is still unfinished. Retry explicitly later.",
    "ja": "別の音声準備がまだ終了していません。後で明示的に再試行してください。"
  },
  "audio.preview.error.sourceLimit": {
    "zh-Hans": "此区间的来源文件超出声音试听限制，未省略音轨。",
    "zh-Hant": "此區間的來源檔案超出聲音試聽限制，未省略音軌。",
    "en": "Source files in this interval exceed audio preview limits. No tracks were omitted.",
    "ja": "この区間のソースファイルが音声試聴の制限を超えています。トラックは省略していません。"
  },
  "audio.preview.error.stale": {
    "zh-Hans": "已保存时间线或来源已变化，请重新准备。",
    "zh-Hant": "已儲存時間軸或來源已變更，請重新準備。",
    "en": "The saved timeline or source changed. Prepare again.",
    "ja": "保存済みタイムラインまたはソースが変わりました。再準備してください。"
  },
  "audio.preview.error.unknownAudio": {
    "zh-Hans": "来源的音频信息尚不明确，完整区间未能准备。",
    "zh-Hant": "來源音訊資訊尚不明確，無法準備完整區間。",
    "en": "Source audio information is unclear. The full interval could not be prepared.",
    "ja": "ソースの音声情報が不明なため、区間全体を準備できませんでした。"
  },
  "audio.preview.error.format": {
    "zh-Hans": "此区间包含暂不支持的音频格式，未省略该音轨。",
    "zh-Hant": "此區間含有暫不支援的音訊格式，未省略該音軌。",
    "en": "This interval contains an unsupported audio format. That track was not omitted.",
    "ja": "この区間には非対応の音声形式が含まれています。そのトラックは省略していません。"
  },
  "audio.preview.error.bounds": {
    "zh-Hans": "已保存片段超出当前来源的音频范围，请核对来源后重新准备。",
    "zh-Hant": "已儲存片段超出目前來源的音訊範圍，請核對來源後重新準備。",
    "en": "A saved clip exceeds the current source’s audio bounds. Check the source and prepare again.",
    "ja": "保存済みクリップが現在のソースの音声範囲を超えています。ソースを確認して再準備してください。"
  },
  "audio.preview.error.decode": {
    "zh-Hans": "来源声音解码不完整或无效，完整区间未能准备。",
    "zh-Hant": "來源聲音解碼不完整或無效，無法準備完整區間。",
    "en": "Source audio decoding was incomplete or invalid. The full interval could not be prepared.",
    "ja": "ソース音声のデコードが不完全または無効のため、区間全体を準備できませんでした。"
  },
  "audio.preview.error.budget": {
    "zh-Hans": "此区间涉及的原始片段超出声音解码预算，完整区间未能准备。可使用单独的已渲染视频预览。",
    "zh-Hant": "此區間涉及的原始片段超出聲音解碼限制，無法準備完整區間。可使用獨立的已算繪影片預覽。",
    "en": "The original clips involved exceed the audio decoding budget, so the full interval could not be prepared. You can use the separate rendered video preview.",
    "ja": "この区間の元クリップが音声デコードの制限を超えたため、区間全体を準備できませんでした。別のレンダリング済み動画プレビューを使用できます。"
  },
  "audio.preview.error.stopPending": {
    "zh-Hans": "上一声音解码尚未确认结束，请等待释放后明确重试。",
    "zh-Hant": "上一次聲音解碼尚未確認結束，請等待釋放後明確重試。",
    "en": "Completion of the previous audio decoding is unconfirmed. Wait for release, then retry explicitly.",
    "ja": "前の音声デコードの終了は未確認です。解放を待ってから明示的に再試行してください。"
  },
  "audio.preview.error.contextClosedPreparing": {
    "zh-Hans": "试听音频时钟在准备过程中已关闭，请明确重新准备。",
    "zh-Hant": "試聽音訊時鐘在準備過程中已關閉，請明確重新準備。",
    "en": "The preview audio clock closed during preparation. Explicitly prepare again.",
    "ja": "準備中に試聴の音声クロックが閉じられました。明示的に再準備してください。"
  },
  "audio.preview.error.sampleRate": {
    "zh-Hans": "当前音频设备无法建立 48 kHz 试听时钟。",
    "zh-Hant": "目前音訊裝置無法建立 48 kHz 試聽時鐘。",
    "en": "The current audio device cannot create a 48 kHz preview clock.",
    "ja": "現在の音声デバイスでは 48 kHz の試聴クロックを作成できません。"
  },
  "audio.preview.error.unsupported": {
    "zh-Hans": "此环境暂不支持已保存时间线声音试听。",
    "zh-Hant": "此環境暫不支援已儲存時間軸的聲音試聽。",
    "en": "This environment does not support saved-timeline audio preview.",
    "ja": "この環境は保存済みタイムラインの音声試聴に対応していません。"
  },
  "audio.preview.error.protocol": {
    "zh-Hans": "声音响应不完整或与当前区间不匹配，请重新准备。",
    "zh-Hant": "聲音回應不完整或與目前區間不符，請重新準備。",
    "en": "The audio response is incomplete or does not match the current interval. Prepare again.",
    "ja": "音声の応答が不完全か、現在の区間と一致しません。再準備してください。"
  },
  "audio.preview.error.failed": {
    "zh-Hans": "声音试听未完成，请确认连接与音频设备后重新准备。",
    "zh-Hant": "聲音試聽未完成，請確認連線與音訊裝置後重新準備。",
    "en": "Audio preview did not complete. Check the connection and audio device, then prepare again.",
    "ja": "音声試聴は完了していません。接続と音声デバイスを確認して再準備してください。"
  },
  "audio.preview.error.outside": {
    "zh-Hans": "已离开准备区间，请明确准备新的最多 20 秒声音。",
    "zh-Hant": "已離開準備區間，請明確準備新的最多 20 秒聲音。",
    "en": "The prepared interval has been left. Explicitly prepare a new interval of up to 20 seconds.",
    "ja": "準備済み区間の外に出ました。最大 20 秒の新しい区間を明示的に準備してください。"
  },
  "audio.preview.error.suspended": {
    "zh-Hans": "音频设备或系统暂停了试听时钟，请明确重新准备。",
    "zh-Hant": "音訊裝置或系統暫停了試聽時鐘，請明確重新準備。",
    "en": "The audio device or system suspended the preview clock. Explicitly prepare again.",
    "ja": "音声デバイスまたはシステムが試聴クロックを一時停止しました。明示的に再準備してください。"
  },
  "audio.preview.error.closed": {
    "zh-Hans": "试听音频时钟已关闭，请明确重新准备。",
    "zh-Hant": "試聽音訊時鐘已關閉，請明確重新準備。",
    "en": "The preview audio clock is closed. Explicitly prepare again.",
    "ja": "試聴の音声クロックが閉じられました。明示的に再準備してください。"
  },
  "audio.preview.error.outputFailed": {
    "zh-Hans": "音频输出设备发生错误，请检查设备后重新准备。",
    "zh-Hant": "音訊輸出裝置發生錯誤，請檢查裝置後重新準備。",
    "en": "The audio output device encountered an error. Check the device and prepare again.",
    "ja": "音声出力デバイスでエラーが発生しました。デバイスを確認して再準備してください。"
  },
  "audio.preview.error.resumeFailed": {
    "zh-Hans": "音频时钟未能启动，请检查播放权限或设备后重新准备。",
    "zh-Hant": "音訊時鐘無法啟動，請檢查播放權限或裝置後重新準備。",
    "en": "The audio clock could not start. Check playback permissions or the device, then prepare again.",
    "ja": "音声クロックを開始できませんでした。再生権限またはデバイスを確認して再準備してください。"
  },
  "audio.preview.error.scheduleFailed": {
    "zh-Hans": "完整声音区间未能启动，已释放全部声音，请重新准备。",
    "zh-Hant": "完整聲音區間無法啟動，已釋放全部聲音，請重新準備。",
    "en": "The full audio interval could not start. All audio was released. Prepare again.",
    "ja": "音声区間全体を開始できなかったため、すべての音声を解放しました。再準備してください。"
  },
  "audio.preview.error.stopped": {
    "zh-Hans": "声音播放已停止，请明确重新准备。",
    "zh-Hant": "聲音播放已停止，請明確重新準備。",
    "en": "Audio playback stopped. Explicitly prepare again.",
    "ja": "音声再生を停止しました。明示的に再準備してください。"
  },
  "subtitles.ui.title": {
    "zh-Hans": "手动字幕",
    "zh-Hant": "手動字幕",
    "en": "Manual subtitles",
    "ja": "手動字幕"
  },
  "subtitles.ui.fixed": {
    "zh-Hans": "固定排版",
    "zh-Hant": "固定排版",
    "en": "Fixed layout",
    "ja": "固定レイアウト"
  },
  "subtitles.ui.back": {
    "zh-Hans": "返回属性",
    "zh-Hant": "返回屬性",
    "en": "Back to properties",
    "ja": "プロパティに戻る"
  },
  "subtitles.ui.limits": {
    "zh-Hans": "底部居中 · 常用汉字、ASCII 与支持的标点 · 1–2 行，每行最多 20 个 Unicode 字符。文字原样保存，不自动换行或删改。",
    "zh-Hant": "底部置中 · 常用漢字、ASCII 與支援的標點 · 1–2 行，每行最多 20 個 Unicode 字元。文字原樣儲存，不會自動換行或刪改。",
    "en": "Bottom center · Common Chinese characters, ASCII, and supported punctuation · 1–2 lines, up to 20 Unicode characters per line. Text is saved exactly as entered, without automatic wrapping or edits.",
    "ja": "下部中央 · 対応する常用漢字、ASCII、句読点 · 1–2 行、各行最大 20 Unicode 文字。テキストは入力どおりに保存され、自動改行や書き換えはしません。"
  },
  "subtitles.ui.renderNote": {
    "zh-Hans": "源素材保持原样。字幕烧录在时间线渲染预览和导出中；此处文字框不是最终画面预览。",
    "zh-Hant": "來源素材保持原樣。字幕會燒錄在時間軸算繪預覽與匯出中；此處文字框不是最終畫面預覽。",
    "en": "Source assets remain unchanged. Subtitles are burned into rendered timeline previews and exports; this text box is not a preview of the final image.",
    "ja": "ソース素材は変更しません。字幕はタイムラインのレンダリングプレビューと書き出しに焼き込まれます。このテキスト欄は最終映像のプレビューではありません。"
  },
  "subtitles.ui.checking": {
    "zh-Hans": "正在核对当前时间线。",
    "zh-Hant": "正在核對目前時間軸。",
    "en": "Checking the current timeline.",
    "ja": "現在のタイムラインを確認中です。"
  },
  "subtitles.ui.noPreview": {
    "zh-Hans": "尚无渲染预览。保存后点击时间线的「渲染预览」。",
    "zh-Hant": "尚無算繪預覽。儲存後請點選時間軸的「算繪預覽」。",
    "en": "No rendered preview yet. After saving, choose “Render preview” on the timeline.",
    "ja": "レンダリング済みプレビューはまだありません。保存後、タイムラインの「プレビューをレンダリング」を選択してください。"
  },
  "subtitles.ui.saving": {
    "zh-Hans": "正在保存字幕…",
    "zh-Hant": "正在儲存字幕…",
    "en": "Saving subtitle…",
    "ja": "字幕を保存中…"
  },
  "subtitles.ui.unconfirmed": {
    "zh-Hans": "原请求结果待确认",
    "zh-Hant": "原請求結果待確認",
    "en": "Original request outcome unconfirmed",
    "ja": "元のリクエストの結果は未確認"
  },
  "subtitles.ui.dirty": {
    "zh-Hans": "有未保存的字幕修改",
    "zh-Hant": "有未儲存的字幕修改",
    "en": "Unsaved subtitle changes",
    "ja": "未保存の字幕変更あり"
  },
  "subtitles.ui.saved": {
    "zh-Hans": "已保存的字幕",
    "zh-Hant": "已儲存的字幕",
    "en": "Saved subtitle",
    "ja": "保存済み字幕"
  },
  "subtitles.ui.selectHint": {
    "zh-Hans": "在时间线选择字幕，或在播放头处新增。",
    "zh-Hant": "在時間軸選擇字幕，或在播放頭處新增。",
    "en": "Select a subtitle on the timeline or add one at the playhead.",
    "ja": "タイムライン上で字幕を選択するか、再生ヘッドの位置に追加してください。"
  },
  "subtitles.ui.text": {
    "zh-Hans": "字幕文字（原样保存）",
    "zh-Hant": "字幕文字（原樣儲存）",
    "en": "Subtitle text (saved exactly as entered)",
    "ja": "字幕テキスト（入力どおりに保存）"
  },
  "subtitles.ui.conflict": {
    "zh-Hans": "时间线已变化，草稿仍保留。放弃修改并载入已保存内容后，才可继续保存。",
    "zh-Hant": "時間軸已變更，草稿仍保留。請捨棄修改並載入已儲存內容後，再繼續儲存。",
    "en": "The timeline changed; your draft is retained. Discard changes and load saved content before saving again.",
    "ja": "タイムラインが変わりましたが、下書きは保持されています。変更を破棄して保存済み内容を読み込んでから、再度保存してください。"
  },
  "subtitles.ui.tasks": {
    "zh-Hans": "打开任务中心",
    "zh-Hant": "開啟工作中心",
    "en": "Open task center",
    "ja": "タスクセンターを開く"
  },
  "subtitles.ui.punctuation": {
    "zh-Hans": "支持的中文标点",
    "zh-Hant": "支援的中文標點",
    "en": "Supported Chinese punctuation",
    "ja": "対応する中国語の句読点"
  },
  "subtitles.ui.characterSupport": {
    "zh-Hans": "ASCII 空格、英文、数字和标点可用；不支持表情、组合字符和其他文字系统。",
    "zh-Hant": "可使用 ASCII 空格、英文、數字和標點；不支援表情符號、組合字元或其他文字系統。",
    "en": "ASCII spaces, English letters, numbers, and punctuation are supported. Emoji, combining characters, and other writing systems are not supported.",
    "ja": "ASCII の空白、英字、数字、記号を使用できます。絵文字、結合文字、その他の文字体系には対応していません。"
  },
  "subtitles.ui.retained": {
    "zh-Hans": "切换右侧标签、返回属性或收起面板会保留字幕草稿。响应丢失时只恢复任务中心的原请求。",
    "zh-Hant": "切換右側分頁、返回屬性或收合面板，會保留字幕草稿。回應遺失時僅還原工作中心的原請求。",
    "en": "Switching right-side tabs, returning to properties, or collapsing the panel retains the subtitle draft. If a response is lost, recover only the original request in the task center.",
    "ja": "右側のタブ切り替え、プロパティに戻る操作、パネルの折りたたみでも字幕の下書きは保持されます。応答が失われた場合は、タスクセンターの元のリクエストのみを復元してください。"
  },
  "subtitles.ui.save": {
    "zh-Hans": "保存字幕",
    "zh-Hant": "儲存字幕",
    "en": "Save subtitle",
    "ja": "字幕を保存"
  },
  "subtitles.ui.remove": {
    "zh-Hans": "移除字幕",
    "zh-Hant": "移除字幕",
    "en": "Remove subtitle",
    "ja": "字幕を削除"
  },
  "subtitles.ui.removeConfirm": {
    "zh-Hans": "从时间线移除此字幕？可通过时间线撤销恢复。",
    "zh-Hant": "要從時間軸移除此字幕嗎？可透過時間軸復原功能還原。",
    "en": "Remove this subtitle from the timeline? You can restore it with timeline undo.",
    "ja": "この字幕をタイムラインから削除しますか？タイムラインの取り消しで戻せます。"
  },
  "subtitles.ui.add": {
    "zh-Hans": "在播放头处新增",
    "zh-Hant": "在播放頭處新增",
    "en": "Add at playhead",
    "ja": "再生ヘッドに追加"
  },
  "subtitles.ui.timeline": {
    "zh-Hans": "字幕时间线",
    "zh-Hant": "字幕時間軸",
    "en": "Subtitle timeline",
    "ja": "字幕タイムライン"
  },
  "subtitles.ui.empty": {
    "zh-Hans": "在播放头处新增，随后在右侧编辑文字与整数帧",
    "zh-Hant": "在播放頭處新增，再於右側編輯文字與整數影格",
    "en": "Add at the playhead, then edit text and integer frames on the right",
    "ja": "再生ヘッドに追加し、右側でテキストと整数フレームを編集"
  },
  "subtitles.ui.stale": {
    "zh-Hans": "已有渲染是旧快照 修订版 {rendered}，当前 修订版 {current}，请重新渲染。",
    "zh-Hant": "既有算繪為舊快照 修訂版 {rendered}，目前為 修訂版 {current}，請重新算繪。",
    "en": "The existing render is an old snapshot, revision {rendered}; the current revision is {current}. Render again.",
    "ja": "既存のレンダリングは古いスナップショット リビジョン {rendered} です。現在は リビジョン {current} です。再レンダリングしてください。"
  },
  "subtitles.ui.matching": {
    "zh-Hans": "渲染快照 修订版 {revision}，与当前已保存时间线一致。",
    "zh-Hant": "算繪快照 修訂版 {revision}，與目前已儲存時間軸一致。",
    "en": "Render snapshot revision {revision} matches the current saved timeline.",
    "ja": "レンダリングのスナップショット リビジョン {revision} は、現在の保存済みタイムラインと一致しています。"
  },
  "subtitles.ui.bounds": {
    "zh-Hans": "30 帧 = 1 秒 · 出点不包含在范围内 · 媒体时长 {frames} 帧。字幕不能重叠或延长媒体时长。",
    "zh-Hant": "30 影格 = 1 秒 · 出點不包含在範圍內 · 媒體時長 {frames} 影格。字幕不可重疊或延長媒體時長。",
    "en": "30 frames = 1 second · Out point is excluded · Media duration: {frames} frames. Subtitles cannot overlap or extend the media duration.",
    "ja": "30 フレーム = 1 秒 · アウト点は含まない · メディアの長さ {frames} フレーム。字幕の重なりやメディアの長さの延長はできません。"
  },
  "subtitles.ui.characters": {
    "zh-Hans": "{counts} 字符",
    "zh-Hant": "{counts} 字元",
    "en": "{counts} characters",
    "ja": "{counts} 文字"
  },
  "subtitles.ui.count": {
    "zh-Hans": "手动字幕 · {count}/100",
    "zh-Hant": "手動字幕 · {count}/100",
    "en": "Manual subtitles · {count}/100",
    "ja": "手動字幕 · {count}/100"
  },
  "subtitles.ui.addAt": {
    "zh-Hans": "在第 {frame} 帧新增字幕",
    "zh-Hant": "在第 {frame} 影格新增字幕",
    "en": "Add a subtitle at frame {frame}",
    "ja": "{frame} フレームに字幕を追加"
  },
  "subtitles.ui.cueAria": {
    "zh-Hans": "字幕 {text}，{start} 至 {end} 帧",
    "zh-Hant": "字幕 {text}，{start} 至 {end} 影格",
    "en": "Subtitle {text}, frames {start} to {end}",
    "ja": "字幕 {text}、{start} から {end} フレーム"
  },
  "subtitles.ui.cueTitle": {
    "zh-Hans": "{text}\n{start}–{end} 帧",
    "zh-Hant": "{text}\n{start}–{end} 影格",
    "en": "{text}\nFrames {start}–{end}",
    "ja": "{text}\n{start}–{end} フレーム"
  },
  "subtitles.ui.range": {
    "zh-Hans": "{start}–{end} 帧",
    "zh-Hant": "{start}–{end} 影格",
    "en": "Frames {start}–{end}",
    "ja": "{start}–{end} フレーム"
  },
  "subtitles.error.select": {
    "zh-Hans": "请先选择字幕或在播放头处新增。",
    "zh-Hant": "請先選擇字幕或在播放頭處新增。",
    "en": "Select a subtitle or add one at the playhead first.",
    "ja": "先に字幕を選択するか、再生ヘッドに追加してください。"
  },
  "subtitles.error.integer": {
    "zh-Hans": "开始帧与持续帧数必须填写整数。",
    "zh-Hant": "開始影格與持續影格數必須填寫整數。",
    "en": "Start frame and duration must be entered as integers.",
    "ja": "開始フレームと長さは整数で入力してください。"
  },
  "subtitles.error.pending": {
    "zh-Hans": "请先核对正在处理的时间线请求。",
    "zh-Hant": "請先核對正在處理的時間軸請求。",
    "en": "Check the timeline request currently in progress first.",
    "ja": "先に処理中のタイムラインのリクエストを確認してください。"
  },
  "subtitles.error.mediaFirst": {
    "zh-Hans": "先加入媒体片段，再添加字幕。",
    "zh-Hant": "先加入媒體片段，再新增字幕。",
    "en": "Add media clips before adding subtitles.",
    "ja": "字幕を追加する前にメディアクリップを追加してください。"
  },
  "subtitles.error.limit": {
    "zh-Hans": "时间线最多支持100条手动字幕。",
    "zh-Hant": "時間軸最多支援 100 條手動字幕。",
    "en": "The timeline supports at most 100 manual subtitles.",
    "ja": "タイムラインで使える手動字幕は最大 100 件です。"
  },
  "subtitles.error.playhead": {
    "zh-Hans": "请将播放头放在已有媒体时长内的整数帧。",
    "zh-Hant": "請將播放頭放在既有媒體時長內的整數影格。",
    "en": "Place the playhead on an integer frame within the existing media duration.",
    "ja": "再生ヘッドを既存メディアの長さの範囲内の整数フレームに置いてください。"
  },
  "subtitles.error.newer": {
    "zh-Hans": "时间线已有更新版本；请核对后放弃草稿并载入最新字幕。",
    "zh-Hant": "時間軸已有更新版本；請核對後捨棄草稿並載入最新字幕。",
    "en": "A newer timeline revision is available. Review it, then discard the draft and load the latest subtitle.",
    "ja": "タイムラインに新しいリビジョンがあります。確認後、下書きを破棄して最新の字幕を読み込んでください。"
  },
  "subtitles.error.unknown": {
    "zh-Hans": "结果待确认。草稿仍保留，请到任务中心恢复同一请求；不要重新提交。",
    "zh-Hant": "結果待確認。草稿仍保留，請至工作中心還原同一請求；不要重新提交。",
    "en": "The outcome is unconfirmed. Your draft is retained. Recover the same request in the task center; do not submit again.",
    "ja": "結果は未確認です。下書きは保持されています。タスクセンターで同じリクエストを復元し、新たに送信しないでください。"
  },
  "subtitles.error.notApplied": {
    "zh-Hans": "请求未应用，草稿仍保留。",
    "zh-Hant": "請求未套用，草稿仍保留。",
    "en": "The request was not applied. Your draft is retained.",
    "ja": "リクエストは適用されませんでした。下書きは保持されています。"
  },
  "subtitles.error.recoveredApplied": {
    "zh-Hans": "原请求已应用。草稿仍保留；放弃草稿后可选择时间线上的已保存字幕。",
    "zh-Hant": "原請求已套用。草稿仍保留；捨棄草稿後可選擇時間軸上已儲存的字幕。",
    "en": "The original request was applied. Your draft is retained. Discard it to select the saved subtitle on the timeline.",
    "ja": "元のリクエストは適用されました。下書きは保持されています。下書きを破棄すると、タイムライン上の保存済み字幕を選択できます。"
  },
  "subtitles.error.recoveredNotApplied": {
    "zh-Hans": "原请求已确认未应用，可核对草稿后保存。",
    "zh-Hant": "原請求已確認未套用，可核對草稿後儲存。",
    "en": "The original request is confirmed not applied. Review the draft, then save.",
    "ja": "元のリクエストが未適用であることを確認しました。下書きを確認してから保存できます。"
  },
  "subtitles.error.invalid": {
    "zh-Hans": "字幕数据或固定排版配置无效。",
    "zh-Hant": "字幕資料或固定排版設定無效。",
    "en": "The subtitle data or fixed-layout profile is invalid.",
    "ja": "字幕データまたは固定レイアウトの設定が無効です。"
  },
  "subtitles.error.text": {
    "zh-Hans": "字幕每行必须有文字，最多两行，每行最多20个字符，UTF-8不超过161字节。",
    "zh-Hant": "字幕每行必須有文字，最多兩行，每行最多 20 個字元，UTF-8 不超過 161 位元組。",
    "en": "Each subtitle line must contain text. Use at most 2 lines, 20 characters per line, and 161 UTF-8 bytes in total.",
    "ja": "字幕の各行には文字が必要です。最大 2 行、各行 20 文字、合計 161 UTF-8 バイト以内にしてください。"
  },
  "subtitles.error.bounds": {
    "zh-Hans": "字幕起止帧必须位于已有媒体时长内。",
    "zh-Hant": "字幕起止影格必須位於既有媒體時長內。",
    "en": "Subtitle start and end frames must be within the existing media duration.",
    "ja": "字幕の開始と終了フレームは既存メディアの長さの範囲内に収めてください。"
  },
  "subtitles.error.overlap": {
    "zh-Hans": "字幕时间不能重叠，可以首尾相接。",
    "zh-Hant": "字幕時間不可重疊，可以首尾相接。",
    "en": "Subtitle intervals cannot overlap, but may meet at their boundaries.",
    "ja": "字幕の時間範囲は重ねられませんが、端をつなげることはできます。"
  },
  "subtitles.error.character": {
    "zh-Hans": "第{line}行第{column}个字符（{codePoint}）不受当前字幕字体配置支持",
    "zh-Hant": "第 {line} 行第 {column} 個字元（{codePoint}）不受目前字幕字型設定支援",
    "en": "Character {column} on line {line} ({codePoint}) is not supported by the current subtitle font profile",
    "ja": "{line} 行目の {column} 文字目（{codePoint}）は、現在の字幕フォント設定に対応していません"
  },
  "timeline.format.title": {
    "zh-Hans": "时间线输出规格",
    "zh-Hant": "時間軸輸出規格",
    "en": "Timeline output format",
    "ja": "タイムラインの出力形式"
  },
  "timeline.format.scope": {
    "zh-Hans": "只调整时间线合成与导出的画面尺寸。源素材、生成比例不会改变；分镜导出固定 9:16。",
    "zh-Hant": "僅調整時間軸合成與匯出的畫面尺寸。來源素材、生成比例不會改變；分鏡匯出固定為 9:16。",
    "en": "Changes only the image size for timeline compositing and export. Source assets and generation aspect ratios stay unchanged; storyboard export remains 9:16.",
    "ja": "タイムラインの合成と書き出しの画面サイズのみ変更します。ソース素材や生成時の縦横比は変わりません。絵コンテの書き出しは 9:16 固定です。"
  },
  "timeline.format.eligibility": {
    "zh-Hans": "仅在尚无片段、编辑历史、请求历史或时间线导出记录时可修改；有待确认编辑时也会阻止保存。开始编辑前可重新选择，规格变更不进入片段撤销历史。",
    "zh-Hant": "僅在尚無片段、編輯歷史、請求歷史或時間軸匯出記錄時可修改；有待確認編輯時也會阻止儲存。開始編輯前可重新選擇，規格變更不會進入片段復原歷史。",
    "en": "Available only before clips, edit history, request history, or timeline export records exist. Unconfirmed edits also block saving. You may choose again before editing; format changes are not part of clip undo history.",
    "ja": "クリップ、編集履歴、リクエスト履歴、タイムラインの書き出し記録がない場合のみ変更できます。未確認の編集がある場合も保存できません。編集前は選び直せます。形式の変更はクリップの取り消し履歴には含まれません。"
  },
  "timeline.format.saving": {
    "zh-Hans": "正在保存规格…",
    "zh-Hant": "正在儲存規格…",
    "en": "Saving format…",
    "ja": "形式を保存中…"
  },
  "timeline.format.dirty": {
    "zh-Hans": "规格草稿未保存",
    "zh-Hant": "規格草稿未儲存",
    "en": "Unsaved format draft",
    "ja": "形式の下書きは未保存"
  },
  "timeline.format.unavailable": {
    "zh-Hans": "输出规格暂不可用",
    "zh-Hant": "輸出規格暫時無法使用",
    "en": "Output format is temporarily unavailable",
    "ja": "出力形式は現在利用できません"
  },
  "timeline.format.saved": {
    "zh-Hans": "已保存的时间线规格",
    "zh-Hant": "已儲存的時間軸規格",
    "en": "Saved timeline format",
    "ja": "保存済みタイムライン形式"
  },
  "timeline.format.default": {
    "zh-Hans": "默认时间线规格（尚未创建）",
    "zh-Hant": "預設時間軸規格（尚未建立）",
    "en": "Default timeline format (not yet created)",
    "ja": "既定のタイムライン形式（未作成）"
  },
  "timeline.format.checking": {
    "zh-Hans": "正在核对输出规格…",
    "zh-Hant": "正在核對輸出規格…",
    "en": "Checking output format…",
    "ja": "出力形式を確認中…"
  },
  "timeline.format.notCreated": {
    "zh-Hans": "尚未创建时间线",
    "zh-Hant": "尚未建立時間軸",
    "en": "Timeline not created yet",
    "ja": "タイムラインは未作成"
  },
  "timeline.format.aspect": {
    "zh-Hans": "输出画幅",
    "zh-Hant": "輸出畫幅",
    "en": "Output aspect ratio",
    "ja": "出力の縦横比"
  },
  "timeline.format.waiting": {
    "zh-Hans": "等待已保存规格",
    "zh-Hant": "等待已儲存規格",
    "en": "Waiting for saved format",
    "ja": "保存済み形式を待機中"
  },
  "timeline.format.fps": {
    "zh-Hans": "帧率（固定）",
    "zh-Hant": "影格率（固定）",
    "en": "Frame rate (fixed)",
    "ja": "フレームレート（固定）"
  },
  "timeline.format.serverBlocks": {
    "zh-Hans": "服务器当前不允许修改：",
    "zh-Hant": "伺服器目前不允許修改：",
    "en": "The server currently blocks changes:",
    "ja": "サーバーが変更を許可していません："
  },
  "timeline.format.pending": {
    "zh-Hans": "编辑恢复记录尚未核对完成或有请求待确认。请先到任务中心核对。",
    "zh-Hant": "編輯還原記錄尚未核對完成，或有請求待確認。請先至工作中心核對。",
    "en": "Edit recovery records have not finished checking, or a request is unconfirmed. Check the task center first.",
    "ja": "編集の復元記録の確認が終わっていないか、未確認のリクエストがあります。先にタスクセンターで確認してください。"
  },
  "timeline.format.conflict": {
    "zh-Hans": "已保存的项目或时间线已变化。选择仍保留，请载入最新规格后重新选择。",
    "zh-Hant": "已儲存的專案或時間軸已變更。選擇仍保留，請載入最新規格後重新選擇。",
    "en": "The saved project or timeline changed. Your selection is retained. Load the latest format, then choose again.",
    "ja": "保存済みのプロジェクトまたはタイムラインが変わりました。選択は保持されています。最新の形式を読み込んでから選び直してください。"
  },
  "timeline.format.retained": {
    "zh-Hans": "保存时服务器会再次核对资格与版本。切换标签、收起面板或返回属性会保留此草稿。",
    "zh-Hant": "儲存時伺服器會再次核對資格與版本。切換分頁、收合面板或返回屬性，會保留此草稿。",
    "en": "The server rechecks eligibility and revisions when saving. Switching tabs, collapsing the panel, or returning to properties retains this draft.",
    "ja": "保存時にサーバーが変更条件とリビジョンを再確認します。タブの切り替え、パネルの折りたたみ、プロパティに戻る操作でも下書きは保持されます。"
  },
  "timeline.format.save": {
    "zh-Hans": "保存输出规格",
    "zh-Hant": "儲存輸出規格",
    "en": "Save output format",
    "ja": "出力形式を保存"
  },
  "timeline.format.reload": {
    "zh-Hans": "重新核对",
    "zh-Hant": "重新核對",
    "en": "Check again",
    "ja": "再確認"
  },
  "timeline.format.loadSaved": {
    "zh-Hans": "载入已保存规格",
    "zh-Hant": "載入已儲存規格",
    "en": "Load saved format",
    "ja": "保存済み形式を読み込む"
  },
  "timeline.format.revision": {
    "zh-Hans": "时间线 修订版 {revision}",
    "zh-Hant": "時間軸 修訂版 {revision}",
    "en": "Timeline revision {revision}",
    "ja": "タイムライン リビジョン {revision}"
  },
  "timeline.format.selected": {
    "zh-Hans": "当前选择：{width} × {height}",
    "zh-Hant": "目前選擇：{width} × {height}",
    "en": "Current selection: {width} × {height}",
    "ja": "現在の選択：{width} × {height}"
  },
  "timeline.format.clips": {
    "zh-Hans": "时间线已有片段",
    "zh-Hant": "時間軸已有片段",
    "en": "The timeline already has clips",
    "ja": "タイムラインにクリップがあります"
  },
  "timeline.format.history": {
    "zh-Hans": "时间线已有编辑历史",
    "zh-Hant": "時間軸已有編輯歷史",
    "en": "The timeline already has edit history",
    "ja": "タイムラインに編集履歴があります"
  },
  "timeline.format.requests": {
    "zh-Hans": "时间线已有编辑请求记录",
    "zh-Hant": "時間軸已有編輯請求記錄",
    "en": "The timeline already has edit request records",
    "ja": "タイムラインに編集リクエストの記録があります"
  },
  "timeline.format.exports": {
    "zh-Hans": "时间线已有预览或导出记录",
    "zh-Hant": "時間軸已有預覽或匯出記錄",
    "en": "The timeline already has preview or export records",
    "ja": "タイムラインにプレビューまたは書き出し記録があります"
  },
  "timeline.format.editPending": {
    "zh-Hans": "项目有待确认的编辑请求",
    "zh-Hant": "專案有待確認的編輯請求",
    "en": "The project has an unconfirmed edit request",
    "ja": "プロジェクトに未確認の編集リクエストがあります"
  },
  "timeline.format.blocked": {
    "zh-Hans": "服务器暂不允许修改输出规格",
    "zh-Hant": "伺服器暫時不允許修改輸出規格",
    "en": "The server currently does not allow output format changes",
    "ja": "現在、サーバーは出力形式の変更を許可していません"
  },
  "timeline.format.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录。",
    "zh-Hant": "工作階段已過期，請重新登入。",
    "en": "Your session expired. Sign in again.",
    "ja": "セッションが期限切れです。再度ログインしてください。"
  },
  "timeline.format.readFailed": {
    "zh-Hans": "无法核对输出规格，请检查连接后重试。",
    "zh-Hant": "無法核對輸出規格，請檢查連線後重試。",
    "en": "Could not check the output format. Check your connection and try again.",
    "ja": "出力形式を確認できません。接続を確認して再試行してください。"
  },
  "timeline.format.unknown": {
    "zh-Hans": "提交结果待确认。请在任务中心恢复同一请求，不能新建请求重试。",
    "zh-Hant": "提交結果待確認。請在工作中心還原同一請求，不可建立新請求重試。",
    "en": "The submission outcome is unconfirmed. Recover the same request in the task center; do not retry with a new request.",
    "ja": "送信結果は未確認です。タスクセンターで同じリクエストを復元してください。新しいリクエストで再試行しないでください。"
  },
  "timeline.format.notApplied": {
    "zh-Hans": "请求未应用，草稿仍保留。请重新核对已保存的规格。",
    "zh-Hant": "請求未套用，草稿仍保留。請重新核對已儲存的規格。",
    "en": "The request was not applied. Your draft is retained. Check the saved format again.",
    "ja": "リクエストは適用されませんでした。下書きは保持されています。保存済み形式を再確認してください。"
  },
  "timeline.format.preset.portrait_720": {
    "zh-Hans": "竖屏 9:16",
    "zh-Hant": "直向 9:16",
    "en": "Portrait 9:16",
    "ja": "縦 9:16"
  },
  "timeline.format.preset.landscape_720": {
    "zh-Hans": "横屏 16:9",
    "zh-Hant": "橫向 16:9",
    "en": "Landscape 16:9",
    "ja": "横 16:9"
  },
  "timeline.format.preset.square_720": {
    "zh-Hans": "方屏 1:1",
    "zh-Hant": "方形 1:1",
    "en": "Square 1:1",
    "ja": "正方形 1:1"
  },
  "timeline.frame.title": {
    "zh-Hans": "源视频抽帧",
    "zh-Hant": "來源影片擷取影格",
    "en": "Extract source frame",
    "ja": "ソース動画からフレームを抽出"
  },
  "timeline.frame.local": {
    "zh-Hans": "本地 · 单张 PNG",
    "zh-Hant": "本機 · 單張 PNG",
    "en": "Local · Single PNG",
    "ja": "ローカル · PNG 1 枚"
  },
  "timeline.frame.timebase": {
    "zh-Hans": "在源素材预览中暂停，再点击“提取此帧”。按 30 fps 编辑时间点寻找首个不早于该时间的解码帧；不是原生/VFR 帧号。",
    "zh-Hant": "在來源素材預覽中暫停，再點選「擷取此影格」。依 30 fps 編輯時間點尋找不早於該時間的第一個解碼影格；不是原生/VFR 影格編號。",
    "en": "Pause the source preview, then choose “Extract this frame”. Uses the 30 fps editing time point to find the first decoded frame at or after that time; this is not a native/VFR frame number.",
    "ja": "ソース素材のプレビューを一時停止して「このフレームを抽出」を選択してください。30 fps の編集時点以降で最初のデコードフレームを探します。ネイティブ/VFR のフレーム番号ではありません。"
  },
  "timeline.frame.profile": {
    "zh-Hans": "最长边 {edge} · 保持比例 · 不放大 · PNG",
    "zh-Hant": "最長邊 {edge} · 保持比例 · 不放大 · PNG",
    "en": "Longest edge {edge} · Preserve aspect ratio · No upscaling · PNG",
    "ja": "長辺 {edge} · 縦横比を維持 · 拡大なし · PNG"
  },
  "timeline.frame.source": {
    "zh-Hans": "当前源：{name}",
    "zh-Hant": "目前來源：{name}",
    "en": "Current source: {name}",
    "ja": "現在のソース：{name}"
  },
  "timeline.frame.frozen": {
    "zh-Hans": "任务冻结点击时的源文件与时间点。结果保存到素材库后，可明确选用；不会自动绑定首帧或开始生成。",
    "zh-Hant": "工作會固定點選時的來源檔案與時間點。結果儲存到素材庫後，可明確選用；不會自動綁定首影格或開始生成。",
    "en": "The task freezes the source file and time point at the moment you click. Once saved to the asset library, the result can be explicitly selected; it will not automatically become the first frame or start generation.",
    "ja": "クリック時のソースファイルと時点がタスクに固定されます。素材ライブラリに保存された結果は明示的に選択できます。自動で先頭フレームに設定したり、生成を開始したりはしません。"
  },
  "timeline.frame.readFirst": {
    "zh-Hans": "请先读取本项目任务，确认没有未完成的同一时间点提取。",
    "zh-Hant": "請先讀取本專案工作，確認沒有同一時間點尚未完成的擷取。",
    "en": "Read this project’s tasks first to check for unfinished extraction at the same time point.",
    "ja": "まずこのプロジェクトのタスクを読み込み、同じ時点の未完了の抽出がないことを確認してください。"
  },
  "timeline.frame.unknown": {
    "zh-Hans": "原请求待确认",
    "zh-Hant": "原請求待確認",
    "en": "Original request unconfirmed",
    "ja": "元のリクエストは未確認"
  },
  "timeline.frame.originalTask": {
    "zh-Hans": "原任务",
    "zh-Hant": "原工作",
    "en": "Original task",
    "ja": "元のタスク"
  },
  "timeline.frame.pendingPoint": {
    "zh-Hans": "{name} · {frame} / 30 秒（第 {frame} 个编辑时间点）",
    "zh-Hant": "{name} · {frame} / 30 秒（第 {frame} 個編輯時間點）",
    "en": "{name} · {frame} / 30 seconds (editing time point {frame})",
    "ja": "{name} · {frame} / 30 秒（編集時点 {frame}）"
  },
  "timeline.frame.operation": {
    "zh-Hans": "原操作：{operation}",
    "zh-Hant": "原操作：{operation}",
    "en": "Original operation: {operation}",
    "ja": "元の操作：{operation}"
  },
  "timeline.frame.windowEvidence": {
    "zh-Hans": "完整输入保留在当前窗口中。重开窗口后先读取后端任务历史；未找到回执不代表原请求未受理。",
    "zh-Hant": "完整輸入保留在目前視窗中。重新開啟視窗後，請先讀取後端工作歷史；未找到回執不代表原請求未受理。",
    "en": "The complete input is retained in this window. After reopening it, read backend task history first. A missing receipt does not prove the original request was not accepted.",
    "ja": "完全な入力は現在のウィンドウに保持されます。ウィンドウを開き直したら、まずバックエンドのタスク履歴を読み込んでください。受領記録が見つからなくても、元のリクエストが受理されなかったとは限りません。"
  },
  "timeline.frame.reconcile": {
    "zh-Hans": "核对原请求（只读）",
    "zh-Hant": "核對原請求（唯讀）",
    "en": "Check original request (read only)",
    "ja": "元のリクエストを確認（読み取り専用）"
  },
  "timeline.frame.retry": {
    "zh-Hans": "重发原请求（同一标识）",
    "zh-Hant": "重送原請求（相同識別碼）",
    "en": "Resend original request (same ID)",
    "ja": "元のリクエストを再送（同じ ID）"
  },
  "timeline.frame.acceptedPending": {
    "zh-Hans": "请求已受理，尚未核实任务当前状态。",
    "zh-Hant": "請求已受理，尚未核實工作目前狀態。",
    "en": "The request was accepted; the task’s current state has not yet been verified.",
    "ja": "リクエストは受理されましたが、タスクの現在の状態はまだ確認できていません。"
  },
  "timeline.frame.readTask": {
    "zh-Hans": "读取此任务",
    "zh-Hant": "讀取此工作",
    "en": "Read this task",
    "ja": "このタスクを読み込む"
  },
  "timeline.frame.tasks": {
    "zh-Hans": "本项目任务",
    "zh-Hant": "本專案工作",
    "en": "Project tasks",
    "ja": "このプロジェクトのタスク"
  },
  "timeline.frame.refresh": {
    "zh-Hans": "读取最新任务",
    "zh-Hant": "讀取最新工作",
    "en": "Read latest tasks",
    "ja": "最新のタスクを読み込む"
  },
  "timeline.frame.loading": {
    "zh-Hans": "正在读取…",
    "zh-Hant": "正在讀取…",
    "en": "Reading…",
    "ja": "読み込み中…"
  },
  "timeline.frame.page": {
    "zh-Hans": "历史第 {page} 页",
    "zh-Hant": "歷史第 {page} 頁",
    "en": "History page {page}",
    "ja": "履歴 {page} ページ"
  },
  "timeline.frame.empty": {
    "zh-Hans": "暂时没有抽帧任务。",
    "zh-Hant": "目前沒有影格擷取工作。",
    "en": "No frame extraction tasks yet.",
    "ja": "フレーム抽出タスクはまだありません。"
  },
  "timeline.frame.point": {
    "zh-Hans": "时间点 {frame} · {seconds} 秒",
    "zh-Hant": "時間點 {frame} · {seconds} 秒",
    "en": "Time point {frame} · {seconds} seconds",
    "ja": "時点 {frame} · {seconds} 秒"
  },
  "timeline.frame.taskMeta": {
    "zh-Hans": "30 fps 编辑时基 · 修订版 {revision} · {status}",
    "zh-Hant": "30 fps 編輯時基 · 修訂版 {revision} · {status}",
    "en": "30 fps editing timebase · revision {revision} · {status}",
    "ja": "30 fps 編集タイムベース · リビジョン {revision} · {status}"
  },
  "timeline.frame.started": {
    "zh-Hans": "已开始提取",
    "zh-Hant": "已開始擷取",
    "en": "Extraction started",
    "ja": "抽出開始済み"
  },
  "timeline.frame.notStarted": {
    "zh-Hans": "尚未开始提取",
    "zh-Hant": "尚未開始擷取",
    "en": "Extraction not started",
    "ja": "抽出未開始"
  },
  "timeline.frame.noAutomaticRetry": {
    "zh-Hans": "此任务不会自动重新提取。需要新 PNG 时，请在源预览重新确认时间点并明确点击提取。",
    "zh-Hant": "此工作不會自動重新擷取。需要新 PNG 時，請在來源預覽重新確認時間點，再明確點選擷取。",
    "en": "This task will not automatically extract again. If you need a new PNG, confirm the time point in the source preview and explicitly choose extraction.",
    "ja": "このタスクは自動で再抽出しません。新しい PNG が必要な場合はソースプレビューで時点を確認し、明示的に抽出してください。"
  },
  "timeline.frame.localResult": {
    "zh-Hans": "已记录本地结果，仍需核验是否完整。建议先恢复已有 PNG；恢复不会再次解码。也可在源预览明确新建提取，旧任务保留。",
    "zh-Hant": "已記錄本機結果，仍需核驗是否完整。建議先還原既有 PNG；還原不會再次解碼。也可在來源預覽明確建立新擷取，舊工作會保留。",
    "en": "A local result is recorded, but its integrity still needs verification. Try recovering the existing PNG first; recovery does not decode again. You may also explicitly start a new extraction in the source preview; the old task is retained.",
    "ja": "ローカル結果は記録済みですが、完全性の確認が必要です。まず既存の PNG を復元することをおすすめします。復元で再デコードは行いません。ソースプレビューで新たな抽出を明示的に開始することもでき、古いタスクは保持されます。"
  },
  "timeline.frame.interruptedResult": {
    "zh-Hans": "中断后可能留有本地 PNG。可明确检查并恢复已有字节；缺失或校验失败会报错，不会再次解码源视频。",
    "zh-Hant": "中斷後可能留有本機 PNG。可明確檢查並還原既有位元組；遺失或驗證失敗會回報錯誤，不會再次解碼來源影片。",
    "en": "A local PNG may remain after interruption. You can explicitly check and recover existing bytes. Missing data or failed verification produces an error; the source video is not decoded again.",
    "ja": "中断後もローカルに PNG が残っている場合があります。既存のデータを明示的に確認して復元できます。データの欠落や検証失敗はエラーになり、ソース動画を再デコードすることはありません。"
  },
  "timeline.frame.errorCode": {
    "zh-Hans": "错误代码：{code}",
    "zh-Hant": "錯誤代碼：{code}",
    "en": "Error code: {code}",
    "ja": "エラーコード：{code}"
  },
  "timeline.frame.savedFallback": {
    "zh-Hans": "已保存 PNG · 名称待素材库刷新",
    "zh-Hant": "已儲存 PNG · 名稱待素材庫重新整理",
    "en": "PNG saved · Name awaiting asset library refresh",
    "ja": "PNG 保存済み · 名前は素材ライブラリ更新後に表示"
  },
  "timeline.frame.provenance": {
    "zh-Hans": "来源：源视频抽帧（extracted-frame）",
    "zh-Hant": "來源：來源影片擷取影格（extracted-frame）",
    "en": "Source: frame extracted from source video (extracted-frame)",
    "ja": "出所：ソース動画から抽出したフレーム（extracted-frame）"
  },
  "timeline.frame.reveal": {
    "zh-Hans": "在素材库查看 PNG",
    "zh-Hant": "在素材庫查看 PNG",
    "en": "View PNG in asset library",
    "ja": "素材ライブラリで PNG を表示"
  },
  "timeline.frame.records": {
    "zh-Hans": "源文件与请求记录",
    "zh-Hant": "來源檔案與請求記錄",
    "en": "Source file and request records",
    "ja": "ソースファイルとリクエスト記録"
  },
  "timeline.frame.sourceAsset": {
    "zh-Hans": "源素材 {id}",
    "zh-Hant": "來源素材 {id}",
    "en": "Source asset {id}",
    "ja": "ソース素材 {id}"
  },
  "timeline.frame.sourceHash": {
    "zh-Hans": "源 SHA-256 {hash}",
    "zh-Hant": "來源 SHA-256 {hash}",
    "en": "Source SHA-256 {hash}",
    "ja": "ソース SHA-256 {hash}"
  },
  "timeline.frame.task": {
    "zh-Hans": "任务 {id}",
    "zh-Hant": "工作 {id}",
    "en": "Task {id}",
    "ja": "タスク {id}"
  },
  "timeline.frame.request": {
    "zh-Hans": "请求 {id}",
    "zh-Hant": "請求 {id}",
    "en": "Request {id}",
    "ja": "リクエスト {id}"
  },
  "timeline.frame.profileId": {
    "zh-Hans": "提取配置 {id}",
    "zh-Hant": "擷取設定 {id}",
    "en": "Extraction profile {id}",
    "ja": "抽出プロファイル {id}"
  },
  "timeline.frame.asset": {
    "zh-Hans": "素材 {id}",
    "zh-Hant": "素材 {id}",
    "en": "Asset {id}",
    "ja": "素材 {id}"
  },
  "timeline.frame.cancel": {
    "zh-Hans": "取消尚未开始的任务",
    "zh-Hant": "取消尚未開始的工作",
    "en": "Cancel task before it starts",
    "ja": "未開始のタスクをキャンセル"
  },
  "timeline.frame.checkRecover": {
    "zh-Hans": "检查并恢复已有 PNG",
    "zh-Hant": "檢查並還原既有 PNG",
    "en": "Check and recover existing PNG",
    "ja": "既存の PNG を確認して復元"
  },
  "timeline.frame.recover": {
    "zh-Hans": "恢复同一份本地 PNG",
    "zh-Hant": "還原同一份本機 PNG",
    "en": "Recover the same local PNG",
    "ja": "同じローカル PNG を復元"
  },
  "timeline.frame.newer": {
    "zh-Hans": "较新一页",
    "zh-Hant": "較新一頁",
    "en": "Newer page",
    "ja": "新しいページ"
  },
  "timeline.frame.older": {
    "zh-Hans": "更早一页",
    "zh-Hant": "更早一頁",
    "en": "Older page",
    "ja": "古いページ"
  },
  "timeline.frame.pagination": {
    "zh-Hans": "历史每页 20 项，可翻阅全部保留任务；加上当前任务，面板最多显示 50 项。关闭面板不会取消已受理任务。",
    "zh-Hant": "歷史每頁 20 項，可翻閱全部保留工作；加上目前工作，面板最多顯示 50 項。關閉面板不會取消已受理工作。",
    "en": "History shows 20 items per page and lets you browse all retained tasks. Including current tasks, the panel shows at most 50 items. Closing the panel does not cancel accepted tasks.",
    "ja": "履歴は 1 ページ 20 件で、保持されているすべてのタスクを確認できます。現在のタスクを含め、パネルには最大 50 件表示されます。パネルを閉じても受理済みのタスクはキャンセルされません。"
  },
  "timeline.frame.safeFailure": {
    "zh-Hans": "抽帧记录暂时无法核验。请重新读取，原请求仍保留。",
    "zh-Hant": "影格擷取記錄暫時無法核驗。請重新讀取，原請求仍保留。",
    "en": "Frame extraction records cannot currently be verified. Read them again; the original request is retained.",
    "ja": "フレーム抽出記録を現在確認できません。再読み込みしてください。元のリクエストは保持されています。"
  },
  "timeline.frame.acceptedSnapshot": {
    "zh-Hans": "原请求已受理。此回执是受理时的快照，正在读取任务当前状态。",
    "zh-Hant": "原請求已受理。此回執為受理時的快照，正在讀取工作目前狀態。",
    "en": "The original request was accepted. This receipt is the snapshot at acceptance; reading the task’s current state.",
    "ja": "元のリクエストは受理されました。この受領記録は受理時のスナップショットです。タスクの現在の状態を読み込み中です。"
  },
  "timeline.frame.acceptedVerified": {
    "zh-Hans": "原请求已受理；下方显示已核验的任务当前状态。",
    "zh-Hant": "原請求已受理；下方顯示已核驗的工作目前狀態。",
    "en": "The original request was accepted. The verified current task state is shown below.",
    "ja": "元のリクエストは受理されました。確認済みの現在のタスク状態を以下に表示します。"
  },
  "timeline.frame.recoverRefused": {
    "zh-Hans": "本次恢复已确认未受理：没有可完整核验的本地 PNG。原任务保留，没有重新解码；请重新读取任务后决定是否明确新建提取。",
    "zh-Hant": "本次還原已確認未受理：沒有可完整核驗的本機 PNG。原工作保留，沒有重新解碼；請重新讀取工作後，再決定是否明確建立新擷取。",
    "en": "This recovery is confirmed not accepted: no local PNG can be fully verified. The original task is retained, with no decoding repeated. Read the task again before explicitly deciding whether to start a new extraction.",
    "ja": "今回の復元は受理されなかったことを確認しました。完全に検証できるローカル PNG がありません。元のタスクは保持され、再デコードは行われていません。タスクを再読み込みしてから、新たな抽出を明示的に開始するか判断してください。"
  },
  "timeline.frame.refused": {
    "zh-Hans": "本次操作已确认未受理，原任务保持不变。请重新读取任务后，再明确选择下一步。",
    "zh-Hant": "本次操作已確認未受理，原工作保持不變。請重新讀取工作後，再明確選擇下一步。",
    "en": "This operation is confirmed not accepted. The original task is unchanged. Read the task again before explicitly choosing the next action.",
    "ja": "今回の操作は受理されなかったことを確認しました。元のタスクは変更されていません。タスクを再読み込みしてから、次の操作を明示的に選択してください。"
  },
  "timeline.frame.outcomeUnknown": {
    "zh-Hans": "是否受理仍待确认。已保留原操作和完整输入；请核对同一请求，不要新建重复提取。",
    "zh-Hant": "是否受理仍待確認。已保留原操作與完整輸入；請核對同一請求，不要建立重複擷取。",
    "en": "Acceptance is still unconfirmed. The original operation and complete input are retained. Check the same request; do not create a duplicate extraction.",
    "ja": "受理されたかはまだ未確認です。元の操作と完全な入力は保持されています。同じリクエストを確認し、重複する抽出を新たに作成しないでください。"
  },
  "timeline.frame.duplicate": {
    "zh-Hans": "此源时间点已有未完成任务。请先核对下面的原任务，避免重复提取。",
    "zh-Hant": "此來源時間點已有未完成工作。請先核對下方的原工作，避免重複擷取。",
    "en": "This source time point already has an unfinished task. Check the original task below to avoid duplicate extraction.",
    "ja": "このソース時点には未完了のタスクがあります。重複した抽出を避けるため、先に以下の元のタスクを確認してください。"
  },
  "timeline.frame.invalidCaptureId": {
    "zh-Hans": "无法创建有效请求标识。尚未提交提取。",
    "zh-Hant": "無法建立有效請求識別碼。尚未提交擷取。",
    "en": "Could not create a valid request ID. Extraction has not been submitted.",
    "ja": "有効なリクエスト ID を作成できません。抽出はまだ送信していません。"
  },
  "timeline.frame.invalidControlId": {
    "zh-Hans": "无法创建有效请求标识。尚未提交操作。",
    "zh-Hant": "無法建立有效請求識別碼。尚未提交操作。",
    "en": "Could not create a valid request ID. The operation has not been submitted.",
    "ja": "有効なリクエスト ID を作成できません。操作はまだ送信していません。"
  },
  "timeline.frame.receiptMissing": {
    "zh-Hans": "尚未找到原请求回执。原标识和输入仍保留；可再次核对，或明确重发同一请求。",
    "zh-Hant": "尚未找到原請求回執。原識別碼與輸入仍保留；可再次核對，或明確重送同一請求。",
    "en": "The original request receipt has not been found. The original ID and input are retained. Check again, or explicitly resend the same request.",
    "ja": "元のリクエストの受領記録が見つかりません。元の ID と入力は保持されています。再度確認するか、同じリクエストを明示的に再送してください。"
  },
  "timeline.frame.revealFailed": {
    "zh-Hans": "无法打开此 PNG。当前编辑仍保留。",
    "zh-Hant": "無法開啟此 PNG。目前編輯仍保留。",
    "en": "Could not open this PNG. Current edits are retained.",
    "ja": "この PNG を開けません。現在の編集内容は保持されています。"
  },
  "timeline.frame.state.queued": {
    "zh-Hans": "等待本地提取",
    "zh-Hant": "等待本機擷取",
    "en": "Waiting for local extraction",
    "ja": "ローカル抽出待ち"
  },
  "timeline.frame.state.running": {
    "zh-Hans": "正在本地提取",
    "zh-Hant": "正在本機擷取",
    "en": "Extracting locally",
    "ja": "ローカルで抽出中"
  },
  "timeline.frame.state.persisting": {
    "zh-Hans": "正在保存 PNG",
    "zh-Hant": "正在儲存 PNG",
    "en": "Saving PNG",
    "ja": "PNG を保存中"
  },
  "timeline.frame.state.succeeded": {
    "zh-Hans": "PNG 已保存",
    "zh-Hant": "PNG 已儲存",
    "en": "PNG saved",
    "ja": "PNG 保存済み"
  },
  "timeline.frame.state.cancelled_before_start": {
    "zh-Hans": "已在开始前取消",
    "zh-Hant": "已在開始前取消",
    "en": "Cancelled before starting",
    "ja": "開始前にキャンセル済み"
  },
  "timeline.frame.state.interrupted": {
    "zh-Hans": "提取已中断",
    "zh-Hant": "擷取已中斷",
    "en": "Extraction interrupted",
    "ja": "抽出が中断されました"
  },
  "timeline.frame.state.local_result_error": {
    "zh-Hans": "本地结果待恢复",
    "zh-Hant": "本機結果待還原",
    "en": "Local result awaiting recovery",
    "ja": "ローカル結果は復元待ち"
  },
  "timeline.frame.state.failed": {
    "zh-Hans": "提取失败",
    "zh-Hant": "擷取失敗",
    "en": "Extraction failed",
    "ja": "抽出失敗"
  },
  "timeline.frame.state.unknown": {
    "zh-Hans": "状态待核验",
    "zh-Hant": "狀態待核驗",
    "en": "State awaiting verification",
    "ja": "状態は確認待ち"
  },
  "timeline.preview.capture": {
    "zh-Hans": "提取此帧 · PNG",
    "zh-Hant": "擷取此影格 · PNG",
    "en": "Extract this frame · PNG",
    "ja": "このフレームを抽出 · PNG"
  },
  "timeline.preview.captureHint": {
    "zh-Hans": "暂停后提取 · 30 fps 编辑时间点 · 最长边 1024 · 保持比例、不放大",
    "zh-Hant": "暫停後擷取 · 30 fps 編輯時間點 · 最長邊 1024 · 保持比例、不放大",
    "en": "Pause to extract · 30 fps editing time point · Longest edge 1024 · Preserve aspect ratio, no upscaling",
    "ja": "一時停止して抽出 · 30 fps 編集時点 · 長辺 1024 · 縦横比を維持、拡大なし"
  },
  "timeline.preview.main": {
    "zh-Hans": "主工作区预览",
    "zh-Hant": "主工作區預覽",
    "en": "Main workspace preview",
    "ja": "メインワークスペースのプレビュー"
  },
  "timeline.preview.title": {
    "zh-Hans": "剪辑预览",
    "zh-Hant": "剪輯預覽",
    "en": "Editing preview",
    "ja": "編集プレビュー"
  },
  "timeline.preview.mode": {
    "zh-Hans": "预览模式",
    "zh-Hant": "預覽模式",
    "en": "Preview mode",
    "ja": "プレビューモード"
  },
  "timeline.preview.sourceTab": {
    "zh-Hans": "源素材快速查看",
    "zh-Hant": "來源素材快速檢視",
    "en": "Quick source preview",
    "ja": "ソース素材を確認"
  },
  "timeline.preview.timelineTab": {
    "zh-Hans": "时间线合成",
    "zh-Hant": "時間軸合成",
    "en": "Timeline composite",
    "ja": "タイムライン合成"
  },
  "timeline.preview.exportFrozen": {
    "zh-Hans": "已导出的成片文件 · 固定设置",
    "zh-Hant": "已匯出的成片檔案 · 固定設定",
    "en": "Exported final video · Fixed settings",
    "ja": "書き出し済み動画 · 固定設定"
  },
  "timeline.preview.previewFormat": {
    "zh-Hans": "编辑预览 · 原始尺寸与默认画质",
    "zh-Hant": "編輯預覽 · 原始尺寸與預設畫質",
    "en": "Editing preview · Original size and default quality",
    "ja": "編集プレビュー · 元のサイズと既定の画質"
  },
  "timeline.preview.sourceUnprocessed": {
    "zh-Hans": "源素材原声 · 不应用片段音量或淡入/淡出；原始画面未调色，不应用片段 LUT",
    "zh-Hant": "來源素材原聲 · 不套用片段音量或淡入／淡出；原始畫面未調色，不套用片段 LUT",
    "en": "Original source audio · No clip gain or fades; original image without color grading or clip LUT",
    "ja": "ソース素材の元の音声 · クリップの音量やフェードは適用しません。映像は未調整で、クリップの LUT も適用しません"
  },
  "timeline.preview.stale": {
    "zh-Hans": "旧快照 修订版 {rendered} · 当前时间线 修订版 {current}，请重新渲染。",
    "zh-Hant": "舊快照 修訂版 {rendered} · 目前時間軸 修訂版 {current}，請重新算繪。",
    "en": "Old snapshot revision {rendered} · Current timeline revision {current}. Render again.",
    "ja": "古いスナップショット リビジョン {rendered} · 現在のタイムライン リビジョン {current}。再レンダリングしてください。"
  },
  "timeline.preview.update": {
    "zh-Hans": "更新预览",
    "zh-Hant": "更新預覽",
    "en": "Update preview",
    "ja": "プレビューを更新"
  },
  "timeline.preview.rendering": {
    "zh-Hans": "正在合成时间线 修订版 {revision}，完成后自动显示。{previous}",
    "zh-Hant": "正在合成時間軸 修訂版 {revision}，完成後自動顯示。{previous}",
    "en": "Compositing timeline revision {revision}. It will appear automatically when complete. {previous}",
    "ja": "タイムライン リビジョン {revision} を合成中です。完了後に自動表示します。{previous}"
  },
  "timeline.preview.previous": {
    "zh-Hans": "下方仍是上次完成的快照。",
    "zh-Hant": "下方仍為上次完成的快照。",
    "en": "The last completed snapshot is still shown below.",
    "ja": "以下には前回完了したスナップショットを表示しています。"
  },
  "timeline.preview.failed": {
    "zh-Hans": "合成失败。请核对任务状态后重新渲染。",
    "zh-Hant": "合成失敗。請核對工作狀態後重新算繪。",
    "en": "Compositing failed. Check the task state before rendering again.",
    "ja": "合成に失敗しました。タスクの状態を確認してから再レンダリングしてください。"
  },
  "timeline.preview.rerender": {
    "zh-Hans": "重新渲染",
    "zh-Hant": "重新算繪",
    "en": "Render again",
    "ja": "再レンダリング"
  },
  "timeline.preview.source": {
    "zh-Hans": "源素材",
    "zh-Hant": "來源素材",
    "en": "Source asset",
    "ja": "ソース素材"
  },
  "timeline.preview.stage": {
    "zh-Hans": "{kind} · 修订版 {revision} · {status}",
    "zh-Hant": "{kind} · 修訂版 {revision} · {status}",
    "en": "{kind} · revision {revision} · {status}",
    "ja": "{kind} · リビジョン {revision} · {status}"
  },
  "timeline.preview.final": {
    "zh-Hans": "成片文件",
    "zh-Hant": "成片檔案",
    "en": "Final video file",
    "ja": "完成動画ファイル"
  },
  "timeline.preview.editing": {
    "zh-Hans": "编辑预览",
    "zh-Hant": "編輯預覽",
    "en": "Editing preview",
    "ja": "編集プレビュー"
  },
  "timeline.preview.expired": {
    "zh-Hans": "已过期",
    "zh-Hant": "已過期",
    "en": "Out of date",
    "ja": "古い状態"
  },
  "timeline.preview.current": {
    "zh-Hans": "当前",
    "zh-Hant": "目前",
    "en": "Current",
    "ja": "最新"
  },
  "timeline.preview.clipOriginal": {
    "zh-Hans": "片段原始源素材 · 未调色，非合成画面",
    "zh-Hant": "片段原始來源素材 · 未調色，非合成畫面",
    "en": "Original clip source · Ungraded, not composited",
    "ja": "クリップの元のソース素材 · 未調整、合成前"
  },
  "timeline.preview.original": {
    "zh-Hans": "原始源素材 · 未调色",
    "zh-Hant": "原始來源素材 · 未調色",
    "en": "Original source · Ungraded",
    "ja": "元のソース素材 · 未調整"
  },
  "timeline.preview.preparing": {
    "zh-Hans": "正在生成可播放的合成预览",
    "zh-Hant": "正在產生可播放的合成預覽",
    "en": "Preparing a playable composite preview",
    "ja": "再生可能な合成プレビューを作成中"
  },
  "timeline.preview.ready": {
    "zh-Hans": "准备好预览时间线",
    "zh-Hant": "準備好預覽時間軸",
    "en": "Ready to preview the timeline",
    "ja": "タイムラインのプレビュー準備完了"
  },
  "timeline.preview.first": {
    "zh-Hans": "先编排第一个片段",
    "zh-Hant": "先編排第一個片段",
    "en": "Arrange your first clip",
    "ja": "最初のクリップを配置"
  },
  "timeline.preview.empty": {
    "zh-Hans": "在这里认真看每一个画面",
    "zh-Hant": "在這裡細看每個畫面",
    "en": "See every frame clearly here",
    "ja": "ここで一つひとつの映像を確認"
  },
  "timeline.preview.renderDetail": {
    "zh-Hans": "多轨叠加、裁剪、空隙、混音与音频淡入/淡出均使用与导出相同的本地渲染。",
    "zh-Hant": "多軌疊加、裁切、間隙、混音與音訊淡入／淡出，均使用與匯出相同的本機算繪。",
    "en": "Track compositing, cropping, gaps, mixing, and audio fades use the same local rendering as export.",
    "ja": "複数トラックの合成、クロップ、空白、ミキシング、音声フェードには、書き出しと同じローカルレンダリングを使用します。"
  },
  "timeline.preview.sourceDetail": {
    "zh-Hans": "点击左侧素材，或选择时间线片段，即可在大画面中查看。",
    "zh-Hant": "點選左側素材，或選擇時間軸片段，即可在大畫面中檢視。",
    "en": "Choose an asset on the left or a timeline clip to view it here at a larger size.",
    "ja": "左側の素材またはタイムラインのクリップを選択すると、大きな画面で確認できます。"
  },
  "timeline.preview.render": {
    "zh-Hans": "渲染时间线预览",
    "zh-Hant": "算繪時間軸預覽",
    "en": "Render timeline preview",
    "ja": "タイムラインプレビューをレンダリング"
  },
  "timeline.preview.seed": {
    "zh-Hans": "从分镜建立时间线",
    "zh-Hant": "從分鏡建立時間軸",
    "en": "Build timeline from storyboard",
    "ja": "絵コンテからタイムラインを作成"
  },
  "timeline.preview.import": {
    "zh-Hans": "导入素材",
    "zh-Hant": "匯入素材",
    "en": "Import assets",
    "ja": "素材を読み込む"
  },
  "timeline.preview.canvas": {
    "zh-Hans": "返回画板",
    "zh-Hant": "返回畫板",
    "en": "Back to canvas",
    "ja": "キャンバスに戻る"
  },
  "timeline.preview.exported": {
    "zh-Hans": "已导出的成片文件",
    "zh-Hant": "已匯出的成片檔案",
    "en": "Exported final video",
    "ja": "書き出し済み完成動画"
  },
  "timeline.preview.composite": {
    "zh-Hans": "多轨合成预览",
    "zh-Hant": "多軌合成預覽",
    "en": "Multitrack composite preview",
    "ja": "マルチトラック合成プレビュー"
  },
  "timeline.preview.unselected": {
    "zh-Hans": "尚未选择素材",
    "zh-Hant": "尚未選擇素材",
    "en": "No asset selected",
    "ja": "素材が選択されていません"
  },
  "timeline.preview.formatUnavailable": {
    "zh-Hans": "快照规格不可用",
    "zh-Hant": "快照規格無法使用",
    "en": "Snapshot format unavailable",
    "ja": "スナップショットの形式は利用できません"
  },
  "timeline.preview.persistent": {
    "zh-Hans": "渲染结果会持久保存，后续编辑不会覆盖旧文件",
    "zh-Hant": "算繪結果會持久儲存，後續編輯不會覆寫舊檔案",
    "en": "Rendered results are saved persistently; later edits do not overwrite old files",
    "ja": "レンダリング結果は永続保存され、以降の編集で古いファイルを上書きしません"
  },
  "timeline.preview.clipPosition": {
    "zh-Hans": "时间线开始 {start} 帧 · 源入点 {source} 帧 · 长度 {duration} 帧",
    "zh-Hant": "時間軸開始 {start} 影格 · 來源入點 {source} 影格 · 長度 {duration} 影格",
    "en": "Timeline start: {start} frames · Source in: {source} frames · Duration: {duration} frames",
    "ja": "タイムライン開始 {start} フレーム · ソースイン点 {source} フレーム · 長さ {duration} フレーム"
  },
  "timeline.preview.independent": {
    "zh-Hans": "源素材播放位置独立于时间线；选中片段后可联动播放头",
    "zh-Hant": "來源素材播放位置獨立於時間軸；選取片段後可連動播放頭",
    "en": "Source playback position is independent of the timeline; select a clip to link the playhead",
    "ja": "ソース素材の再生位置はタイムラインと独立しています。クリップを選択すると再生ヘッドに連動します"
  },
  "timeline.preview.sourceFrames": {
    "zh-Hans": "源素材 / 帧",
    "zh-Hant": "來源素材 / 影格",
    "en": "Source / frames",
    "ja": "ソース / フレーム"
  },
  "timeline.preview.timelineFrames": {
    "zh-Hans": "时间线 / 帧",
    "zh-Hant": "時間軸 / 影格",
    "en": "Timeline / frames",
    "ja": "タイムライン / フレーム"
  },
  "timeline.references.first": {
    "zh-Hans": "首帧参考图",
    "zh-Hant": "首影格參考圖",
    "en": "First-frame reference",
    "ja": "先頭フレームの参照画像"
  },
  "timeline.references.last": {
    "zh-Hans": "尾帧参考图",
    "zh-Hant": "尾影格參考圖",
    "en": "Last-frame reference",
    "ja": "最終フレームの参照画像"
  },
  "timeline.references.role": {
    "zh-Hans": "参考角色：{role}",
    "zh-Hant": "參考角色：{role}",
    "en": "Reference role: {role}",
    "ja": "参照の役割：{role}"
  },
  "timeline.references.none": {
    "zh-Hans": "未选择首帧或尾帧参考图。",
    "zh-Hant": "尚未選擇首影格或尾影格參考圖。",
    "en": "No first- or last-frame reference selected.",
    "ja": "先頭または最終フレームの参照画像は未選択です。"
  },
  "timeline.references.all": {
    "zh-Hans": "完整生成参考图",
    "zh-Hant": "完整生成參考圖",
    "en": "Complete generation references",
    "ja": "生成に使う参照画像一覧"
  },
  "timeline.references.alt": {
    "zh-Hans": "{role}：{name}",
    "zh-Hant": "{role}：{name}",
    "en": "{role}: {name}",
    "ja": "{role}：{name}"
  },
  "timeline.references.unnamedImage": {
    "zh-Hans": "未命名图片",
    "zh-Hant": "未命名圖片",
    "en": "Untitled image",
    "ja": "無題の画像"
  },
  "timeline.references.unavailable": {
    "zh-Hans": "原图暂不可用",
    "zh-Hant": "原圖暫時無法使用",
    "en": "Original image unavailable",
    "ja": "元の画像は現在利用できません"
  },
  "timeline.references.unnamedAsset": {
    "zh-Hans": "未命名素材",
    "zh-Hant": "未命名素材",
    "en": "Untitled asset",
    "ja": "無題の素材"
  },
  "timeline.references.identity": {
    "zh-Hans": "素材标识与校验值",
    "zh-Hant": "素材識別碼與驗證值",
    "en": "Asset identity and checksum",
    "ja": "素材の識別情報とチェックサム"
  },
  "timeline.references.id": {
    "zh-Hans": "素材 ID",
    "zh-Hant": "素材 ID",
    "en": "Asset ID",
    "ja": "素材 ID"
  },
  "timeline.references.noHash": {
    "zh-Hans": "未提供校验值",
    "zh-Hant": "未提供驗證值",
    "en": "No checksum provided",
    "ja": "チェックサムなし"
  },
  "timeline.references.optional": {
    "zh-Hans": "可选 · 已选 {count}",
    "zh-Hant": "選填 · 已選 {count}",
    "en": "Optional · {count} selected",
    "ja": "任意 · {count} 件選択済み"
  },
  "timeline.references.restriction": {
    "zh-Hans": "首尾帧组合仅接入 Ark 与 Mock。须同时有一张首帧；同一素材不能兼作首尾帧（当前应用限制）。更换服务商不会清除已保存的尾帧。",
    "zh-Hant": "首尾影格組合僅接入 Ark 與 Mock。須同時有一張首影格；相同素材不可同時作為首尾影格（目前應用程式限制）。更換服務商不會清除已儲存的尾影格。",
    "en": "First/last-frame pairs are supported only through Ark and Mock. A first frame is also required; the same asset cannot serve as both frames (current app restriction). Changing provider does not clear the saved last frame.",
    "ja": "先頭・最終フレームの組み合わせは Ark と Mock のみ対応しています。先頭フレームも 1 枚必要です。同じ素材を両方に使うことはできません（現在のアプリの制限）。プロバイダーを変更しても保存済みの最終フレームは消去されません。"
  },
  "timeline.references.lastAria": {
    "zh-Hans": "尾帧参考图 {name}",
    "zh-Hant": "尾影格參考圖 {name}",
    "en": "Last-frame reference {name}",
    "ja": "最終フレームの参照画像 {name}"
  },
  "timeline.references.import": {
    "zh-Hans": "先在左侧导入一张图片作为尾帧。",
    "zh-Hant": "請先在左側匯入一張圖片作為尾影格。",
    "en": "First import an image on the left to use as the last frame.",
    "ja": "まず左側で最終フレームに使う画像を読み込んでください。"
  },
  "timeline.references.selected": {
    "zh-Hans": "已选尾帧：{name}",
    "zh-Hant": "已選尾影格：{name}",
    "en": "Selected last frame: {name}",
    "ja": "選択中の最終フレーム：{name}"
  },
  "timeline.references.missing": {
    "zh-Hans": "素材不存在，请重新选择",
    "zh-Hant": "素材不存在，請重新選擇",
    "en": "Asset missing; choose again",
    "ja": "素材が見つかりません。選び直してください"
  },
  "timeline.references.clear": {
    "zh-Hans": "清除尾帧参考图",
    "zh-Hant": "清除尾影格參考圖",
    "en": "Clear last-frame reference",
    "ja": "最終フレームの参照画像を解除"
  },
  "audio.clip.fieldAria": {
    "zh-Hans": "音频{label}",
    "zh-Hant": "音訊{label}",
    "en": "Audio {label}",
    "ja": "音声 {label}"
  },
  "audio.waveform.held.missing": {
    "zh-Hans": "历史状态 波形未生成 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 波形尚未產生 · 還原分支不會解碼",
    "en": "Historical status: Waveform not generated · Restored branches do not decode",
    "ja": "履歴の状態：波形未生成 · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.loading": {
    "zh-Hans": "历史状态 检查波形… · 恢复分支不解码",
    "zh-Hant": "歷史狀態 檢查波形… · 還原分支不會解碼",
    "en": "Historical status: Checking waveform… · Restored branches do not decode",
    "ja": "履歴の状態：波形を確認中… · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.queued": {
    "zh-Hans": "历史状态 波形排队中… · 恢复分支不解码",
    "zh-Hant": "歷史狀態 波形佇列中… · 還原分支不會解碼",
    "en": "Historical status: Waveform queued… · Restored branches do not decode",
    "ja": "履歴の状態：波形は待機中… · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.running": {
    "zh-Hans": "历史状态 本地分析中… · 恢复分支不解码",
    "zh-Hant": "歷史狀態 本機分析中… · 還原分支不會解碼",
    "en": "Historical status: Analyzing locally… · Restored branches do not decode",
    "ja": "履歴の状態：ローカルで解析中… · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.ready": {
    "zh-Hans": "历史状态 原始源音轨波形 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 原始來源音軌波形 · 還原分支不會解碼",
    "en": "Historical status: Original source audio waveform · Restored branches do not decode",
    "ja": "履歴の状態：元のソース音声の波形 · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.interrupted": {
    "zh-Hans": "历史状态 波形分析已中断，请重试 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 波形分析已中斷，請重試 · 還原分支不會解碼",
    "en": "Historical status: Waveform analysis was interrupted. Retry explicitly. · Restored branches do not decode",
    "ja": "履歴の状態：波形解析が中断されました。明示的に再試行してください。 · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.error": {
    "zh-Hans": "历史状态 波形暂不可用，请重试 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 波形暫時無法使用，請重試 · 還原分支不會解碼",
    "en": "Historical status: Waveform unavailable. Try again. · Restored branches do not decode",
    "ja": "履歴の状態：波形を利用できません。再試行してください。 · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.unsupported": {
    "zh-Hans": "历史状态 此素材暂不支持波形 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 此素材暫不支援波形 · 還原分支不會解碼",
    "en": "Historical status: Waveforms are not supported for this asset · Restored branches do not decode",
    "ja": "履歴の状態：この素材の波形には対応していません · 復元ブランチではデコードしません"
  },
  "audio.waveform.held.unavailable": {
    "zh-Hans": "历史状态 波形暂不可用 · 恢复分支不解码",
    "zh-Hant": "歷史狀態 波形暫時無法使用 · 還原分支不會解碼",
    "en": "Historical status: Waveform unavailable · Restored branches do not decode",
    "ja": "履歴の状態：波形を利用できません · 復元ブランチではデコードしません"
  }
} as const satisfies MessageCatalog;
assertNoDuplicateMessageKeys(timelineCoreMessages, timelineDeliveryMessages);
export const timelineMessages = { ...timelineCoreMessages, ...timelineDeliveryMessages } as const satisfies MessageCatalog;
