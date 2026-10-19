#!/usr/bin/env node
/** Explicit offline source42 → restored43 entry. No backend, default workspace,
 * credentials, provider or inherited task execution is part of this command. */
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {backupDiagnostic} from './backup-presentation.ts';
import type {Locale} from '@mioon/i18n';
import {
  createOpacityCandidateWorkspaceBackup,
  verifyOpacityCandidateWorkspaceBackup,
  restoreOpacityCandidateWorkspaceBackup,
  inspectOpacityCandidateRestorePublication,
} from '../../../packages/business/src/opacity-candidate-backup.ts';

const name = 'mioon-opacity-backup';
const entry = 'node apps/cli/src/opacity-backup.ts';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
type Command = 'create' | 'verify' | 'restore' | 'restore-status' | 'help' | 'version';
type Copy = {requirements: string[]; privacy: string[]; safety: string[]; output: string; notice: string; validation: string; source: string};
const copy: Readonly<Record<Locale, Copy>> = {
  'zh-Hans': {
    requirements: ['需要 Node.js 24+ 和已安装的源码工作区依赖。', '仅接受完整分类的普通 schema42 冷工作区。先正常关闭使用源目录的所有后端或桌面应用；现有锁、未检查点 WAL／journal 均拒绝，不修复。', '使用显式、规范的绝对路径。目标必须不存在，父目录须安全且已存在；禁止路径重叠、符号链接及位于已有工作区中的恢复目标。'],
    privacy: ['备份包含全工作区数据库和受支持的受管媒体／staging 字节，包括聊天、提示词、缓存及可能含秘密的用户文本。备份为私有明文，不加密。', 'v3 未保存草稿不备份、不恢复，源草稿保留。token、凭据、设置和连接文件也排除；源工作区保留。'],
    safety: ['沿用 format1 清单、逐文件校验和 COMPLETE 发布；本入口固定备份42并离线恢复成43（restored-local-v10），不升级40/41、不递归备份43。', '恢复保留 captured 历史、回执、held、epoch 和 origin 证据；旧 pending 任务保持 held，不重试或执行。新 origin 也不能绕过原有能力边界。', '只处理本地文件，不启动监听、后端、worker、provider 或媒体进程，不自动打开恢复工作区。离线恢复后，可通过独立候选应用入口的 --open-restored-workspace 显式打开受保护的43。', '不覆盖、自动重试或自动删除。中断可能留下未完成的新目录；保留原备份并另选新目标。SIGINT／SIGTERM 请求取消并等待本地清理，锁清理不确定会明确报告。', 'restore-status 仅只读观察43和来源绑定，不修复锁／sidecar、恢复任务或证明此前未确认的 fsync 已持久化。丢失输出时用原备份和目标查询，也支持精确 provenance 参数。'],
    output: 'stdout 恰好一个 JSON 信封；成功 {ok:true,data:...}，错误 {ok:false,error:{code,message,details,retryable:false}}。退出码：0 成功，2 参数错误，1 操作失败，130 SIGINT，143 SIGTERM。--locale 支持 zh-Hans、zh-Hant、en、ja，默认简体中文。',
    notice: 'v3 未保存草稿不备份、不恢复；源草稿和源工作区保留。token、凭据、设置和连接文件也排除。',
    validation: `请使用一个支持的命令及其文档参数。运行 ${entry} --help 查看用法。`,
    source: '本入口仅接受完整分类的普通 schema42 原始备份，并恢复为受保护的 schema43；不接受40/41、已恢复或未知 schema。',
  },
  'zh-Hant': {
    requirements: ['需要 Node.js 24+ 與已安裝的原始碼工作區相依套件。', '僅接受完整分類的普通 schema42 冷工作區。先正常關閉使用來源目錄的所有後端或桌面應用程式；既有鎖、未檢查點 WAL／journal 均拒絕，不修復。', '使用明確、規範的絕對路徑。目標必須不存在，父目錄須安全且已存在；禁止路徑重疊、符號連結及位於既有工作區中的還原目標。'],
    privacy: ['備份包含全工作區資料庫及支援的受管媒體／staging 位元組，包括聊天、提示詞、快取及可能含秘密的使用者文字。備份為私有明文，不加密。', 'v3 未儲存草稿不備份、不還原，來源草稿保留。token、憑證、設定和連線檔案也排除；來源工作區保留。'],
    safety: ['沿用 format1 清單、逐檔校驗及 COMPLETE 發布；本入口固定備份42並離線還原成43（restored-local-v10），不升級40/41、不遞迴備份43。', '還原保留 captured 歷史、回執、held、epoch 和 origin 證據；舊 pending 任務維持 held，不重試或執行。新 origin 也不能繞過既有能力邊界。', '只處理本機檔案，不啟動監聽、後端、worker、provider 或媒體程序，不自動開啟還原工作區。離線還原後，可透過獨立候選應用程式入口的 --open-restored-workspace 明確開啟受保護的43。', '不覆寫、自動重試或自動刪除。中斷可能留下未完成的新目錄；保留原備份並另選新目標。SIGINT／SIGTERM 請求取消並等待本機清理，鎖清理不確定會明確回報。', 'restore-status 僅唯讀觀察43與來源綁定，不修復鎖／sidecar、恢復任務或證明先前未確認的 fsync 已持久化。遺失輸出時用原備份與目標查詢，也支援精確 provenance 參數。'],
    output: 'stdout 恰好一個 JSON 信封；成功 {ok:true,data:...}，錯誤 {ok:false,error:{code,message,details,retryable:false}}。退出碼：0 成功，2 參數錯誤，1 操作失敗，130 SIGINT，143 SIGTERM。--locale 支援 zh-Hans、zh-Hant、en、ja，預設簡體中文。',
    notice: 'v3 未儲存草稿不備份、不還原；來源草稿和來源工作區保留。token、憑證、設定和連線檔案也排除。',
    validation: `請使用一個支援的命令及其文件參數。執行 ${entry} --help 查看用法。`,
    source: '本入口僅接受完整分類的普通 schema42 原始備份，並還原為受保護的 schema43；不接受40/41、已還原或未知 schema。',
  },
  en: {
    requirements: ['Node.js 24+ with installed source workspace dependencies.', 'Only fully classified ordinary schema42 cold workspaces are accepted. Close every backend or desktop app using the source first. Existing locks and uncheckpointed WAL/journal files are refused without repair.', 'Use explicit canonical absolute paths and a nonexistent destination with an existing safe parent. Overlaps, symbolic links and restore targets inside an existing workspace are refused.'],
    privacy: ['Whole-workspace capture includes the database and supported managed media/staging bytes, including chats, prompts, caches and user text that may contain secrets. Backups are private plaintext, not encrypted.', 'Unsaved v3 drafts are excluded from backup and restore; source drafts remain. Tokens, credentials, settings and connection files are also excluded. The source workspace is retained.'],
    safety: ['Reuses format1 manifests, per-file integrity checks and COMPLETE publication. This entry captures fixed42 and restores offline to guarded43 (restored-local-v10); it does not upgrade40/41 or recursively back up43.', 'Captured histories, receipts, held, epoch and origin evidence are preserved. Old pending tasks remain held and are never retried or executed. A new origin cannot bypass existing capability boundaries.', 'Local files only. No listener, backend, worker, provider or media process starts, and no restored workspace opens automatically. After offline restore, explicitly open guarded43 through the separate candidate application entry with --open-restored-workspace.', 'No overwrite, automatic retry or automatic deletion. Interrupted operations may leave an incomplete new destination; preserve the original backup and choose another new target. SIGINT/SIGTERM request cancellation and await local cleanup; uncertain lock release is reported.', 'restore-status only observes guarded43 and provenance read-only. It does not repair locks/sidecars, resume tasks or prove previously unconfirmed fsync durability. After output loss, query with the original backup and destination, or the exact provenance parameters.'],
    output: 'Exactly one JSON envelope on stdout: success {ok:true,data:...}; error {ok:false,error:{code,message,details,retryable:false}}. Exit codes: 0 success, 2 invalid arguments, 1 operation failure, 130 SIGINT, 143 SIGTERM. --locale accepts zh-Hans, zh-Hant, en, ja; default: Simplified Chinese.',
    notice: 'Unsaved v3 drafts are excluded from backup and restore; source drafts and the source workspace remain. Tokens, credentials, settings and connection files are also excluded.',
    validation: `Use exactly one supported command and its documented options. Run ${entry} --help for usage.`,
    source: 'This entry only accepts fully classified ordinary schema42 original backups and restores to guarded schema43. Schemas40/41, restored and unknown schemas are refused.',
  },
  ja: {
    requirements: ['Node.js 24+ とインストール済みのソースワークスペース依存関係が必要です。', '完全に分類された通常の schema42 のコールドワークスペースのみ受け付けます。先にソースを使うすべてのバックエンドとデスクトップアプリを正常終了してください。既存のロックと未チェックポイントの WAL／journal は修復せず拒否します。', '明示的で正規の絶対パスを使い、安全な既存の親ディレクトリ内に未作成の保存先を指定してください。パスの重複、シンボリックリンク、既存ワークスペース内への復元は拒否します。'],
    privacy: ['バックアップには全ワークスペースのデータベースと対応する管理対象メディア／staging バイトが含まれます。チャット、プロンプト、キャッシュなどのユーザーテキストには秘密情報が含まれる場合があります。私有の平文であり、暗号化しません。', '未保存の v3 下書きはバックアップ・復元の対象外です。ソースの下書きは保持します。token、認証情報、設定、接続ファイルも対象外です。ソースワークスペースは保持します。'],
    safety: ['既存の format1 マニフェスト、ファイルごとの整合性検証、COMPLETE 公開を再利用します。固定42をバックアップし、保護された43（restored-local-v10）へオフライン復元します。40/41の更新と43の再帰バックアップは行いません。', '取得済みの履歴、受領記録、held、epoch、origin の証拠を保持します。古い pending タスクは held のままで、再試行・実行しません。新しい origin も既存の権限境界を回避できません。', 'ローカルファイルのみ処理します。待ち受け、バックエンド、worker、provider、メディアプロセスを起動せず、復元先も自動で開きません。オフライン復元後、独立した候補アプリ入口の --open-restored-workspace で保護された43を明示的に開けます。', '上書き、自動再試行、自動削除は行いません。中断後は未完成の新規ディレクトリが残る場合があります。元のバックアップを保持し、別の新規保存先を選んでください。SIGINT／SIGTERM は取消を要求し、ローカルの後処理を待ちます。ロック解除が不確かな場合は明示します。', 'restore-status は43の保護と出所の対応を読み取り専用で観察します。ロック／sidecar の修復、タスク再開、未確認の fsync の永続性証明は行いません。出力紛失時は元のバックアップと復元先、または正確な provenance 引数を指定してください。'],
    output: 'stdout には JSON エンベロープを1個だけ出力します。成功 {ok:true,data:...}、失敗 {ok:false,error:{code,message,details,retryable:false}}。終了コード：0 成功、2 引数不正、1 操作失敗、130 SIGINT、143 SIGTERM。--locale は zh-Hans、zh-Hant、en、ja に対応し、既定は簡体字中国語です。',
    notice: '未保存の v3 下書きはバックアップ・復元の対象外です。ソースの下書きとワークスペースは保持します。token、認証情報、設定、接続ファイルも対象外です。',
    validation: `対応するコマンド1個と文書化された引数を指定してください。使い方は ${entry} --help を実行してください。`,
    source: '完全に分類された通常の schema42 の元バックアップのみ受け付け、保護された schema43 に復元します。40/41、復元済み、不明な schema は拒否します。',
  },
};

