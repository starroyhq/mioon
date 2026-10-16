#!/usr/bin/env node
/** Explicit offline ordinary40 → ordinary42 copy. Import/help never reads a
 * workspace, connection, credential or user setting and never starts services. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Locale} from '@mioon/i18n';
import {OPACITY_UPGRADE_ERROR_CODES, OPACITY_UPGRADE_WARNINGS, opacityWorkspaceUpgradeInputSchema, opacityWorkspaceUpgradeResultSchema} from '../../../packages/contracts/src/opacity-upgrade.ts';
import type {OpacityWorkspaceUpgradeErrorCode, OpacityWorkspaceUpgradeInput} from '../../../packages/contracts/src/opacity-upgrade.ts';

const name = 'mioon-opacity-upgrade', entry = 'node apps/cli/src/opacity-upgrade.ts';
type ErrorCode = OpacityWorkspaceUpgradeErrorCode | 'VALIDATION_ERROR';
type Copy = {requirements: string[]; preservation: string[]; safety: string[]; notice: string; output: string; errors: Record<ErrorCode, string>};
const copy: Readonly<Record<Locale, Copy>> = {
  'zh-Hans': {
    requirements: ['需要 Node.js 24+ 和已安装的源码工作区依赖。', '只接受普通 schema40 冷工作区。先正常关闭使用源目录的后端和桌面应用；已有锁及未检查点 WAL／journal 均拒绝，不修复。', '必须指定规范绝对路径、已有且完整校验的普通40备份目录、全新42目标目录和明确的 web、development 或 production 渠道。目标须有安全的既有父目录；禁止路径重叠、符号链接和已有工作区内的目标。'],
    preservation: ['先通过原标准备份入口创建独立40备份；本入口只读并完整验证该备份，再向新目录发布普通42副本；源工作区及源文件保留。时间线、历史、回执及受支持素材字节原样保留。', '数据库偏好原文保留；last-project 偏好仅将工作区 scope 绑定到新副本，不迁移 token、凭据、设置、连接文件或浏览器存储。', '仅允许已结算任务。旧 pending、held、未知或仍可执行的任务均拒绝；不恢复执行，不更改 origin／epoch 证据。', '草稿策略为 excluded-empty-only：仅明确为空且受支持的草稿 companion 可排除，源文件保留；活动、未知或损坏草稿均拒绝。旧 sequence export、generated asset 或其他未通过资格校验的资产／导出会明确拒绝。'],
    safety: ['这是显式离线复制入口；不原地升级，不自动升级，不修改默认启动入口，不接受 restored41 或 restored43。', '要求关闭的40源数据库及全部素材与备份精确匹配；只读备份，复用现有备份校验和原子发布机制；不启动监听、后端、provider、worker、媒体进程或目标应用。', '不覆盖、不自动重试。失败仅清理能确认属于本次操作的产物；无法确认的文件保留并报告。发布不确定时保留备份和目标，不把错误输出当作未执行证明。', 'SIGINT／SIGTERM 请求取消并等待清理；不强制结束进程。成功不代表默认入口已启用42或真实 GUI 已验收。'],
    notice: '已创建普通42新副本；已有40备份和源保留。草稿仅允许明确为空；任务仅允许已结算。不自动打开或切换目标。',
    output: 'stdout 恰好一个 JSON 信封；成功 {ok:true,data:...}，错误 {ok:false,error:{code,message,details,retryable:false}}。退出码：0 成功，2 参数错误，1 操作失败，130 SIGINT，143 SIGTERM。--lang 支持 zh-Hans、zh-Hant、en、ja，默认简中。',
    errors: {
      VALIDATION_ERROR: `请使用明确的 upgrade 参数；运行 ${entry} --help 查看用法。`,
      WORKSPACE_UPGRADE_INVALID_PATH: '请使用规范绝对路径和互不重叠的源、已有完整备份及全新目标目录。',
      WORKSPACE_UPGRADE_DESTINATION_EXISTS: '目标目录已存在；请选择全新目标目录，既有内容未被覆盖。',
      WORKSPACE_UPGRADE_DESTINATION_WORKSPACE_ANCESTOR: '备份或目标位于已有工作区内；请选择工作区外的独立新目录。',
      WORKSPACE_UPGRADE_SOURCE_INVALID: '源数据库未通过完整性、固定结构或身份校验；未发布42副本。',
      WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED: '仅支持普通 schema40；restored41、42、43 和未知版本均拒绝。',
      WORKSPACE_UPGRADE_UNRESOLVED_TASKS: '源包含未结算、held、未知或仍可执行任务；升级拒绝，不恢复执行。',
      WORKSPACE_UPGRADE_UNSUPPORTED_ASSET: '源包含不支持的资产身份或 generated asset；升级拒绝，源保留。',
      WORKSPACE_UPGRADE_UNSUPPORTED_EXPORT: '源包含不支持的导出或旧 sequence export；升级拒绝，源保留。',
      WORKSPACE_UPGRADE_DRAFTS_UNSUPPORTED: '源存在活动、未知或不支持的草稿；仅明确为空的受支持草稿可排除，源草稿保留。',
      WORKSPACE_UPGRADE_COMPANION_INVALID: '工作区 companion 文件损坏或不支持；升级拒绝，不重写该文件。',
      WORKSPACE_UPGRADE_SCOPE_MISMATCH: '偏好或 companion 的工作区 scope 不匹配；升级拒绝，不跨工作区绑定。',
      WORKSPACE_UPGRADE_INVENTORY_INCOMPLETE: '源文件清单不完整或含未分类内容；升级拒绝，不静默排除。',
      WORKSPACE_UPGRADE_CHANGED: '源、备份或目标文件在检查期间发生变化；操作未安全完成。',
      WORKSPACE_UPGRADE_LOCKED: '源或目标已有锁；先正常关闭相关应用并检查锁，不删除或修复既有锁。',
      WORKSPACE_UPGRADE_LOCK_LOST: '本次操作的锁发生变化；保留备份和目标供检查，不自动重试。',
      WORKSPACE_UPGRADE_NOT_COLD: '源有未检查点的 SQLite WAL／journal；先正常关闭应用，不修复或删除 sidecar。',
      WORKSPACE_UPGRADE_LIMIT: '源或副本超过固定离线操作上限；升级拒绝。',
      WORKSPACE_UPGRADE_CANCELLED: '升级已请求取消并等待清理；保留无法确认的产物，检查后使用另一全新目标。',
      WORKSPACE_UPGRADE_IO: '离线升级未安全完成；保留备份和无法确认的目标，检查后再决定后续操作。',
      WORKSPACE_UPGRADE_PRESERVATION_FAILED: '副本未通过时间线、历史、回执、偏好或素材保留校验；未确认发布成功。',
      WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED: '42副本可能已发布，但持久化或确认不确定。保留40备份及目标并检查，禁止自动重试或执行旧任务。',
    },
  },
  'zh-Hant': {
    requirements: ['需要 Node.js 24+ 與已安裝的原始碼工作區相依套件。', '僅接受普通 schema40 冷工作區。先正常關閉使用來源目錄的後端與桌面應用程式；既有鎖和未檢查點 WAL／journal 均拒絕，不修復。', '必須指定規範絕對路徑、既有且完整校驗的普通40備份目錄、全新42目標目錄和明確的 web、development 或 production 通道。目標須有安全的既有父目錄；禁止路徑重疊、符號連結與既有工作區內的目標。'],
    preservation: ['先透過原標準備份入口建立獨立40備份；本入口唯讀並完整驗證該備份，再向新目錄發布普通42副本；來源工作區及來源檔案保留。時間軸、歷史、回執與支援的素材位元組原樣保留。', '資料庫偏好原文保留；last-project 偏好僅將工作區 scope 綁定至新副本，不遷移 token、憑證、設定、連線檔案或瀏覽器儲存。', '僅允許已結算任務。舊 pending、held、未知或仍可執行任務均拒絕；不恢復執行，不變更 origin／epoch 證據。', '草稿策略為 excluded-empty-only：僅明確為空且支援的草稿 companion 可排除，來源檔案保留；活動、未知或損壞草稿均拒絕。舊 sequence export、generated asset 或其他未通過資格校驗的資產／匯出會明確拒絕。'],
    safety: ['這是明確的離線複製入口；不原地升級、不自動升級、不修改預設啟動入口，不接受 restored41 或 restored43。', '要求已關閉的40來源資料庫及全部素材與備份精確相符；唯讀備份，重用既有備份校驗與原子發布機制；不啟動監聽、後端、provider、worker、媒體程序或目標應用程式。', '不覆寫、不自動重試。失敗僅清理能確認屬於本次操作的產物；無法確認的檔案保留並回報。發布不確定時保留備份與目標，不將錯誤輸出視為未執行證明。', 'SIGINT／SIGTERM 請求取消並等待清理；不強制結束程序。成功不代表預設入口已啟用42或真實 GUI 已驗收。'],
    notice: '已建立普通42新副本；既有40備份與來源保留。草稿僅允許明確為空；任務僅允許已結算。不自動開啟或切換目標。',
    output: 'stdout 恰好一個 JSON 信封；成功 {ok:true,data:...}，錯誤 {ok:false,error:{code,message,details,retryable:false}}。結束碼：0 成功，2 參數錯誤，1 操作失敗，130 SIGINT，143 SIGTERM。--lang 支援 zh-Hans、zh-Hant、en、ja，預設簡中。',
    errors: {
      VALIDATION_ERROR: `請使用明確的 upgrade 參數；執行 ${entry} --help 查看用法。`,
      WORKSPACE_UPGRADE_INVALID_PATH: '請使用規範絕對路徑及互不重疊的來源、既有完整備份與全新目標目錄。',
      WORKSPACE_UPGRADE_DESTINATION_EXISTS: '目標目錄已存在；請選擇全新目標目錄，既有內容未被覆寫。',
      WORKSPACE_UPGRADE_DESTINATION_WORKSPACE_ANCESTOR: '備份或目標位於既有工作區內；請選擇工作區外的獨立新目錄。',
      WORKSPACE_UPGRADE_SOURCE_INVALID: '來源資料庫未通過完整性、固定結構或身分校驗；未發布42副本。',
      WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED: '僅支援普通 schema40；restored41、42、43 與未知版本均拒絕。',
      WORKSPACE_UPGRADE_UNRESOLVED_TASKS: '來源包含未結算、held、未知或仍可執行任務；升級拒絕，不恢復執行。',
      WORKSPACE_UPGRADE_UNSUPPORTED_ASSET: '來源包含不支援的資產身分或 generated asset；升級拒絕，來源保留。',
      WORKSPACE_UPGRADE_UNSUPPORTED_EXPORT: '來源包含不支援的匯出或舊 sequence export；升級拒絕，來源保留。',
      WORKSPACE_UPGRADE_DRAFTS_UNSUPPORTED: '來源存在活動、未知或不支援的草稿；僅明確為空的受支援草稿可排除，來源草稿保留。',
      WORKSPACE_UPGRADE_COMPANION_INVALID: '工作區 companion 檔案損壞或不支援；升級拒絕，不重寫該檔案。',
      WORKSPACE_UPGRADE_SCOPE_MISMATCH: '偏好或 companion 的工作區 scope 不符；升級拒絕，不跨工作區綁定。',
      WORKSPACE_UPGRADE_INVENTORY_INCOMPLETE: '來源檔案清單不完整或包含未分類內容；升級拒絕，不靜默排除。',
      WORKSPACE_UPGRADE_CHANGED: '來源、備份或目標檔案在檢查期間變更；操作未安全完成。',
      WORKSPACE_UPGRADE_LOCKED: '來源或目標已有鎖；先正常關閉相關應用程式並檢查鎖，不刪除或修復既有鎖。',
      WORKSPACE_UPGRADE_LOCK_LOST: '本次操作的鎖已變更；保留備份與目標供檢查，不自動重試。',
      WORKSPACE_UPGRADE_NOT_COLD: '來源有未檢查點的 SQLite WAL／journal；先正常關閉應用程式，不修復或刪除 sidecar。',
      WORKSPACE_UPGRADE_LIMIT: '來源或副本超過固定離線操作上限；升級拒絕。',
      WORKSPACE_UPGRADE_CANCELLED: '升級已請求取消並等待清理；保留無法確認的產物，檢查後使用另一全新目標。',
      WORKSPACE_UPGRADE_IO: '離線升級未安全完成；保留備份與無法確認的目標，檢查後再決定後續操作。',
      WORKSPACE_UPGRADE_PRESERVATION_FAILED: '副本未通過時間軸、歷史、回執、偏好或素材保留校驗；未確認發布成功。',
      WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED: '42副本可能已發布，但持久化或確認不確定。保留40備份與目標並檢查，禁止自動重試或執行舊任務。',
    },
  },
  en: {
    requirements: ['Node.js 24+ with installed source workspace dependencies.', 'Only ordinary schema40 cold workspaces are accepted. Close source backends and desktop apps normally. Existing locks and uncheckpointed WAL/journal files are refused without repair.', 'Specify canonical absolute paths, an existing fully verified ordinary40 backup directory, a new42 destination and an explicit web, development or production channel. The new destination requires a safe existing parent. Overlaps, symbolic links and destinations inside existing workspaces are refused.'],
    preservation: ['First create a separate40 backup through the original standard backup entry. This entry reads and fully verifies that existing backup before publishing an ordinary42 copy in a new directory. The source workspace and files remain. Timelines, histories, receipts and supported media bytes are preserved.', 'Database preference text is retained. Only the last-project workspace scope is rebound to the new copy. Tokens, credentials, settings, connection files and browser storage are not migrated.', 'Only settled tasks are accepted. Old pending, held, unknown or still executable tasks are refused; no task resumes and origin/epoch evidence is unchanged.', 'The draft policy is excluded-empty-only: only supported, explicitly empty draft companions may be excluded; source files remain. Active, unknown or corrupt drafts are refused. Old sequence exports, generated assets and other ineligible assets/exports are explicitly refused.'],
    safety: ['This is an explicit offline copy. No in-place or automatic upgrade, default entrypoint change, or restored41/restored43 conversion.', 'Requires the closed40 source database and all media to match the backup exactly. Reads the backup without changing it and reuses existing backup verification and atomic publication. No listener, backend, provider, worker, media process or target application starts.', 'No overwrite or automatic retry. Failure cleans only confirmed operation-owned artifacts; uncertain files remain and are reported. If publication is unconfirmed, preserve the backup and destination; an error does not prove nothing ran.', 'SIGINT/SIGTERM request cancellation and await cleanup without forced termination. Success does not enable42 in the default production entrypoint or establish real GUI acceptance.'],
    notice: 'Created a new ordinary42 copy; the existing40 backup and source remain. Only explicitly empty drafts and settled tasks are accepted. The target is not opened or selected automatically.',
    output: 'Exactly one JSON envelope on stdout: success {ok:true,data:...}; error {ok:false,error:{code,message,details,retryable:false}}. Exit codes: 0 success, 2 invalid arguments, 1 operation failure, 130 SIGINT, 143 SIGTERM. --lang accepts zh-Hans, zh-Hant, en, ja; default: Simplified Chinese.',
    errors: {
      VALIDATION_ERROR: `Use explicit upgrade arguments; run ${entry} --help for usage.`,
      WORKSPACE_UPGRADE_INVALID_PATH: 'Use canonical absolute paths and nonoverlapping source, existing complete backup and new destination directories.',
      WORKSPACE_UPGRADE_DESTINATION_EXISTS: 'The destination already exists. Choose a new destination; existing contents were not overwritten.',
      WORKSPACE_UPGRADE_DESTINATION_WORKSPACE_ANCESTOR: 'The backup or destination is inside an existing workspace. Choose an independent new directory outside workspaces.',
      WORKSPACE_UPGRADE_SOURCE_INVALID: 'Source integrity, fixed structure or identity validation failed. No42 copy was published.',
      WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED: 'Only ordinary schema40 is supported. Restored41,42,43 and unknown versions are refused.',
      WORKSPACE_UPGRADE_UNRESOLVED_TASKS: 'The source contains unsettled, held, unknown or still executable tasks. Upgrade is refused and no task resumes.',
      WORKSPACE_UPGRADE_UNSUPPORTED_ASSET: 'The source contains unsupported asset identity or a generated asset. Upgrade is refused; the source remains.',
      WORKSPACE_UPGRADE_UNSUPPORTED_EXPORT: 'The source contains an unsupported export or old sequence export. Upgrade is refused; the source remains.',
      WORKSPACE_UPGRADE_DRAFTS_UNSUPPORTED: 'The source has active, unknown or unsupported drafts. Only supported, explicitly empty drafts may be excluded; source drafts remain.',
      WORKSPACE_UPGRADE_COMPANION_INVALID: 'A workspace companion file is corrupt or unsupported. Upgrade is refused without rewriting it.',
      WORKSPACE_UPGRADE_SCOPE_MISMATCH: 'A preference or companion workspace scope does not match. Upgrade is refused without cross-workspace rebinding.',
      WORKSPACE_UPGRADE_INVENTORY_INCOMPLETE: 'The source inventory is incomplete or contains unclassified content. Upgrade is refused without silent exclusions.',
      WORKSPACE_UPGRADE_CHANGED: 'A source, backup or destination file changed during inspection. The operation did not complete safely.',
      WORKSPACE_UPGRADE_LOCKED: 'The source or destination has an existing lock. Close the relevant app normally and review the lock; existing locks are not removed or repaired.',
      WORKSPACE_UPGRADE_LOCK_LOST: 'An operation lock changed. Preserve the backup and destination for inspection; do not retry automatically.',
      WORKSPACE_UPGRADE_NOT_COLD: 'The source has an uncheckpointed SQLite WAL/journal. Close the app normally; sidecars are not repaired or deleted.',
      WORKSPACE_UPGRADE_LIMIT: 'The source or copy exceeds a fixed offline operation limit. Upgrade is refused.',
      WORKSPACE_UPGRADE_CANCELLED: 'Upgrade cancellation was requested and cleanup awaited. Retain uncertain artifacts and use another new destination after review.',
      WORKSPACE_UPGRADE_IO: 'Offline upgrade did not complete safely. Preserve the backup and uncertain destination for review.',
      WORKSPACE_UPGRADE_PRESERVATION_FAILED: 'Timeline, history, receipt, preference or media preservation validation failed. Successful publication is not confirmed.',
      WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED: 'The 42 copy may be published, but durability or acknowledgement is unconfirmed. Preserve the 40 backup and destination for inspection. Do not retry automatically or execute inherited tasks.',
    },
  },
  ja: {
    requirements: ['Node.js 24+ とインストール済みのソースワークスペース依存関係が必要です。', '通常の schema40 のコールドワークスペースのみ受け付けます。ソースを使うバックエンドとデスクトップアプリを正常終了してください。既存ロックと未チェックポイントの WAL／journal は修復せず拒否します。', '正規の絶対パス、既存の完全に検証された通常40バックアップ、新規42保存先、web・development・production の明示的なチャネルが必要です。新規保存先には安全な既存親ディレクトリが必要です。パスの重複、シンボリックリンク、既存ワークスペース内の保存先は拒否します。'],
    preservation: ['先に既存の標準バックアップ入口で独立した40バックアップを作成してください。本入口は既存のバックアップを読み取り専用で完全に検証してから、新規ディレクトリへ通常42のコピーを公開します。ソースとそのファイルは保持し、タイムライン、履歴、受領記録、対応する素材バイトを保存します。', 'データベース内の環境設定の原文を保持します。last-project のワークスペース scope だけを新規コピーに再設定し、token、認証情報、設定、接続ファイル、ブラウザ保存領域は移行しません。', '確定済みタスクのみ受け付けます。古い pending、held、不明、実行可能なタスクは拒否します。実行を再開せず、origin／epoch の証拠を変更しません。', '下書き方針は excluded-empty-only です。対応していて明確に空の companion だけを除外でき、ソースのファイルは保持します。使用中、不明、破損した下書きは拒否します。旧 sequence export、generated asset、ほかの対象外の素材・書き出しも明示的に拒否します。'],
    safety: ['明示的なオフラインコピーです。上書き更新、自動更新、既定の起動入口変更、restored41／restored43 の変換は行いません。', '正常終了した40ソースのデータベースと全素材がバックアップと正確に一致する必要があります。バックアップは読み取り専用とし、既存の検証と原子的公開を再利用します。待ち受け、バックエンド、provider、worker、メディアプロセス、保存先アプリを起動しません。', '上書きや自動再試行を行いません。失敗時は本操作の所有物と確認できる生成物だけを片付け、不確かなファイルは保持して報告します。公開未確認時はバックアップと保存先を保持し、エラーを未実行の証明と見なしません。', 'SIGINT／SIGTERM は取消を要求して後処理を待ち、強制終了しません。成功しても既定の本番入口で42が有効になったことや、実際の GUI 検証完了を意味しません。'],
    notice: '通常42の新規コピーを作成しました。既存の40バックアップとソースは保持します。明確に空の下書きと確定済みタスクのみ対応します。保存先を自動で開いたり選択したりしません。',
    output: 'stdout には JSON エンベロープを1個だけ出力します。成功 {ok:true,data:...}、失敗 {ok:false,error:{code,message,details,retryable:false}}。終了コード：0 成功、2 引数不正、1 操作失敗、130 SIGINT、143 SIGTERM。--lang は zh-Hans、zh-Hant、en、ja に対応し、既定は簡体字中国語です。',
    errors: {
      VALIDATION_ERROR: `upgrade の引数を明示してください。使い方は ${entry} --help を実行してください。`,
      WORKSPACE_UPGRADE_INVALID_PATH: '正規の絶対パスと重複しないソース、既存の完全なバックアップ、新規保存先を指定してください。',
      WORKSPACE_UPGRADE_DESTINATION_EXISTS: '保存先が既に存在します。既存内容を上書きせず、新規保存先を選んでください。',
      WORKSPACE_UPGRADE_DESTINATION_WORKSPACE_ANCESTOR: 'バックアップまたは保存先が既存ワークスペース内にあります。外部の独立した新規ディレクトリを選んでください。',
      WORKSPACE_UPGRADE_SOURCE_INVALID: 'ソースの整合性、固定構造、識別情報の検証に失敗しました。42コピーは公開していません。',
      WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED: '通常の schema40 のみ対応します。restored41、42、43、不明なバージョンは拒否します。',
      WORKSPACE_UPGRADE_UNRESOLVED_TASKS: 'ソースに未確定、held、不明、実行可能なタスクがあります。更新を拒否し、実行を再開しません。',
      WORKSPACE_UPGRADE_UNSUPPORTED_ASSET: 'ソースに未対応の素材識別情報または generated asset があります。更新を拒否し、ソースは保持します。',
      WORKSPACE_UPGRADE_UNSUPPORTED_EXPORT: 'ソースに未対応の書き出しまたは旧 sequence export があります。更新を拒否し、ソースは保持します。',
      WORKSPACE_UPGRADE_DRAFTS_UNSUPPORTED: 'ソースに使用中、不明、未対応の下書きがあります。対応していて明確に空の下書きだけを除外でき、ソースの下書きは保持します。',
      WORKSPACE_UPGRADE_COMPANION_INVALID: 'ワークスペースの companion ファイルが破損または未対応です。書き換えずに更新を拒否します。',
      WORKSPACE_UPGRADE_SCOPE_MISMATCH: '環境設定または companion のワークスペース scope が一致しません。異なるワークスペースに結び直さず更新を拒否します。',
      WORKSPACE_UPGRADE_INVENTORY_INCOMPLETE: 'ソースの一覧が不完全か未分類の内容を含みます。暗黙に除外せず更新を拒否します。',
      WORKSPACE_UPGRADE_CHANGED: '検査中にソース、バックアップ、保存先のファイルが変わりました。操作は安全に完了していません。',
      WORKSPACE_UPGRADE_LOCKED: 'ソースまたは保存先に既存ロックがあります。アプリを正常終了してロックを確認してください。既存ロックは削除・修復しません。',
      WORKSPACE_UPGRADE_LOCK_LOST: '本操作のロックが変わりました。バックアップと保存先を保持して確認し、自動再試行しないでください。',
      WORKSPACE_UPGRADE_NOT_COLD: 'ソースに未チェックポイントの SQLite WAL／journal があります。アプリを正常終了してください。sidecar は修復・削除しません。',
      WORKSPACE_UPGRADE_LIMIT: 'ソースまたはコピーが固定のオフライン上限を超えています。更新を拒否します。',
      WORKSPACE_UPGRADE_CANCELLED: '更新の取消を要求し、後処理を待ちました。不確かな生成物は保持し、確認後に別の新規保存先を使ってください。',
      WORKSPACE_UPGRADE_IO: 'オフライン更新は安全に完了していません。バックアップと不確かな保存先を保持して確認してください。',
      WORKSPACE_UPGRADE_PRESERVATION_FAILED: 'タイムライン、履歴、受領記録、環境設定、素材の保存検証に失敗しました。公開成功は確認できていません。',
      WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED: '42コピーは公開済みの可能性がありますが、永続化または確認が不確かです。40バックアップと保存先を保持して確認し、自動再試行や古いタスクの実行を行わないでください。',
    },
  },
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: unknown, key: string): unknown => {
  try {if (!object(value)) return undefined; const field = Object.getOwnPropertyDescriptor(value, key); return field && Object.hasOwn(field, 'value') ? field.value : undefined;} catch {return undefined;}
};
function fail(): never {throw Object.assign(new Error('Invalid explicit offline upgrade arguments.'), {code: 'VALIDATION_ERROR'});}
const locales = ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const;
type Input = {command: 'help'; locale: Locale} | {command: 'schema'; locale: Locale} | ({command: 'upgrade'; locale: Locale} & OpacityWorkspaceUpgradeInput);

export function parseOpacityUpgradeArguments(argv: readonly string[], onLocale: (locale: Locale) => void = () => {}): Input {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail();
  const args: string[] = [];
  let locale: Locale = 'zh-Hans', languageSeen = false;
  const businessFlags = ['--source', '--backup', '--destination', '--channel'];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--lang' || argument.startsWith('--lang=')) {
      if (languageSeen || (index > 0 && businessFlags.includes(argv[index - 1]))) fail();
      const value = argument === '--lang' ? argv[++index] : argument.slice('--lang='.length);
      if (!locales.some(item => item === value)) fail();
      locale = value as Locale; languageSeen = true; onLocale(locale);
    } else args.push(argument);
  }
  if (args.length === 0 || (args.length === 1 && ['help', '--help'].includes(args[0])) || (args.length === 2 && args[0] === 'upgrade' && args[1] === '--help')) return {command: 'help', locale};
  if (args.length === 1 && args[0] === 'schema') return {command: 'schema', locale};
  if (args[0] !== 'upgrade') fail();
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!businessFlags.includes(flag) || Object.hasOwn(values, flag) || value === undefined || value.startsWith('--')) fail();
    values[flag] = value;
  }
  if (businessFlags.some(flag => !Object.hasOwn(values, flag))) fail();
  const parsed = opacityWorkspaceUpgradeInputSchema.safeParse({source: values['--source'], backup: values['--backup'], destination: values['--destination'], channel: values['--channel']});
  if (!parsed.success) fail();
  return {command: 'upgrade', locale, ...parsed.data};
}

export function opacityUpgradeHelp(locale: Locale = 'zh-Hans') {
  const {requirements, preservation, safety, output} = copy[locale];
  return {name, offline: true, sourceVersion: 40, targetVersion: 42, profile: 'ordinary', locale,
    draftPolicy: 'excluded-empty-only', taskPolicy: 'settled-only', preferencePolicy: 'preserved',
    usage: [`${entry} upgrade --source /absolute/closed40 --backup /absolute/existing-verified40-backup --destination /absolute/new42 --channel web --lang ${locale}`, `${entry} --help`, `${entry} schema`],
    requirements, preservation, safety, output};
}

function schema() {
  return {name, offline: true, sourceVersion: 40, targetVersion: 42, profile: 'ordinary',
    input: {additionalProperties: false, required: ['source', 'backup', 'destination', 'channel'],
      properties: {source: {type: 'string', format: 'canonical-absolute-local-path'}, backup: {type: 'string', format: 'canonical-absolute-verified40-backup-path'}, destination: {type: 'string', format: 'canonical-absolute-new-local-path'}, channel: {enum: ['web', 'development', 'production']}}},
    result: {publication: 'confirmed', draftPolicy: 'excluded-empty-only', taskPolicy: 'settled-only', preferencePolicy: 'preserved', sourcePolicy: 'unchanged',
      backupBinding: ['sourceBackupId', 'manifestHash', 'sourceDbHash'], targetIdentity: ['targetDbHash'], backupPayload: ['fileCount', 'payloadBytes'], warnings: OPACITY_UPGRADE_WARNINGS},
    errors: ['VALIDATION_ERROR', ...OPACITY_UPGRADE_ERROR_CODES]};
}

/** Only fixed codes and bounded generated publication binding may cross stdout.
 * Raw exception messages, stack, paths, row text and arbitrary details do not. */
