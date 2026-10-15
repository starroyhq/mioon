import type { MessageCatalog } from '../types.ts';

/** Localized operation prose only; operation names, schemas and effect contracts stay unchanged. */
export const operationMessages = {
  "operation.lut.import": {
    "zh-Hans": "导入项目拥有的标准化3D Cube资源，最大7 MiB，支持以稳定请求精确重放。此操作仅保存资源，不应用视觉LUT。",
    "zh-Hant": "匯入專案擁有的標準化3D Cube資源，最大7 MiB，支援以穩定請求精確重放。此操作僅儲存資源，不套用視覺LUT。",
    "en": "Import a project-owned normalized 3D Cube resource, maximum 7 MiB, with exact stable-request replay. This stores a resource; it does not apply a visual LUT.",
    "ja": "プロジェクト所有の正規化された3D Cubeリソースを最大7 MiBまでインポートし、安定したリクエストIDによる元の結果の再現に対応します。リソースを保存するだけで、表示用LUTは適用しません。"
  },
  "operation.lut.list": {
    "zh-Hans": "分页列出项目拥有的有界LUT元数据，不返回字节，也不进行渲染。",
    "zh-Hant": "分頁列出專案擁有的有界LUT中繼資料，不傳回位元組，也不進行算繪。",
    "en": "List a bounded page of project-owned LUT metadata without bytes or rendering.",
    "ja": "プロジェクト所有のLUTメタデータを件数制限付きでページごとに一覧表示します。バイト列の取得やレンダリングは行いません。"
  },
  "operation.lut.inspect": {
    "zh-Hans": "验证一个拥有的LUT资源并检查其元数据与哈希，不返回字节，也不应用该资源。",
    "zh-Hant": "驗證一個擁有的LUT資源並檢查其中繼資料與雜湊，不傳回位元組，也不套用該資源。",
    "en": "Verify one owned LUT resource and inspect its metadata/hash without returning its bytes or applying it.",
    "ja": "所有するLUTリソースを1つ検証し、メタデータとハッシュを確認します。バイト列の返却やLUTの適用は行いません。"
  },
  "operation.lut.look.inspect": {
    "zh-Hans": "读取一个拥有的LUT并验证其有界单一Look包元数据。普通Cube资源返回not_pack。来源与许可声明仅为声明，并非认证。不返回字节、路径或有效链接，不获取URL、不渲染、不应用。",
    "zh-Hant": "讀取一個擁有的LUT並驗證其有界單一Look套件中繼資料。一般Cube資源傳回not_pack。來源與授權聲明僅為宣告，並非認證。不傳回位元組、路徑或有效連結，不擷取URL、不算繪、不套用。",
    "en": "Read one owned LUT and verify its bounded single-Look pack metadata. Plain Cube resources return not_pack. Source and licence claims remain declarations, not certification. No bytes, paths, active links, URL fetches, rendering or application.",
    "ja": "所有するLUTを1つ読み取り、サイズ制限付きの単一Lookパックのメタデータを検証します。通常のCubeリソースはnot_packを返します。出典とライセンスの記載は申告であり、認証ではありません。バイト列、パス、有効なリンクの返却、URLの取得、レンダリング、適用は行いません。"
  },
  "operation.timeline.colour.source.inspect": {
    "zh-Hans": "只读对一个拥有的本地视频源进行有界哈希与元数据探测。返回证据与SDR解读资格，不保证调色、解码器、LUT兼容性或未来渲染结果。不写入、不联网。",
    "zh-Hant": "以唯讀方式對一個擁有的本機影片來源進行有界雜湊與中繼資料探測。傳回證據與SDR解讀資格，不保證調色、解碼器、LUT相容性或未來算繪結果。不寫入、不連網。",
    "en": "Read-only bounded hash and metadata probe of one owned local video source. Returns evidence and SDR interpretation eligibility, not a grading, decoder, LUT compatibility or future render guarantee. No writes or network.",
    "ja": "所有するローカル動画ソースを1つ、処理範囲を制限して読み取り専用でハッシュおよびメタデータ検査します。証拠とSDRとして解釈可能かどうかを返しますが、グレーディング、デコーダー、LUTの互換性、将来のレンダリングを保証しません。書き込みやネットワーク通信は行いません。"
  },
  "operation.timeline.colour.image.inspect": {
    "zh-Hans": "只读对一个拥有的静态RGB8/RGBA8 PNG进行有界检查。验证其精确字节、PNG结构与允许的色彩元数据；无标记文件仍须用户明确指定以sRGB解读。不写入、不联网、不调用供应商。",
    "zh-Hant": "以唯讀方式對一個擁有的靜態RGB8/RGBA8 PNG進行有界檢查。驗證其精確位元組、PNG結構與允許的色彩中繼資料；無標記檔案仍須使用者明確指定以sRGB解讀。不寫入、不連網、不呼叫供應商。",
    "en": "Read-only bounded inspection of one owned static RGB8/RGBA8 PNG. Validates its exact bytes, PNG structure and permitted colour metadata; untagged files still require explicit user sRGB interpretation. No writes, network or providers.",
    "ja": "所有する静止RGB8/RGBA8 PNGを1つ、処理範囲を制限して読み取り専用で検査します。正確なバイト列、PNG構造、許可された色メタデータを検証します。タグのないファイルには、ユーザーによる明示的なsRGB解釈の指定が引き続き必要です。書き込み、ネットワーク通信、プロバイダーの呼び出しは行いません。"
  },
  "operation.timeline.colour.jpeg.inspect": {
    "zh-Hans": "只读进行有界严格JFIF基线JPEG检查与本地解码。JFIF不能证明sRGB，仍须用户明确指定解读方式。拒绝EXIF、ICC、HDR、渐进式与多图像来源。不写入、不联网。",
    "zh-Hant": "以唯讀方式進行有界嚴格JFIF基線JPEG檢查與本機解碼。JFIF不能證明sRGB，仍須使用者明確指定解讀方式。拒絕EXIF、ICC、HDR、漸進式與多影像來源。不寫入、不連網。",
    "en": "Read-only bounded strict JFIF baseline JPEG inspection and local decode. JFIF does not prove sRGB: explicit user interpretation is still required. Rejects EXIF, ICC, HDR, progressive and multi-image sources. No writes or network.",
    "ja": "読み取り専用で処理範囲を制限した厳密なJFIFベースラインJPEG検査とローカルデコードを行います。JFIFはsRGBの証明ではなく、ユーザーによる明示的な解釈の指定が引き続き必要です。EXIF、ICC、HDR、プログレッシブ、複数画像のソースは拒否します。書き込みやネットワーク通信は行いません。"
  },
  "operation.workspace.backup.inspect": {
    "zh-Hans": "只读检查整个工作区的有界数据库计数；不复制文件、不恢复任务、不读取密钥。冷备份前必须正常关闭应用和同工作区后端。",
    "zh-Hant": "唯讀檢查整個工作區的有界資料庫計數；不複製檔案、不復原任務、不讀取密鑰。冷備份前必須正常關閉應用程式和同工作區後端。",
    "en": "Read-only inspection of bounded database counts across the workspace; does not copy files, recover tasks, or read secrets. Before a cold backup, cleanly shut down the application and backends using the same workspace.",
    "ja": "ワークスペース全体のデータベース件数を、処理範囲を制限して読み取り専用で確認します。ファイルのコピー、タスクの復旧、シークレットの読み取りは行いません。コールドバックアップの前に、アプリと同じワークスペースを使用するバックエンドを正常に終了する必要があります。"
  },
  "operation.workspace.restore.inspect": {
    "zh-Hans": "只读查看工作区恢复分支身份、隔离计数与可用操作；不接收路径、不恢复或执行旧任务、不授予模型或付费权限。显式 includeAudioRoleCapability:true 可查询当前音频角色编辑能力。",
    "zh-Hant": "唯讀查看工作區復原分支身分、隔離計數與可用操作；不接收路徑、不復原或執行舊任務、不授予模型或付費權限。明確 includeAudioRoleCapability:true 可查詢目前音訊角色編輯能力。",
    "en": "Read-only inspection of the workspace restore-branch identity, isolation counts, and available operations; accepts no paths, does not recover or execute old tasks, and grants no model or paid-use permissions. Explicit includeAudioRoleCapability:true reports current audio-role editing capability.",
    "ja": "ワークスペースの復元ブランチの識別情報、隔離件数、利用可能な操作を読み取り専用で確認します。パスの受け取り、過去のタスクの復旧や実行、モデル利用権限や有料利用権限の付与は行いません。includeAudioRoleCapability:true を明示すると、現在の音声役割の編集可否を確認できます。"
  },
  "operation.timeline.format.get": {
    "zh-Hans": "只读查询当前时间线输出规格、版本与初始设置资格；不创建时间线",
    "zh-Hant": "唯讀查詢目前時間軸輸出規格、版本與初始設定資格；不建立時間軸。",
    "en": "Read-only query of the current timeline output format, version, and eligibility for initial setup; does not create a timeline.",
    "ja": "現在のタイムラインの出力形式、バージョン、初期設定の適用可否を読み取り専用で照会します。タイムラインは作成しません。"
  },
  "operation.timeline.format.set": {
    "zh-Hans": "仅为初始空白时间线显式设置竖屏、横屏或方屏720规格，固定30fps；项目与时间线双版本校验，精确请求重放，不进入撤销历史",
    "zh-Hant": "僅為初始空白時間軸明確設定直向、橫向或正方形720規格，固定30fps；專案與時間軸雙版本校驗，精確請求重放，不進入復原歷史。",
    "en": "Explicitly set portrait, landscape, or square 720 output at fixed 30fps only for an initially blank timeline; validates both project and timeline versions, supports exact request replay, and does not enter undo history.",
    "ja": "初期状態の空のタイムラインに限り、縦長、横長、正方形の720出力形式を固定30fpsで明示的に設定します。プロジェクトとタイムラインの両バージョンを検証し、同一リクエストの元の結果の再現に対応します。取り消し履歴には追加しません。"
  },
  "operation.timeline.subtitle.add": {
    "zh-Hans": "按时间线版本添加一条手动字幕；固定字体排版，30fps时间，返回完整已保存时间线",
    "zh-Hant": "按時間軸版本新增一條手動字幕；固定字型排版，30fps時間，傳回完整已儲存時間軸。",
    "en": "Add one manual subtitle against the timeline version, with fixed-font layout and 30fps timing; returns the complete saved timeline.",
    "ja": "タイムラインのバージョンを照合して手動字幕を1つ追加します。固定フォントの組版と30fpsの時間を使用し、保存済みのタイムライン全体を返します。"
  },
  "operation.timeline.subtitle.update": {
    "zh-Hans": "按时间线版本更新指定字幕文字或时间；不修改素材，不生成语音或转录",
    "zh-Hant": "按時間軸版本更新指定字幕文字或時間；不修改素材，不產生語音或轉錄。",
    "en": "Update the specified subtitle text or timing against the timeline version; does not modify assets, generate speech, or transcribe.",
    "ja": "タイムラインのバージョンを照合して指定字幕のテキストまたは時間を更新します。素材の変更、音声生成、文字起こしは行いません。"
  },
  "operation.timeline.subtitle.remove": {
    "zh-Hans": "按时间线版本移除指定手动字幕，保留精确请求回执和撤销历史",
    "zh-Hant": "按時間軸版本移除指定手動字幕，保留精確請求回執和復原歷史。",
    "en": "Remove the specified manual subtitle against the timeline version, preserving the exact request receipt and undo history.",
    "ja": "タイムラインのバージョンを照合して指定の手動字幕を削除し、厳密なリクエスト受領記録と取り消し履歴を保持します。"
  },
  "operation.frame.extract": {
    "zh-Hans": "用稳定请求键从本项目固定素材哈希与30fps源时点显式提取一张本地PNG；先持久化任务再解码，不修改原素材，不生成或付费；30fps标记不是原生或VFR帧号",
    "zh-Hant": "用穩定請求鍵從本專案固定素材雜湊與30fps來源時點明確擷取一張本機PNG；先持久化任務再解碼，不修改原素材，不生成或付費；30fps標記不是原生或VFR影格號。",
    "en": "Explicitly extract one local PNG using a stable request key, this project's pinned asset hash, and a 30fps source time point. Persists the task before decoding; does not modify the original asset, generate media, or incur payment. The 30fps marker is not a native or VFR frame number.",
    "ja": "安定したリクエストキー、このプロジェクト内の固定された素材ハッシュ、30fpsのソース時点を使用して、ローカルPNGを1枚明示的に抽出します。デコード前にタスクを永続化し、元の素材の変更、メディア生成、課金は行いません。30fpsのマーカーはネイティブまたはVFRのフレーム番号ではありません。"
  },
  "operation.frame.request.get": {
    "zh-Hans": "只读查询原抽帧操作的不可变受理回执；历史状态不触发执行，当前状态另查task.get",
    "zh-Hant": "唯讀查詢原擷取影格操作的不可變受理回執；歷史狀態不觸發執行，目前狀態另查task.get。",
    "en": "Read-only query of the original frame extraction operation's immutable acceptance receipt; historical status does not trigger execution. Query task.get separately for current status.",
    "ja": "元のフレーム抽出操作の不変な受理記録を読み取り専用で照会します。履歴状態から実行は開始されません。現在の状態はtask.getで別途照会してください。"
  },
  "operation.frame.task.get": {
    "zh-Hans": "只读查询本项目已有抽帧任务和安全结果元数据；不读取媒体或恢复任务",
    "zh-Hant": "唯讀查詢本專案既有擷取影格任務和安全結果中繼資料；不讀取媒體或復原任務。",
    "en": "Read-only query of this project's existing frame extraction task and safe result metadata; does not read media or recover tasks.",
    "ja": "このプロジェクトの既存フレーム抽出タスクと安全な結果メタデータを読み取り専用で照会します。メディアの読み取りやタスクの復旧は行いません。"
  },
  "operation.frame.task.list": {
    "zh-Hans": "按项目分页只读发现本地抽帧任务，默认20条、最多50条；重启和查询不会自动解码",
    "zh-Hant": "按專案分頁唯讀探索本機擷取影格任務，預設20條、最多50條；重新啟動和查詢不會自動解碼。",
    "en": "Discover local frame extraction tasks by project in read-only pages, 20 by default and at most 50; restarting or querying never automatically decodes.",
    "ja": "プロジェクトごとのローカルフレーム抽出タスクを読み取り専用でページ単位に検索します。既定は20件、最大50件です。再起動や照会で自動デコードは行いません。"
  },
  "operation.frame.task.cancelQueued": {
    "zh-Hans": "按任务版本和稳定请求键仅取消排队或明确未启动的中断抽帧任务；已运行任务不伪称取消成功",
    "zh-Hant": "按任務版本和穩定請求鍵僅取消排隊或明確未啟動的中斷擷取影格任務；已執行任務不偽稱取消成功。",
    "en": "Using the task version and a stable request key, cancel only queued or interrupted frame extraction tasks confirmed not to have started; does not falsely claim cancellation of already running tasks.",
    "ja": "タスクのバージョンと安定したリクエストキーを使用し、キュー待機中、または未開始と確認された中断済みフレーム抽出タスクのみをキャンセルします。実行済みのタスクをキャンセルできたと偽って報告しません。"
  },
  "operation.frame.task.recoverResult": {
    "zh-Hans": "按任务版本和稳定请求键明确校验并发布已存在的完整PNG与任务凭据；不重新解码，不重新提交",
    "zh-Hant": "按任務版本和穩定請求鍵明確校驗並發布已存在的完整PNG與任務憑據；不重新解碼，不重新提交。",
    "en": "Using the task version and a stable request key, explicitly verify and publish an existing complete PNG and task receipt; does not decode again or resubmit.",
    "ja": "タスクのバージョンと安定したリクエストキーを使用し、既存の完全なPNGとタスク証憑を明示的に検証して公開します。再デコードや再送信は行いません。"
  },
  "operation.image.profile.list": {
    "zh-Hans": "读取图像预设；includeSettingsRevision:true 可发现对应槽的非秘密配置版本，默认响应不变；不探测网络、解密密钥或授予生成批准",
    "zh-Hant": "讀取影像預設；includeSettingsRevision:true 可探索對應槽的非秘密設定版本，預設回應不變；不探測網路、解密密鑰或授予生成批准。",
    "en": "Read image presets; includeSettingsRevision:true reveals the corresponding slot's non-secret configuration version without changing the default response. Does not probe the network, decrypt secrets, or grant generation approval.",
    "ja": "画像プリセットを読み取ります。includeSettingsRevision:trueで対応スロットの秘密ではない設定バージョンを確認できます。既定の応答は変わりません。ネットワークの検査、シークレットの復号、生成の承認は行いません。"
  },
  "operation.image.generate": {
    "zh-Hans": "持久化精确 Mock 图像请求或重放原回执；Mock 与官方 OpenAI 可选择单张项目内 PNG 作为编辑来源，原图保留。新真实请求须先准备 review 并由用户界面批准；不自动替换镜头、引用或时间线",
    "zh-Hant": "持久化精確Mock影像請求或重放原回執；Mock與官方OpenAI可選擇單張專案內PNG作為編輯來源，原圖保留。新真實請求須先準備review並由使用者介面批准；不自動替換鏡頭、引用或時間軸。",
    "en": "Persist an exact Mock image request or replay its original receipt. Mock and official OpenAI can use one in-project PNG as an editing source while preserving the original. New real requests require a prepared review and user-interface approval first; never automatically replaces shots, references, or the timeline.",
    "ja": "厳密なMock画像リクエストを永続化するか、元の受領記録を再現します。Mockと公式OpenAIでは、プロジェクト内のPNGを1枚、元画像を保持したまま編集ソースにできます。新規の実際のリクエストには、事前のreview準備とユーザーインターフェースでの承認が必要です。ショット、参照、タイムラインを自動置換しません。"
  },
  "operation.image.request.get": {
    "zh-Hans": "只读查找原图像请求的不可变受理回执；返回历史状态，不重试、不启动工作，当前状态另查 task.get",
    "zh-Hant": "唯讀尋找原影像請求的不可變受理回執；傳回歷史狀態，不重試、不啟動工作，目前狀態另查task.get。",
    "en": "Read-only lookup of the original image request's immutable acceptance receipt; returns historical status without retrying or starting work. Query task.get separately for current status.",
    "ja": "元の画像リクエストの不変な受理記録を読み取り専用で検索します。再試行や作業の開始を行わず、履歴状態を返します。現在の状態はtask.getで別途照会してください。"
  },
  "operation.image.task.get": {
    "zh-Hans": "只读查询本项目图像任务与可恢复状态，不恢复或重新生成",
    "zh-Hant": "唯讀查詢本專案影像任務與可復原狀態，不復原或重新生成。",
    "en": "Read-only query of this project's image tasks and recoverable states; does not recover or regenerate.",
    "ja": "このプロジェクトの画像タスクと復旧可能な状態を読み取り専用で照会します。復旧や再生成は行いません。"
  },
  "operation.image.task.list": {
    "zh-Hans": "分页只读列出项目或图像组任务，最新记录在前，不启动任务",
    "zh-Hant": "分頁唯讀列出專案或影像群組任務，最新記錄在前，不啟動任務。",
    "en": "List project or image-group tasks in read-only pages, newest records first; does not start tasks.",
    "ja": "プロジェクトまたは画像グループのタスクを、新しい記録から順に読み取り専用でページごとに一覧表示します。タスクは開始しません。"
  },
  "operation.image.group.list": {
    "zh-Hans": "分页只读列出项目图像组，最新创建记录在前",
    "zh-Hant": "分頁唯讀列出專案影像群組，最新建立記錄在前。",
    "en": "List project image groups in read-only pages, most recently created first.",
    "ja": "プロジェクトの画像グループを、作成日時の新しい順に読み取り専用でページごとに一覧表示します。"
  },
  "operation.image.group.get": {
    "zh-Hans": "只读查询已有图像组当前版本及待处理任务，不创建分组",
    "zh-Hant": "唯讀查詢既有影像群組目前版本及待處理任務，不建立群組。",
    "en": "Read-only query of an existing image group's current version and pending tasks; does not create groups.",
    "ja": "既存の画像グループの現在のバージョンと保留中タスクを読み取り専用で照会します。グループは作成しません。"
  },
  "operation.image.version.list": {
    "zh-Hans": "分页只读列出图像组的不可变结果，版本号降序；仅返回安全托管素材元数据",
    "zh-Hant": "分頁唯讀列出影像群組的不可變結果，版本號遞減；僅傳回安全受管素材中繼資料。",
    "en": "List an image group's immutable results in read-only pages, in descending version order; returns only safe managed-asset metadata.",
    "ja": "画像グループの不変な結果を、バージョン番号の降順に読み取り専用でページごとに一覧表示します。安全な管理対象素材のメタデータのみを返します。"
  },
  "operation.image.task.cancelQueued": {
    "zh-Hans": "用稳定请求 ID 和任务版本明确取消尚未分派的排队或中断任务，不代表供应商退款",
    "zh-Hant": "用穩定請求ID和任務版本明確取消尚未分派的排隊或中斷任務，不代表供應商退款。",
    "en": "Explicitly cancel undispatched queued or interrupted tasks using a stable request ID and task version; does not imply a provider refund.",
    "ja": "安定したリクエストIDとタスクのバージョンを使用し、未割り当てのキュー待機中または中断済みタスクを明示的にキャンセルします。プロバイダーの返金を意味しません。"
  },
  "operation.image.task.recoverResult": {
    "zh-Hans": "用稳定请求 ID 明确核验并保存已存在的本地结果；缺失结果保持待确认，绝不重新调用图像供应商",
    "zh-Hant": "用穩定請求ID明確核驗並儲存已存在的本機結果；缺失結果保持待確認，絕不重新呼叫影像供應商。",
    "en": "Explicitly verify and save existing local results using a stable request ID; missing results remain pending confirmation, and the image provider is never called again.",
    "ja": "安定したリクエストIDを使用し、既存のローカル結果を明示的に検証して保存します。結果がない場合は確認待ちのままとし、画像プロバイダーを再度呼び出すことはありません。"
  },
  "operation.image.review.prepare": {
    "zh-Hans": "保存当前项目的精确图像请求供用户确认；官方 OpenAI 可编辑一张已验证的项目内 PNG，冻结原始字节哈希及来源；自定义兼容仅文本生成，本机 ComfyUI 冻结固定工作流。准备不批准、不生成、不发送请求",
    "zh-Hant": "儲存目前專案的精確影像請求供使用者確認；官方OpenAI可編輯一張已驗證的專案內PNG，凍結原始位元組雜湊及來源；自訂相容僅文字生成，本機ComfyUI凍結固定工作流程。準備不批准、不生成、不傳送請求。",
    "en": "Save the current project's exact image request for user confirmation. Official OpenAI can edit one verified in-project PNG with its original byte hash and provenance frozen; custom-compatible providers support text-only generation, and local ComfyUI freezes a fixed workflow. Preparation does not approve, generate, or send requests.",
    "ja": "現在のプロジェクトの厳密な画像リクエストをユーザー確認用に保存します。公式OpenAIでは検証済みのプロジェクト内PNGを1枚編集でき、元のバイト列のハッシュと出典を固定します。カスタム互換プロバイダーはテキストからの生成のみで、ローカルComfyUIは所定のワークフローを固定します。準備では承認、生成、リクエスト送信を行いません。"
  },
  "operation.image.review.get": {
    "zh-Hans": "读取当前项目已保存的图像请求确认记录；不会批准、执行或重试",
    "zh-Hant": "讀取目前專案已儲存的影像請求確認記錄；不會批准、執行或重試。",
    "en": "Read the current project's saved image request confirmation record; does not approve, execute, or retry.",
    "ja": "現在のプロジェクトに保存された画像リクエスト確認記録を読み取ります。承認、実行、再試行は行いません。"
  },
  "operation.image.review.list": {
    "zh-Hans": "分页读取当前项目图像请求确认记录；不会批准或执行",
    "zh-Hant": "分頁讀取目前專案影像請求確認記錄；不會批准或執行。",
    "en": "Read the current project's image request confirmation records in pages; does not approve or execute.",
    "ja": "現在のプロジェクトの画像リクエスト確認記録をページごとに読み取ります。承認や実行は行いません。"
  },
  "operation.image.task.remote.get": {
    "zh-Hans": "只读当前项目已有本机 ComfyUI 任务的本地远端状态记录和最近观察进度；不联网、不创建任务、不恢复或启动观察",
    "zh-Hant": "唯讀目前專案既有本機ComfyUI任務的本機遠端狀態記錄和最近觀察進度；不連網、不建立任務、不復原或啟動觀察。",
    "en": "Read-only query of local remote-state records and the latest observation progress for existing local ComfyUI tasks in the current project; does not access the network, create tasks, recover tasks, or start observation.",
    "ja": "現在のプロジェクトの既存ローカルComfyUIタスクについて、ローカルに保存されたリモート状態記録と最新の観測進捗を読み取り専用で照会します。ネットワーク接続、タスクの作成や復旧、観測開始は行いません。"
  },
  "operation.image.task.observeRemote": {
    "zh-Hans": "按远端记录版本和稳定请求 ID 持久化一次观察；异步仅查询已冻结 ComfyUI 任务，验证完成身份后可取回一个固定 PNG；不提交、不重试生成、不自动轮询，原受理回执永久保留",
    "zh-Hant": "按遠端記錄版本和穩定請求ID持久化一次觀察；非同步僅查詢已凍結ComfyUI任務，驗證完成身分後可取回一個固定PNG；不提交、不重試生成、不自動輪詢，原受理回執永久保留。",
    "en": "Persist one observation using the remote-record version and a stable request ID. Asynchronously queries only the frozen ComfyUI task and may retrieve one pinned PNG after verifying completion identity. Does not submit, retry generation, or poll automatically; the original acceptance receipt is retained permanently.",
    "ja": "リモート記録のバージョンと安定したリクエストIDを使用し、1回の観測を永続化します。固定されたComfyUIタスクのみを非同期で照会し、完了の識別情報を検証後、固定されたPNGを1枚取得できます。送信、生成の再試行、自動ポーリングは行いません。元の受理記録は永続的に保持します。"
  },
  "operation.project.inspect": {
    "zh-Hans": "只读检查指定项目的有界安全元数据；不创建时间线，不返回路径、URL或媒体",
    "zh-Hant": "唯讀檢查指定專案的有界安全中繼資料；不建立時間軸，不傳回路徑、URL或媒體。",
    "en": "Read-only inspection of bounded safe metadata for the specified project; does not create a timeline or return paths, URLs, or media.",
    "ja": "指定プロジェクトの安全なメタデータを、範囲を制限して読み取り専用で検査します。タイムラインの作成や、パス、URL、メディアの返却は行いません。"
  },
  "operation.asset.inspect": {
    "zh-Hans": "分页只读检查指定项目的安全素材元数据；默认10条、最多25条，不读取媒体",
    "zh-Hant": "分頁唯讀檢查指定專案的安全素材中繼資料；預設10條、最多25條，不讀取媒體。",
    "en": "Read-only paginated inspection of safe asset metadata for the specified project, 10 items by default and at most 25; does not read media.",
    "ja": "指定プロジェクトの安全な素材メタデータを読み取り専用でページごとに検査します。既定は10件、最大25件です。メディアは読み取りません。"
  },
  "operation.shot.inspect": {
    "zh-Hans": "分页只读检查指定项目的安全镜头元数据；默认10条、最多25条，提示词最多返回1000UTF-8字节并标明截断，不返回媒体",
    "zh-Hant": "分頁唯讀檢查指定專案的安全鏡頭中繼資料；預設10條、最多25條，提示詞最多傳回1000 UTF-8位元組並標明截斷，不傳回媒體。",
    "en": "Read-only paginated inspection of safe shot metadata for the specified project, 10 items by default and at most 25. Returns at most 1000 UTF-8 bytes of each prompt, indicating truncation; does not return media.",
    "ja": "指定プロジェクトの安全なショットメタデータを読み取り専用でページごとに検査します。既定は10件、最大25件です。プロンプトはUTF-8で最大1000バイトまで返し、切り詰めを明示します。メディアは返しません。"
  },
  "operation.timeline.inspect": {
    "zh-Hans": "只读检查已存在的时间线安全元数据；不存在时如实报告，不创建空时间线",
    "zh-Hant": "唯讀檢查已存在的時間軸安全中繼資料；不存在時如實報告，不建立空時間軸。",
    "en": "Read-only inspection of safe metadata for an existing timeline; accurately reports absence without creating an empty timeline.",
    "ja": "既存タイムラインの安全なメタデータを読み取り専用で検査します。存在しない場合はそのまま報告し、空のタイムラインは作成しません。"
  },
  "operation.subject.create": {
    "zh-Hans": "创建项目内版本化主体，仅固定已有托管图片及来源，不生成媒体；必须使用稳定请求 ID",
    "zh-Hant": "建立專案內版本化主體，僅固定既有受管圖片及來源，不生成媒體；必須使用穩定請求ID。",
    "en": "Create a versioned subject within the project, pinning only existing managed images and provenance without generating media; a stable request ID is required.",
    "ja": "プロジェクト内にバージョン管理された主体を作成し、既存の管理対象画像と出典のみを固定します。メディアは生成しません。安定したリクエストIDが必須です。"
  },
  "operation.subject.version.add": {
    "zh-Hans": "添加主体的不可变参考版本；已有绑定固定旧选择并提示复核，不自动更新镜头或生成",
    "zh-Hant": "新增主體的不可變參考版本；既有綁定固定舊選擇並提示複核，不自動更新鏡頭或生成。",
    "en": "Add an immutable reference version for a subject; existing bindings retain their old selections and indicate review is needed, without automatically updating shots or generating.",
    "ja": "主体の不変な参照バージョンを追加します。既存のバインドは以前の選択を固定したまま再確認を促し、ショットの自動更新や生成は行いません。"
  },
  "operation.subject.binding.set": {
    "zh-Hans": "按独立绑定版本和主体版本明确固定、复核或解除主体/风格引用；不会修改首帧或时间线",
    "zh-Hant": "按獨立綁定版本和主體版本明確固定、複核或解除主體／風格引用；不會修改首影格或時間軸。",
    "en": "Explicitly pin, review, or detach a subject/style reference against the independent binding version and subject version; does not modify the first frame or timeline.",
    "ja": "独立したバインドのバージョンと主体のバージョンを照合し、主体／スタイル参照を明示的に固定、再確認、または解除します。先頭フレームやタイムラインは変更しません。"
  },
  "operation.subject.list": {
    "zh-Hans": "分页只读列出项目主体与当前参考版本，不创建记录，不返回媒体路径或 URL",
    "zh-Hant": "分頁唯讀列出專案主體與目前參考版本，不建立記錄，不傳回媒體路徑或URL。",
    "en": "List project subjects and their current reference versions in read-only pages; does not create records or return media paths or URLs.",
    "ja": "プロジェクトの主体と現在の参照バージョンを読み取り専用でページごとに一覧表示します。記録の作成やメディアのパス、URLの返却は行いません。"
  },
  "operation.subject.version.list": {
    "zh-Hans": "分页只读列出主体所有不可变参考版本，可明确重新选择旧版",
    "zh-Hant": "分頁唯讀列出主體所有不可變參考版本，可明確重新選擇舊版。",
    "en": "List all immutable reference versions of a subject in read-only pages; an older version can be explicitly reselected.",
    "ja": "主体のすべての不変な参照バージョンを読み取り専用でページごとに一覧表示します。以前のバージョンを明示的に再選択できます。"
  },
  "operation.subject.binding.list": {
    "zh-Hans": "按唯一镜头或主体过滤器分页只读列出绑定及保留的解绑版本，标记是否需复核",
    "zh-Hant": "按唯一鏡頭或主體篩選器分頁唯讀列出綁定及保留的解綁版本，標記是否需複核。",
    "en": "List bindings and retained unbound versions in read-only pages using exactly one shot or subject filter, indicating whether review is needed.",
    "ja": "ショットまたは主体のいずれか1つのフィルターを使用し、バインドと保持された解除済みバージョンを読み取り専用でページごとに一覧表示して、再確認の要否を示します。"
  },
  "operation.asset.range.get": {
    "zh-Hans": "只读查询已有视频或音频素材的独立源范围；未保存时返回 revision 0 和 range null，不创建记录；使用30fps时间线时基，非原生/VFR逐帧精度",
    "zh-Hant": "唯讀查詢既有影片或音訊素材的獨立來源範圍；未儲存時傳回revision 0和range null，不建立記錄；使用30fps時間軸時基，非原生／VFR逐影格精度。",
    "en": "Read-only query of the independent source range for an existing video or audio asset. Unsaved ranges return revision 0 and range null without creating records. Uses the 30fps timeline timebase, not native/VFR frame accuracy.",
    "ja": "既存の動画または音声素材の独立したソース範囲を読み取り専用で照会します。未保存の場合は記録を作成せず、revision 0とrange nullを返します。30fpsのタイムライン時間基準を使用し、ネイティブ／VFRのフレーム精度ではありません。"
  },
  "operation.asset.range.set": {
    "zh-Hans": "按独立范围版本保存素材入点和排他出点；至少1帧，可超过时间线18000帧上限；必须使用稳定requestId精确重放，不修改素材、版本或时间线",
    "zh-Hant": "按獨立範圍版本儲存素材入點和排他出點；至少1影格，可超過時間軸18000影格上限；必須使用穩定requestId精確重放，不修改素材、版本或時間軸。",
    "en": "Save the asset in-point and exclusive out-point against the independent range version. The range must span at least 1 frame and may exceed the timeline's 18000-frame limit. Requires a stable requestId for exact replay; does not modify the asset, version, or timeline.",
    "ja": "独立した範囲バージョンを照合し、素材のイン点と排他的アウト点を保存します。少なくとも1フレーム必要で、タイムラインの18000フレーム上限を超えることができます。同一リクエストの元の結果の再現には安定したrequestIdが必須です。素材、バージョン、タイムラインは変更しません。"
  },
  "operation.asset.annotation.list": {
    "zh-Hans": "按请求顺序读取项目素材的标签和纯文本备注，不创建记录。",
    "zh-Hant": "按請求順序讀取專案素材的標籤和純文字備註，不建立記錄。",
    "en": "Read project asset tags and plain-text notes in request order without creating records.",
    "ja": "プロジェクト素材のタグとプレーンテキストのメモをリクエスト順に読み取ります。記録は作成しません。"
  },
  "operation.asset.annotation.set": {
    "zh-Hans": "按独立版本保存素材标签和纯文本备注，使用稳定请求 ID 精确重放；不修改素材字节、生成版本或时间线。恢复的工作区不支持此操作。",
    "zh-Hant": "按獨立版本儲存素材標籤和純文字備註，使用穩定請求 ID 精確重播；不修改素材位元組、生成版本或時間軸。還原的工作區不支援此操作。",
    "en": "Save asset tags and plain-text notes against an independent revision with exact stable-key replay. Does not change media bytes, generated versions or the timeline. Unavailable in restored workspaces.",
    "ja": "独立したリビジョンを照合して素材のタグとプレーンテキストのメモを保存し、同じキーで元の結果を再現します。メディア、生成バージョン、タイムラインは変更しません。復元したワークスペースでは使用できません。"
  },
  "operation.asset.disposition.list": {
    "zh-Hans": "只读查询指定项目中1–100个不重复素材的共享标记，按请求顺序返回；未保存时为 neutral 和 revision 0；缺失或跨项目时整批失败，不创建记录",
    "zh-Hant": "唯讀查詢指定專案中1–100個不重複素材的共用標記，按請求順序傳回；未儲存時為neutral和revision 0；缺失或跨專案時整批失敗，不建立記錄。",
    "en": "Read-only query of shared flags for 1–100 distinct assets in the specified project, returned in request order. Unsaved flags are neutral with revision 0. Any missing or cross-project asset fails the entire batch; no records are created.",
    "ja": "指定プロジェクトの重複しない1–100件の素材の共有マークを読み取り専用で照会し、リクエスト順に返します。未保存の場合はneutral、revision 0です。存在しない素材や別プロジェクトの素材があるとバッチ全体が失敗します。記録は作成しません。"
  },
  "operation.asset.disposition.set": {
    "zh-Hans": "按独立版本设置素材共享标记 neutral、favorite 或 rejected；重置仍保留版本；必须使用稳定requestId精确重放，不删除素材、不修改名称、字节、源范围或时间线",
    "zh-Hant": "按獨立版本設定素材共用標記neutral、favorite或rejected；重設仍保留版本；必須使用穩定requestId精確重放，不刪除素材、不修改名稱、位元組、來源範圍或時間軸。",
    "en": "Set an asset's shared flag to neutral, favorite, or rejected against its independent version; resetting still retains the version. Requires a stable requestId for exact replay. Does not delete assets or change names, bytes, source ranges, or the timeline.",
    "ja": "独立したバージョンを照合し、素材の共有マークをneutral、favorite、rejectedのいずれかに設定します。リセットしてもバージョンは保持します。同一リクエストの元の結果の再現には安定したrequestIdが必須です。素材の削除、名前、バイト列、ソース範囲、タイムラインの変更は行いません。"
  },
  "operation.asset.waveform.request": {
    "zh-Hans": "显式请求本地源音频波形缓存；重复请求复用排队、运行或就绪结果，失败或中断须显式retry；运行有界本地解码并写入可淘汰缓存，不调用生成供应商、不编辑素材或时间线",
    "zh-Hant": "明確請求本機來源音訊波形快取；重複請求重用排隊、執行或就緒結果，失敗或中斷須明確retry；執行有界本機解碼並寫入可淘汰快取，不呼叫生成供應商、不編輯素材或時間軸。",
    "en": "Explicitly request a local source-audio waveform cache. Repeated requests reuse queued, running, or ready results; failed or interrupted requests require an explicit retry. Performs bounded local decoding and writes an evictable cache, without calling generation providers or editing assets or the timeline.",
    "ja": "ローカルのソース音声波形キャッシュを明示的に要求します。繰り返しの要求ではキュー待機中、実行中、準備完了の結果を再利用し、失敗や中断には明示的なretryが必要です。処理範囲を制限したローカルデコードを行い、削除可能なキャッシュに書き込みます。生成プロバイダーの呼び出し、素材やタイムラインの編集は行いません。"
  },
  "operation.asset.waveform.get": {
    "zh-Hans": "只读查询指定项目素材的源音频波形；30fps源范围使用排他出点，最多返回2048个归一化峰值；不启动解码、不探测媒体、不修复或写入缓存；不表示时间线混音结果",
    "zh-Hant": "唯讀查詢指定專案素材的來源音訊波形；30fps來源範圍使用排他出點，最多傳回2048個正規化峰值；不啟動解碼、不探測媒體、不修復或寫入快取；不表示時間軸混音結果。",
    "en": "Read-only query of the source-audio waveform for the specified project asset. The 30fps source range uses an exclusive out-point and returns at most 2048 normalized peaks. Does not start decoding, probe media, repair or write caches; does not represent the timeline mix.",
    "ja": "指定プロジェクト素材のソース音声波形を読み取り専用で照会します。30fpsのソース範囲は排他的アウト点を使用し、正規化されたピークを最大2048個返します。デコード開始、メディア検査、キャッシュの修復や書き込みは行いません。タイムラインのミックス結果を示すものではありません。"
  },
  "operation.timeline.export.preflight": {
    "zh-Hans": "只读检查既有时间线的本地导出条件；按版本流式核验素材哈希并运行有界ffprobe元数据检查，不完整解码、不创建时间线、缓存或导出，不调用供应商；返回ready、blocked、incomplete或stale，检查结果不保证未来文件可用",
    "zh-Hant": "唯讀檢查既有時間軸的本機匯出條件；按版本串流核驗素材雜湊並執行有界ffprobe中繼資料檢查，不完整解碼、不建立時間軸、快取或匯出，不呼叫供應商；傳回ready、blocked、incomplete或stale，檢查結果不保證未來檔案可用。",
    "en": "Read-only inspection of local export prerequisites for an existing timeline. Streams asset-hash verification against the version and runs bounded ffprobe metadata checks, without full decoding, creating timelines, caches or exports, or calling providers. Returns ready, blocked, incomplete, or stale; results do not guarantee future file availability.",
    "ja": "既存タイムラインのローカル書き出し条件を読み取り専用で検査します。バージョンを照合して素材ハッシュをストリーミング検証し、処理範囲を制限したffprobeメタデータ検査を実行します。完全なデコード、タイムライン、キャッシュ、書き出しの作成、プロバイダー呼び出しは行いません。ready、blocked、incomplete、staleを返します。結果は将来のファイル利用可能性を保証しません。"
  },
  "operation.timeline.export.samplePeak": {
    "zh-Hans": "已导出文件解码样本峰值：显式完整解码一个已成功导出的托管文件，返回绑定实际核验文件哈希的临时测量；单次有界本地计算，不排队、不保存、不重试、不修改项目或导出、不调用供应商；结果不保证其他播放或制作阶段的表现",
    "zh-Hant": "已匯出檔案解碼樣本峰值：明確完整解碼一個已成功匯出的受管檔案，傳回綁定實際核驗檔案雜湊的暫時測量；單次有界本機計算，不排隊、不儲存、不重試、不修改專案或匯出、不呼叫供應商；結果不保證其他播放或製作階段的表現。",
    "en": "Decoded sample peak of an exported file: explicitly fully decode one successfully exported managed file and return a temporary measurement bound to its actually verified file hash. One bounded local computation, with no queueing, saving, retries, project or export changes, or provider calls. Results do not guarantee behavior at other playback or production stages.",
    "ja": "書き出し済みファイルのデコード後サンプルピークを測定します。正常に書き出された管理対象ファイルを1つ明示的に完全デコードし、実際に検証したファイルハッシュに紐づく一時的な測定値を返します。処理範囲を制限した1回のローカル計算であり、キュー登録、保存、再試行、プロジェクトや書き出しの変更、プロバイダー呼び出しは行いません。他の再生・制作段階の挙動は保証しません。"
  },
  "operation.timeline.export.loudness": {
    "zh-Hans": "已导出文件响度与真峰值估计：按显式文件哈希和固定测量配置完整解码一个已成功导出的托管 MP4，返回临时结果；仅显式自定义目标产生算术建议，不验证当前时间线、不授权应用增益；有界本地只读计算，不排队、不保存、不重试、不调用模型或供应商、不修改或阻止导出",
    "zh-Hant": "已匯出檔案響度與真峰值估計：按明確檔案雜湊和固定測量設定完整解碼一個已成功匯出的受管MP4，傳回暫時結果；僅明確自訂目標產生算術建議，不驗證目前時間軸、不授權套用增益；有界本機唯讀計算，不排隊、不儲存、不重試、不呼叫模型或供應商、不修改或阻止匯出。",
    "en": "Exported-file loudness and true-peak estimate: fully decode one successfully exported managed MP4 using an explicit file hash and fixed measurement configuration, returning temporary results. Only explicit custom targets yield arithmetic suggestions; does not validate the current timeline or authorize gain application. Bounded local read-only computation, with no queueing, saving, retries, model or provider calls, or modification or blocking of exports.",
    "ja": "書き出し済みファイルのラウドネスとトゥルーピークを推定します。明示されたファイルハッシュと固定の測定設定を使用して、正常に書き出された管理対象MP4を1つ完全デコードし、一時的な結果を返します。明示的なカスタム目標にのみ算術的な提案を行い、現在のタイムラインの検証やゲイン適用の許可は行いません。処理範囲を制限したローカルの読み取り専用計算で、キュー登録、保存、再試行、モデルやプロバイダーの呼び出し、書き出しの変更や阻止は行いません。"
  },
  "operation.timeline.clip.loudness": {
    "zh-Hans": "显式测量一个最多60秒（1800帧）的完整已保存选中片段；超长时拒绝，不自动截短。在源裁切、增益和淡入淡出后的独立声音，不混入其他轨道。精确绑定版本、片段及源哈希；固定配置、有界本地只读解码。无目标、候选、应用、写入、队列、自动重试或供应商调用。",
    "zh-Hant": "明確測量一個最多60秒（1800影格）的完整已儲存選取片段；超長時拒絕，不自動截短。在來源裁切、增益和淡入淡出後的獨立聲音，不混入其他軌道。精確綁定版本、片段及來源雜湊；固定設定、有界本機唯讀解碼。無目標、候選、套用、寫入、佇列、自動重試或供應商呼叫。",
    "en": "Explicitly measure one complete selected saved clip of at most 60 seconds (1800 frames); refuse longer clips without automatic trimming. Measure independently after source trim, gain and fades, without other tracks. Binds the exact revision, clip and source hash; fixed profile and bounded local read-only decode. No target, candidate, apply, writes, queue, automatic retry or providers.",
    "ja": "保存済みの選択クリップ1つ全体を最大60秒（1800フレーム）まで測定します。これを超えるクリップは自動で短縮せず拒否します。ソースのトリミング、ゲイン、フェード適用後に他のトラックを含めず独立して測定します。正確なリビジョン、クリップ、ソースハッシュに紐付け、固定プロファイルで処理量を制限したローカルの読み取り専用デコードを行います。目標値、候補、適用、書き込み、キュー、自動再試行、プロバイダー呼び出しはありません。"
  },
  "operation.timeline.loudness.prepare": {
    "zh-Hans": "显式按已保存时间线版本、固定混音和测量配置及用户自选 LUFS/dBTP 目标，完整测量编码前浮点混音与实际固定增益候选；结果临时且 applyAllowed 始终为 false。有界高资源本地只读计算，不写文件或数据库、不排队、不默认目标、不编辑、不导出、不重试、不调用模型或供应商",
    "zh-Hant": "明確按已儲存時間軸版本、固定混音和測量設定及使用者自選LUFS/dBTP目標，完整測量編碼前浮點混音與實際固定增益候選；結果暫時且applyAllowed始終為false。有界高資源本機唯讀計算，不寫檔案或資料庫、不排隊、不預設目標、不編輯、不匯出、不重試、不呼叫模型或供應商。",
    "en": "Explicitly fully measure the pre-encoding floating-point mix and actual fixed-gain candidate using the saved timeline version, fixed mixing and measurement configuration, and user-selected LUFS/dBTP targets. Results are temporary and applyAllowed is always false. Bounded, resource-intensive local read-only computation: no file or database writes, queueing, default targets, editing, exporting, retries, or model/provider calls.",
    "ja": "保存済みタイムラインのバージョン、固定のミックス・測定設定、ユーザー指定のLUFS/dBTP目標を使用し、エンコード前の浮動小数点ミックスと実際の固定ゲイン候補を明示的に完全測定します。結果は一時的で、applyAllowedは常にfalseです。処理範囲を制限した高リソースのローカル読み取り専用計算であり、ファイルやデータベースへの書き込み、キュー登録、既定目標の設定、編集、書き出し、再試行、モデルやプロバイダーの呼び出しは行いません。"
  },
  "operation.timeline.loudness.apply": {
    "zh-Hans": "显式应用整片响度候选：按固定请求身份、版本、来源快照和候选摘要重新完整测量，仅在两个目标通过后原子修改可听片段增益并保存一次撤销历史及原始回执；旧请求先重放，不重新测量，不接受客户端增益，不自动限幅或切换导出模式，不调用模型或供应商。恢复副本仅可读取被保留历史回执，不允许新应用",
    "zh-Hant": "明確套用整片響度候選：按固定請求身分、版本、來源快照和候選摘要重新完整測量，僅在兩個目標通過後原子修改可聽片段增益並儲存一次復原歷史及原始回執；舊請求先重放，不重新測量，不接受用戶端增益，不自動限幅或切換匯出模式，不呼叫模型或供應商。復原副本僅可讀取被保留歷史回執，不允許新套用。",
    "en": "Explicitly apply a whole-film loudness candidate: fully remeasure against the fixed request identity, version, source snapshot, and candidate digest. Only after both targets pass, atomically change audible-clip gains and save one undo-history entry and the original receipt. Existing requests replay first without remeasurement. Accepts no client-provided gains; no automatic limiting, export-mode switching, or model/provider calls. Restored copies can only read retained historical receipts; new applications are forbidden.",
    "ja": "作品全体のラウドネス候補を明示的に適用します。固定のリクエスト識別情報、バージョン、ソーススナップショット、候補ダイジェストを照合して完全に再測定します。両目標を満たした場合のみ、可聴クリップのゲインを原子的に変更し、取り消し履歴1件と元の受領記録を保存します。既存リクエストは再測定せず、先に元の結果を再現します。クライアント指定ゲインは受け付けず、自動リミッティング、書き出しモード切り替え、モデルやプロバイダーの呼び出しは行いません。復元コピーでは保持された過去の受領記録の読み取りのみが可能で、新規適用は禁止です。"
  },
  "operation.timeline.audioPreview.plan": {
    "zh-Hans": "只读规划当前已保存时间线最多20秒的声音试听区间；绑定项目、版本与素材哈希，返回有界PCM准备清单。此调用不解码、不播放、不初始化时间线、不写入；PCM另由固定已认证本地资源显式有界解码，不能作为完整成片或响度/真峰值检查。",
    "zh-Hant": "唯讀規劃目前已儲存時間軸最多20秒的聲音試聽區間；綁定專案、版本與素材雜湊，傳回有界PCM準備清單。此呼叫不解碼、不播放、不初始化時間軸、不寫入；PCM另由固定已認證本機資源明確有界解碼，不能作為完整成片或響度／真峰值檢查。",
    "en": "Read-only planning of an audio preview range of at most 20 seconds on the current saved timeline. Binds the project, version, and asset hashes and returns a bounded PCM preparation manifest. This call does not decode, play, initialize the timeline, or write. PCM is decoded separately through an explicit bounded operation on a fixed authenticated local resource; this is not a full-film or loudness/true-peak check.",
    "ja": "現在の保存済みタイムラインで最大20秒の音声試聴範囲を読み取り専用で計画します。プロジェクト、バージョン、素材ハッシュに紐づく、範囲制限付きPCM準備マニフェストを返します。この呼び出しではデコード、再生、タイムライン初期化、書き込みを行いません。PCMは固定された認証済みローカルリソースを通じて、別の明示的な範囲制限付き操作でデコードします。作品全体やラウドネス／トゥルーピークの検査には使用できません。"
  },
  "operation.timeline.audioPreview.continuousPlan": {
    "zh-Hans": "只读规划已保存时间线的 V2 连续音频预览会话；绑定项目、完整版本和源身份，固定 2 秒混音块，共享全会话 96 MiB 应用额度。仅返回元数据，不读取媒体字节、不解码、不播放、不初始化时间线、不写文件或数据库，不调用网络、模型或付费供应商。仅在显式播放操作后，由固定认证本地资源按需有界准备完整多轨混音。不是内置 Agent 工具，也不是视频合成或响度/真峰值检查；恢复副本拒绝该操作。",
    "zh-Hant": "唯讀規劃已儲存時間軸的 V2 連續音訊預覽工作階段；綁定專案、完整版本和來源身分，固定 2 秒混音區塊，共用整個工作階段的 96 MiB 應用程式額度。僅傳回中繼資料，不讀取媒體位元組、不解碼、不播放、不初始化時間軸、不寫入檔案或資料庫，不呼叫網路、模型或付費供應商。僅在明確播放操作後，由固定認證本機資源按需有界準備完整多軌混音。不是內建 Agent 工具，也不是影片合成或響度／真峰值檢查；復原副本拒絕此操作。",
    "en": "Read-only planning of a V2 continuous audio preview session for a saved timeline. Binds the project, full revision, and source identities; fixed 2-second mixed blocks share one 96 MiB application reservation for the entire session. Metadata only: no media-byte reads, decoding, playback, timeline initialization, file/database writes, network, model, or paid-provider calls. Only after an explicit playback gesture does a fixed authenticated local resource prepare complete multitrack mixes on demand within bounds. Not a built-in Agent tool, composed-video preview, or loudness/true-peak check; restored copies reject this operation.",
    "ja": "保存済みタイムラインの V2 連続音声プレビューセッションを読み取り専用で計画します。プロジェクト、完全なリビジョン、ソース識別情報に紐づけ、固定 2 秒のミックスブロックでセッション全体の 96 MiB アプリケーション予約枠を共有します。メタデータのみを返し、メディアバイトの読み取り、デコード、再生、タイムライン初期化、ファイルやデータベースへの書き込み、ネットワーク、モデル、有料プロバイダーの呼び出しは行いません。明示的な再生操作後に限り、固定の認証済みローカルリソースが完全なマルチトラックミックスを必要に応じて範囲内で準備します。組み込み Agent ツール、合成映像プレビュー、ラウドネス／トゥルーピーク検査ではありません。復元コピーでは拒否されます。"
  },
  "operation.timeline.export.capabilities": {
    "zh-Hans": "显式检查所选 MP4/H264 导出配置的本地编码能力；运行有界本地计算，不修改项目或导出，不调用供应商；结果绑定项目和时间线版本，实际导出会再次验证",
    "zh-Hant": "明確檢查所選MP4/H264匯出設定的本機編碼能力；執行有界本機計算，不修改專案或匯出，不呼叫供應商；結果綁定專案和時間軸版本，實際匯出會再次驗證。",
    "en": "Explicitly check local encoding capabilities for the selected MP4/H264 export configuration. Runs bounded local computation without modifying the project or exports or calling providers. Results are bound to project and timeline versions; actual export validates again.",
    "ja": "選択したMP4/H264書き出し設定のローカルエンコード能力を明示的に検査します。処理範囲を制限したローカル計算を行い、プロジェクトや書き出しの変更、プロバイダー呼び出しは行いません。結果はプロジェクトとタイムラインのバージョンに紐づき、実際の書き出し時に再検証します。"
  },
  "operation.project.create": {
    "zh-Hans": "创建持久化视频项目",
    "zh-Hant": "建立持久化影片專案。",
    "en": "Create a persistent video project.",
    "ja": "永続保存される動画プロジェクトを作成します。"
  },
  "operation.project.list": {
    "zh-Hans": "列出项目",
    "zh-Hant": "列出專案。",
    "en": "List projects.",
    "ja": "プロジェクトを一覧表示します。"
  },
  "operation.project.get": {
    "zh-Hans": "读取完整项目、画布和任务；旧项目首次读取时可创建空时间线",
    "zh-Hant": "讀取完整專案、畫布和任務；舊專案首次讀取時可建立空時間軸。",
    "en": "Read the complete project, canvas, and tasks; the first read of an older project may create an empty timeline.",
    "ja": "プロジェクト全体、キャンバス、タスクを読み取ります。旧プロジェクトの初回読み取りでは空のタイムラインが作成される場合があります。"
  },
  "operation.asset.import": {
    "zh-Hans": "导入授权的本地图片、视频或音频字节（base64，最大30MiB）",
    "zh-Hant": "匯入授權的本機圖片、影片或音訊位元組（base64，最大30MiB）。",
    "en": "Import authorized local image, video, or audio bytes (base64, maximum 30MiB).",
    "ja": "許可されたローカルの画像、動画、音声のバイト列をインポートします（base64、最大30MiB）。"
  },
  "operation.asset.list": {
    "zh-Hans": "读取项目素材",
    "zh-Hant": "讀取專案素材。",
    "en": "Read project assets.",
    "ja": "プロジェクトの素材を読み取ります。"
  },
  "operation.shot.create": {
    "zh-Hans": "创建稳定ID镜头",
    "zh-Hant": "建立穩定ID鏡頭。",
    "en": "Create a shot with a stable ID.",
    "ja": "安定したIDを持つショットを作成します。"
  },
  "operation.shot.update": {
    "zh-Hans": "按版本更新镜头，旧版本返回冲突",
    "zh-Hant": "按版本更新鏡頭，舊版本傳回衝突。",
    "en": "Update a shot against its version; stale versions return a conflict.",
    "ja": "バージョンを照合してショットを更新します。古いバージョンには競合を返します。"
  },
  "operation.shot.reorder": {
    "zh-Hans": "按项目版本原子调整镜头顺序",
    "zh-Hant": "按專案版本原子調整鏡頭順序。",
    "en": "Atomically reorder shots against the project version.",
    "ja": "プロジェクトのバージョンを照合してショットの順序を原子的に変更します。"
  },
  "operation.node.create": {
    "zh-Hans": "创建文本、图片、视频或音频画布节点",
    "zh-Hant": "建立文字、圖片、影片或音訊畫布節點。",
    "en": "Create a text, image, video, or audio canvas node.",
    "ja": "テキスト、画像、動画、音声のキャンバスノードを作成します。"
  },
  "operation.node.update": {
    "zh-Hans": "按版本更新节点",
    "zh-Hant": "按版本更新節點。",
    "en": "Update a node against its version.",
    "ja": "バージョンを照合してノードを更新します。"
  },
  "operation.edge.create": {
    "zh-Hans": "创建同项目的视觉连线；不参与生成，也不传递提示词或素材",
    "zh-Hant": "建立同專案的視覺連線；不參與生成，也不傳遞提示詞或素材。",
    "en": "Create a visual connection within the same project; it does not participate in generation or pass prompts or assets.",
    "ja": "同じプロジェクト内に視覚的な接続を作成します。生成には関与せず、プロンプトや素材も伝達しません。"
  },
  "operation.edge.delete": {
    "zh-Hans": "仅移除视觉连线；首帧参考连线须使用 reference_detach",
    "zh-Hant": "僅移除視覺連線；首影格參考連線須使用reference_detach。",
    "en": "Remove only the visual connection; first-frame reference connections must use reference_detach.",
    "ja": "視覚的な接続のみを削除します。先頭フレーム参照の接続にはreference_detachを使用する必要があります。"
  },
  "operation.reference.attach": {
    "zh-Hans": "原子连接同项目的托管图片节点与镜头作为首帧；须校验两端版本且镜头无手选参考图，使用稳定requestId",
    "zh-Hant": "原子連接同專案的受管圖片節點與鏡頭作為首影格；須校驗兩端版本且鏡頭無手選參考圖，使用穩定requestId。",
    "en": "Atomically connect a managed image node and shot in the same project as the first frame. Requires validation of both endpoint versions, no manually selected reference image on the shot, and a stable requestId.",
    "ja": "同じプロジェクト内の管理対象画像ノードとショットを、先頭フレームとして原子的に接続します。両端のバージョン検証、ショットに手動選択した参照画像がないこと、安定したrequestIdが必要です。"
  },
  "operation.reference.detach": {
    "zh-Hans": "按镜头版本原子断开首帧参考连线并清除其专属参考选择；保留原素材、节点及历史任务快照，使用稳定requestId",
    "zh-Hant": "按鏡頭版本原子中斷首影格參考連線並清除其專屬參考選擇；保留原素材、節點及歷史任務快照，使用穩定requestId。",
    "en": "Atomically detach the first-frame reference connection against the shot version and clear its exclusive reference selection. Preserves original assets, nodes, and historical task snapshots; uses a stable requestId.",
    "ja": "ショットのバージョンを照合し、先頭フレーム参照の接続を原子的に解除して、その接続専用の参照選択をクリアします。元の素材、ノード、過去のタスクスナップショットを保持し、安定したrequestIdを使用します。"
  },
  "operation.provider.list": {
    "zh-Hans": "查询供应商能力与配置状态",
    "zh-Hant": "查詢供應商能力與設定狀態。",
    "en": "Query provider capabilities and configuration status.",
    "ja": "プロバイダーの機能と設定状態を照会します。"
  },
  "operation.generation.submit": {
    "zh-Hans": "用稳定requestId提交生成（默认仅模拟）",
    "zh-Hant": "用穩定requestId提交生成（預設僅模擬）。",
    "en": "Submit generation using a stable requestId (simulation only by default).",
    "ja": "安定したrequestIdを使用して生成を送信します（既定ではシミュレーションのみ）。"
  },
  "operation.job.get": {
    "zh-Hans": "读取任务和可恢复错误",
    "zh-Hant": "讀取任務和可復原錯誤。",
    "en": "Read a task and recoverable errors.",
    "ja": "タスクと復旧可能なエラーを読み取ります。"
  },
  "operation.job.list": {
    "zh-Hans": "读取项目任务",
    "zh-Hant": "讀取專案任務。",
    "en": "Read project tasks.",
    "ja": "プロジェクトのタスクを読み取ります。"
  },
  "operation.job.retry": {
    "zh-Hans": "显式重试已明确失败任务，必须用新requestId",
    "zh-Hant": "明確重試已明確失敗任務，必須用新requestId。",
    "en": "Explicitly retry a task confirmed to have failed; a new requestId is required.",
    "ja": "失敗が明確なタスクを明示的に再試行します。新しいrequestIdが必須です。"
  },
  "operation.job.cancel": {
    "zh-Hans": "停止本地等待，不声称已取消供应商任务",
    "zh-Hant": "停止本機等待，不聲稱已取消供應商任務。",
    "en": "Stop waiting locally without claiming the provider task has been cancelled.",
    "ja": "ローカルでの待機を停止します。プロバイダー側のタスクがキャンセルされたとは主張しません。"
  },
  "operation.job.reconcile": {
    "zh-Hans": "重新查询或对账已有任务，不重新提交",
    "zh-Hant": "重新查詢或對帳既有任務，不重新提交。",
    "en": "Query again or reconcile an existing task without resubmitting.",
    "ja": "既存のタスクを再照会または照合します。再送信は行いません。"
  },
  "operation.version.list": {
    "zh-Hans": "列出不可变生成版本",
    "zh-Hant": "列出不可變生成版本。",
    "en": "List immutable generation versions.",
    "ja": "不変な生成バージョンを一覧表示します。"
  },
  "operation.version.select": {
    "zh-Hans": "按镜头版本选择结果",
    "zh-Hant": "按鏡頭版本選擇結果。",
    "en": "Select a result against the shot version.",
    "ja": "ショットのバージョンを照合して結果を選択します。"
  },
  "operation.export.create": {
    "zh-Hans": "冻结已选版本并按镜头顺序导出真实9:16 MP4",
    "zh-Hant": "凍結已選版本並按鏡頭順序匯出真實9:16 MP4。",
    "en": "Freeze selected versions and export a real 9:16 MP4 in shot order.",
    "ja": "選択済みバージョンを固定し、ショット順に実際の9:16 MP4を書き出します。"
  },
  "operation.export.get": {
    "zh-Hans": "查询导出进度和文件",
    "zh-Hant": "查詢匯出進度和檔案。",
    "en": "Query export progress and files.",
    "ja": "書き出しの進捗とファイルを照会します。"
  },
  "operation.timeline.get": {
    "zh-Hans": "读取持久化30fps多轨时间线；旧项目首次读取时仅创建空轨道",
    "zh-Hant": "讀取持久化30fps多軌時間軸；舊專案首次讀取時僅建立空軌道。",
    "en": "Read the persistent 30fps multitrack timeline; the first read of an older project creates only empty tracks.",
    "ja": "永続保存された30fpsのマルチトラックタイムラインを読み取ります。旧プロジェクトの初回読み取りでは空のトラックのみを作成します。"
  },
  "operation.timeline.history.get": {
    "zh-Hans": "只读查询时间线编辑历史与撤销/重做位置；不创建时间线，不包含媒体或生成任务",
    "zh-Hant": "唯讀查詢時間軸編輯歷史與復原／重做位置；不建立時間軸，不包含媒體或生成任務。",
    "en": "Read-only query of timeline edit history and the undo/redo position; does not create a timeline or include media or generation tasks.",
    "ja": "タイムラインの編集履歴と取り消し／やり直し位置を読み取り専用で照会します。タイムラインは作成せず、メディアや生成タスクも含みません。"
  },
  "operation.timeline.undo": {
    "zh-Hans": "按时间线版本撤销一次轨道或片段编辑；保留稳定ID并递增版本，不撤销生成、花费或导出",
    "zh-Hant": "按時間軸版本復原一次軌道或片段編輯；保留穩定ID並遞增版本，不復原生成、花費或匯出。",
    "en": "Undo one track or clip edit against the timeline version, preserving stable IDs and incrementing the version; does not undo generation, spending, or exports.",
    "ja": "タイムラインのバージョンを照合し、トラックまたはクリップの編集を1回取り消します。安定したIDを保持し、バージョンを増加させます。生成、支出、書き出しは取り消しません。"
  },
  "operation.timeline.redo": {
    "zh-Hans": "按时间线版本重做一次已撤销的轨道或片段编辑；使用稳定requestId恢复原请求结果",
    "zh-Hant": "按時間軸版本重做一次已復原的軌道或片段編輯；使用穩定requestId復原原請求結果。",
    "en": "Redo one undone track or clip edit against the timeline version; uses a stable requestId to recover the original request result.",
    "ja": "タイムラインのバージョンを照合し、取り消したトラックまたはクリップの編集を1回やり直します。安定したrequestIdを使用して元のリクエスト結果を復元します。"
  },
  "operation.timeline.track.add": {
    "zh-Hans": "按时间线版本新增视频或音频轨道，最多12轨",
    "zh-Hant": "按時間軸版本新增影片或音訊軌道，最多12軌。",
    "en": "Add a video or audio track against the timeline version, up to 12 tracks.",
    "ja": "タイムラインのバージョンを照合して動画または音声トラックを追加します。最大12トラックです。"
  },
  "operation.timeline.track.update": {
    "zh-Hans": "按时间线版本更新轨道名称、画面隐藏或静音",
    "zh-Hant": "按時間軸版本更新軌道名稱、畫面隱藏或靜音。",
    "en": "Update a track's name, visual hiding, or muting against the timeline version.",
    "ja": "タイムラインのバージョンを照合し、トラック名、映像の非表示、ミュートを更新します。"
  },
  "operation.timeline.clip.add": {
    "zh-Hans": "在指定轨道与帧位置添加固定素材片段；同轨不可重叠。音频或视频片段可明确标记人声、音乐或音效角色，仅作分类，不改变声音。",
    "zh-Hant": "在指定軌道與影格位置新增固定素材片段；同軌不可重疊。音訊或影片片段可明確標記人聲、音樂或音效角色，僅作分類，不改變聲音。",
    "en": "Add a pinned-asset clip at a track and frame position; same-track clips cannot overlap. Audio/video clips may explicitly classify their audio role as human, music or sfx without changing sound.",
    "ja": "指定トラックとフレーム位置に素材を固定したクリップを追加します。同一トラック内では重複できません。音声・動画クリップの人声、音楽、効果音の役割は分類のみで、音は変わりません。"
  },
  "operation.timeline.clip.update": {
    "zh-Hans": "按时间线版本移动、裁切或调整片段，保留固定素材引用。audioRole 可为 human（人声）、music（音乐）、sfx（音效）；null 明确清除，省略保留。角色编辑可撤销并更新版本与快照，不改变音量、静音或路由。",
    "zh-Hant": "按時間軸版本移動、裁切或調整片段，保留固定素材參照。audioRole 可為 human（人聲）、music（音樂）、sfx（音效）；null 明確清除，省略保留。角色編輯可復原並更新版本與快照，不改變音量、靜音或路由。",
    "en": "Move, trim or adjust a clip against its timeline version, preserving its pinned source. audioRole accepts human, music or sfx; null explicitly clears, omission preserves. Role edits are undoable and change revision/snapshots, not volume, mute or routing.",
    "ja": "タイムラインのバージョンを照合してクリップを移動・調整し、固定素材参照を保持します。audioRole は human（人声）、music（音楽）、sfx（効果音）。null は明示的な解除、省略は保持です。役割の編集は取り消し可能で、バージョンとスナップショットは更新されますが、音量・ミュート・ルーティングは変わりません。"
  },
  "operation.timeline.clip.replaceSource": {
    "zh-Hans": "按时间线版本显式替换片段的固定素材；仅同类视频、音频或图片互换，保留片段ID、位置、时长、源入点、画面、音量和淡入淡出；可选versionId须精确匹配新素材并固定来源镜头，不跟随镜头后续选用版本；使用必填稳定requestId精确重放，可撤销，不生成或处理媒体",
    "zh-Hant": "按時間軸版本明確替換片段的固定素材；僅同類影片、音訊或圖片互換，保留片段ID、位置、時長、來源入點、畫面、音量和淡入淡出；可選versionId須精確匹配新素材並固定來源鏡頭，不跟隨鏡頭後續選用版本；使用必填穩定requestId精確重放，可復原，不生成或處理媒體。",
    "en": "Explicitly replace a clip's pinned asset against the timeline version. Only like-for-like video, audio, or image replacements are allowed; preserves clip ID, position, duration, source in-point, visuals, volume, and fades. Optional versionId must exactly match the new asset and pin the source shot, without following its later selected versions. Requires a stable requestId for exact replay; undoable, with no media generation or processing.",
    "ja": "タイムラインのバージョンを照合してクリップの固定素材を明示的に置換します。動画、音声、画像の同種間のみ置換可能で、クリップID、位置、長さ、ソースのイン点、映像、音量、フェードを保持します。任意のversionIdは新素材と厳密に一致し、ソースショットを固定する必要があり、後から選択されたバージョンには追従しません。同一リクエストの元の結果の再現には安定したrequestIdが必須です。取り消し可能で、メディアの生成や処理は行いません。"
  },
  "operation.timeline.clip.remove": {
    "zh-Hans": "按时间线版本移除指定片段",
    "zh-Hant": "按時間軸版本移除指定片段。",
    "en": "Remove the specified clip against the timeline version.",
    "ja": "タイムラインのバージョンを照合して指定クリップを削除します。"
  },
  "operation.timeline.clip.split": {
    "zh-Hans": "在所选片段内部的整数时间线帧原子分割；左段保留ID，右段固定新ID；保留素材和源范围，不移动其他片段，可一次撤销，使用稳定requestId",
    "zh-Hant": "在所選片段內部的整數時間軸影格原子分割；左段保留ID，右段固定新ID；保留素材和來源範圍，不移動其他片段，可一次復原，使用穩定requestId。",
    "en": "Atomically split inside the selected clip at an integer timeline frame. The left segment retains its ID and the right gets a fixed new ID. Preserves assets and source ranges, moves no other clips, and can be undone in one step; uses a stable requestId.",
    "ja": "選択クリップ内の整数タイムラインフレームで原子的に分割します。左側はIDを保持し、右側には固定の新しいIDを割り当てます。素材とソース範囲を保持し、他のクリップは移動しません。1回で取り消し可能で、安定したrequestIdを使用します。"
  },
  "operation.timeline.seed": {
    "zh-Hans": "仅向空时间线按镜头顺序复制当前所选版本，之后独立编辑",
    "zh-Hant": "僅向空時間軸按鏡頭順序複製目前所選版本，之後獨立編輯。",
    "en": "Copy the currently selected versions in shot order only into an empty timeline, which is edited independently afterward.",
    "ja": "空のタイムラインに限り、現在選択されているバージョンをショット順にコピーします。その後は独立して編集します。"
  },
  "operation.timeline.render": {
    "zh-Hans": "冻结完整多轨时间线和素材哈希，排队生成真实预览或导出；导出可指定30fps左闭右开的帧范围，快照保持完整；通过export_get查询",
    "zh-Hant": "凍結完整多軌時間軸和素材雜湊，排隊產生真實預覽或匯出；匯出可指定30fps左閉右開的影格範圍，快照保持完整；透過export_get查詢。",
    "en": "Freeze the complete multitrack timeline and asset hashes and queue a real preview or export. Exports may specify a 30fps frame range with an inclusive start and exclusive end; the snapshot remains complete. Query through export_get.",
    "ja": "マルチトラックタイムライン全体と素材ハッシュを固定し、実際のプレビューまたは書き出しをキューに登録します。書き出しでは30fpsの開始を含み終了を含まないフレーム範囲を指定できます。スナップショットは全体を保持します。export_getで照会してください。"
  }
} satisfies MessageCatalog;