function fail(): never {throw Object.assign(new Error('Invalid fixed offline CLI input.'), {code: 'VALIDATION_ERROR'});}
function text(value: unknown): string {if (typeof value !== 'string') return fail(); return value;}
function version(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  if (!object(metadata) || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(metadata.version))
    throw Object.assign(new Error('Invalid product version.'), {code: 'WORKSPACE_BACKUP_IO'});
  return metadata.version;
}

function help(topic: unknown, locale: Locale) {
  const commands: Record<string, string> = {
    create: `${entry} create --source /absolute/closed42-workspace --destination /absolute/new-backup`,
    verify: `${entry} verify --directory /absolute/backup42`,
    restore: `${entry} restore --directory /absolute/backup42 --destination /absolute/new43-workspace`,
    'restore-status': `${entry} restore-status --directory /absolute/original-backup42 --destination /absolute/restored43-workspace`,
  };
  const exactStatus = `${entry} restore-status --destination /absolute/restored43-workspace --restoration-id UUID --backup-id UUID --manifest-hash SHA256 --source-db-hash SHA256`;
  const {requirements, privacy, safety, output} = copy[locale];
  return {name, version: version(), offline: true, sourceSchema: 42, restoredSchema: 43, draftPolicy: 'excluded', locale,
    usage: typeof topic === 'string' && Object.hasOwn(commands, topic) ? [commands[topic], ...(topic === 'restore-status' ? [exactStatus] : [])] : [...Object.values(commands), exactStatus, `${entry} --help`, `${entry} --version`],
    requirements, privacy, safety, output};
}