export function safeOpacityUpgradeError(error: unknown, locale: Locale = 'zh-Hans') {
  const reported = own(error, 'code');
  const code: ErrorCode = typeof reported === 'string' && (reported === 'VALIDATION_ERROR' || OPACITY_UPGRADE_ERROR_CODES.some(value => value === reported)) ? reported as ErrorCode : 'WORKSPACE_UPGRADE_IO';
  const details: {cleanupUnconfirmed?: true; publication?: {state: 'unconfirmed'; sourceBackupId: string; manifestHash: string; sourceDbHash: string; targetDbHash?: string}} = {};
  // Error instances are objects too; their code and cleanup fields are explicit
  // internal evidence, never a reason to forward an arbitrary error object.
  if (own(error, 'cleanupUnconfirmed') === true) details.cleanupUnconfirmed = true;
  const publication = own(error, 'publication');
  if (code === 'WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED' && publication !== null && typeof publication === 'object') {
    const state = own(publication, 'state'), sourceBackupId = own(publication, 'sourceBackupId'), manifestHash = own(publication, 'manifestHash'), sourceDbHash = own(publication, 'sourceDbHash'), targetDbHash = own(publication, 'targetDbHash');
    const uuid = typeof sourceBackupId === 'string' && sourceBackupId.length === 36 && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(sourceBackupId);
    const hash = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/u.test(input);
    if (state === 'unconfirmed' && uuid && typeof sourceBackupId === 'string' && hash(manifestHash) && hash(sourceDbHash) && (targetDbHash === undefined || hash(targetDbHash)))
      details.publication = {state: 'unconfirmed', sourceBackupId, manifestHash, sourceDbHash, ...(typeof targetDbHash === 'string' ? {targetDbHash} : {})};
  }
  return {code, message: copy[locale].errors[code], details, retryable: false as const};
}

