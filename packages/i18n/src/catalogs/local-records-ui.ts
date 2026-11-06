import type {MessageCatalog} from '../types.ts';
export const localRecordsUiMessages = {
  "localRecords.title": {
    "zh-Hans": "本机记录",
    "zh-Hant": "本機記錄",
    "en": "Local records",
    "ja": "ローカル記録"
  },
  "localRecords.help": {
    "zh-Hans": "每个项目在这台电脑上的版本历史、自动备份、Mio 记录和后台任务记录，按项目分开存放。项目文件找不到的，可以在这里删除这些记录。",
    "zh-Hant": "每個專案在這台電腦上的版本歷史、自動備份、Mio 記錄和背景工作記錄，按專案分開儲存。找不到專案檔案時，可以在這裡刪除這些記錄。",
    "en": "Version history, automatic backups, Mio records and background task records are stored separately for each project on this computer. Records whose project file cannot be found can be deleted here.",
    "ja": "このコンピューターのバージョン履歴、自動バックアップ、Mio 記録、バックグラウンドタスク記録はプロジェクトごとに保存されます。プロジェクトファイルが見つからない記録をここで削除できます。"
  },
  "localRecords.loading": {
    "zh-Hans": "正在统计…",
    "zh-Hant": "正在統計…",
    "en": "Calculating…",
    "ja": "集計中…"
  },
  "localRecords.summary": {
    "zh-Hans": "有 {count} 个项目的记录找不到项目文件 · 共 {size}",
    "zh-Hant": "有 {count} 個專案的記錄找不到專案檔案 · 共 {size}",
    "en": "Project files missing for {count} records · {size} total",
    "ja": "プロジェクトファイルが見つからない記録 {count} 件 · 合計 {size}"
  },
  "localRecords.empty": {
    "zh-Hans": "没有需要清理的记录",
    "zh-Hant": "沒有需要清理的記錄",
    "en": "No records need cleanup",
    "ja": "削除が必要な記録はありません"
  },
  "localRecords.unknownName": {
    "zh-Hans": "未知项目",
    "zh-Hant": "未知專案",
    "en": "Unknown project",
    "ja": "不明なプロジェクト"
  },
  "localRecords.noLocation": {
    "zh-Hans": "没有登记位置",
    "zh-Hant": "沒有登記位置",
    "en": "No registered location",
    "ja": "登録された場所はありません"
  },
  "localRecords.delete": {
    "zh-Hans": "删除",
    "zh-Hant": "刪除",
    "en": "Delete",
    "ja": "削除"
  },
  "localRecords.cancel": {
    "zh-Hans": "取消",
    "zh-Hant": "取消",
    "en": "Cancel",
    "ja": "キャンセル"
  },
  "localRecords.refresh": {
    "zh-Hans": "刷新列表",
    "zh-Hant": "重新整理清單",
    "en": "Refresh list",
    "ja": "一覧を更新"
  },
  "localRecords.journalTag": {
    "zh-Hans": "暂时不能删",
    "zh-Hant": "暫時無法刪除",
    "en": "Cannot delete yet",
    "ja": "現在は削除できません"
  },
  "localRecords.journalHelp": {
    "zh-Hans": "这个项目上次没有正常关闭，删掉这些记录会让项目文件没法恢复。先接上项目所在的磁盘、打开一次项目，再回来删除。",
    "zh-Hant": "這個專案上次沒有正常關閉，刪掉這些記錄會讓專案檔案無法復原。先接上專案所在的磁碟、開啟一次專案，再回來刪除。",
    "en": "This project did not close correctly. Deleting these records would prevent its file from recovering. Connect its disk and open the project once, then return to delete the records.",
    "ja": "このプロジェクトは正常に閉じられませんでした。記録を削除するとファイルを復旧できません。保存先ディスクを接続して一度開いてから、削除してください。"
  },
  "localRecords.tasksTag": {
    "zh-Hans": "有生成任务没结束",
    "zh-Hant": "有生成工作尚未結束",
    "en": "Generation tasks unfinished",
    "ja": "生成タスクが未完了"
  },
  "localRecords.tasksHelp": {
    "zh-Hans": "这个项目还有生成任务没结束。找回项目让任务做完，再回来删除。",
    "zh-Hant": "這個專案還有生成工作尚未結束。找回專案讓工作完成，再回來刪除。",
    "en": "This project has unfinished generation tasks. Find the project and let them finish before deleting its records.",
    "ja": "このプロジェクトには未完了の生成タスクがあります。プロジェクトを見つけてタスクを完了してから削除してください。"
  },
  "localRecords.confirmTitle": {
    "zh-Hans": "删除「{name}」的本机记录？",
    "zh-Hant": "刪除「{name}」的本機記錄？",
    "en": "Delete local records for “{name}”?",
    "ja": "「{name}」のローカル記録を削除しますか？"
  },
  "localRecords.confirmHelp": {
    "zh-Hans": "会删掉这个项目在这台电脑上的版本历史、自动备份、Mio 记录和后台任务记录，共 {size}。项目文件本身不受影响；以后再找到项目文件，它会作为没有版本历史的项目打开。这一步不能撤销。",
    "zh-Hant": "會刪掉這個專案在這台電腦上的版本歷史、自動備份、Mio 記錄和背景工作記錄，共 {size}。專案檔案本身不受影響；以後再找到專案檔案，它會作為沒有版本歷史的專案開啟。這一步無法復原。",
    "en": "This deletes {size} of version history, automatic backups, Mio records and background task records for this project on this computer. The project file is unaffected. If found later, it opens without version history. This cannot be undone.",
    "ja": "このコンピューターのバージョン履歴、自動バックアップ、Mio 記録、バックグラウンドタスク記録（{size}）を削除します。プロジェクトファイル自体は変わりません。後で見つかった場合、バージョン履歴なしで開きます。この操作は取り消せません。"
  },
  "localRecords.backupWarning": {
    "zh-Hans": {"one": "其中有 {count} 份自动备份（{size}）。项目文件找不到时，这些备份可能是它仅剩的副本，删掉以后就不能再从备份恢复。", "other": "其中有 {count} 份自动备份（{size}）。项目文件找不到时，这些备份可能是它仅剩的副本，删掉以后就不能再从备份恢复。"},
    "zh-Hant": {"one": "其中有 {count} 份自動備份（{size}）。找不到專案檔案時，這些備份可能是它僅存的副本，刪除後就無法再從備份還原。", "other": "其中有 {count} 份自動備份（{size}）。找不到專案檔案時，這些備份可能是它僅存的副本，刪除後就無法再從備份還原。"},
    "en": {"one": "This includes {count} automatic backup ({size}). If the project file is missing, this backup may be its only remaining copy. Deleting it removes the ability to recover from that backup.", "other": "These include {count} automatic backups ({size}). If the project file is missing, these backups may be its only remaining copies. Deleting them removes the ability to recover from those backups."},
    "ja": {"one": "この中に自動バックアップが {count} 件（{size}）あります。プロジェクトファイルが見つからない場合、残された唯一のコピーかもしれません。削除すると、これらのバックアップから復元できなくなります。", "other": "この中に自動バックアップが {count} 件（{size}）あります。プロジェクトファイルが見つからない場合、残された唯一のコピーかもしれません。削除すると、これらのバックアップから復元できなくなります。"}
  },
  "localRecords.readError": {
    "zh-Hans": "无法读取本机记录，请刷新列表重试。",
    "zh-Hant": "無法讀取本機記錄，請重新整理清單重試。",
    "en": "Local records could not be read. Refresh the list to retry.",
    "ja": "ローカル記録を読み取れません。一覧を更新してください。"
  },
  "localRecords.inUse": {
    "zh-Hans": "这个项目的文件又找到了、正在打开，或者还有生成任务没结束，不能删除。",
    "zh-Hant": "這個專案的檔案又找到了、正在開啟，或還有生成工作尚未結束，無法刪除。",
    "en": "This project file was found again, is opening, or has unfinished generation tasks. Its records cannot be deleted.",
    "ja": "プロジェクトファイルが見つかった、開いている、または生成タスクが未完了のため削除できません。"
  },
  "localRecords.notFound": {
    "zh-Hans": "这份记录已经不在了。",
    "zh-Hant": "這份記錄已經不在了。",
    "en": "These records are no longer present.",
    "ja": "この記録はすでにありません。"
  },
  "localRecords.identityChanged": {
    "zh-Hans": "应用资料库或服务已变化。请刷新列表，重新确认要删除的记录。",
    "zh-Hant": "應用程式資料庫或服務已變更。請重新整理清單，再確認要刪除的記錄。",
    "en": "The application library or service changed. Refresh the list and confirm the records again.",
    "ja": "アプリのライブラリーまたはサービスが変わりました。一覧を更新して、削除する記録を再確認してください。"
  },
  "localRecords.unknown": {
    "zh-Hans": "没收到确切的删除结果。请刷新列表核对；不会自动再次删除。列表中不再显示，也不能据此确认刚才的删除成功。",
    "zh-Hant": "沒有收到確切的刪除結果。請重新整理清單核對；不會自動再次刪除。清單中不再顯示，也無法據此確認剛才的刪除成功。",
    "en": "The deletion result is unconfirmed. Refresh the list to check; deletion will not be retried automatically. An absent row alone does not confirm that this deletion succeeded.",
    "ja": "削除結果を確認できません。一覧を更新して確認してください。自動で再削除はしません。行が消えたことだけでは、今回の削除成功は確認できません。"
  },
  "localRecords.deleteError": {
    "zh-Hans": "无法确认删除，请刷新列表后重试。",
    "zh-Hant": "無法確認刪除，請重新整理清單後重試。",
    "en": "Deletion could not be confirmed. Refresh the list before trying again.",
    "ja": "削除を確認できません。一覧を更新してから再試行してください。"
  },
  "localRecords.deleted": {
    "zh-Hans": "已删除本机记录",
    "zh-Hant": "已刪除本機記錄",
    "en": "Local records deleted",
    "ja": "ローカル記録を削除しました"
  },
  "workspace.storage.help": {
    "zh-Hans": "本机记录和设置保存在这里。缓存由应用管理；项目文件按各自的位置保存。",
    "zh-Hant": "本機記錄和設定儲存在這裡。快取由應用程式管理；專案檔案儲存在各自的位置。",
    "en": "Local records and settings are stored here. The app manages caches; project files remain at their own locations.",
    "ja": "ローカル記録と設定をここに保存します。キャッシュはアプリが管理し、プロジェクトファイルは各保存先にあります。"
  },
  "workspace.storage.summary": {
    "zh-Hans": "本机记录 {records} · 缓存 {cache}",
    "zh-Hant": "本機記錄 {records} · 快取 {cache}",
    "en": "Local records {records} · cache {cache}",
    "ja": "ローカル記録 {records} · キャッシュ {cache}"
  },
  "workspace.storage.cacheLocation": {
    "zh-Hans": "缓存位置",
    "zh-Hant": "快取位置",
    "en": "Cache location",
    "ja": "キャッシュの場所"
  },
  "workspace.storage.overlap": {
    "zh-Hans": "分项按各自目录统计，可能重叠，不作为总空间相加。缓存可由应用重新生成。",
    "zh-Hant": "各項按各自目錄統計，可能重疊，不加總為總空間。快取可由應用程式重新產生。",
    "en": "Categories measure their own directories and may overlap; they are not added into a total. The app can rebuild caches.",
    "ja": "各項目はそれぞれのフォルダーを集計し、重複する場合があるため合計しません。キャッシュはアプリで再生成できます。"
  }
} as const satisfies MessageCatalog;