/** Import by runtime string: the legacy entry has top-level await, so require()
 * cannot load it. Unknown plus checked exports avoids widening the JS typecheck. */
async function sharedHelpers() {
  const moduleName: string = './backup.mjs';
  const module: unknown = await import(moduleName);
  if (!object(module)) throw new Error('Offline CLI helpers unavailable.');
  const parse: unknown = module.parseBackupArguments, safe: unknown = module.safeBackupCliError, write: unknown = module.writeBackupCliOutput;
  if (typeof parse !== 'function' || typeof safe !== 'function' || typeof write !== 'function') throw new Error('Offline CLI helpers unavailable.');
  return {
    parse(argv: readonly string[], onLocale: (locale: Locale) => void): Record<string, unknown> {
      const result: unknown = Reflect.apply(parse, module, [argv, onLocale]);
      if (!object(result)) return fail(); return result;
    },
    safe(error: unknown, command?: Command): Record<string, unknown> {
      const result: unknown = Reflect.apply(safe, module, [error, command]);
      if (!object(result) || typeof result.code !== 'string' || typeof result.message !== 'string' || !object(result.details) || result.retryable !== false)
        throw new Error('Offline CLI diagnostics unavailable.');
      return result;
    },
    async write(stream: NodeJS.WriteStream, content: string): Promise<boolean> {return await Reflect.apply(write, module, [stream, content]) === true;},
  };
}