function write(stream: NodeJS.WriteStream, content: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {if (!settled) {settled = true; stream.removeListener('error', onError); resolve(value);}};
    const onError = () => finish(false);
    stream.once('error', onError);
    try {stream.write(content, error => {if (error) setImmediate(() => finish(false)); else finish(true);});} catch {finish(false);}
  });
}

export async function runOpacityUpgradeCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let locale: Locale = 'zh-Hans', firstSignal: 'SIGINT' | 'SIGTERM' | undefined;
  let data: unknown, failure: ReturnType<typeof safeOpacityUpgradeError> | undefined, upgraded = false;
  try {
    const input = parseOpacityUpgradeArguments(argv, value => {locale = value;});
    if (input.command === 'help') data = opacityUpgradeHelp(locale);
    else if (input.command === 'schema') data = schema();
    else {
      const controller = new AbortController();
      const interrupt = (value: 'SIGINT' | 'SIGTERM') => {firstSignal ??= value; controller.abort();};
      const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      try {
        const {upgradeOpacityWorkspace40To42} = await import('../../../packages/business/src/opacity-upgrade.ts');
        const {command: ignored, locale: ignoredLocale, ...options} = input;
        const result: unknown = await upgradeOpacityWorkspace40To42({...options, signal: controller.signal});
        const parsed = opacityWorkspaceUpgradeResultSchema.safeParse(result);
        if (!parsed.success) throw Object.assign(new Error('Invalid fixed upgrade result.'), {code: 'WORKSPACE_UPGRADE_IO'});
        data = parsed.data; upgraded = true;
      } finally {
        // Await business cleanup before scoped signal handlers are removed.
        process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      }
    }
  } catch (error) {failure = safeOpacityUpgradeError(error, locale);}
  if (failure) {
    await write(process.stdout, `${JSON.stringify({ok: false, error: failure})}\n`);
    await write(process.stderr, `${failure.code}: ${failure.message}\n`);
    return ['VALIDATION_ERROR', 'WORKSPACE_UPGRADE_INVALID_PATH'].includes(failure.code) ? 2 : failure.code === 'WORKSPACE_UPGRADE_CANCELLED' ? (firstSignal === 'SIGTERM' ? 143 : 130) : 1;
  }
  const written = await write(process.stdout, `${JSON.stringify({ok: true, data})}\n`);
  if (upgraded) await write(process.stderr, `${copy[locale].notice}\n`);
  return written ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runOpacityUpgradeCli();