export async function runOpacityBackupCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const helpers = await sharedHelpers();
  let locale: Locale = 'zh-Hans', firstSignal: 'SIGINT' | 'SIGTERM' | undefined, command: Command | undefined;
  let data: unknown, error: Record<string, unknown> | undefined;
  try {
    const input = helpers.parse(argv, value => {locale = value;});
    if (!['create', 'verify', 'restore', 'restore-status', 'help', 'version'].includes(text(input.command))) fail();
    command = input.command as Command;
    if (command === 'help') data = help(input.topic, locale);
    else if (command === 'version') data = {name, version: version()};
    else {
      const controller = new AbortController();
      const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {firstSignal ??= signal; controller.abort();};
      const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      try {
        if (command === 'create') data = await createOpacityCandidateWorkspaceBackup({source: text(input.source), destination: text(input.destination), signal: controller.signal});
        else if (command === 'verify') data = await verifyOpacityCandidateWorkspaceBackup({directory: text(input.directory), signal: controller.signal});
        else if (command === 'restore') data = await restoreOpacityCandidateWorkspaceBackup({directory: text(input.directory), destination: text(input.destination), signal: controller.signal});
        else data = await inspectOpacityCandidateRestorePublication(typeof input.directory === 'string'
          ? {directory: input.directory, destination: text(input.destination), signal: controller.signal}
          : {destination: text(input.destination), restorationId: text(input.restorationId), sourceBackupId: text(input.sourceBackupId), manifestHash: text(input.manifestHash), sourceDbHash: text(input.sourceDbHash), signal: controller.signal});
      } finally {
        // Operation settles its own cleanup before these scoped listeners leave.
        process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      }
    }
  } catch (caught) {
    error = helpers.safe(caught, command);
    const code = text(error.code);
    error.message = code === 'VALIDATION_ERROR' ? copy[locale].validation
      : code === 'WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED' ? copy[locale].source
      : backupDiagnostic(code, text(error.message), locale);
  }
  if (error) {
    await helpers.write(process.stdout, `${JSON.stringify({ok: false, error})}\n`);
    await helpers.write(process.stderr, `${text(error.code)}: ${text(error.message)}\n`);
    return error.code === 'VALIDATION_ERROR' || ['WORKSPACE_BACKUP_INVALID_PATH', 'WORKSPACE_RESTORE_INVALID_PATH'].includes(text(error.code)) ? 2
      : ['WORKSPACE_BACKUP_CANCELLED', 'WORKSPACE_RESTORE_CANCELLED'].includes(text(error.code)) ? (firstSignal === 'SIGTERM' ? 143 : 130) : 1;
  }
  const written = await helpers.write(process.stdout, `${JSON.stringify({ok: true, data})}\n`);
  if (command === 'create' || command === 'restore') await helpers.write(process.stderr, `${copy[locale].notice}\n`);
  return written ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runOpacityBackupCli();
