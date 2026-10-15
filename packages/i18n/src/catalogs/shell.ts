import type { MessageCatalog } from '../types.ts';
import { subjectsMessages } from './subjects.ts';
import { assertNoDuplicateMessageKeys } from '../catalog-integrity.ts';

const shellCoreMessages = {
  "projects.updatedAt": {
    "zh-Hans": "更新时间",
    "zh-Hant": "更新時間",
    "en": "Updated",
    "ja": "更新日時"
  },
  "projects.timeUnknown": {
    "zh-Hans": "时间未知",
    "zh-Hant": "時間不明",
    "en": "Time unknown",
    "ja": "日時不明"
  },
  "projects.nameRequired": {
    "zh-Hans": "请填写项目名称。",
    "zh-Hant": "請填寫專案名稱。",
    "en": "Enter a project name.",
    "ja": "プロジェクト名を入力してください。"
  },
  "projects.inputLimits": {
    "zh-Hans": "项目名称最多 150 个字符，创作方向最多 2000 个字符。",
    "zh-Hant": "專案名稱最多 150 個字元，創作方向最多 2000 個字元。",
    "en": "Project names can have up to 150 characters and creative direction up to 2000.",
    "ja": "プロジェクト名は150文字以内、制作方針は2000文字以内で入力してください。"
  },
  "projects.createRetained": {
    "zh-Hans": "输入已保留。请先刷新项目列表核对，再决定是否重新创建。",
    "zh-Hant": "輸入已保留。請先重新整理專案清單核對，再決定是否重新建立。",
    "en": "Your input is retained. Refresh the project list to check before deciding whether to create again.",
    "ja": "入力内容は保持されています。再作成する前にプロジェクト一覧を更新して確認してください。"
  },
  "projects.createUnknown": {
    "zh-Hans": "新建结果未确认，输入已保留。请先刷新项目列表核对，避免重复创建。",
    "zh-Hant": "建立結果尚未確認，輸入已保留。請先重新整理專案清單核對，避免重複建立。",
    "en": "Creation is unconfirmed and your input is retained. Refresh the project list to check and avoid duplicates.",
    "ja": "作成結果は未確認で、入力内容は保持されています。重複作成を避けるため、プロジェクト一覧を更新して確認してください。"
  },
  "projects.home": {
    "zh-Hans": "项目首页",
    "zh-Hant": "專案首頁",
    "en": "Project home",
    "ja": "プロジェクトホーム"
  },
  "projects.entry": {
    "zh-Hans": "项目入口",
    "zh-Hant": "專案入口",
    "en": "Project entry",
    "ja": "プロジェクト入口"
  },
  "projects.list": {
    "zh-Hans": "项目列表",
    "zh-Hant": "專案清單",
    "en": "Projects",
    "ja": "プロジェクト一覧"
  },
  "projects.connections": {
    "zh-Hans": "连接设置",
    "zh-Hant": "連線設定",
    "en": "Connection settings",
    "ja": "接続設定"
  },
  "projects.loadingView": {
    "zh-Hans": "正在读取项目和视图设置。",
    "zh-Hant": "正在讀取專案與檢視設定。",
    "en": "Loading the project and view settings.",
    "ja": "プロジェクトと表示設定を読み込んでいます。"
  },
  "projects.openFailed": {
    "zh-Hans": "项目未能打开",
    "zh-Hant": "無法開啟專案",
    "en": "Could not open project",
    "ja": "プロジェクトを開けませんでした"
  },
  "projects.openRetryHint": {
    "zh-Hans": "请重试，或从项目列表选择其他项目。",
    "zh-Hant": "請重試，或從專案清單選擇其他專案。",
    "en": "Try again or choose another project from the list.",
    "ja": "再試行するか、一覧から別のプロジェクトを選択してください。"
  },
  "projects.retryOpen": {
    "zh-Hans": "重试打开",
    "zh-Hant": "重試開啟",
    "en": "Retry opening",
    "ja": "もう一度開く"
  },
  "projects.workspace": {
    "zh-Hans": "当前工作区",
    "zh-Hant": "目前工作區",
    "en": "Current workspace",
    "ja": "現在のワークスペース"
  },
  "projects.manageConnections": {
    "zh-Hans": "管理当前工作区的全局连接配置。",
    "zh-Hant": "管理目前工作區的全域連線設定。",
    "en": "Manage global connections for the current workspace.",
    "ja": "現在のワークスペース全体の接続設定を管理します。"
  },
  "projects.chooseStory": {
    "zh-Hans": "选择一个项目继续创作，或开始一个新故事。",
    "zh-Hant": "選擇專案繼續創作，或開始一個新故事。",
    "en": "Choose a project to keep creating, or start a new story.",
    "ja": "プロジェクトを選んで制作を続けるか、新しいストーリーを始めましょう。"
  },
  "projects.createFirst": {
    "zh-Hans": "创建第一个项目",
    "zh-Hant": "建立第一個專案",
    "en": "Create your first project",
    "ja": "最初のプロジェクトを作成"
  },
  "projects.createNew": {
    "zh-Hans": "新建项目",
    "zh-Hant": "新增專案",
    "en": "New project",
    "ja": "新規プロジェクト"
  },
  "projects.newStory": {
    "zh-Hans": "开始一个新故事",
    "zh-Hant": "開始一個新故事",
    "en": "Start a new story",
    "ja": "新しいストーリーを始める"
  },
  "projects.createIntro": {
    "zh-Hans": "为这次创作命名，创建成功后进入项目。",
    "zh-Hant": "為這次創作命名，建立成功後進入專案。",
    "en": "Name your creation. The project opens after it is created.",
    "ja": "作品に名前を付けてください。作成後にプロジェクトが開きます。"
  },
  "projects.name": {
    "zh-Hans": "项目名称",
    "zh-Hant": "專案名稱",
    "en": "Project name",
    "ja": "プロジェクト名"
  },
  "projects.namePlaceholder": {
    "zh-Hans": "例如：山野之间 · 秋日短片",
    "zh-Hant": "例如：山野之間 · 秋日短片",
    "en": "For example: Into the hills · An autumn short",
    "ja": "例：山あいで・秋のショートフィルム"
  },
  "projects.direction": {
    "zh-Hans": "创作方向",
    "zh-Hant": "創作方向",
    "en": "Creative direction",
    "ja": "制作方針"
  },
  "shell.optional": {
    "zh-Hans": "可选",
    "zh-Hant": "選填",
    "en": "Optional",
    "ja": "任意"
  },
  "projects.directionPlaceholder": {
    "zh-Hans": "关于这个故事，你最想表达什么？",
    "zh-Hant": "關於這個故事，你最想表達什麼？",
    "en": "What do you most want this story to express?",
    "ja": "このストーリーで最も伝えたいことは何ですか？"
  },
  "shell.cancel": {
    "zh-Hans": "取消",
    "zh-Hant": "取消",
    "en": "Cancel",
    "ja": "キャンセル"
  },
  "projects.creating": {
    "zh-Hans": "正在创建…",
    "zh-Hant": "正在建立…",
    "en": "Creating…",
    "ja": "作成中…"
  },
  "projects.createOpen": {
    "zh-Hans": "创建并打开",
    "zh-Hant": "建立並開啟",
    "en": "Create and open",
    "ja": "作成して開く"
  },
  "projects.workspaceProjects": {
    "zh-Hans": "工作区项目",
    "zh-Hant": "工作區專案",
    "en": "Workspace projects",
    "ja": "ワークスペースのプロジェクト"
  },
  "projects.refreshing": {
    "zh-Hans": "正在刷新…",
    "zh-Hant": "正在重新整理…",
    "en": "Refreshing…",
    "ja": "更新中…"
  },
  "projects.refreshList": {
    "zh-Hans": "刷新项目列表",
    "zh-Hant": "重新整理專案清單",
    "en": "Refresh projects",
    "ja": "プロジェクト一覧を更新"
  },
  "projects.loadingList": {
    "zh-Hans": "正在读取项目列表…",
    "zh-Hant": "正在讀取專案清單…",
    "en": "Loading projects…",
    "ja": "プロジェクト一覧を読み込み中…"
  },
  "projects.emptyTitle": {
    "zh-Hans": "还没有项目",
    "zh-Hant": "還沒有專案",
    "en": "No projects yet",
    "ja": "プロジェクトがありません"
  },
  "projects.emptyBody": {
    "zh-Hans": "从一个新故事开始。创建项目后，就可以组织镜头、添加素材和剪辑成片。",
    "zh-Hant": "從一個新故事開始。建立專案後，就能整理鏡頭、新增素材並剪輯成片。",
    "en": "Start a new story. Create a project to organize shots, add assets, and edit your film.",
    "ja": "新しいストーリーを始めましょう。プロジェクトを作成すると、ショットの整理、素材の追加、映像の編集ができます。"
  },
  "projects.open": {
    "zh-Hans": "打开项目",
    "zh-Hant": "開啟專案",
    "en": "Open project",
    "ja": "プロジェクトを開く"
  },
  "projects.workspaceFootnote": {
    "zh-Hans": "这里显示当前已连接工作区中的项目。",
    "zh-Hant": "這裡顯示目前已連線工作區中的專案。",
    "en": "Projects from the currently connected workspace appear here.",
    "ja": "現在接続しているワークスペースのプロジェクトが表示されます。"
  },
  "projects.openingNamed": {
    "zh-Hans": "正在打开「{name}」…",
    "zh-Hant": "正在開啟「{name}」…",
    "en": "Opening “{name}”…",
    "ja": "「{name}」を開いています…"
  },
  "projects.opening": {
    "zh-Hans": "正在打开项目…",
    "zh-Hant": "正在開啟專案…",
    "en": "Opening project…",
    "ja": "プロジェクトを開いています…"
  },
  "projects.failedNamed": {
    "zh-Hans": "无法打开「{name}」",
    "zh-Hant": "無法開啟「{name}」",
    "en": "Could not open “{name}”",
    "ja": "「{name}」を開けませんでした"
  },
  "projects.countSorted": {
    "zh-Hans": {
      "one": "{count} 个项目 · 按更新时间排列",
      "other": "{count} 个项目 · 按更新时间排列"
    },
    "zh-Hant": {
      "one": "{count} 個專案 · 依更新時間排序",
      "other": "{count} 個專案 · 依更新時間排序"
    },
    "en": {
      "one": "{count} project · Sorted by last update",
      "other": "{count} projects · Sorted by last update"
    },
    "ja": {
      "one": "{count}件のプロジェクト・更新日時順",
      "other": "{count}件のプロジェクト・更新日時順"
    }
  },
  "projects.openNamed": {
    "zh-Hans": "打开 {name}",
    "zh-Hant": "開啟 {name}",
    "en": "Open {name}",
    "ja": "{name} を開く"
  },
  "shell.globalConnections": {
    "zh-Hans": "全局连接设置",
    "zh-Hant": "全域連線設定",
    "en": "Global connection settings",
    "ja": "共通の接続設定"
  },
  "shell.settingsRetained": {
    "zh-Hans": "设置由此窗口独立保留。关闭其他项目不会清除这里的输入。",
    "zh-Hant": "設定由此視窗獨立保留。關閉其他專案不會清除此處的輸入。",
    "en": "This window retains its settings independently. Closing other projects will not clear these inputs.",
    "ja": "このウィンドウは設定を独立して保持します。他のプロジェクトを閉じても、ここでの入力は消えません。"
  },
  "shell.checkingWorkspace": {
    "zh-Hans": "正在核对工作区身份…",
    "zh-Hant": "正在核對工作區身分…",
    "en": "Checking workspace identity…",
    "ja": "ワークスペースの識別情報を確認中…"
  },
  "shell.restoredConnectionsUnavailable": {
    "zh-Hans": "恢复分支不提供模型连接设置。",
    "zh-Hant": "還原分支不提供模型連線設定。",
    "en": "Model connection settings are unavailable in a restored branch.",
    "ja": "復元ブランチではモデル接続設定を利用できません。"
  },
  "shell.workspaceUnconfirmed": {
    "zh-Hans": "工作区身份未确认，请保留此窗口并核对连接。",
    "zh-Hant": "工作區身分尚未確認，請保留此視窗並核對連線。",
    "en": "Workspace identity is unconfirmed. Keep this window open and check the connection.",
    "ja": "ワークスペースの識別情報を確認できていません。このウィンドウを開いたまま接続を確認してください。"
  },
  "shell.windowUnconfirmed": {
    "zh-Hans": "窗口身份未确认",
    "zh-Hant": "視窗身分尚未確認",
    "en": "Window identity unconfirmed",
    "ja": "ウィンドウの識別情報が未確認です"
  },
  "shell.keepWindow": {
    "zh-Hans": "请保留当前窗口，重新启动前先核对是否有未完成的输入。",
    "zh-Hant": "請保留目前視窗，重新啟動前先核對是否有未完成的輸入。",
    "en": "Keep this window open. Check for unfinished input before restarting.",
    "ja": "このウィンドウを開いたまま、再起動する前に未完了の入力がないか確認してください。"
  },
  "shell.checkingWindow": {
    "zh-Hans": "正在核对桌面窗口…",
    "zh-Hant": "正在核對桌面視窗…",
    "en": "Checking desktop window…",
    "ja": "デスクトップウィンドウを確認中…"
  },
  "projects.quittingCreate": {
    "zh-Hans": "应用正在退出，暂不能新建项目。",
    "zh-Hant": "應用程式正在結束，暫時無法新增專案。",
    "en": "The app is quitting. New projects cannot be created now.",
    "ja": "アプリを終了中のため、プロジェクトを作成できません。"
  },
  "projects.previousCreateUnknown": {
    "zh-Hans": "上次新建结果未确认。请保留此窗口并刷新列表核对，不要重复创建。",
    "zh-Hant": "上次建立結果尚未確認。請保留此視窗並重新整理清單核對，不要重複建立。",
    "en": "The previous creation is unconfirmed. Keep this window open and refresh the list to check. Do not create a duplicate.",
    "ja": "前回の作成結果が未確認です。このウィンドウを開いたまま一覧を更新して確認し、重複作成しないでください。"
  },
  "projects.checkOpenResult": {
    "zh-Hans": "请先核对当前打开窗口的结果。",
    "zh-Hant": "請先核對目前開啟視窗的結果。",
    "en": "Check the current window-opening result first.",
    "ja": "まずウィンドウを開く操作の結果を確認してください。"
  },
  "projects.workspaceNotChecked": {
    "zh-Hans": "工作区身份尚未核对，暂不能新建项目。",
    "zh-Hant": "工作區身分尚未核對，暫時無法新增專案。",
    "en": "Workspace identity has not been checked. New projects cannot be created yet.",
    "ja": "ワークスペースの識別情報が未確認のため、まだプロジェクトを作成できません。"
  },
  "projects.restoredCreateUnavailable": {
    "zh-Hans": "恢复分支暂不支持新建项目。",
    "zh-Hant": "還原分支暫不支援新增專案。",
    "en": "New projects are not supported in a restored branch.",
    "ja": "復元ブランチでは新規プロジェクトを作成できません。"
  },
  "projects.openWorkspace": {
    "zh-Hans": "打开工作区项目",
    "zh-Hant": "開啟工作區專案",
    "en": "Open workspace project",
    "ja": "ワークスペースのプロジェクトを開く"
  },
  "projects.separateWindow": {
    "zh-Hans": "从当前工作区选择项目，将在独立编辑窗口打开；此窗口的项目与输入会保留。",
    "zh-Hant": "從目前工作區選擇專案，將在獨立編輯視窗開啟；此視窗的專案與輸入會保留。",
    "en": "Choose a project from this workspace to open in a separate editor window. This window’s project and inputs are retained.",
    "ja": "現在のワークスペースから選ぶと、別の編集ウィンドウで開きます。このウィンドウのプロジェクトと入力内容は保持されます。"
  },
  "projects.closeSelection": {
    "zh-Hans": "关闭项目选择",
    "zh-Hant": "關閉專案選擇",
    "en": "Close project selection",
    "ja": "プロジェクト選択を閉じる"
  },
  "projects.checkOriginalOpen": {
    "zh-Hans": "只核对原打开请求，不会重新创建项目。",
    "zh-Hant": "僅核對原開啟請求，不會重新建立專案。",
    "en": "Only checks the original opening request. It will not create a project again.",
    "ja": "元の「開く」リクエストのみを確認します。プロジェクトは再作成しません。"
  },
  "projects.checkWindow": {
    "zh-Hans": "核对窗口状态",
    "zh-Hant": "核對視窗狀態",
    "en": "Check window status",
    "ja": "ウィンドウの状態を確認"
  },
  "shell.connectionScope": {
    "zh-Hans": "设置属于当前工作区，不需要先打开项目。查看设置不会发起生成；未保存的连接输入在离开前需要确认。",
    "zh-Hant": "設定屬於目前工作區，無須先開啟專案。檢視設定不會啟動生成；離開前須確認尚未儲存的連線輸入。",
    "en": "Settings belong to this workspace; no project needs to be open. Viewing settings does not start generation. Unsaved connection inputs require confirmation before leaving.",
    "ja": "設定は現在のワークスペースに属し、プロジェクトを開く必要はありません。設定を見るだけで生成は始まりません。未保存の接続入力がある場合、離れる前に確認が必要です。"
  },
  "shell.connectionType": {
    "zh-Hans": "连接类型",
    "zh-Hant": "連線類型",
    "en": "Connection type",
    "ja": "接続の種類"
  },
  "shell.openaiImage": {
    "zh-Hans": "OpenAI 图像",
    "zh-Hant": "OpenAI 圖像",
    "en": "OpenAI images",
    "ja": "OpenAI 画像"
  },
  "shell.compatibleImage": {
    "zh-Hans": "兼容图像服务",
    "zh-Hant": "相容圖像服務",
    "en": "Compatible image service",
    "ja": "互換画像サービス"
  },
  "shell.localComfy": {
    "zh-Hans": "本机 ComfyUI",
    "zh-Hant": "本機 ComfyUI",
    "en": "Local ComfyUI",
    "ja": "ローカル ComfyUI"
  },
  "projects.openUnavailable": {
    "zh-Hans": "暂时无法打开此项目",
    "zh-Hant": "暫時無法開啟此專案",
    "en": "Cannot open this project right now",
    "ja": "現在このプロジェクトを開けません"
  },
  "projects.checkingSavedView": {
    "zh-Hans": "正在核对项目数据和已保存视图。",
    "zh-Hant": "正在核對專案資料與已儲存的檢視。",
    "en": "Checking project data and the saved view.",
    "ja": "プロジェクトデータと保存済み表示を確認しています。"
  },
  "projects.retryThis": {
    "zh-Hans": "重试打开此项目",
    "zh-Hant": "重試開啟此專案",
    "en": "Retry opening this project",
    "ja": "このプロジェクトをもう一度開く"
  },
  "projects.otherWindowPreserved": {
    "zh-Hans": "选择项目将在独立编辑窗口打开；此窗口及已接受的任务会保留。",
    "zh-Hant": "選擇的專案將在獨立編輯視窗開啟；此視窗與已接受的工作會保留。",
    "en": "The selected project opens in a separate editor window. This window and accepted tasks are retained.",
    "ja": "選んだプロジェクトは別の編集ウィンドウで開きます。このウィンドウと受理済みタスクは保持されます。"
  },
  "projects.locator": {
    "zh-Hans": "最近项目位置",
    "zh-Hant": "最近專案位置",
    "en": "Recent project location",
    "ja": "最近のプロジェクトの場所"
  },
  "projects.locatorRestoredHint": {
    "zh-Hans": "恢复分支暂不记住最近项目",
    "zh-Hant": "還原分支暫不記住最近專案",
    "en": "A restored branch does not remember the recent project",
    "ja": "復元ブランチでは最近のプロジェクトを記録しません"
  },
  "projects.locatorRestored": {
    "zh-Hans": "恢复分支不记位置",
    "zh-Hant": "還原分支不記位置",
    "en": "Location not saved in restored branch",
    "ja": "復元ブランチでは場所を保存しません"
  },
  "projects.locatorSaved": {
    "zh-Hans": "位置已记住",
    "zh-Hant": "位置已記住",
    "en": "Location saved",
    "ja": "場所を保存しました"
  },
  "projects.locatorPending": {
    "zh-Hans": "记住位置中…",
    "zh-Hant": "正在記住位置…",
    "en": "Saving location…",
    "ja": "場所を保存中…"
  },
  "projects.locatorConflict": {
    "zh-Hans": "位置记录冲突",
    "zh-Hant": "位置記錄衝突",
    "en": "Location record conflict",
    "ja": "場所の記録が競合しています"
  },
  "projects.locatorUnavailable": {
    "zh-Hans": "位置暂不可用",
    "zh-Hant": "位置暫時無法使用",
    "en": "Location unavailable",
    "ja": "場所を利用できません"
  },
  "projects.locatorUnconfirmed": {
    "zh-Hans": "位置未确认",
    "zh-Hant": "位置尚未確認",
    "en": "Location unconfirmed",
    "ja": "場所が未確認です"
  },
  "projects.locatorLoading": {
    "zh-Hans": "读取位置…",
    "zh-Hant": "正在讀取位置…",
    "en": "Loading location…",
    "ja": "場所を読み込み中…"
  },
  "projects.locatorMissing": {
    "zh-Hans": "上次项目缺失",
    "zh-Hant": "上次專案缺失",
    "en": "Previous project missing",
    "ja": "前回のプロジェクトが見つかりません"
  },
  "projects.recent": {
    "zh-Hans": "最近项目",
    "zh-Hant": "最近專案",
    "en": "Recent project",
    "ja": "最近のプロジェクト"
  },
  "projects.locatorDetails": {
    "zh-Hans": "最近项目位置详情",
    "zh-Hant": "最近專案位置詳情",
    "en": "Recent project location details",
    "ja": "最近のプロジェクトの場所の詳細"
  },
  "shell.details": {
    "zh-Hans": "详情",
    "zh-Hant": "詳情",
    "en": "Details",
    "ja": "詳細"
  },
  "projects.locatorScope": {
    "zh-Hans": "仅本工作区的位置记忆。只记住下次打开的项目位置；项目内容和片段草稿分别保存。",
    "zh-Hant": "僅記憶本工作區的位置。只記住下次開啟的專案位置；專案內容與片段草稿另行儲存。",
    "en": "Remembers a location only in this workspace, for the next project opening. Project content and clip drafts are saved separately.",
    "ja": "このワークスペースで次回開くプロジェクトの場所のみを記憶します。プロジェクト内容とクリップの下書きは別に保存されます。"
  },
  "projects.locatorUncertain": {
    "zh-Hans": "当前项目可能尚未记住。先前写入结果未确认，重新核对不会取消先前写入，也不会自动改写记录。",
    "zh-Hant": "目前專案可能尚未記住。先前寫入結果尚未確認，重新核對不會取消先前寫入，也不會自動改寫記錄。",
    "en": "The current project may not be remembered yet. The previous write is unconfirmed. Rechecking neither cancels that write nor automatically overwrites the record.",
    "ja": "現在のプロジェクトはまだ記憶されていない可能性があります。前回の書き込み結果が未確認です。再確認しても前回の書き込みの取り消しや記録の自動上書きは行いません。"
  },
  "projects.locatorWritesStopped": {
    "zh-Hans": "已停止写入，请重新载入后明确打开项目。",
    "zh-Hant": "已停止寫入，請重新載入後明確開啟專案。",
    "en": "Writing has stopped. Reload, then explicitly open a project.",
    "ja": "書き込みを停止しました。再読み込み後、明示的にプロジェクトを開いてください。"
  },
  "projects.locatorIdentityChanged": {
    "zh-Hans": "工作区或服务身份已变化，请重新载入后明确打开项目。",
    "zh-Hant": "工作區或服務身分已變更，請重新載入後明確開啟專案。",
    "en": "Workspace or service identity changed. Reload, then explicitly open a project.",
    "ja": "ワークスペースまたはサービスの識別情報が変わりました。再読み込み後、明示的にプロジェクトを開いてください。"
  },
  "projects.locatorManualOpen": {
    "zh-Hans": "仍可手动打开项目。",
    "zh-Hant": "仍可手動開啟專案。",
    "en": "You can still open projects manually.",
    "ja": "プロジェクトは手動で開けます。"
  },
  "projects.locatorRechecked": {
    "zh-Hans": "已读取服务器记录；先前未确认的写入仍保留，未恢复自动写入。",
    "zh-Hant": "已讀取伺服器記錄；先前未確認的寫入仍保留，尚未恢復自動寫入。",
    "en": "Server records were read. The earlier unconfirmed write is retained; automatic writing has not resumed.",
    "ja": "サーバーの記録を読み取りました。以前の未確認の書き込みは保持され、自動書き込みは再開していません。"
  },
  "projects.retrySameWrite": {
    "zh-Hans": "重试同一次写入",
    "zh-Hant": "重試同一次寫入",
    "en": "Retry the same write",
    "ja": "同じ書き込みを再試行"
  },
  "shell.readOnlyCheck": {
    "zh-Hans": "只读核对",
    "zh-Hant": "唯讀核對",
    "en": "Check read-only",
    "ja": "読み取り専用で確認"
  },
  "shell.checkingReadOnly": {
    "zh-Hans": "正在只读核对…",
    "zh-Hant": "正在以唯讀方式核對…",
    "en": "Checking read-only…",
    "ja": "読み取り専用で確認中…"
  },
  "projects.locatorStatus": {
    "zh-Hans": "最近项目位置：{status}",
    "zh-Hant": "最近專案位置：{status}",
    "en": "Recent project location: {status}",
    "ja": "最近のプロジェクトの場所：{status}"
  },
  "projects.locatorChecking": {
    "zh-Hans": "正在核对位置记录…",
    "zh-Hant": "正在核對位置記錄…",
    "en": "Checking location record…",
    "ja": "場所の記録を確認中…"
  },
  "projects.locatorOwner": {
    "zh-Hans": "最近项目由项目入口统一记录；查看或核对不会打开项目，也不会改写项目内容。",
    "zh-Hant": "最近專案由專案入口統一記錄；檢視或核對不會開啟專案，也不會改寫專案內容。",
    "en": "The project entry manages the recent project record. Viewing or checking it does not open a project or overwrite project content.",
    "ja": "最近のプロジェクトはプロジェクト入口で一元的に記録します。表示や確認をしても、プロジェクトを開いたり内容を上書きしたりしません。"
  },
  "projects.locatorOriginalRetained": {
    "zh-Hans": "先前写入结果未确认，原请求仍保留。重新读取不会撤销或自动重试它。",
    "zh-Hant": "先前寫入結果尚未確認，原請求仍保留。重新讀取不會撤銷或自動重試該請求。",
    "en": "The earlier write is unconfirmed and the original request is retained. Reading again does not cancel or automatically retry it.",
    "ja": "以前の書き込み結果が未確認で、元のリクエストは保持されています。再読み込みによる取り消しや自動再試行は行いません。"
  },
  "projects.locatorConflictScope": {
    "zh-Hans": "位置记录发生冲突，已停止写入。请只读核对后再明确处理，不会自动覆盖。",
    "zh-Hant": "位置記錄發生衝突，已停止寫入。請先以唯讀方式核對，再明確處理；不會自動覆寫。",
    "en": "A location record conflict stopped writing. Check read-only, then choose how to proceed. Nothing will be overwritten automatically.",
    "ja": "場所の記録が競合したため、書き込みを停止しました。読み取り専用で確認してから明示的に対応してください。自動上書きは行いません。"
  },
  "projects.locatorKeepWindow": {
    "zh-Hans": "工作区或服务身份已变化，请保留当前窗口并核对。",
    "zh-Hant": "工作區或服務身分已變更，請保留目前視窗並核對。",
    "en": "Workspace or service identity changed. Keep this window open and check.",
    "ja": "ワークスペースまたはサービスの識別情報が変わりました。このウィンドウを開いたまま確認してください。"
  },
  "projects.locatorView": {
    "zh-Hans": "查看最近项目位置记录",
    "zh-Hant": "檢視最近專案位置記錄",
    "en": "View recent project location record",
    "ja": "最近のプロジェクトの場所の記録を表示"
  },
  "projects.keepCreateOpen": {
    "zh-Hans": "新建项目的输入尚未提交。保留这些输入并打开所选项目？",
    "zh-Hant": "新增專案的輸入尚未提交。保留這些輸入並開啟所選專案？",
    "en": "New-project input has not been submitted. Keep it and open the selected project?",
    "ja": "新規プロジェクトの入力はまだ送信されていません。入力を保持して、選択したプロジェクトを開きますか？"
  },
  "projects.windowOpenFailed": {
    "zh-Hans": "窗口暂不能打开。原项目与输入已保留，请核对后明确重试。",
    "zh-Hant": "暫時無法開啟視窗。原專案與輸入已保留，請核對後明確重試。",
    "en": "The window cannot open right now. The original project and inputs are retained. Check before explicitly retrying.",
    "ja": "現在ウィンドウを開けません。元のプロジェクトと入力は保持されています。確認後に明示的に再試行してください。"
  },
  "projects.targetWindowFailed": {
    "zh-Hans": "目标编辑窗口未能完成读取，请在该窗口核对。",
    "zh-Hant": "目標編輯視窗未能完成讀取，請在該視窗核對。",
    "en": "The target editor window could not finish loading. Check that window.",
    "ja": "対象の編集ウィンドウで読み込みが完了しませんでした。そのウィンドウで確認してください。"
  },
  "projects.openOutcomeUnknown": {
    "zh-Hans": "打开窗口的结果尚未确认。请核对窗口状态；不会自动重发打开或新建请求。",
    "zh-Hant": "開啟視窗的結果尚未確認。請核對視窗狀態；不會自動重送開啟或新增請求。",
    "en": "The window-opening result is unconfirmed. Check the window status. Open or create requests will not be resent automatically.",
    "ja": "ウィンドウを開く操作の結果が未確認です。ウィンドウの状態を確認してください。「開く」や「作成」のリクエストを自動再送することはありません。"
  },
  "projects.checkCurrentRequest": {
    "zh-Hans": "请先在此窗口核对当前新建或打开请求。现有输入已保留。",
    "zh-Hant": "請先在此視窗核對目前的新增或開啟請求。現有輸入已保留。",
    "en": "First check the current create or open request in this window. Existing input is retained.",
    "ja": "まずこのウィンドウで現在の作成または開くリクエストを確認してください。入力内容は保持されています。"
  },
  "projects.keepCreateClose": {
    "zh-Hans": "新建项目的输入尚未提交。保留这些输入并关闭项目选择？",
    "zh-Hant": "新增專案的輸入尚未提交。保留這些輸入並關閉專案選擇？",
    "en": "New-project input has not been submitted. Keep it and close project selection?",
    "ja": "新規プロジェクトの入力はまだ送信されていません。入力を保持してプロジェクト選択を閉じますか？"
  },
  "projects.listUnavailable": {
    "zh-Hans": "暂时无法读取工作区项目。请核对连接后刷新；现有输入会保留。",
    "zh-Hant": "暫時無法讀取工作區專案。請核對連線後重新整理；現有輸入會保留。",
    "en": "Cannot read workspace projects right now. Check the connection and refresh. Existing input will be retained.",
    "ja": "現在ワークスペースのプロジェクトを読み取れません。接続を確認してから更新してください。入力内容は保持されます。"
  },
  "projects.changedNotCreated": {
    "zh-Hans": "窗口身份或退出状态已变化，未发起新建项目。",
    "zh-Hant": "視窗身分或結束狀態已變更，未發起新增專案。",
    "en": "Window identity or quit state changed. Project creation was not started.",
    "ja": "ウィンドウの識別情報または終了状態が変わったため、プロジェクト作成は開始していません。"
  },
  "projects.unconfirmedNotCreated": {
    "zh-Hans": "窗口身份尚未确认，未发起新建项目。请核对后明确重试。",
    "zh-Hant": "視窗身分尚未確認，未發起新增專案。請核對後明確重試。",
    "en": "Window identity is unconfirmed. Project creation was not started. Check before explicitly retrying.",
    "ja": "ウィンドウの識別情報が未確認のため、プロジェクト作成は開始していません。確認後に明示的に再試行してください。"
  },
  "projects.createRejectedRetained": {
    "zh-Hans": "新建请求未被接受。现有输入已保留，请核对后明确重试。",
    "zh-Hant": "新增請求未被接受。現有輸入已保留，請核對後明確重試。",
    "en": "The create request was not accepted. Existing input is retained. Check before explicitly retrying.",
    "ja": "作成リクエストは受理されませんでした。入力内容は保持されています。確認後に明示的に再試行してください。"
  },
  "projects.createUnknownRefresh": {
    "zh-Hans": "新建结果未确认。请保留此窗口并刷新项目列表核对；不要重复创建。",
    "zh-Hant": "新增結果尚未確認。請保留此視窗並重新整理專案清單核對；不要重複建立。",
    "en": "Creation is unconfirmed. Keep this window open and refresh the project list to check. Do not create a duplicate.",
    "ja": "作成結果が未確認です。このウィンドウを開いたままプロジェクト一覧を更新して確認してください。重複作成しないでください。"
  },
  "projects.created": {
    "zh-Hans": "项目已创建。",
    "zh-Hant": "專案已建立。",
    "en": "Project created.",
    "ja": "プロジェクトを作成しました。"
  },
  "projects.createRejected": {
    "zh-Hans": "新建请求未被接受，请核对输入后明确重试。",
    "zh-Hant": "新增請求未被接受，請核對輸入後明確重試。",
    "en": "The create request was not accepted. Check the input before explicitly retrying.",
    "ja": "作成リクエストは受理されませんでした。入力を確認してから明示的に再試行してください。"
  },
  "projects.createUnconfirmedKeep": {
    "zh-Hans": "新建结果尚未确认，请保留原窗口核对。",
    "zh-Hant": "新增結果尚未確認，請保留原視窗核對。",
    "en": "Creation is unconfirmed. Keep the original window open to check.",
    "ja": "作成結果が未確認です。元のウィンドウを開いたまま確認してください。"
  },
  "projects.invalidIdentity": {
    "zh-Hans": "项目列表或工作区身份核对无效，请保留当前窗口并重新读取。",
    "zh-Hant": "專案清單或工作區身分核對無效，請保留目前視窗並重新讀取。",
    "en": "Project list or workspace identity validation failed. Keep this window open and read again.",
    "ja": "プロジェクト一覧またはワークスペースの識別情報の検証に失敗しました。このウィンドウを開いたまま再読み込みしてください。"
  },
  "projects.checkingEditorCreateBlocked": {
    "zh-Hans": "正在核对编辑窗口，暂不能新建项目。",
    "zh-Hant": "正在核對編輯視窗，暫時無法新增專案。",
    "en": "The editor window is being checked. New projects cannot be created yet.",
    "ja": "編集ウィンドウを確認中のため、まだプロジェクトを作成できません。"
  },
  "projects.createUnknownRestart": {
    "zh-Hans": "上次新建结果未确认。请保留此窗口并刷新列表核对；重新启动后也请先核对，避免重复创建。",
    "zh-Hant": "上次新增結果尚未確認。請保留此視窗並重新整理清單核對；重新啟動後也請先核對，避免重複建立。",
    "en": "The previous creation is unconfirmed. Keep this window open and refresh the list to check. Check again after restarting to avoid duplicates.",
    "ja": "前回の作成結果が未確認です。このウィンドウを開いたまま一覧を更新して確認してください。再起動後も重複作成を避けるため、先に確認してください。"
  },
  "shell.settingsBusy": {
    "zh-Hans": "设置仍在读取、保存或核对结果。请先处理当前设置。",
    "zh-Hant": "設定仍在讀取、儲存或核對結果。請先處理目前設定。",
    "en": "Settings are still loading, saving, or checking an outcome. Resolve the current settings first.",
    "ja": "設定の読み込み、保存、または結果確認が進行中です。まず現在の設定に対応してください。"
  },
  "shell.changeConnectionConfirm": {
    "zh-Hans": "连接设置有未保存的输入。切换连接会清空尚未提交的密钥；其他草稿仍保留。继续？",
    "zh-Hant": "連線設定有尚未儲存的輸入。切換連線會清空尚未提交的金鑰；其他草稿仍保留。是否繼續？",
    "en": "Connection settings have unsaved input. Switching connections clears unsubmitted keys; other drafts are retained. Continue?",
    "ja": "接続設定に未保存の入力があります。接続を切り替えると未送信のキーは消去されますが、他の下書きは保持されます。続けますか？"
  },
  "shell.error.conflict": {
    "zh-Hans": "保存冲突：内容已在其他窗口更新。已刷新最新状态，请检查后再保存。",
    "zh-Hant": "儲存衝突：內容已在其他視窗更新。已重新整理最新狀態，請檢查後再儲存。",
    "en": "Save conflict: content changed in another window. The latest state has been refreshed. Review it before saving again.",
    "ja": "保存が競合しました。別のウィンドウで内容が更新されています。最新の状態を読み込んだので、確認してから再度保存してください。"
  },
  "shell.error.overlap": {
    "zh-Hans": "同一轨道的片段不能重叠。请调整开始帧，或移到另一条兼容轨道；你的输入仍保留。",
    "zh-Hant": "同一軌道的片段不能重疊。請調整起始影格，或移至另一條相容軌道；輸入仍保留。",
    "en": "Clips cannot overlap on the same track. Adjust the start frame or move to another compatible track. Your input is retained.",
    "ja": "同じトラック内でクリップを重ねることはできません。開始フレームを調整するか、互換性のある別のトラックへ移動してください。入力内容は保持されています。"
  },
  "shell.error.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录。",
    "zh-Hant": "工作階段已過期，請重新登入。",
    "en": "Your session expired. Sign in again.",
    "ja": "セッションの有効期限が切れました。もう一度ログインしてください。"
  },
  "shell.error.incomplete": {
    "zh-Hans": "无法确认操作结果。请检查连接并核对当前状态；若有待确认请求，请先在任务中核对原请求，不要重复提交。",
    "zh-Hant": "無法確認操作結果。請檢查連線並核對目前狀態；若有待確認請求，請先在工作中核對原請求，不要重複提交。",
    "en": "The operation’s outcome could not be confirmed. Check the connection and current state. If a request is pending, check the original request in Tasks before submitting again.",
    "ja": "操作の結果を確認できませんでした。接続と現在の状態を確認してください。未確認のリクエストがある場合は、再送信する前にタスクで元のリクエストを確認してください。"
  },
  "shell.login.invalidToken": {
    "zh-Hans": "访问令牌无效，请使用服务器配置的工作台令牌。",
    "zh-Hant": "存取權杖無效，請使用伺服器設定的工作台權杖。",
    "en": "The access token is invalid. Use the workbench token configured on the server.",
    "ja": "アクセストークンが無効です。サーバーに設定したワークベンチのトークンを使用してください。"
  },
  "shell.login.headline": {
    "zh-Hans": "让每一个想法，都有自己的镜头。",
    "zh-Hant": "讓每一個想法，都有自己的鏡頭。",
    "en": "Give every idea its own shot.",
    "ja": "すべてのアイデアに、その一場面を。"
  },
  "shell.login.description": {
    "zh-Hans": "从一张参考图出发，在无限画布中构思故事。生成、比较、编排，让灵感一步步成为影像。",
    "zh-Hant": "從一張參考圖出發，在無限畫布中構思故事。生成、比較、編排，讓靈感一步步成為影像。",
    "en": "Start with a reference image and shape your story on an infinite canvas. Generate, compare, and arrange to bring your ideas to life.",
    "ja": "1枚の参照画像から、無限のキャンバスでストーリーを構想。生成、比較、構成を重ねて、ひらめきを映像にしましょう。"
  },
  "shell.login.eyebrow": {
    "zh-Hans": "让灵感动起来",
    "zh-Hant": "讓靈感動起來",
    "en": "YOUR IDEAS, IN MOTION",
    "ja": "アイデアを、映像へ"
  },
  "shell.login.footnote": {
    "zh-Hans": "私有工作区 · 本地媒体管理 · 版本可追溯",
    "zh-Hant": "私人工作區 · 本機媒體管理 · 版本可追溯",
    "en": "Private workspace · Local media · Traceable versions",
    "ja": "プライベートなワークスペース・ローカルメディア管理・バージョン履歴"
  },
  "shell.login.title": {
    "zh-Hans": "进入你的影像工作台",
    "zh-Hant": "進入你的影像工作台",
    "en": "Enter your video workbench",
    "ja": "映像ワークベンチに入る"
  },
  "shell.login.hint": {
    "zh-Hans": "使用工作台访问令牌登录。令牌仅用于建立安全会话。",
    "zh-Hant": "使用工作台存取權杖登入。權杖僅用於建立安全的工作階段。",
    "en": "Sign in with your workbench access token. It is used only to establish a secure session.",
    "ja": "ワークベンチのアクセストークンでログインします。トークンは安全なセッションの確立にのみ使用します。"
  },
  "shell.login.token": {
    "zh-Hans": "访问令牌",
    "zh-Hant": "存取權杖",
    "en": "Access token",
    "ja": "アクセストークン"
  },
  "shell.login.placeholder": {
    "zh-Hans": "输入工作台令牌",
    "zh-Hant": "輸入工作台權杖",
    "en": "Enter workbench token",
    "ja": "ワークベンチのトークンを入力"
  },
  "shell.login.enter": {
    "zh-Hans": "进入工作台",
    "zh-Hant": "進入工作台",
    "en": "Enter workbench",
    "ja": "ワークベンチに入る"
  },
  "shell.login.secrets": {
    "zh-Hans": "服务商 API 密钥始终留在服务器",
    "zh-Hant": "服務商 API 金鑰始終留在伺服器",
    "en": "Provider API keys stay on the server",
    "ja": "サービス提供元の API キーはサーバーに保持されます"
  },
  "shell.closeDialog": {
    "zh-Hans": "关闭对话框",
    "zh-Hant": "關閉對話框",
    "en": "Close dialog",
    "ja": "ダイアログを閉じる"
  },
  "projects.comparison.title": {
    "zh-Hans": "版本对比",
    "zh-Hant": "版本比較",
    "en": "Compare versions",
    "ja": "バージョン比較"
  },
  "projects.comparison.noPrompt": {
    "zh-Hans": "没有画面描述",
    "zh-Hant": "沒有畫面描述",
    "en": "No visual description",
    "ja": "映像の説明がありません"
  },
  "projects.comparison.current": {
    "zh-Hans": "当前选用版本",
    "zh-Hant": "目前選用版本",
    "en": "Currently selected version",
    "ja": "現在選択中のバージョン"
  },
  "projects.comparison.scope": {
    "zh-Hans": "选用版本更新镜头预览与后续分镜导出；已有时间线片段和导出文件保持独立。",
    "zh-Hant": "選用版本會更新鏡頭預覽與後續分鏡匯出；既有時間軸片段與匯出檔案保持獨立。",
    "en": "Selecting a version updates the shot preview and future storyboard exports. Existing timeline clips and exported files remain independent.",
    "ja": "バージョンを選ぶとショットのプレビューと以降のストーリーボード書き出しが更新されます。既存のタイムラインクリップと書き出しファイルは変更されません。"
  },
  "projects.newStoryHint": {
    "zh-Hans": "为这次创作命名，随时可以继续回来。",
    "zh-Hant": "為這次創作命名，隨時可以回來繼續。",
    "en": "Name your creation. You can return to it anytime.",
    "ja": "作品に名前を付けましょう。いつでも戻って制作を続けられます。"
  },
  "projects.create": {
    "zh-Hans": "创建项目",
    "zh-Hant": "建立專案",
    "en": "Create project",
    "ja": "プロジェクトを作成"
  },
  "shell.confirm.switchWorkspace": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并切换工作区？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並切換工作區？",
    "en": "This panel has unsaved changes. Discard them and switch workspaces?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してワークスペースを切り替えますか？"
  },
  "shell.settingsBusyRetained": {
    "zh-Hans": "连接设置仍在读取、保存或核对结果。请先在设置页处理，当前页面已保留。",
    "zh-Hant": "連線設定仍在讀取、儲存或核對結果。請先在設定頁處理，目前頁面已保留。",
    "en": "Connection settings are still loading, saving, or checking an outcome. Resolve them in settings first. This page is retained.",
    "ja": "接続設定の読み込み、保存、または結果確認が進行中です。まず設定ページで対応してください。現在のページは保持されています。"
  },
  "shell.confirm.leaveConnections": {
    "zh-Hans": "连接设置有未保存的输入。离开会放弃这些连接输入，新输入的密钥会清空；不会保存设置或发送生成请求。继续？",
    "zh-Hant": "連線設定有尚未儲存的輸入。離開會放棄這些連線輸入，並清空新輸入的金鑰；不會儲存設定或傳送生成請求。是否繼續？",
    "en": "Connection settings have unsaved input. Leaving discards these inputs and clears newly entered keys. It does not save settings or send generation requests. Continue?",
    "ja": "接続設定に未保存の入力があります。離れると接続入力が破棄され、新しく入力したキーが消去されます。設定の保存や生成リクエストの送信は行いません。続けますか？"
  },
  "shell.error.restoreIdentity": {
    "zh-Hans": "恢复工作区来源与本次打开不一致。",
    "zh-Hant": "還原工作區來源與本次開啟不一致。",
    "en": "The restored workspace origin does not match this opening request.",
    "ja": "復元ワークスペースのソースが今回の開くリクエストと一致しません。"
  },
  "shell.error.projectIdentity": {
    "zh-Hans": "项目返回身份与本次打开不一致。",
    "zh-Hant": "傳回的專案身分與本次開啟不一致。",
    "en": "The returned project identity does not match this opening request.",
    "ja": "返されたプロジェクトの識別情報が今回の開くリクエストと一致しません。"
  },
  "shell.confirm.switchProject": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并打开另一个项目？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並開啟其他專案？",
    "en": "This panel has unsaved changes. Discard them and open another project?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄して別のプロジェクトを開きますか？"
  },
  "shell.error.viewNotReady": {
    "zh-Hans": "项目视图尚未完成载入，请重试打开。",
    "zh-Hant": "專案檢視尚未載入完成，請重試開啟。",
    "en": "The project view has not finished loading. Try opening it again.",
    "ja": "プロジェクト表示の読み込みが完了していません。もう一度開いてください。"
  },
  "shell.error.selectionNotReady": {
    "zh-Hans": "项目尚未完成当前选择的数据核对，请重试打开。",
    "zh-Hant": "專案尚未完成目前選擇的資料核對，請重試開啟。",
    "en": "Project data has not been verified for the current selection. Try opening it again.",
    "ja": "現在の選択に対するプロジェクトデータの確認が完了していません。もう一度開いてください。"
  },
  "shell.confirm.loadSavedView": {
    "zh-Hans": "载入已保存视图会替换当前的工作区、选择和位置。继续？",
    "zh-Hant": "載入已儲存的檢視會取代目前的工作區、選擇與位置。是否繼續？",
    "en": "Loading the saved view replaces the current workspace view, selection, and position. Continue?",
    "ja": "保存済みの表示を読み込むと、現在のワークスペース表示、選択、位置が置き換わります。続けますか？"
  },
  "shell.pendingKeepWindow": {
    "zh-Hans": "当前窗口仍有处理中或结果未知的请求。请先在原面板核对；显示项目首页不会关闭此窗口。",
    "zh-Hant": "目前視窗仍有處理中或結果未知的請求。請先在原面板核對；顯示專案首頁不會關閉此視窗。",
    "en": "This window has requests in progress or with unknown outcomes. Check them in the original panel first. Showing project home will not close this window.",
    "ja": "このウィンドウに処理中または結果不明のリクエストがあります。まず元のパネルで確認してください。プロジェクトホームを表示しても、このウィンドウは閉じません。"
  },
  "shell.error.projectChanged": {
    "zh-Hans": "项目已变化，已阻止旧面板提交。",
    "zh-Hant": "專案已變更，已阻止舊面板提交。",
    "en": "The project changed. Submission from the old panel was blocked.",
    "ja": "プロジェクトが変わったため、以前のパネルからの送信をブロックしました。"
  },
  "shell.error.previousSessionPending": {
    "zh-Hans": "旧会话有请求待确认。请先在任务中心恢复原请求或明确转存，草稿仍保留。",
    "zh-Hant": "舊工作階段有請求待確認。請先在工作中心還原原請求或明確轉存，草稿仍保留。",
    "en": "A previous session has a request awaiting confirmation. Restore the original request or explicitly transfer it in the task center first. Your draft is retained.",
    "ja": "以前のセッションに確認待ちのリクエストがあります。まずタスクセンターで元のリクエストを復元するか、明示的に移管してください。下書きは保持されています。"
  },
  "shell.error.notApplied": {
    "zh-Hans": "服务器已确认此请求未应用。草稿仍保留，请核对最新状态后重新编辑。",
    "zh-Hant": "伺服器已確認此請求尚未套用。草稿仍保留，請核對最新狀態後重新編輯。",
    "en": "The server confirmed this request was not applied. Your draft is retained. Check the latest state before editing again.",
    "ja": "このリクエストが未適用であることをサーバーが確認しました。下書きは保持されています。最新の状態を確認してから再編集してください。"
  },
  "shell.requestSaved": {
    "zh-Hans": "原请求已保存到任务中心，请明确恢复后继续编辑。",
    "zh-Hant": "原請求已儲存至工作中心，請明確還原後再繼續編輯。",
    "en": "The original request was saved to the task center. Explicitly restore it before continuing to edit.",
    "ja": "元のリクエストをタスクセンターに保存しました。明示的に復元してから編集を続けてください。"
  },
  "shell.error.editAcknowledgement": {
    "zh-Hans": "未收到完整的编辑确认，请在任务中心核对原请求。",
    "zh-Hant": "未收到完整的編輯確認，請在工作中心核對原請求。",
    "en": "No complete edit acknowledgement was received. Check the original request in the task center.",
    "ja": "完全な編集の確認応答を受信できませんでした。タスクセンターで元のリクエストを確認してください。"
  },
  "shell.editOutcomeUnknown": {
    "zh-Hans": "提交结果仍需确认。原请求已保留，请在任务中心恢复同一请求；不会自动重试。",
    "zh-Hant": "提交結果仍需確認。原請求已保留，請在工作中心還原同一請求；不會自動重試。",
    "en": "The submission outcome still needs confirmation. The original request is retained. Restore that same request in the task center; it will not be retried automatically.",
    "ja": "送信結果の確認が必要です。元のリクエストは保持されています。タスクセンターで同じリクエストを復元してください。自動再試行は行いません。"
  },
  "shell.requestApplied": {
    "zh-Hans": "原请求已确认应用。已刷新当前项目，未替换面板草稿。",
    "zh-Hant": "原請求已確認套用。已重新整理目前專案，未取代面板草稿。",
    "en": "The original request is confirmed applied. The current project was refreshed without replacing panel drafts.",
    "ja": "元のリクエストの適用を確認しました。パネルの下書きは置き換えず、現在のプロジェクトを更新しました。"
  },
  "shell.requestNotApplied": {
    "zh-Hans": "原请求已确认未应用，可以核对草稿后重新编辑。",
    "zh-Hant": "原請求已確認尚未套用，可核對草稿後重新編輯。",
    "en": "The original request is confirmed not applied. Review your draft before editing again.",
    "ja": "元のリクエストが未適用であることを確認しました。下書きを確認してから再編集できます。"
  },
  "shell.requestStillUnknown": {
    "zh-Hans": "原请求结果仍待确认，恢复记录继续保留。",
    "zh-Hant": "原請求結果仍待確認，還原記錄會繼續保留。",
    "en": "The original request outcome is still unconfirmed. Its recovery record is retained.",
    "ja": "元のリクエストの結果は引き続き未確認です。復元記録は保持されます。"
  },
  "shell.error.sessionChanged": {
    "zh-Hans": "会话请求已变化，旧记录未清除。请核对任务中心。",
    "zh-Hant": "工作階段請求已變更，舊記錄未清除。請核對工作中心。",
    "en": "The session request changed. The old record was not cleared. Check the task center.",
    "ja": "セッションのリクエストが変わりました。古い記録は消去していません。タスクセンターで確認してください。"
  },
  "shell.requestTransferred": {
    "zh-Hans": "原编号与完整参数已转存到本地任务数据库。转存本身没有执行编辑，请明确核对并恢复原请求。",
    "zh-Hant": "原編號與完整參數已轉存至本機工作資料庫。轉存本身未執行編輯，請明確核對並還原原請求。",
    "en": "The original ID and full parameters were transferred to the local task database. Transfer alone did not execute an edit. Explicitly check and restore the original request.",
    "ja": "元のIDとすべてのパラメーターをローカルのタスクデータベースに移しました。移管自体では編集を実行していません。明示的に確認して元のリクエストを復元してください。"
  },
  "shell.shotTextFirst": {
    "zh-Hans": "请先核对或保存镜头文字；其他编辑请求不会被文字确认清除。",
    "zh-Hant": "請先核對或儲存鏡頭文字；文字確認不會清除其他編輯請求。",
    "en": "Check or save the shot text first. Text acknowledgement does not clear other edit requests.",
    "ja": "まずショットのテキストを確認または保存してください。テキストの確認応答によって他の編集リクエストが消去されることはありません。"
  },
  "shell.error.oldPanelRequest": {
    "zh-Hans": "项目已变化，已阻止旧面板提交。请回到原项目的任务面板核对请求。",
    "zh-Hant": "專案已變更，已阻止舊面板提交。請回到原專案的工作面板核對請求。",
    "en": "The project changed, so submission from the old panel was blocked. Check the request in the original project’s task panel.",
    "ja": "プロジェクトが変わったため、以前のパネルからの送信をブロックしました。元のプロジェクトのタスクパネルでリクエストを確認してください。"
  },
  "shell.error.subjectRetryChanged": {
    "zh-Hans": "主体重试的原请求已变化或缺失，已阻止恢复；不会重新创建请求。",
    "zh-Hant": "主體重試的原請求已變更或缺失，已阻止還原；不會重新建立請求。",
    "en": "The original subject-retry request changed or is missing. Recovery was blocked; no request will be recreated.",
    "ja": "被写体の再試行の元リクエストが変更されたか見つからないため、復元をブロックしました。リクエストは再作成しません。"
  },
  "shell.error.subjectRetryPending": {
    "zh-Hans": "主体重试有原请求待确认，请先在任务中心核对同一请求。",
    "zh-Hant": "主體重試有原請求待確認，請先在工作中心核對同一請求。",
    "en": "An original subject-retry request awaits confirmation. Check that same request in the task center first.",
    "ja": "被写体の再試行に確認待ちの元リクエストがあります。まずタスクセンターで同じリクエストを確認してください。"
  },
  "shell.error.subjectGenerationPending": {
    "zh-Hans": "主体生成有原请求待确认，请先在任务中心核对；不会提交新选择或自动重试原请求。",
    "zh-Hant": "主體生成有原請求待確認，請先在工作中心核對；不會提交新選擇或自動重試原請求。",
    "en": "An original subject-generation request awaits confirmation. Check it in the task center first. No new selection will be submitted and the original request will not be retried automatically.",
    "ja": "被写体生成に確認待ちの元リクエストがあります。まずタスクセンターで確認してください。新しい選択の送信や元リクエストの自動再試行は行いません。"
  },
  "shell.error.operationMismatch": {
    "zh-Hans": "原请求操作不一致，已阻止提交。请先核对任务面板中的原请求。",
    "zh-Hant": "原請求操作不一致，已阻止提交。請先核對工作面板中的原請求。",
    "en": "The original request operation does not match. Submission was blocked. Check the original request in the task panel first.",
    "ja": "元のリクエストの操作が一致しないため、送信をブロックしました。まずタスクパネルで元のリクエストを確認してください。"
  },
  "shell.error.ownerMismatch": {
    "zh-Hans": "原请求所属项目不一致，已阻止提交。请先核对原项目的任务记录。",
    "zh-Hant": "原請求所屬專案不一致，已阻止提交。請先核對原專案的工作記錄。",
    "en": "The original request’s project does not match. Submission was blocked. Check the original project’s task record first.",
    "ja": "元のリクエストのプロジェクトが一致しないため、送信をブロックしました。まず元のプロジェクトのタスク記録を確認してください。"
  },
  "shell.error.timelineAcknowledgement": {
    "zh-Hans": "未收到与原请求一致的时间线确认。",
    "zh-Hant": "未收到與原請求一致的時間軸確認。",
    "en": "No timeline acknowledgement matching the original request was received.",
    "ja": "元のリクエストと一致するタイムラインの確認応答を受信できませんでした。"
  },
  "shell.error.referenceAcknowledgement": {
    "zh-Hans": "未收到与原请求一致的首帧参考确认。",
    "zh-Hant": "未收到與原請求一致的首幀參考確認。",
    "en": "No first-frame reference acknowledgement matching the original request was received.",
    "ja": "元のリクエストと一致する開始フレーム参照の確認応答を受信できませんでした。"
  },
  "shell.error.subjectAcknowledgement": {
    "zh-Hans": "主体生成确认与原请求的固定图片不一致。原请求保留，请在任务中心核对。",
    "zh-Hant": "主體生成確認與原請求的固定圖片不一致。原請求會保留，請在工作中心核對。",
    "en": "The subject-generation acknowledgement does not match the original request’s fixed images. The original request is retained. Check the task center.",
    "ja": "被写体生成の確認応答が元のリクエストの固定画像と一致しません。元のリクエストは保持されています。タスクセンターで確認してください。"
  },
  "shell.error.retryAcknowledgement": {
    "zh-Hans": "主体重试确认与原任务的固定快照不一致。原请求保留，请在任务中心核对。",
    "zh-Hant": "主體重試確認與原工作的固定快照不一致。原請求會保留，請在工作中心核對。",
    "en": "The subject-retry acknowledgement does not match the original task’s fixed snapshot. The original request is retained. Check the task center.",
    "ja": "被写体の再試行の確認応答が元のタスクの固定スナップショットと一致しません。元のリクエストは保持されています。タスクセンターで確認してください。"
  },
  "shell.submissionUnknown": {
    "zh-Hans": "提交结果尚未确认。原请求已保留，请在任务面板恢复同一请求；不会自动重试或生成新的提交编号。",
    "zh-Hant": "提交結果尚未確認。原請求已保留，請在工作面板還原同一請求；不會自動重試或產生新的提交編號。",
    "en": "Submission is unconfirmed. The original request is retained. Restore that same request in the task panel. There will be no automatic retry or new submission ID.",
    "ja": "送信結果が未確認です。元のリクエストは保持されています。タスクパネルで同じリクエストを復元してください。自動再試行や新しい送信IDの作成は行いません。"
  },
  "shell.confirm.viewCanvasSource": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并查看画板来源？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並檢視畫板來源？",
    "en": "This panel has unsaved changes. Discard them and view the canvas source?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してキャンバスのソースを表示しますか？"
  },
  "shell.generationCheckText": {
    "zh-Hans": "请先核对目标镜头的本地文字，保存或处理记录后再次明确点击生成。不会自动继续生成。",
    "zh-Hant": "請先核對目標鏡頭的本機文字，儲存或處理記錄後，再次明確點選生成。不會自動繼續生成。",
    "en": "Check the target shot’s local text first. Save or resolve its records, then explicitly click Generate again. Generation will not continue automatically.",
    "ja": "まず対象ショットのローカルテキストを確認してください。保存または記録の処理後、明示的にもう一度「生成」をクリックしてください。生成が自動で続行されることはありません。"
  },
  "shell.generationBillingUnknown": {
    "zh-Hans": "此镜头存在状态未知的提交，服务商可能已经计费。请先核实任务状态，不要重复提交。",
    "zh-Hant": "此鏡頭有狀態未知的提交，服務商可能已經計費。請先核實工作狀態，不要重複提交。",
    "en": "This shot has a submission with unknown status. The provider may already have billed you. Verify the task status first; do not submit again.",
    "ja": "このショットには状態不明の送信があり、サービス提供元ですでに課金されている可能性があります。まずタスクの状態を確認し、重複送信しないでください。"
  },
  "shell.error.retrySnapshotChanged": {
    "zh-Hans": "原主体任务快照缺失或变化，已阻止重试。请重新读取原任务。",
    "zh-Hant": "原主體工作快照缺失或變更，已阻止重試。請重新讀取原工作。",
    "en": "The original subject-task snapshot is missing or changed. Retry was blocked. Read the original task again.",
    "ja": "元の被写体タスクのスナップショットが見つからないか変更されたため、再試行をブロックしました。元のタスクを再読み込みしてください。"
  },
  "shell.retryCreated": {
    "zh-Hans": "已基于原始快照创建重试任务",
    "zh-Hant": "已依據原始快照建立重試工作",
    "en": "Retry task created from the original snapshot",
    "ja": "元のスナップショットから再試行タスクを作成しました"
  },
  "shell.generationUnconfirmed": {
    "zh-Hans": "提交结果待确认。请查看任务状态，不要重复提交。",
    "zh-Hant": "提交結果待確認。請檢視工作狀態，不要重複提交。",
    "en": "Submission awaits confirmation. Check the task status; do not submit again.",
    "ja": "送信結果は確認待ちです。タスクの状態を確認し、重複送信しないでください。"
  },
  "shell.generationSubmitted": {
    "zh-Hans": "生成任务已提交，完成后会保存为新版本。",
    "zh-Hant": "生成工作已提交，完成後會儲存為新版本。",
    "en": "Generation task submitted. It will be saved as a new version when complete.",
    "ja": "生成タスクを送信しました。完了すると新しいバージョンとして保存されます。"
  },
  "shell.generationInputsChanged": {
    "zh-Hans": "镜头、参考素材或当前工作区已变化，请重新检查固定主体图片或完整首尾帧后确认生成。",
    "zh-Hant": "鏡頭、參考素材或目前工作區已變更，請重新檢查固定主體圖片或完整首尾幀後確認生成。",
    "en": "The shot, reference assets, or current workspace changed. Recheck the fixed subject images or complete first and last frames before confirming generation.",
    "ja": "ショット、参照素材、または現在のワークスペースが変わりました。固定された被写体画像、または開始・終了フレーム一式を再確認してから生成を承認してください。"
  },
  "projects.previousCreateKeep": {
    "zh-Hans": "上次新建项目的结果尚未确认。请保留当前窗口并核对项目列表，不要重复创建。",
    "zh-Hant": "上次新增專案的結果尚未確認。請保留目前視窗並核對專案清單，不要重複建立。",
    "en": "The previous project creation is unconfirmed. Keep this window open and check the project list; do not create a duplicate.",
    "ja": "前回のプロジェクト作成結果が未確認です。このウィンドウを開いたまま一覧を確認し、重複作成しないでください。"
  },
  "shell.confirm.createProject": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并新建项目？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並新增專案？",
    "en": "This panel has unsaved changes. Discard them and create a new project?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄して新規プロジェクトを作成しますか？"
  },
  "projects.createdImportHint": {
    "zh-Hans": "项目已创建。导入素材，开始你的第一个镜头。",
    "zh-Hant": "專案已建立。匯入素材，開始你的第一個鏡頭。",
    "en": "Project created. Import assets and start your first shot.",
    "ja": "プロジェクトを作成しました。素材を読み込んで、最初のショットを作りましょう。"
  },
  "projects.maybeCreated": {
    "zh-Hans": "项目可能已创建。请刷新项目列表核对，不要直接重复创建。",
    "zh-Hant": "專案可能已建立。請重新整理專案清單核對，不要直接重複建立。",
    "en": "The project may have been created. Refresh the project list to check; do not immediately create it again.",
    "ja": "プロジェクトは作成済みの可能性があります。一覧を更新して確認し、そのまま重複作成しないでください。"
  },
  "shell.confirm.createShot": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并创建镜头？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並建立鏡頭？",
    "en": "This panel has unsaved changes. Discard them and create a shot?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してショットを作成しますか？"
  },
  "shell.confirm.createStructure": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并创建镜头结构？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並建立鏡頭結構？",
    "en": "This panel has unsaved changes. Discard them and create a shot structure?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してショット構成を作成しますか？"
  },
  "projects.default.establish": {
    "zh-Hans": "建立场景",
    "zh-Hant": "建立場景",
    "en": "Set the scene",
    "ja": "シーンを描く"
  },
  "projects.default.develop": {
    "zh-Hans": "展开故事",
    "zh-Hant": "展開故事",
    "en": "Develop the story",
    "ja": "ストーリーを展開"
  },
  "projects.default.resolve": {
    "zh-Hans": "留下余韵",
    "zh-Hant": "留下餘韻",
    "en": "Leave an impression",
    "ja": "余韻を残す"
  },
  "projects.structureReady": {
    "zh-Hans": "三个镜头已准备好，逐个写下画面描述。",
    "zh-Hant": "三個鏡頭已準備好，請逐一寫下畫面描述。",
    "en": "Three shots are ready. Add a visual description for each.",
    "ja": "3つのショットを用意しました。それぞれの映像の説明を入力してください。"
  },
  "shell.confirm.addCanvas": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并添加到画板？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並新增至畫板？",
    "en": "This panel has unsaved changes. Discard them and add to the canvas?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してキャンバスに追加しますか？"
  },
  "projects.default.note": {
    "zh-Hans": "创作笔记",
    "zh-Hant": "創作筆記",
    "en": "Creative notes",
    "ja": "制作メモ"
  },
  "shell.error.fileContent": {
    "zh-Hans": "无法读取文件内容，请检查文件。",
    "zh-Hant": "無法讀取檔案內容，請檢查檔案。",
    "en": "Cannot read the file contents. Check the file.",
    "ja": "ファイルの内容を読み取れません。ファイルを確認してください。"
  },
  "shell.error.fileAccess": {
    "zh-Hans": "无法读取文件，请检查文件是否可访问。",
    "zh-Hant": "無法讀取檔案，請檢查是否可存取檔案。",
    "en": "Cannot read the file. Check that it is accessible.",
    "ja": "ファイルを読み取れません。アクセス可能か確認してください。"
  },
  "shell.error.fileAborted": {
    "zh-Hans": "文件读取已中止。",
    "zh-Hant": "檔案讀取已中止。",
    "en": "File reading was aborted.",
    "ja": "ファイルの読み取りが中止されました。"
  },
  "shell.error.importAcknowledgement": {
    "zh-Hans": "未收到有效导入确认。",
    "zh-Hant": "未收到有效的匯入確認。",
    "en": "No valid import acknowledgement was received.",
    "ja": "有効な読み込みの確認応答を受信できませんでした。"
  },
  "projects.shotSaved": {
    "zh-Hans": "镜头已保存",
    "zh-Hant": "鏡頭已儲存",
    "en": "Shot saved",
    "ja": "ショットを保存しました"
  },
  "projects.nodeSaved": {
    "zh-Hans": "节点已保存",
    "zh-Hant": "節點已儲存",
    "en": "Node saved",
    "ja": "ノードを保存しました"
  },
  "shell.shotTextPending": {
    "zh-Hans": "镜头文字尚待保存或核对。请先处理右侧文字记录，再保存其他设置、连接或生成。",
    "zh-Hant": "鏡頭文字尚待儲存或核對。請先處理右側文字記錄，再儲存其他設定、連線或生成。",
    "en": "Shot text still needs saving or checking. Resolve the text record on the right before saving other settings, connecting, or generating.",
    "ja": "ショットのテキストの保存または確認が必要です。右側のテキスト記録を処理してから、他の設定の保存、接続、生成を行ってください。"
  },
  "shell.referenceRecoveryPending": {
    "zh-Hans": "首帧请求恢复状态尚未确认。请先在任务中心核对，再保存、连接或生成。",
    "zh-Hant": "首幀請求還原狀態尚未確認。請先在工作中心核對，再儲存、連線或生成。",
    "en": "The first-frame request recovery state is unconfirmed. Check the task center before saving, connecting, or generating.",
    "ja": "開始フレームのリクエストの復元状態が未確認です。保存、接続、生成を行う前にタスクセンターで確認してください。"
  },
  "shell.projectEditPending": {
    "zh-Hans": "此项目有编辑请求待确认。草稿仍保留；请先在任务面板恢复原请求，再保存、连接或生成。",
    "zh-Hant": "此專案有編輯請求待確認。草稿仍保留；請先在工作面板還原原請求，再儲存、連線或生成。",
    "en": "This project has an edit request awaiting confirmation. Your draft is retained. Restore the original request in the task panel before saving, connecting, or generating.",
    "ja": "このプロジェクトに確認待ちの編集リクエストがあります。下書きは保持されています。タスクパネルで元のリクエストを復元してから、保存、接続、生成を行ってください。"
  },
  "shell.referenceSyncing": {
    "zh-Hans": "首帧连接正在同步，请稍候。",
    "zh-Hant": "首幀連線正在同步，請稍候。",
    "en": "The first-frame connection is syncing. Please wait.",
    "ja": "開始フレームの接続を同期中です。お待ちください。"
  },
  "shell.referencePending": {
    "zh-Hans": "首帧连接的结果尚未确认。请先在任务面板恢复同一请求，再保存或生成。",
    "zh-Hant": "首幀連線的結果尚未確認。請先在工作面板還原同一請求，再儲存或生成。",
    "en": "The first-frame connection outcome is unconfirmed. Restore that same request in the task panel before saving or generating.",
    "ja": "開始フレーム接続の結果が未確認です。タスクパネルで同じリクエストを復元してから、保存や生成を行ってください。"
  },
  "shell.referenceSaveBeforeConnect": {
    "zh-Hans": "请先保存或放弃当前面板的修改，再连接首帧。你的输入仍保留。",
    "zh-Hant": "請先儲存或放棄目前面板的修改，再連接首幀。輸入仍保留。",
    "en": "Save or discard this panel’s changes before connecting the first frame. Your input is retained.",
    "ja": "開始フレームを接続する前に、このパネルの変更を保存または破棄してください。入力内容は保持されています。"
  },
  "shell.referenceConnected": {
    "zh-Hans": "已连接首帧参考图。生成将使用这张图片。",
    "zh-Hant": "已連接首幀參考圖。生成將使用這張圖片。",
    "en": "First-frame reference connected. Generation will use this image.",
    "ja": "開始フレームの参照画像を接続しました。生成にはこの画像を使用します。"
  },
  "shell.referenceSaveBeforeDisconnect": {
    "zh-Hans": "请先保存或放弃当前面板的修改，再断开首帧。你的输入仍保留。",
    "zh-Hant": "請先儲存或放棄目前面板的修改，再中斷首幀連線。輸入仍保留。",
    "en": "Save or discard this panel’s changes before disconnecting the first frame. Your input is retained.",
    "ja": "開始フレームの接続を解除する前に、このパネルの変更を保存または破棄してください。入力内容は保持されています。"
  },
  "shell.referenceDisconnected": {
    "zh-Hans": "首帧连接已断开，原始素材与图片节点已保留。",
    "zh-Hant": "首幀連線已中斷，原始素材與圖片節點已保留。",
    "en": "First-frame connection removed. The original asset and image node are retained.",
    "ja": "開始フレームの接続を解除しました。元の素材と画像ノードは保持されています。"
  },
  "shell.differentNodes": {
    "zh-Hans": "请选择两个不同的节点。",
    "zh-Hant": "請選擇兩個不同的節點。",
    "en": "Choose two different nodes.",
    "ja": "異なる2つのノードを選択してください。"
  },
  "shell.referencePortHint": {
    "zh-Hans": "请将图片的绿色首帧输出连接到镜头的绿色首帧输入。灰色端口仅用于视觉连线。",
    "zh-Hant": "請將圖片的綠色首幀輸出連接至鏡頭的綠色首幀輸入。灰色連接埠僅用於視覺連線。",
    "en": "Connect the image’s green first-frame output to the shot’s green first-frame input. Gray ports are only for visual links.",
    "ja": "画像の緑色の開始フレーム出力を、ショットの緑色の開始フレーム入力へ接続してください。灰色のポートは視覚的なリンク専用です。"
  },
  "shell.visualLinkAdded": {
    "zh-Hans": "已添加视觉连线，不会改变生成输入。",
    "zh-Hant": "已新增視覺連線，不會變更生成輸入。",
    "en": "Visual link added. Generation inputs are unchanged.",
    "ja": "視覚的なリンクを追加しました。生成入力は変わりません。"
  },
  "shell.referenceDisconnectHint": {
    "zh-Hans": "首帧参考需要在镜头设置中明确断开；选中连线后可打开目标镜头。",
    "zh-Hant": "首幀參考須在鏡頭設定中明確中斷；選取連線後可開啟目標鏡頭。",
    "en": "Disconnect first-frame references explicitly in shot settings. Select the link to open its target shot.",
    "ja": "開始フレーム参照はショット設定で明示的に解除してください。リンクを選択すると対象のショットを開けます。"
  },
  "projects.versionUpdated": {
    "zh-Hans": "已更新当前选用版本",
    "zh-Hant": "已更新目前選用版本",
    "en": "Selected version updated",
    "ja": "選択中のバージョンを更新しました"
  },
  "projects.storyboardReordered": {
    "zh-Hans": "分镜顺序已更新，画布位置保持独立",
    "zh-Hant": "分鏡順序已更新，畫布位置保持獨立",
    "en": "Storyboard order updated. Canvas positions are unchanged.",
    "ja": "ストーリーボードの順序を更新しました。キャンバス上の位置は変わりません。"
  },
  "shell.confirm.viewTaskShot": {
    "zh-Hans": "当前面板有未保存的修改。放弃修改并查看任务镜头？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並檢視工作鏡頭？",
    "en": "This panel has unsaved changes. Discard them and view the task’s shot?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してタスクのショットを表示しますか？"
  },
  "shell.storyboardExportCreated": {
    "zh-Hans": "导出任务已创建，将按分镜板顺序拼接选用版本。",
    "zh-Hant": "匯出工作已建立，將依分鏡板順序拼接選用版本。",
    "en": "Export task created. Selected versions will be joined in storyboard order.",
    "ja": "書き出しタスクを作成しました。選択したバージョンをストーリーボードの順序で連結します。"
  },
  "shell.confirm.locateClip": {
    "zh-Hans": "当前面板有未保存修改。放弃修改并定位此素材的时间线片段？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並定位此素材的時間軸片段？",
    "en": "This panel has unsaved changes. Discard them and locate this asset’s timeline clip?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してこの素材のタイムラインクリップへ移動しますか？"
  },
  "shell.timelineFormatSaved": {
    "zh-Hans": "时间线输出规格已保存。",
    "zh-Hant": "時間軸輸出規格已儲存。",
    "en": "Timeline output format saved.",
    "ja": "タイムラインの出力形式を保存しました。"
  },
  "shell.error.formatAcknowledgement": {
    "zh-Hans": "规格确认与本次请求不一致。",
    "zh-Hant": "規格確認與本次請求不一致。",
    "en": "The format acknowledgement does not match this request.",
    "ja": "出力形式の確認応答が今回のリクエストと一致しません。"
  },
  "shell.subtitleSaved": {
    "zh-Hans": "字幕已保存；请重新渲染以查看最新画面。",
    "zh-Hant": "字幕已儲存；請重新算圖以查看最新畫面。",
    "en": "Subtitles saved. Render again to see the latest result.",
    "ja": "字幕を保存しました。最新の映像を見るには再レンダリングしてください。"
  },
  "shell.error.subtitleAcknowledgement": {
    "zh-Hans": "字幕确认与原请求不一致。",
    "zh-Hant": "字幕確認與原請求不一致。",
    "en": "The subtitle acknowledgement does not match the original request.",
    "ja": "字幕の確認応答が元のリクエストと一致しません。"
  },
  "shell.subtitlePending": {
    "zh-Hans": "请先在任务中心核对原字幕请求，草稿仍保留。",
    "zh-Hant": "請先在工作中心核對原字幕請求，草稿仍保留。",
    "en": "Check the original subtitle request in the task center first. Your draft is retained.",
    "ja": "まずタスクセンターで元の字幕リクエストを確認してください。下書きは保持されています。"
  },
  "shell.confirm.changeSubtitle": {
    "zh-Hans": "字幕有未保存修改。放弃此字幕草稿并选择另一条？",
    "zh-Hant": "字幕有尚未儲存的修改。放棄此字幕草稿並選擇另一條？",
    "en": "This subtitle has unsaved changes. Discard its draft and choose another subtitle?",
    "ja": "字幕に未保存の変更があります。この字幕の下書きを破棄して別の字幕を選択しますか？"
  },
  "shell.error.replacementAcknowledgement": {
    "zh-Hans": "替换确认与本次核对不一致。",
    "zh-Hant": "取代確認與本次核對不一致。",
    "en": "The replacement acknowledgement does not match this review.",
    "ja": "置き換えの確認応答が今回の確認内容と一致しません。"
  },
  "shell.timelinePending": {
    "zh-Hans": "上一条时间线操作的结果尚未确认。请先恢复同一请求，再继续编辑。",
    "zh-Hant": "上一個時間軸操作的結果尚未確認。請先還原同一請求，再繼續編輯。",
    "en": "The previous timeline operation is unconfirmed. Restore that same request before continuing to edit.",
    "ja": "前のタイムライン操作の結果が未確認です。同じリクエストを復元してから編集を続けてください。"
  },
  "shell.confirm.changeClip": {
    "zh-Hans": "当前面板有未保存修改。放弃修改并切换片段？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並切換片段？",
    "en": "This panel has unsaved changes. Discard them and switch clips?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してクリップを切り替えますか？"
  },
  "shell.confirm.addTimeline": {
    "zh-Hans": "当前面板有未保存修改。放弃修改并加入时间线？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並加入時間軸？",
    "en": "This panel has unsaved changes. Discard them and add to the timeline?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄してタイムラインに追加しますか？"
  },
  "shell.clipAdded": {
    "zh-Hans": "固定素材片段已加入时间线。",
    "zh-Hant": "固定素材片段已加入時間軸。",
    "en": "A clip with a fixed asset reference was added to the timeline.",
    "ja": "固定された素材参照を持つクリップをタイムラインに追加しました。"
  },
  "shell.confirm.returnSource": {
    "zh-Hans": "当前片段有未保存修改。放弃修改并返回来源素材？",
    "zh-Hant": "目前片段有尚未儲存的修改。放棄修改並返回來源素材？",
    "en": "This clip has unsaved changes. Discard them and return to the source asset?",
    "ja": "現在のクリップに未保存の変更があります。変更を破棄してソース素材に戻りますか？"
  },
  "shell.confirm.moveClip": {
    "zh-Hans": "当前片段有未保存修改。放弃修改并移动片段？",
    "zh-Hant": "目前片段有尚未儲存的修改。放棄修改並移動片段？",
    "en": "This clip has unsaved changes. Discard them and move the clip?",
    "ja": "現在のクリップに未保存の変更があります。変更を破棄してクリップを移動しますか？"
  },
  "shell.compatibleTracks": {
    "zh-Hans": "画面片段与音频片段只能移动到各自兼容的轨道。",
    "zh-Hant": "畫面片段與音訊片段只能移至各自相容的軌道。",
    "en": "Video and audio clips can only move to their compatible track types.",
    "ja": "映像クリップと音声クリップは、それぞれ互換性のある種類のトラックにのみ移動できます。"
  },
  "shell.exportPending": {
    "zh-Hans": "已有导出请求结果待确认。请在任务面板恢复同一请求。",
    "zh-Hant": "已有匯出請求的結果待確認。請在工作面板還原同一請求。",
    "en": "An existing export request awaits confirmation. Restore that same request in the task panel.",
    "ja": "既存の書き出しリクエストが確認待ちです。タスクパネルで同じリクエストを復元してください。"
  },
  "shell.exportRecordUnavailable": {
    "zh-Hans": "无法核对导出请求记录。请先在任务面板核实原请求。",
    "zh-Hant": "無法核對匯出請求記錄。請先在工作面板核實原請求。",
    "en": "Cannot check the export request record. Verify the original request in the task panel first.",
    "ja": "書き出しリクエストの記録を確認できません。まずタスクパネルで元のリクエストを確認してください。"
  },
  "shell.previewRendering": {
    "zh-Hans": "时间线正在渲染；完成后会自动显示可播放的合成预览。",
    "zh-Hant": "時間軸正在算圖；完成後會自動顯示可播放的合成預覽。",
    "en": "The timeline is rendering. A playable composite preview will appear when it finishes.",
    "ja": "タイムラインをレンダリング中です。完了すると再生可能な合成プレビューを自動表示します。"
  },
  "shell.timelineExportStarted": {
    "zh-Hans": "时间线导出已开始，使用当前编排的固定快照。",
    "zh-Hant": "時間軸匯出已開始，使用目前編排的固定快照。",
    "en": "Timeline export started using a fixed snapshot of the current edit.",
    "ja": "現在の編集内容の固定スナップショットを使い、タイムラインの書き出しを開始しました。"
  },
  "shell.confirm.changeSource": {
    "zh-Hans": "当前面板有未保存修改。放弃修改并查看另一个源素材？",
    "zh-Hant": "目前面板有尚未儲存的修改。放棄修改並檢視其他來源素材？",
    "en": "This panel has unsaved changes. Discard them and view another source asset?",
    "ja": "現在のパネルに未保存の変更があります。変更を破棄して別のソース素材を表示しますか？"
  },
  "shell.savedRangeAdded": {
    "zh-Hans": "已保存范围已作为固定素材片段加入时间线。",
    "zh-Hant": "已儲存範圍已作為固定素材片段加入時間軸。",
    "en": "The saved range was added to the timeline as a fixed asset clip.",
    "ja": "保存済みの範囲を、固定された素材クリップとしてタイムラインに追加しました。"
  },
  "shell.waitProjectLoad": {
    "zh-Hans": "请等待当前项目连接与数据加载完成。",
    "zh-Hant": "請等待目前專案的連線與資料載入完成。",
    "en": "Wait for the current project connection and data to finish loading.",
    "ja": "現在のプロジェクトの接続とデータ読み込みが完了するまでお待ちください。"
  },
  "shell.saveBeforeMoveReview": {
    "zh-Hans": "请先保存或放弃属性面板草稿，再审阅片段移动。草稿不会自动发送或清除。",
    "zh-Hant": "請先儲存或放棄屬性面板草稿，再審閱片段移動。草稿不會自動傳送或清除。",
    "en": "Save or discard the properties draft before reviewing clip moves. Drafts are not automatically sent or cleared.",
    "ja": "クリップ移動を確認する前に、プロパティパネルの下書きを保存または破棄してください。下書きを自動送信・消去することはありません。"
  },
  "shell.timelineBusy": {
    "zh-Hans": "有时间线操作正在处理或待确认，请先在任务中心核对。",
    "zh-Hant": "有時間軸操作正在處理或待確認，請先在工作中心核對。",
    "en": "A timeline operation is in progress or awaiting confirmation. Check the task center first.",
    "ja": "処理中または確認待ちのタイムライン操作があります。まずタスクセンターで確認してください。"
  },
  "shell.sourceRangeSaved": {
    "zh-Hans": "源范围已保存，已有片段保持独立。",
    "zh-Hant": "來源範圍已儲存，既有片段保持獨立。",
    "en": "Source range saved. Existing clips remain independent.",
    "ja": "ソース範囲を保存しました。既存のクリップは変更されません。"
  },
  "shell.assetMarkSaved": {
    "zh-Hans": "素材标记已保存。",
    "zh-Hant": "素材標記已儲存。",
    "en": "Asset mark saved.",
    "ja": "素材のマークを保存しました。"
  },
  "shell.planningLinkSaved": {
    "zh-Hans": "本地策划关联已保存，生成输入与已有结果保持独立。",
    "zh-Hant": "本機策劃關聯已儲存，生成輸入與既有結果保持獨立。",
    "en": "Local planning link saved. Generation inputs and existing results remain independent.",
    "ja": "ローカルの企画リンクを保存しました。生成入力と既存の結果は変更されません。"
  },
  "assets.imageNode": {
    "zh-Hans": "图片节点",
    "zh-Hant": "圖片節點",
    "en": "Image node",
    "ja": "画像ノード"
  },
  "shell.saveShotBeforeGenerate": {
    "zh-Hans": "请先在右侧保存镜头修改，再生成。",
    "zh-Hant": "請先在右側儲存鏡頭修改，再生成。",
    "en": "Save the shot changes on the right before generating.",
    "ja": "生成する前に、右側でショットの変更を保存してください。"
  },
  "shell.connecting": {
    "zh-Hans": "正在连接你的工作区…",
    "zh-Hant": "正在連線至你的工作區…",
    "en": "Connecting to your workspace…",
    "ja": "ワークスペースに接続中…"
  },
  "shell.connectFailed": {
    "zh-Hans": "暂时无法连接工作台",
    "zh-Hant": "暫時無法連線至工作台",
    "en": "Cannot connect to the workbench right now",
    "ja": "現在ワークベンチに接続できません"
  },
  "shell.checkServer": {
    "zh-Hans": "请确认服务器已启动。",
    "zh-Hant": "請確認伺服器已啟動。",
    "en": "Make sure the server is running.",
    "ja": "サーバーが起動していることを確認してください。"
  },
  "shell.reconnect": {
    "zh-Hans": "重新连接",
    "zh-Hant": "重新連線",
    "en": "Reconnect",
    "ja": "再接続"
  },
  "projects.project": {
    "zh-Hans": "项目",
    "zh-Hant": "專案",
    "en": "Project",
    "ja": "プロジェクト"
  },
  "shell.restoredScope": {
    "zh-Hans": "恢复分支：仅本地查看、编辑与导出",
    "zh-Hant": "還原分支：僅限本機檢視、編輯與匯出",
    "en": "Restored branch: local viewing, editing, and export only",
    "ja": "復元ブランチ：ローカルでの表示・編集・書き出しのみ"
  },
  "shell.restoredNoConnections": {
    "zh-Hans": "恢复分支不提供模型连接设置",
    "zh-Hant": "還原分支不提供模型連線設定",
    "en": "Model connection settings are unavailable in a restored branch",
    "ja": "復元ブランチではモデル接続設定を利用できません"
  },
  "projects.backToList": {
    "zh-Hans": "返回项目列表",
    "zh-Hant": "返回專案清單",
    "en": "Back to projects",
    "ja": "プロジェクト一覧に戻る"
  },
  "assets.importLocal": {
    "zh-Hans": "导入本地素材",
    "zh-Hant": "匯入本機素材",
    "en": "Import local assets",
    "ja": "ローカル素材を読み込む"
  },
  "shell.title": {
    "zh-Hans": "Mioon 影像工作台",
    "zh-Hant": "Mioon 影像工作台",
    "en": "Mioon video workbench",
    "ja": "Mioon 映像ワークベンチ"
  },
  "projects.choose": {
    "zh-Hans": "选择一个项目",
    "zh-Hant": "選擇專案",
    "en": "Choose a project",
    "ja": "プロジェクトを選択"
  },
  "projects.yourProjects": {
    "zh-Hans": "你的项目",
    "zh-Hant": "你的專案",
    "en": "Your projects",
    "ja": "プロジェクト"
  },
  "shell.timelineOutput": {
    "zh-Hans": "时间线输出规格",
    "zh-Hant": "時間軸輸出規格",
    "en": "Timeline output format",
    "ja": "タイムラインの出力形式"
  },
  "shell.workspaceMode": {
    "zh-Hans": "工作区模式",
    "zh-Hant": "工作區模式",
    "en": "Workspace mode",
    "ja": "ワークスペースのモード"
  },
  "shell.canvas": {
    "zh-Hans": "画板",
    "zh-Hant": "畫板",
    "en": "Canvas",
    "ja": "キャンバス"
  },
  "shell.editing": {
    "zh-Hans": "剪辑",
    "zh-Hant": "剪輯",
    "en": "Editing",
    "ja": "編集"
  },
  "shell.agentChat": {
    "zh-Hans": "Agent 文字对话",
    "zh-Hant": "Agent 文字對話",
    "en": "Agent chat",
    "ja": "Agent チャット"
  },
  "shell.agentConnections": {
    "zh-Hans": "Agent 连接设置",
    "zh-Hant": "Agent 連線設定",
    "en": "Agent connection settings",
    "ja": "Agent 接続設定"
  },
  "shell.regionGuide": {
    "zh-Hans": "区域说明",
    "zh-Hant": "區域說明",
    "en": "Workspace guide",
    "ja": "ワークスペースガイド"
  },
  "shell.tasks": {
    "zh-Hans": "任务",
    "zh-Hant": "工作",
    "en": "Tasks",
    "ja": "タスク"
  },
  "shell.recoveryUnchecked": {
    "zh-Hans": "恢复记录尚未核对",
    "zh-Hant": "還原記錄尚未核對",
    "en": "Recovery records not checked yet",
    "ja": "復元記録は未確認です"
  },
  "shell.viewSavedExports": {
    "zh-Hans": "查看已保存的导出与预览",
    "zh-Hant": "檢視已儲存的匯出與預覽",
    "en": "View saved exports and previews",
    "ja": "保存済みの書き出しとプレビューを表示"
  },
  "shell.viewExports": {
    "zh-Hans": "查看导出记录",
    "zh-Hant": "檢視匯出記錄",
    "en": "View export history",
    "ja": "書き出し履歴を表示"
  },
  "shell.generateAllShots": {
    "zh-Hans": "请先为每个镜头生成并选用一个版本",
    "zh-Hant": "請先為每個鏡頭生成並選用一個版本",
    "en": "Generate and select a version for each shot first",
    "ja": "まず各ショットを生成し、バージョンを選択してください"
  },
  "shell.exportStoryboardHint": {
    "zh-Hans": "按分镜板顺序导出成片",
    "zh-Hant": "依分鏡板順序匯出成片",
    "en": "Export a film in storyboard order",
    "ja": "ストーリーボードの順序で映像を書き出す"
  },
  "shell.exportStoryboard": {
    "zh-Hans": "导出分镜",
    "zh-Hant": "匯出分鏡",
    "en": "Export storyboard",
    "ja": "ストーリーボードを書き出す"
  },
  "shell.exportTimeline": {
    "zh-Hans": "导出时间线",
    "zh-Hant": "匯出時間軸",
    "en": "Export timeline",
    "ja": "タイムラインを書き出す"
  },
  "shell.privateWorkspace": {
    "zh-Hans": "私有工作区",
    "zh-Hant": "私人工作區",
    "en": "Private workspace",
    "ja": "プライベートワークスペース"
  },
  "shell.guideTitle": {
    "zh-Hans": "同一个项目，两种专注的工作方式",
    "zh-Hant": "同一個專案，兩種專注的工作方式",
    "en": "One project, two focused ways to work",
    "ja": "ひとつのプロジェクト、ふたつの制作モード"
  },
  "shell.closeGuide": {
    "zh-Hans": "关闭区域说明",
    "zh-Hant": "關閉區域說明",
    "en": "Close workspace guide",
    "ja": "ワークスペースガイドを閉じる"
  },
  "shell.guideCanvas": {
    "zh-Hans": "整理参考图、镜头和版本，在右侧调整生成参数。分镜顺序可按需展开。",
    "zh-Hant": "整理參考圖、鏡頭與版本，並在右側調整生成參數。可依需要展開分鏡順序。",
    "en": "Organize reference images, shots, and versions. Adjust generation parameters on the right and expand storyboard order when needed.",
    "ja": "参照画像、ショット、バージョンを整理し、右側で生成パラメーターを調整します。必要に応じてストーリーボードの順序を展開できます。"
  },
  "shell.guideEditing": {
    "zh-Hans": "在大画面中检查素材或合成预览，用多轨时间线编排画面和声音。",
    "zh-Hant": "在大畫面中檢查素材或合成預覽，使用多軌時間軸編排畫面與聲音。",
    "en": "Inspect assets or composite previews in a large viewer. Arrange visuals and sound on a multitrack timeline.",
    "ja": "大きなビューアで素材や合成プレビューを確認し、マルチトラックのタイムラインで映像と音を構成します。"
  },
  "shell.sharedAssets": {
    "zh-Hans": "共享素材库",
    "zh-Hant": "共用素材庫",
    "en": "Shared asset library",
    "ja": "共通の素材ライブラリ"
  },
  "shell.guideAssets": {
    "zh-Hans": "原始素材与每个生成版本都可加入时间线。已有片段固定引用加入时的素材。",
    "zh-Hant": "原始素材與每個生成版本皆可加入時間軸。既有片段固定參照加入時的素材。",
    "en": "Original assets and every generated version can be added to the timeline. Existing clips keep their asset references from the time they were added.",
    "ja": "元の素材と生成した各バージョンをタイムラインに追加できます。既存のクリップは追加時の素材参照を保持します。"
  },
  "shell.guideTransitionTitle": {
    "zh-Hans": "来回衔接",
    "zh-Hant": "來回銜接",
    "en": "Move between modes",
    "ja": "モードを行き来"
  },
  "shell.guideTransition": {
    "zh-Hans": "加入时间线后进入剪辑；返回来源可定位原镜头和版本。切换保留各自的视角和选择。",
    "zh-Hant": "加入時間軸後進入剪輯；返回來源可定位原鏡頭與版本。切換時會保留各自的視角與選擇。",
    "en": "Adding to the timeline enters Editing. Return to source locates the original shot and version. Each mode retains its view and selection.",
    "ja": "タイムラインに追加すると編集モードに入ります。ソースに戻ると元のショットとバージョンを確認できます。切り替えても各モードの表示と選択は保持されます。"
  },
  "shell.guideVersions": {
    "zh-Hans": "重新生成或选用新版本，不会替换已有时间线片段。未保存修改会在离开面板前确认。",
    "zh-Hant": "重新生成或選用新版本，不會取代既有時間軸片段。離開面板前會確認尚未儲存的修改。",
    "en": "Regenerating or selecting a new version does not replace existing timeline clips. You will be asked about unsaved changes before leaving a panel.",
    "ja": "再生成や新しいバージョンの選択で既存のタイムラインクリップが置き換わることはありません。未保存の変更はパネルを離れる前に確認します。"
  },
  "assets.library": {
    "zh-Hans": "素材库",
    "zh-Hant": "素材庫",
    "en": "Asset library",
    "ja": "素材ライブラリ"
  },
  "shell.canvasWorkspace": {
    "zh-Hans": "画板工作区",
    "zh-Hant": "畫板工作區",
    "en": "Canvas workspace",
    "ja": "キャンバスワークスペース"
  },
  "shell.editingWorkspace": {
    "zh-Hans": "剪辑工作区",
    "zh-Hant": "剪輯工作區",
    "en": "Editing workspace",
    "ja": "編集ワークスペース"
  },
  "shell.text": {
    "zh-Hans": "文字",
    "zh-Hant": "文字",
    "en": "Text",
    "ja": "テキスト"
  },
  "assets.image": {
    "zh-Hans": "图片",
    "zh-Hant": "圖片",
    "en": "Image",
    "ja": "画像"
  },
  "assets.video": {
    "zh-Hans": "视频",
    "zh-Hant": "影片",
    "en": "Video",
    "ja": "動画"
  },
  "assets.audio": {
    "zh-Hans": "音频",
    "zh-Hant": "音訊",
    "en": "Audio",
    "ja": "音声"
  },
  "projects.addShot": {
    "zh-Hans": "添加镜头",
    "zh-Hant": "新增鏡頭",
    "en": "Add shot",
    "ja": "ショットを追加"
  },
  "shell.referenceParticipates": {
    "zh-Hans": "首帧参考 · 参与生成",
    "zh-Hant": "首幀參考 · 用於生成",
    "en": "First-frame reference · Used in generation",
    "ja": "開始フレーム参照・生成に使用"
  },
  "shell.visualLinkOnly": {
    "zh-Hans": "视觉连线 · 仅整理思路",
    "zh-Hant": "視覺連線 · 僅整理思路",
    "en": "Visual link · Organization only",
    "ja": "視覚的なリンク・整理専用"
  },
  "shell.referenceLink": {
    "zh-Hans": "首帧参考连接",
    "zh-Hant": "首幀參考連線",
    "en": "First-frame reference connection",
    "ja": "開始フレーム参照の接続"
  },
  "shell.viewDisconnect": {
    "zh-Hans": "查看 / 断开",
    "zh-Hant": "檢視／中斷",
    "en": "View / Disconnect",
    "ja": "表示／接続解除"
  },
  "shell.visualLinkNoGeneration": {
    "zh-Hans": "视觉连线不参与生成",
    "zh-Hant": "視覺連線不參與生成",
    "en": "Visual links are not used in generation",
    "ja": "視覚的なリンクは生成に使いません"
  },
  "shell.deleteKey": {
    "zh-Hans": "Delete 删除",
    "zh-Hant": "Delete 刪除",
    "en": "Delete to remove",
    "ja": "Delete で削除"
  },
  "shell.emptyIdea": {
    "zh-Hans": "一个想法",
    "zh-Hant": "一個想法",
    "en": "An idea",
    "ja": "ひとつのアイデア"
  },
  "shell.emptyPossibilities": {
    "zh-Hans": "无限可能",
    "zh-Hant": "無限可能",
    "en": "Endless possibilities",
    "ja": "無限の可能性"
  },
  "shell.emptyFilm": {
    "zh-Hans": "一部作品",
    "zh-Hant": "一部作品",
    "en": "A film",
    "ja": "ひとつの作品"
  },
  "shell.emptyTitle": {
    "zh-Hans": "下一部作品，从这里开始。",
    "zh-Hant": "下一部作品，從這裡開始。",
    "en": "Your next creation starts here.",
    "ja": "次の作品は、ここから。"
  },
  "shell.emptyCreateHint": {
    "zh-Hans": "先创建或打开一个项目，即可使用画板和剪辑。",
    "zh-Hant": "先建立或開啟專案，即可使用畫板與剪輯。",
    "en": "Create or open a project to use Canvas and Editing.",
    "ja": "プロジェクトを作成または開くと、キャンバスと編集を使えます。"
  },
  "projects.shotEmptyTitle": {
    "zh-Hans": "给故事一个开场。",
    "zh-Hant": "給故事一個開場。",
    "en": "Give your story a beginning.",
    "ja": "ストーリーの始まりを。"
  },
  "projects.shotEmptyHint": {
    "zh-Hans": "从单个镜头开始，或先搭好三幕的故事结构。",
    "zh-Hant": "從單個鏡頭開始，或先建立三幕的故事結構。",
    "en": "Start with one shot, or lay out a three-act story.",
    "ja": "ひとつのショットから始めるか、3幕のストーリー構成を用意しましょう。"
  },
  "projects.createShot": {
    "zh-Hans": "创建镜头",
    "zh-Hant": "建立鏡頭",
    "en": "Create shot",
    "ja": "ショットを作成"
  },
  "projects.createStructure": {
    "zh-Hans": "创建三镜头结构",
    "zh-Hant": "建立三鏡頭結構",
    "en": "Create three-shot structure",
    "ja": "3ショット構成を作成"
  },
  "shell.zoomOutCanvas": {
    "zh-Hans": "缩小画布",
    "zh-Hant": "縮小畫布",
    "en": "Zoom out canvas",
    "ja": "キャンバスを縮小"
  },
  "shell.zoomOut": {
    "zh-Hans": "缩小",
    "zh-Hant": "縮小",
    "en": "Zoom out",
    "ja": "縮小"
  },
  "shell.zoomInCanvas": {
    "zh-Hans": "放大画布",
    "zh-Hant": "放大畫布",
    "en": "Zoom in canvas",
    "ja": "キャンバスを拡大"
  },
  "shell.zoomIn": {
    "zh-Hans": "放大",
    "zh-Hant": "放大",
    "en": "Zoom in",
    "ja": "拡大"
  },
  "shell.fitCanvasHint": {
    "zh-Hans": "适应画布 · 保留节点位置",
    "zh-Hant": "符合畫布 · 保留節點位置",
    "en": "Fit canvas · Keep node positions",
    "ja": "キャンバスに合わせる・ノード位置を保持"
  },
  "shell.fitCanvas": {
    "zh-Hans": "适应画布",
    "zh-Hant": "符合畫布",
    "en": "Fit canvas",
    "ja": "キャンバスに合わせる"
  },
  "shell.showMinimap": {
    "zh-Hans": "显示缩略地图",
    "zh-Hant": "顯示縮圖地圖",
    "en": "Show minimap",
    "ja": "ミニマップを表示"
  },
  "shell.canvasInteractionHint": {
    "zh-Hans": "双击媒体放大查看 · 拖动画布平移",
    "zh-Hant": "按兩下媒體放大檢視 · 拖曳畫布平移",
    "en": "Double-click media to enlarge · Drag canvas to pan",
    "ja": "メディアをダブルクリックで拡大・キャンバスをドラッグで移動"
  },
  "shell.restoredFrameUnavailable": {
    "zh-Hans": "恢复分支可预览源素材；新抽帧暂不可用。",
    "zh-Hant": "還原分支可預覽來源素材；暫時無法擷取新影格。",
    "en": "A restored branch can preview source assets, but new frame extraction is unavailable.",
    "ja": "復元ブランチでソース素材はプレビューできますが、新しいフレーム抽出は利用できません。"
  },
  "storyboard.order": {
    "zh-Hans": "分镜顺序",
    "zh-Hant": "分鏡順序",
    "en": "Storyboard order",
    "ja": "ストーリーボードの順序"
  },
  "storyboard.title": {
    "zh-Hans": "分镜 · 故事顺序",
    "zh-Hant": "分鏡 · 故事順序",
    "en": "Storyboard · Story order",
    "ja": "ストーリーボード・ストーリーの順序"
  },
  "storyboard.dragHint": {
    "zh-Hans": "拖动排序 · 独立于时间线",
    "zh-Hant": "拖曳排序 · 獨立於時間軸",
    "en": "Drag to reorder · Independent of timeline",
    "ja": "ドラッグで並べ替え・タイムラインとは独立"
  },
  "shell.add": {
    "zh-Hans": "添加",
    "zh-Hant": "新增",
    "en": "Add",
    "ja": "追加"
  },
  "storyboard.collapse": {
    "zh-Hans": "收起分镜",
    "zh-Hant": "收合分鏡",
    "en": "Collapse storyboard",
    "ja": "ストーリーボードを折りたたむ"
  },
  "storyboard.expand": {
    "zh-Hans": "展开分镜",
    "zh-Hant": "展開分鏡",
    "en": "Expand storyboard",
    "ja": "ストーリーボードを展開"
  },
  "storyboard.empty": {
    "zh-Hans": "镜头会出现在这里。画布负责探索，分镜板负责叙事。",
    "zh-Hant": "鏡頭會顯示在這裡。畫布用於探索，分鏡板用於敘事。",
    "en": "Shots appear here. Explore on the canvas, tell the story on the storyboard.",
    "ja": "ショットがここに表示されます。キャンバスで構想し、ストーリーボードで物語を組み立てましょう。"
  },
  "storyboard.addNext": {
    "zh-Hans": "添加下一个镜头",
    "zh-Hant": "新增下一個鏡頭",
    "en": "Add next shot",
    "ja": "次のショットを追加"
  },
  "storyboard.nextAct": {
    "zh-Hans": "下一幕",
    "zh-Hant": "下一幕",
    "en": "Next act",
    "ja": "次の幕"
  },
  "shell.images": {
    "zh-Hans": "图像",
    "zh-Hant": "圖像",
    "en": "Images",
    "ja": "画像"
  },
  "shell.deliveryChecks": {
    "zh-Hans": "交付检查",
    "zh-Hant": "交付檢查",
    "en": "Delivery checks",
    "ja": "納品チェック"
  },
  "shell.properties": {
    "zh-Hans": "属性",
    "zh-Hant": "屬性",
    "en": "Properties",
    "ja": "プロパティ"
  },
  "shell.inspectorTabs": {
    "zh-Hans": "属性、Agent、图像、交付检查与任务",
    "zh-Hant": "屬性、Agent、圖像、交付檢查與工作",
    "en": "Properties, Agent, Images, Delivery checks, and Tasks",
    "ja": "プロパティ、Agent、画像、納品チェック、タスク"
  },
  "shell.rightWorkspace": {
    "zh-Hans": "右侧工作区",
    "zh-Hant": "右側工作區",
    "en": "Right workspace",
    "ja": "右側のワークスペース"
  },
  "shell.collapseInspector": {
    "zh-Hans": "收起右侧面板",
    "zh-Hant": "收合右側面板",
    "en": "Collapse right panel",
    "ja": "右側のパネルを折りたたむ"
  },
  "shell.restoredFramesRetained": {
    "zh-Hans": "抽帧任务保留，执行暂不可用",
    "zh-Hant": "影格擷取工作已保留，暫時無法執行",
    "en": "Frame extraction tasks retained; execution unavailable",
    "ja": "フレーム抽出タスクは保持されていますが、実行は利用できません"
  },
  "shell.clipProperties": {
    "zh-Hans": "片段属性",
    "zh-Hant": "片段屬性",
    "en": "Clip properties",
    "ja": "クリップのプロパティ"
  },
  "shell.selectTimelineClip": {
    "zh-Hans": "选择时间线片段",
    "zh-Hant": "選擇時間軸片段",
    "en": "Select a timeline clip",
    "ja": "タイムラインのクリップを選択"
  },
  "shell.clipPropertiesHint": {
    "zh-Hans": "在这里调整起止帧、源入点、画面位置和音量。",
    "zh-Hant": "在這裡調整起止影格、來源入點、畫面位置與音量。",
    "en": "Adjust start and end frames, source in-point, position, and volume here.",
    "ja": "開始・終了フレーム、ソースのイン点、画面の位置、音量をここで調整できます。"
  },
  "shell.restoredNoBackup": {
    "zh-Hans": "恢复分支不能再次创建备份",
    "zh-Hant": "還原分支無法再次建立備份",
    "en": "A restored branch cannot create another backup",
    "ja": "復元ブランチでは新たなバックアップを作成できません"
  },
  "shell.restoredAgentHistory": {
    "zh-Hans": "Agent 历史保留，执行暂不可用",
    "zh-Hant": "Agent 歷程已保留，暫時無法執行",
    "en": "Agent history retained; execution unavailable",
    "ja": "Agent 履歴は保持されていますが、実行は利用できません"
  },
  "shell.restoredImageHistory": {
    "zh-Hans": "图像与 Comfy 历史保留，执行暂不可用",
    "zh-Hant": "圖像與 Comfy 歷程已保留，暫時無法執行",
    "en": "Image and Comfy history retained; execution unavailable",
    "ja": "画像と Comfy の履歴は保持されていますが、実行は利用できません"
  },
  "shell.timeline": {
    "zh-Hans": "时间线",
    "zh-Hant": "時間軸",
    "en": "Timeline",
    "ja": "タイムライン"
  },
  "shell.mobileNavigation": {
    "zh-Hans": "移动工作区导航",
    "zh-Hant": "行動工作區導覽",
    "en": "Mobile workspace navigation",
    "ja": "モバイルワークスペースのナビゲーション"
  },
  "assets.assets": {
    "zh-Hans": "素材",
    "zh-Hant": "素材",
    "en": "Assets",
    "ja": "素材"
  },
  "shell.preview": {
    "zh-Hans": "预览",
    "zh-Hant": "預覽",
    "en": "Preview",
    "ja": "プレビュー"
  },
  "shell.dismissNotice": {
    "zh-Hans": "关闭提示",
    "zh-Hant": "關閉提示",
    "en": "Dismiss notice",
    "ja": "通知を閉じる"
  },
  "assets.addCanvas": {
    "zh-Hans": "添加到画布",
    "zh-Hant": "新增至畫布",
    "en": "Add to canvas",
    "ja": "キャンバスに追加"
  },
  "shell.generationConfirmTitle": {
    "zh-Hans": "确认提交真实生成",
    "zh-Hant": "確認提交實際生成",
    "en": "Confirm real generation",
    "ja": "実際の生成を確認"
  },
  "shell.generationCosts": {
    "zh-Hans": "此操作会调用外部生成服务，可能产生费用。",
    "zh-Hant": "此操作會呼叫外部生成服務，可能產生費用。",
    "en": "This action calls an external generation service and may incur charges.",
    "ja": "この操作は外部生成サービスを呼び出し、料金が発生する場合があります。"
  },
  "shell.generationRetryScope": {
    "zh-Hans": "重试明确失败的任务：使用原任务的固定镜头快照。",
    "zh-Hant": "重試已明確失敗的工作：使用原工作的固定鏡頭快照。",
    "en": "Retry a definitively failed task using its original fixed shot snapshot.",
    "ja": "失敗が明確なタスクを、元の固定ショットスナップショットで再試行します。"
  },
  "shell.generationSubjectScope": {
    "zh-Hans": "将发送上方固定版本的原图；提示词保持原样，不会自动注入主体名称或身份指令。",
    "zh-Hant": "將傳送上方固定版本的原圖；提示詞保持原樣，不會自動加入主體名稱或身分指令。",
    "en": "The original images from the fixed versions above will be sent. The prompt stays unchanged; subject names or identity instructions are not injected automatically.",
    "ja": "上記の固定バージョンの元画像を送信します。プロンプトは変更せず、被写体名や識別指示を自動追加することはありません。"
  },
  "shell.generationBudgetScope": {
    "zh-Hans": "此处不提供价格或预算承诺。请先确认服务商计费、账户额度与服务器侧已授权的调用上限。",
    "zh-Hant": "此處不提供價格或預算承諾。請先確認服務商計費、帳戶額度與伺服器端已授權的呼叫上限。",
    "en": "No price or budget commitment is provided here. Check provider billing, your account balance, and the server-authorized call limit first.",
    "ja": "ここでは価格や予算の保証は行いません。まず提供元の料金体系、アカウントの利用枠、サーバー側で許可された呼び出し上限を確認してください。"
  },
  "shell.generationUnknownNoRetry": {
    "zh-Hans": "提交状态不明确时，系统会停止重试，防止重复计费。",
    "zh-Hant": "提交狀態不明確時，系統會停止重試，以防重複計費。",
    "en": "When submission status is unclear, retries stop to prevent duplicate charges.",
    "ja": "送信状態が不明な場合、重複課金を防ぐため再試行を停止します。"
  },
  "shell.generationConfirmSend": {
    "zh-Hans": "确认发送并生成",
    "zh-Hant": "確認傳送並生成",
    "en": "Confirm sending and generate",
    "ja": "送信を確認して生成"
  },
  "projects.comparison.subtitle": {
    "zh-Hans": "{name} · 每个版本保留独立的生成参数与参考图快照",
    "zh-Hant": "{name} · 每個版本保留獨立的生成參數與參考圖快照",
    "en": "{name} · Each version keeps its own generation parameters and reference snapshots",
    "ja": "{name}・各バージョンは独立した生成パラメーターと参照画像のスナップショットを保持します"
  },
  "projects.comparison.label": {
    "zh-Hans": "对比版本 {label}",
    "zh-Hant": "比較版本 {label}",
    "en": "Comparison version {label}",
    "ja": "比較バージョン {label}"
  },
  "projects.version": {
    "zh-Hans": "版本 {number}",
    "zh-Hant": "版本 {number}",
    "en": "Version {number}",
    "ja": "バージョン {number}"
  },
  "projects.mockVersion": {
    "zh-Hans": "版本 {number} · 模拟",
    "zh-Hant": "版本 {number} · 模擬",
    "en": "Version {number} · Mock",
    "ja": "バージョン {number}・モック"
  },
  "projects.providerVersion": {
    "zh-Hans": "版本 {number} · {provider}",
    "zh-Hant": "版本 {number} · {provider}",
    "en": "Version {number} · {provider}",
    "ja": "バージョン {number}・{provider}"
  },
  "shell.durationSeconds": {
    "zh-Hans": "{seconds} 秒",
    "zh-Hant": "{seconds} 秒",
    "en": "{seconds} s",
    "ja": "{seconds} 秒"
  },
  "projects.comparison.select": {
    "zh-Hans": "选用版本 {number}",
    "zh-Hant": "選用版本 {number}",
    "en": "Select version {number}",
    "ja": "バージョン {number} を選択"
  },
  "shell.confirm.unsentBoth": {
    "zh-Hans": "Agent 和图像工坊都有未发送的草稿。切换项目会放弃草稿和属性面板中未保存的修改；已接受的任务可能继续。继续切换？",
    "zh-Hant": "Agent 與圖像工坊皆有尚未傳送的草稿。切換專案會放棄草稿與屬性面板中尚未儲存的修改；已接受的工作可能繼續。是否繼續切換？",
    "en": "Agent and the image workshop both have unsent drafts. Switching projects discards these drafts and unsaved properties changes. Accepted tasks may continue. Switch projects?",
    "ja": "Agent と画像ワークショップに未送信の下書きがあります。プロジェクトを切り替えると下書きとプロパティの未保存の変更は破棄されます。受理済みタスクは続行する可能性があります。切り替えますか？"
  },
  "shell.confirm.unsentImage": {
    "zh-Hans": "图像工坊有未发送的草稿。切换项目会放弃草稿和属性面板中未保存的修改；已接受的任务可能继续。继续切换？",
    "zh-Hant": "圖像工坊有尚未傳送的草稿。切換專案會放棄草稿與屬性面板中尚未儲存的修改；已接受的工作可能繼續。是否繼續切換？",
    "en": "The image workshop has an unsent draft. Switching projects discards it and unsaved properties changes. Accepted tasks may continue. Switch projects?",
    "ja": "画像ワークショップに未送信の下書きがあります。プロジェクトを切り替えると下書きとプロパティの未保存の変更は破棄されます。受理済みタスクは続行する可能性があります。切り替えますか？"
  },
  "shell.confirm.unsentAgent": {
    "zh-Hans": "Agent 有未发送的草稿。切换项目会放弃该草稿和属性面板中未保存的修改；已发送的回复可能继续。继续切换？",
    "zh-Hant": "Agent 有尚未傳送的草稿。切換專案會放棄該草稿與屬性面板中尚未儲存的修改；已傳送的回覆可能繼續。是否繼續切換？",
    "en": "Agent has an unsent draft. Switching projects discards it and unsaved properties changes. Replies already sent may continue. Switch projects?",
    "ja": "Agent に未送信の下書きがあります。プロジェクトを切り替えると下書きとプロパティの未保存の変更は破棄されます。送信済みの応答は続行する可能性があります。切り替えますか？"
  },
  "shell.error.referenceRequestPending": {
    "zh-Hans": "上一条首帧参考请求的结果尚未确认。原请求已保留，请先在任务面板恢复同一请求。",
    "zh-Hant": "上一個首幀參考請求的結果尚未確認。原請求已保留，請先在工作面板還原同一請求。",
    "en": "The previous first-frame reference request is unconfirmed. The original request is retained. Restore that same request in the task panel first.",
    "ja": "前回の開始フレーム参照リクエストの結果が未確認です。元のリクエストは保持されています。まずタスクパネルで同じリクエストを復元してください。"
  },
  "shell.error.timelineRequestPending": {
    "zh-Hans": "上一条时间线请求的结果尚未确认。原请求已保留，请先在任务面板恢复同一请求。",
    "zh-Hant": "上一個時間軸請求的結果尚未確認。原請求已保留，請先在工作面板還原同一請求。",
    "en": "The previous timeline request is unconfirmed. The original request is retained. Restore that same request in the task panel first.",
    "ja": "前回のタイムラインリクエストの結果が未確認です。元のリクエストは保持されています。まずタスクパネルで同じリクエストを復元してください。"
  },
  "projects.default.shot": {
    "zh-Hans": "镜头 {number}",
    "zh-Hant": "鏡頭 {number}",
    "en": "Shot {number}",
    "ja": "ショット {number}"
  },
  "projects.structureStopped": {
    "zh-Hans": "已停止创建结构，已确认 {count}/3 个镜头。如有待确认请求，请在任务面板恢复；其余镜头不会自动创建。",
    "zh-Hant": "已停止建立結構，已確認 {count}/3 個鏡頭。如有待確認請求，請在工作面板還原；其餘鏡頭不會自動建立。",
    "en": "Structure creation stopped with {count}/3 shots confirmed. Restore any unconfirmed request in the task panel. Remaining shots will not be created automatically.",
    "ja": "構成の作成を停止しました。3ショット中 {count} ショットを確認済みです。未確認のリクエストはタスクパネルで復元してください。残りのショットを自動作成することはありません。"
  },
  "assets.importImageFirst": {
    "zh-Hans": "请先导入图片素材。",
    "zh-Hant": "請先匯入圖片素材。",
    "en": "Import an image asset first.",
    "ja": "まず画像素材を読み込んでください。"
  },
  "assets.importAudioFirst": {
    "zh-Hans": "请先导入音频素材。",
    "zh-Hant": "請先匯入音訊素材。",
    "en": "Import an audio asset first.",
    "ja": "まず音声素材を読み込んでください。"
  },
  "assets.importVideoFirst": {
    "zh-Hans": "请先导入视频素材。",
    "zh-Hant": "請先匯入影片素材。",
    "en": "Import a video asset first.",
    "ja": "まず動画素材を読み込んでください。"
  },
  "assets.unsupportedImport": {
    "zh-Hans": "格式不支持。请使用 PNG、JPG、WEBP、MP4、WEBM、MP3、WAV 或 M4A。",
    "zh-Hant": "不支援此格式。請使用 PNG、JPG、WEBP、MP4、WEBM、MP3、WAV 或 M4A。",
    "en": "Unsupported format. Use PNG, JPG, WEBP, MP4, WEBM, MP3, WAV, or M4A.",
    "ja": "対応していない形式です。PNG、JPG、WEBP、MP4、WEBM、MP3、WAV、M4A を使用してください。"
  },
  "assets.importTooLarge": {
    "zh-Hans": "超过 30 MiB，请压缩后导入。",
    "zh-Hant": "超過 30 MiB，請壓縮後再匯入。",
    "en": "The file exceeds 30 MiB. Compress it before importing.",
    "ja": "30 MiB を超えています。圧縮してから読み込んでください。"
  },
  "shell.confirm.disconnectReference": {
    "zh-Hans": "断开「{name}」的首帧参考连接？这会清除此连接设置的参考图，原始素材与图片节点会保留。",
    "zh-Hant": "中斷「{name}」的首幀參考連線？這會清除此連線設定的參考圖，原始素材與圖片節點會保留。",
    "en": "Disconnect the first-frame reference for “{name}”? This clears the reference image set by this connection. The original asset and image node are retained.",
    "ja": "「{name}」の開始フレーム参照を解除しますか？この接続で設定した参照画像はクリアされます。元の素材と画像ノードは保持されます。"
  },
  "shell.clipSplit": {
    "zh-Hans": "已在第 {frame} 帧分割为 {left} + {right} 帧，可一次撤销。",
    "zh-Hant": "已在第 {frame} 影格分割為 {left} + {right} 影格，可一次復原。",
    "en": "Split at frame {frame} into {left} + {right} frames. Undo it in one step.",
    "ja": "フレーム {frame} で {left} + {right} フレームに分割しました。1回の操作で元に戻せます。"
  },
  "shell.needsAudioTrack": {
    "zh-Hans": "此素材需要音频轨道。请拖到兼容轨道。",
    "zh-Hant": "此素材需要音訊軌道。請拖曳至相容軌道。",
    "en": "This asset needs an audio track. Drag it to a compatible track.",
    "ja": "この素材には音声トラックが必要です。対応するトラックへドラッグしてください。"
  },
  "shell.needsVideoTrack": {
    "zh-Hans": "此素材需要画面轨道。请拖到兼容轨道。",
    "zh-Hant": "此素材需要影像軌道。請拖曳至相容軌道。",
    "en": "This asset needs a video track. Drag it to a compatible track.",
    "ja": "この素材には映像トラックが必要です。対応するトラックへドラッグしてください。"
  },
  "storyboard.summary": {
    "zh-Hans": {
      "one": "{count} 个镜头 · {seconds} 秒",
      "other": "{count} 个镜头 · {seconds} 秒"
    },
    "zh-Hant": {
      "one": "{count} 個鏡頭 · {seconds} 秒",
      "other": "{count} 個鏡頭 · {seconds} 秒"
    },
    "en": {
      "one": "{count} shot · {seconds} s",
      "other": "{count} shots · {seconds} s"
    },
    "ja": {
      "one": "{count} ショット・{seconds} 秒",
      "other": "{count} ショット・{seconds} 秒"
    }
  },
  "storyboard.select": {
    "zh-Hans": "选择分镜 {name}",
    "zh-Hant": "選擇分鏡 {name}",
    "en": "Select storyboard shot {name}",
    "ja": "ストーリーボードのショット {name} を選択"
  },
  "storyboard.moveEarlier": {
    "zh-Hans": "将 {name} 前移",
    "zh-Hant": "將 {name} 前移",
    "en": "Move {name} earlier",
    "ja": "{name} を前へ移動"
  },
  "storyboard.moveLater": {
    "zh-Hans": "将 {name} 后移",
    "zh-Hant": "將 {name} 後移",
    "en": "Move {name} later",
    "ja": "{name} を後ろへ移動"
  },
  "shell.generationReviewParameters": {
    "zh-Hans": "{model} · {mode} · {seconds} 秒 · {ratio}",
    "zh-Hant": "{model} · {mode} · {seconds} 秒 · {ratio}",
    "en": "{model} · {mode} · {seconds} s · {ratio}",
    "ja": "{model}・{mode}・{seconds} 秒・{ratio}"
  },
  "shell.generationDataScope": {
    "zh-Hans": {
      "one": "将发送此镜头的提示词、参数与 {count} 张参考图。费用由服务商按你的账户计费；工作台不保证远端任务可以取消。",
      "other": "将发送此镜头的提示词、参数与 {count} 张参考图。费用由服务商按你的账户计费；工作台不保证远端任务可以取消。"
    },
    "zh-Hant": {
      "one": "將傳送此鏡頭的提示詞、參數與 {count} 張參考圖。費用由服務商依你的帳戶計費；工作台不保證可取消遠端工作。",
      "other": "將傳送此鏡頭的提示詞、參數與 {count} 張參考圖。費用由服務商依你的帳戶計費；工作台不保證可取消遠端工作。"
    },
    "en": {
      "one": "This shot’s prompt, parameters, and {count} reference image will be sent. The provider bills your account. The workbench does not guarantee that the remote task can be cancelled.",
      "other": "This shot’s prompt, parameters, and {count} reference images will be sent. The provider bills your account. The workbench does not guarantee that the remote task can be cancelled."
    },
    "ja": {
      "one": "このショットのプロンプト、パラメーター、{count} 枚の参照画像を送信します。料金はサービス提供元からアカウントに請求されます。ワークベンチはリモートタスクのキャンセルを保証しません。",
      "other": "このショットのプロンプト、パラメーター、{count} 枚の参照画像を送信します。料金はサービス提供元からアカウントに請求されます。ワークベンチはリモートタスクのキャンセルを保証しません。"
    }
  },
  "projects.bootMissingRemembered": {
    "zh-Hans": "指定链接中的项目不存在，已打开此工作区最近保存的位置。",
    "zh-Hant": "指定連結中的專案不存在，已開啟此工作區最近儲存的位置。",
    "en": "The linked project does not exist. The workspace’s last saved location was opened.",
    "ja": "リンク先のプロジェクトが存在しないため、このワークスペースで最後に保存した場所を開きました。"
  },
  "projects.bootMissingFallback": {
    "zh-Hans": "指定链接中的项目不存在。已打开列表中的首个项目；可另行选择。",
    "zh-Hant": "指定連結中的專案不存在。已開啟清單中的第一個專案；可另行選擇。",
    "en": "The linked project does not exist. The first project in the list was opened; you can choose another.",
    "ja": "リンク先のプロジェクトが存在しないため、一覧の最初のプロジェクトを開きました。別のプロジェクトを選択できます。"
  },
  "projects.bootMissingEmpty": {
    "zh-Hans": "指定链接中的项目不存在。请选择或新建项目。",
    "zh-Hant": "指定連結中的專案不存在。請選擇或新增專案。",
    "en": "The linked project does not exist. Choose or create a project.",
    "ja": "リンク先のプロジェクトが存在しません。プロジェクトを選択または作成してください。"
  },
  "projects.bootRememberedFallback": {
    "zh-Hans": "上次记住的项目已不可用。已打开列表中的首个项目；可另行选择。",
    "zh-Hant": "上次記住的專案已無法使用。已開啟清單中的第一個專案；可另行選擇。",
    "en": "The remembered project is unavailable. The first project in the list was opened; you can choose another.",
    "ja": "記憶していたプロジェクトを利用できないため、一覧の最初のプロジェクトを開きました。別のプロジェクトを選択できます。"
  },
  "projects.bootRememberedEmpty": {
    "zh-Hans": "上次记住的项目已不可用。请选择或新建项目。",
    "zh-Hant": "上次記住的專案已無法使用。請選擇或新增專案。",
    "en": "The remembered project is unavailable. Choose or create a project.",
    "ja": "記憶していたプロジェクトを利用できません。プロジェクトを選択または作成してください。"
  },
  "assets.importBusy": {
    "zh-Hans": {
      "one": "上一批导入仍在处理中，当前文件结束后不再继续后续文件。本次选择未开始 {count} 个：{files}。请等待结束并核对素材列表，再单独选择仍需导入的文件。",
      "other": "上一批导入仍在处理中，当前文件结束后不再继续后续文件。本次选择未开始 {count} 个：{files}。请等待结束并核对素材列表，再单独选择仍需导入的文件。"
    },
    "zh-Hant": {
      "one": "上一批匯入仍在處理中，目前檔案結束後不會繼續後續檔案。本次選擇尚未開始 {count} 個：{files}。請等待結束並核對素材清單，再單獨選擇仍須匯入的檔案。",
      "other": "上一批匯入仍在處理中，目前檔案結束後不會繼續後續檔案。本次選擇尚未開始 {count} 個：{files}。請等待結束並核對素材清單，再單獨選擇仍須匯入的檔案。"
    },
    "en": {
      "one": "The previous import batch is still running and will stop after the current file. This selection of {count} file has not started: {files}. Wait for completion and check the asset list, then select only files still needed.",
      "other": "The previous import batch is still running and will stop after the current file. This selection of {count} files has not started: {files}. Wait for completion and check the asset list, then select only files still needed."
    },
    "ja": {
      "one": "前の読み込みバッチは処理中で、現在のファイルが終了したら停止します。今回の {count} ファイルの読み込みは開始していません：{files}。終了後に素材一覧を確認し、必要なファイルだけを選択してください。",
      "other": "前の読み込みバッチは処理中で、現在のファイルが終了したら停止します。今回の {count} ファイルの読み込みは開始していません：{files}。終了後に素材一覧を確認し、必要なファイルだけを選択してください。"
    }
  },
  "assets.importComplete": {
    "zh-Hans": {
      "one": "已确认导入 {count} 个：{files}。未尝试 0 个。拖入画板或时间线，即可开始编排。",
      "other": "已确认导入 {count} 个：{files}。未尝试 0 个。拖入画板或时间线，即可开始编排。"
    },
    "zh-Hant": {
      "one": "已確認匯入 {count} 個：{files}。尚未嘗試 0 個。拖曳至畫板或時間軸即可開始編排。",
      "other": "已確認匯入 {count} 個：{files}。尚未嘗試 0 個。拖曳至畫板或時間軸即可開始編排。"
    },
    "en": {
      "one": "Import confirmed for {count} file: {files}. No files remain unattempted. Drag it onto the canvas or timeline to start arranging.",
      "other": "Import confirmed for {count} files: {files}. No files remain unattempted. Drag them onto the canvas or timeline to start arranging."
    },
    "ja": {
      "one": "{count} ファイルの読み込みを確認しました：{files}。未試行のファイルはありません。キャンバスやタイムラインにドラッグして構成を始められます。",
      "other": "{count} ファイルの読み込みを確認しました：{files}。未試行のファイルはありません。キャンバスやタイムラインにドラッグして構成を始められます。"
    }
  },
  "assets.importLocalFailed": {
    "zh-Hans": {
      "one": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。本地处理失败，未提交 1 个：{current}。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。请检查文件后再试。",
      "other": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。本地处理失败，未提交 1 个：{current}。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。请检查文件后再试。"
    },
    "zh-Hant": {
      "one": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。本機處理失敗，尚未提交：{current}。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。請檢查檔案後再試。",
      "other": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。本機處理失敗，尚未提交：{current}。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。請檢查檔案後再試。"
    },
    "en": {
      "one": "Import confirmed for {count} file: {files} ({omitted} more not listed). Local processing failed; not submitted: {current}. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically. Check the file before trying again.",
      "other": "Import confirmed for {count} files: {files} ({omitted} more not listed). Local processing failed; not submitted: {current}. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically. Check the file before trying again."
    },
    "ja": {
      "one": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。ローカル処理に失敗し、未送信です：{current}。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。ファイルを確認してから再試行してください。",
      "other": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。ローカル処理に失敗し、未送信です：{current}。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。ファイルを確認してから再試行してください。"
    }
  },
  "assets.importRejected": {
    "zh-Hans": {
      "one": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。服务端已拒绝 1 个：{current}。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。",
      "other": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。服务端已拒绝 1 个：{current}。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。"
    },
    "zh-Hant": {
      "one": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。伺服器已拒絕：{current}。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。",
      "other": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。伺服器已拒絕：{current}。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。"
    },
    "en": {
      "one": "Import confirmed for {count} file: {files} ({omitted} more not listed). The server rejected: {current}. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically.",
      "other": "Import confirmed for {count} files: {files} ({omitted} more not listed). The server rejected: {current}. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically."
    },
    "ja": {
      "one": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。サーバーが拒否しました：{current}。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。",
      "other": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。サーバーが拒否しました：{current}。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。"
    }
  },
  "assets.importUnknown": {
    "zh-Hans": {
      "one": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。结果未知 1 个：{current}。请求已发出，但未收到有效确认；素材可能已保存。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。请先核对素材列表再决定是否重新导入，不要整批重选。",
      "other": "已确认导入 {count} 个：{files}（另 {omitted} 个未列出）。结果未知 1 个：{current}。请求已发出，但未收到有效确认；素材可能已保存。未尝试 {remaining} 个：{unattempted}（另 {unattemptedOmitted} 个未列出）。已停止本批，不会自动重试。请先核对素材列表再决定是否重新导入，不要整批重选。"
    },
    "zh-Hant": {
      "one": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。結果未知：{current}。請求已送出，但未收到有效確認；素材可能已儲存。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。請先核對素材清單，再決定是否重新匯入，不要整批重新選取。",
      "other": "已確認匯入 {count} 個：{files}（另 {omitted} 個未列出）。結果未知：{current}。請求已送出，但未收到有效確認；素材可能已儲存。尚未嘗試 {remaining} 個：{unattempted}（另 {unattemptedOmitted} 個未列出）。已停止本批，不會自動重試。請先核對素材清單，再決定是否重新匯入，不要整批重新選取。"
    },
    "en": {
      "one": "Import confirmed for {count} file: {files} ({omitted} more not listed). Outcome unknown: {current}. The request was sent without a valid acknowledgement; the asset may be saved. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically. Check the asset list before importing again; do not reselect the whole batch.",
      "other": "Import confirmed for {count} files: {files} ({omitted} more not listed). Outcome unknown: {current}. The request was sent without a valid acknowledgement; the asset may be saved. Files not attempted: {remaining}. Unattempted files: {unattempted} ({unattemptedOmitted} more not listed). This batch stopped and will not retry automatically. Check the asset list before importing again; do not reselect the whole batch."
    },
    "ja": {
      "one": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。結果不明：{current}。リクエストは送信済みですが有効な確認応答がなく、素材が保存された可能性があります。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。素材一覧を確認してから再読み込みを判断し、バッチ全体を選び直さないでください。",
      "other": "{count} ファイルの読み込みを確認しました：{files}（他 {omitted} 件省略）。結果不明：{current}。リクエストは送信済みですが有効な確認応答がなく、素材が保存された可能性があります。未試行は {remaining} ファイル：{unattempted}（他 {unattemptedOmitted} 件省略）。このバッチを停止しました。自動再試行は行いません。素材一覧を確認してから再読み込みを判断し、バッチ全体を選び直さないでください。"
    }
  },
  "shell.sync.last": {
    "zh-Hans": "最近同步：{time}",
    "zh-Hant": "最近同步：{time}",
    "en": "Last synced: {time}",
    "ja": "最終同期：{time}"
  },
  "shell.sync.disconnected": {
    "zh-Hans": "连接中断",
    "zh-Hant": "連線中斷",
    "en": "Disconnected",
    "ja": "接続が切れました"
  },
  "shell.sync.syncing": {
    "zh-Hans": "正在同步",
    "zh-Hant": "正在同步",
    "en": "Syncing",
    "ja": "同期中"
  },
  "shell.sync.unsaved": {
    "zh-Hans": "有未保存修改",
    "zh-Hant": "有尚未儲存的修改",
    "en": "Unsaved changes",
    "ja": "未保存の変更あり"
  },
  "shell.sync.saved": {
    "zh-Hans": "已保存",
    "zh-Hant": "已儲存",
    "en": "Saved",
    "ja": "保存済み"
  },
  "shell.sync.otherWindow": {
    "zh-Hans": "视图已在其他窗口更新",
    "zh-Hant": "檢視已在其他視窗更新",
    "en": "View updated in another window",
    "ja": "別のウィンドウで表示が更新されています"
  },
  "shell.sync.viewNotSynced": {
    "zh-Hans": "视图位置未同步",
    "zh-Hant": "檢視位置尚未同步",
    "en": "View position not synced",
    "ja": "表示位置は未同期です"
  },
  "shell.retry": {
    "zh-Hans": "重试",
    "zh-Hant": "重試",
    "en": "Retry",
    "ja": "再試行"
  },
  "shell.sync.loadSaved": {
    "zh-Hans": "载入已保存视图",
    "zh-Hant": "載入已儲存的檢視",
    "en": "Load saved view",
    "ja": "保存済みの表示を読み込む"
  },
  "shell.sync.savingView": {
    "zh-Hans": "保存视图…",
    "zh-Hant": "正在儲存檢視…",
    "en": "Saving view…",
    "ja": "表示を保存中…"
  },
  "shell.panel.assetsWidth": {
    "zh-Hans": "素材库宽度",
    "zh-Hant": "素材庫寬度",
    "en": "Asset library width",
    "ja": "素材ライブラリの幅"
  },
  "shell.panel.inspectorWidth": {
    "zh-Hans": "属性面板宽度",
    "zh-Hant": "屬性面板寬度",
    "en": "Properties panel width",
    "ja": "プロパティパネルの幅"
  },
  "shell.panel.timelineHeight": {
    "zh-Hans": "时间线高度",
    "zh-Hant": "時間軸高度",
    "en": "Timeline height",
    "ja": "タイムラインの高さ"
  },
  "shell.panel.expand": {
    "zh-Hans": "展开{label}",
    "zh-Hant": "展開{label}",
    "en": "Expand {label}",
    "ja": "{label} を展開"
  },
  "shell.panel.resize": {
    "zh-Hans": "调整{label}",
    "zh-Hant": "調整{label}",
    "en": "Resize {label}",
    "ja": "{label} を調整"
  },
  "shell.panel.pixels": {
    "zh-Hans": {
      "one": "{count} 像素",
      "other": "{count} 像素"
    },
    "zh-Hant": {
      "one": "{count} 像素",
      "other": "{count} 像素"
    },
    "en": {
      "one": "{count} pixel",
      "other": "{count} pixels"
    },
    "ja": {
      "one": "{count} ピクセル",
      "other": "{count} ピクセル"
    }
  },
  "shell.panel.resizeHint": {
    "zh-Hans": "拖动调整{label} · 方向键 10px · Shift 50px · 双击重置",
    "zh-Hant": "拖曳調整{label} · 方向鍵 10px · Shift 50px · 按兩下重設",
    "en": "Drag to resize {label} · Arrow keys 10px · Shift 50px · Double-click to reset",
    "ja": "ドラッグで {label} を調整・矢印キー 10px・Shift 50px・ダブルクリックでリセット"
  },
  "shell.panel.menu": {
    "zh-Hans": "面板",
    "zh-Hant": "面板",
    "en": "Panels",
    "ja": "パネル"
  },
  "shell.panel.canvas": {
    "zh-Hans": "画板面板",
    "zh-Hant": "畫板面板",
    "en": "Canvas panels",
    "ja": "キャンバスのパネル"
  },
  "shell.panel.editing": {
    "zh-Hans": "剪辑面板",
    "zh-Hant": "剪輯面板",
    "en": "Editing panels",
    "ja": "編集のパネル"
  },
  "shell.panel.multitrack": {
    "zh-Hans": "多轨时间线",
    "zh-Hant": "多軌時間軸",
    "en": "Multitrack timeline",
    "ja": "マルチトラックタイムライン"
  },
  "shell.panel.reset": {
    "zh-Hans": "重置当前工作区布局",
    "zh-Hant": "重設目前工作區配置",
    "en": "Reset current workspace layout",
    "ja": "現在のワークスペース配置をリセット"
  },
  "assets.waitFirstVisual": {
    "zh-Hans": "等待你的第一个画面",
    "zh-Hant": "等待你的第一個畫面",
    "en": "Waiting for your first visual",
    "ja": "最初の映像を待っています"
  },
  "assets.audioAsset": {
    "zh-Hans": "音频素材",
    "zh-Hant": "音訊素材",
    "en": "Audio asset",
    "ja": "音声素材"
  },
  "assets.shotReference": {
    "zh-Hans": "镜头参考图",
    "zh-Hant": "鏡頭參考圖",
    "en": "Shot reference image",
    "ja": "ショットの参照画像"
  },
  "shell.node.shotVisualInput": {
    "zh-Hans": "镜头视觉连线输入，不参与生成",
    "zh-Hant": "鏡頭視覺連線輸入，不參與生成",
    "en": "Shot visual-link input; not used in generation",
    "ja": "ショットの視覚的リンク入力。生成には使いません"
  },
  "shell.node.visualOnly": {
    "zh-Hans": "视觉连线 · 不参与生成",
    "zh-Hant": "視覺連線 · 不參與生成",
    "en": "Visual link · Not used in generation",
    "ja": "視覚的なリンク・生成には使いません"
  },
  "shell.node.referenceInput": {
    "zh-Hans": "首帧参考输入",
    "zh-Hant": "首幀參考輸入",
    "en": "First-frame reference input",
    "ja": "開始フレーム参照入力"
  },
  "shell.node.referenceInputHint": {
    "zh-Hans": "将图片的首帧输出连接到这里",
    "zh-Hant": "將圖片的首幀輸出連接至這裡",
    "en": "Connect an image’s first-frame output here",
    "ja": "画像の開始フレーム出力をここに接続"
  },
  "shell.node.firstFrameInput": {
    "zh-Hans": "首帧输入",
    "zh-Hant": "首幀輸入",
    "en": "First-frame input",
    "ja": "開始フレーム入力"
  },
  "shell.node.mock": {
    "zh-Hans": " · 模拟",
    "zh-Hant": " · 模擬",
    "en": " · Mock",
    "ja": "・モック"
  },
  "shell.node.promptPlaceholder": {
    "zh-Hans": "写下这个镜头的画面、动作与光线…",
    "zh-Hant": "寫下這個鏡頭的畫面、動作與光線…",
    "en": "Describe the shot’s visuals, action, and lighting…",
    "ja": "ショットの映像、動き、光を描写してください…"
  },
  "shell.node.versionSelected": {
    "zh-Hans": "已选用版本",
    "zh-Hant": "已選用版本",
    "en": "Version selected",
    "ja": "バージョン選択済み"
  },
  "shell.node.awaitingGeneration": {
    "zh-Hans": "待生成",
    "zh-Hant": "待生成",
    "en": "Awaiting generation",
    "ja": "生成待ち"
  },
  "shell.node.referenceCount": {
    "zh-Hans": {
      "one": "{count} 张参考",
      "other": "{count} 张参考"
    },
    "zh-Hant": {
      "one": "{count} 張參考",
      "other": "{count} 張參考"
    },
    "en": {
      "one": "{count} reference",
      "other": "{count} references"
    },
    "ja": {
      "one": "参照 {count} 枚",
      "other": "参照 {count} 枚"
    }
  },
  "shell.node.firstFrameSource": {
    "zh-Hans": "首帧 · {name}",
    "zh-Hant": "首幀 · {name}",
    "en": "First frame · {name}",
    "ja": "開始フレーム・{name}"
  },
  "shell.node.versionCount": {
    "zh-Hans": {
      "one": "{count} 个版本",
      "other": "{count} 个版本"
    },
    "zh-Hant": {
      "one": "{count} 個版本",
      "other": "{count} 個版本"
    },
    "en": {
      "one": "{count} version",
      "other": "{count} versions"
    },
    "ja": {
      "one": "{count} バージョン",
      "other": "{count} バージョン"
    }
  },
  "shell.node.generateNamed": {
    "zh-Hans": "生成 {name}",
    "zh-Hant": "生成 {name}",
    "en": "Generate {name}",
    "ja": "{name} を生成"
  },
  "shell.node.generateProvider": {
    "zh-Hans": "使用 {provider} 生成；参数与右侧设置一致",
    "zh-Hant": "使用 {provider} 生成；參數與右側設定一致",
    "en": "Generate with {provider}; uses the settings on the right",
    "ja": "{provider} で生成。右側の設定を使用します"
  },
  "shell.node.chooseProvider": {
    "zh-Hans": "在右侧选择生成服务商",
    "zh-Hant": "在右側選擇生成服務商",
    "en": "Choose a generation provider on the right",
    "ja": "右側で生成サービス提供元を選択"
  },
  "shell.generate": {
    "zh-Hans": "生成",
    "zh-Hant": "生成",
    "en": "Generate",
    "ja": "生成"
  },
  "shell.node.shotVisualOutput": {
    "zh-Hans": "镜头视觉连线输出，不参与生成",
    "zh-Hant": "鏡頭視覺連線輸出，不參與生成",
    "en": "Shot visual-link output; not used in generation",
    "ja": "ショットの視覚的リンク出力。生成には使いません"
  },
  "shell.node.assetVisualInput": {
    "zh-Hans": "素材视觉连线输入，不参与生成",
    "zh-Hant": "素材視覺連線輸入，不參與生成",
    "en": "Asset visual-link input; not used in generation",
    "ja": "素材の視覚的リンク入力。生成には使いません"
  },
  "assets.reference": {
    "zh-Hans": "参考素材",
    "zh-Hant": "參考素材",
    "en": "Reference asset",
    "ja": "参照素材"
  },
  "shell.node.connectReference": {
    "zh-Hans": "连接首帧到镜头",
    "zh-Hant": "連接首幀至鏡頭",
    "en": "Connect first frame to shot",
    "ja": "開始フレームをショットに接続"
  },
  "shell.node.referenceOutput": {
    "zh-Hans": "首帧参考输出",
    "zh-Hant": "首幀參考輸出",
    "en": "First-frame reference output",
    "ja": "開始フレーム参照出力"
  },
  "shell.node.referenceOutputHint": {
    "zh-Hans": "连接到镜头的首帧输入，作为生成参考图",
    "zh-Hant": "連接至鏡頭的首幀輸入，作為生成參考圖",
    "en": "Connect to a shot’s first-frame input as a generation reference",
    "ja": "ショットの開始フレーム入力へ接続して生成の参照画像として使用"
  },
  "shell.node.firstFrameOutput": {
    "zh-Hans": "首帧输出",
    "zh-Hant": "首幀輸出",
    "en": "First-frame output",
    "ja": "開始フレーム出力"
  },
  "shell.node.assetVisualOutput": {
    "zh-Hans": "素材视觉连线输出，不参与生成",
    "zh-Hant": "素材視覺連線輸出，不參與生成",
    "en": "Asset visual-link output; not used in generation",
    "ja": "素材の視覚的リンク出力。生成には使いません"
  },
  "shell.node.noteVisualInput": {
    "zh-Hans": "笔记视觉连线输入，不参与生成",
    "zh-Hant": "筆記視覺連線輸入，不參與生成",
    "en": "Note visual-link input; not used in generation",
    "ja": "メモの視覚的リンク入力。生成には使いません"
  },
  "shell.node.noteVisualOutput": {
    "zh-Hans": "笔记视觉连线输出，不参与生成",
    "zh-Hant": "筆記視覺連線輸出，不參與生成",
    "en": "Note visual-link output; not used in generation",
    "ja": "メモの視覚的リンク出力。生成には使いません"
  },
  "shell.node.notePlaceholder": {
    "zh-Hans": "一个想法，一段情绪，一条故事线。\n\n选中卡片，在右侧写下你的灵感。",
    "zh-Hant": "一個想法，一段情緒，一條故事線。\n\n選取卡片，在右側寫下你的靈感。",
    "en": "An idea, a feeling, a storyline.\n\nSelect the card and capture your inspiration on the right.",
    "ja": "アイデア、感情、ストーリーの流れ。\n\nカードを選択して、右側にひらめきを書き留めましょう。"
  },
  "inspector.confirm.textMode": {
    "zh-Hans": "切换为文生视频会清除此镜头的首帧与尾帧参考图选择，素材库中的原图会保留。继续？",
    "zh-Hant": "切換為文字生成影片會清除此鏡頭的首幀與尾幀參考圖選擇，素材庫中的原圖會保留。是否繼續？",
    "en": "Switching to text-to-video clears this shot’s first- and last-frame reference selections. Original images remain in the library. Continue?",
    "ja": "テキストから動画に切り替えると、このショットの開始・終了フレームの参照選択がクリアされます。ライブラリの元画像は保持されます。続けますか？"
  },
  "inspector.confirm.clearLastFrame": {
    "zh-Hans": "清除此镜头的尾帧参考图选择？首帧选择与素材库中的原图会保留。",
    "zh-Hant": "清除此鏡頭的尾幀參考圖選擇？首幀選擇與素材庫中的原圖會保留。",
    "en": "Clear this shot’s last-frame reference selection? The first-frame selection and original library images will be retained.",
    "ja": "このショットの終了フレーム参照をクリアしますか？開始フレームの選択とライブラリの元画像は保持されます。"
  },
  "inspector.confirm.clearManual": {
    "zh-Hans": "清除此镜头的手动参考图选择？素材库中的原图会保留。保存修改后才能连接首帧节点。",
    "zh-Hant": "清除此鏡頭的手動參考圖選擇？素材庫中的原圖會保留。儲存修改後才能連接首幀節點。",
    "en": "Clear this shot’s manual reference selections? Original library images will be retained. Save the changes before connecting a first-frame node.",
    "ja": "このショットの手動の参照画像選択をクリアしますか？ライブラリの元画像は保持されます。変更を保存してから開始フレームのノードを接続できます。"
  },
  "inspector.title": {
    "zh-Hans": "创作面板",
    "zh-Hant": "創作面板",
    "en": "Creative panel",
    "ja": "制作パネル"
  },
  "inspector.emptyTitle": {
    "zh-Hans": "让灵感成为镜头",
    "zh-Hant": "讓靈感成為鏡頭",
    "en": "Turn ideas into shots",
    "ja": "ひらめきをショットに"
  },
  "inspector.emptyHint": {
    "zh-Hans": "选择画布中的一个镜头，编辑画面描述、参考图和生成参数。",
    "zh-Hant": "選取畫布中的鏡頭，編輯畫面描述、參考圖與生成參數。",
    "en": "Select a shot on the canvas to edit its visual description, references, and generation settings.",
    "ja": "キャンバスのショットを選択し、映像の説明、参照画像、生成設定を編集します。"
  },
  "inspector.stepImport": {
    "zh-Hans": "导入参考素材",
    "zh-Hant": "匯入參考素材",
    "en": "Import reference assets",
    "ja": "参照素材を読み込む"
  },
  "inspector.stepWrite": {
    "zh-Hans": "编写镜头与提示词",
    "zh-Hant": "編寫鏡頭與提示詞",
    "en": "Write shots and prompts",
    "ja": "ショットとプロンプトを作成"
  },
  "inspector.stepGenerate": {
    "zh-Hans": "生成、比较并编排",
    "zh-Hant": "生成、比較並編排",
    "en": "Generate, compare, and arrange",
    "ja": "生成・比較・構成"
  },
  "inspector.organizationHint": {
    "zh-Hans": "画布组织空间关系；分镜安排故事顺序；多轨时间线决定时序、叠层和声音。",
    "zh-Hant": "畫布用於組織空間關係；分鏡安排故事順序；多軌時間軸決定時序、疊層與聲音。",
    "en": "The canvas organizes spatial relationships, the storyboard sets story order, and the multitrack timeline controls timing, layers, and sound.",
    "ja": "キャンバスで空間的な関係を整理し、ストーリーボードで物語の順序を決め、マルチトラックタイムラインでタイミング、レイヤー、音を構成します。"
  },
  "inspector.textNote": {
    "zh-Hans": "文字笔记",
    "zh-Hant": "文字筆記",
    "en": "Text note",
    "ja": "テキストメモ"
  },
  "inspector.assetNode": {
    "zh-Hans": "素材节点",
    "zh-Hant": "素材節點",
    "en": "Asset node",
    "ja": "素材ノード"
  },
  "inspector.nodeName": {
    "zh-Hans": "节点名称",
    "zh-Hant": "節點名稱",
    "en": "Node name",
    "ja": "ノード名"
  },
  "inspector.textContent": {
    "zh-Hans": "文字内容",
    "zh-Hant": "文字內容",
    "en": "Text content",
    "ja": "テキスト内容"
  },
  "inspector.notePlaceholder": {
    "zh-Hans": "写下故事、场景或创作方向…",
    "zh-Hant": "寫下故事、場景或創作方向…",
    "en": "Describe a story, scene, or creative direction…",
    "ja": "ストーリー、シーン、制作方針を書き留めましょう…"
  },
  "inspector.nodeConflict": {
    "zh-Hans": "其他编辑已更新此节点。",
    "zh-Hant": "其他編輯已更新此節點。",
    "en": "This node was updated by another edit.",
    "ja": "別の編集でこのノードが更新されています。"
  },
  "inspector.loadLatest": {
    "zh-Hans": "载入最新内容",
    "zh-Hant": "載入最新內容",
    "en": "Load latest content",
    "ja": "最新の内容を読み込む"
  },
  "inspector.saveNode": {
    "zh-Hans": "保存节点",
    "zh-Hant": "儲存節點",
    "en": "Save node",
    "ja": "ノードを保存"
  },
  "inspector.discard": {
    "zh-Hans": "放弃修改",
    "zh-Hant": "放棄修改",
    "en": "Discard changes",
    "ja": "変更を破棄"
  },
  "inspector.visualLinkHint": {
    "zh-Hans": "灰色端口创建视觉连线，仅用于整理思路，不参与生成。点击视觉连线后可按 Delete 删除。",
    "zh-Hant": "灰色連接埠建立視覺連線，僅用於整理思路，不參與生成。點選視覺連線後可按 Delete 刪除。",
    "en": "Gray ports create visual links for organization only, not generation. Select a visual link and press Delete to remove it.",
    "ja": "灰色のポートは整理専用の視覚的リンクを作成し、生成には使いません。リンクを選択して Delete を押すと削除できます。"
  },
  "inspector.shotSettings": {
    "zh-Hans": "镜头设置",
    "zh-Hant": "鏡頭設定",
    "en": "Shot settings",
    "ja": "ショット設定"
  },
  "inspector.shotPanel": {
    "zh-Hans": "镜头面板",
    "zh-Hant": "鏡頭面板",
    "en": "Shot panel",
    "ja": "ショットパネル"
  },
  "inspector.parameters": {
    "zh-Hans": "创作参数",
    "zh-Hant": "創作參數",
    "en": "Creative settings",
    "ja": "制作設定"
  },
  "inspector.versions": {
    "zh-Hans": "版本历史",
    "zh-Hant": "版本歷程",
    "en": "Version history",
    "ja": "バージョン履歴"
  },
  "inspector.explore": {
    "zh-Hans": "探索不同的可能",
    "zh-Hant": "探索不同的可能",
    "en": "Explore the possibilities",
    "ja": "さまざまな可能性を探る"
  },
  "inspector.compare": {
    "zh-Hans": "比较",
    "zh-Hant": "比較",
    "en": "Compare",
    "ja": "比較"
  },
  "inspector.mock": {
    "zh-Hans": "模拟",
    "zh-Hant": "模擬",
    "en": "Mock",
    "ja": "モック"
  },
  "inspector.noPrompt": {
    "zh-Hans": "未填写提示词",
    "zh-Hant": "尚未填寫提示詞",
    "en": "No prompt entered",
    "ja": "プロンプト未入力"
  },
  "inspector.selected": {
    "zh-Hans": "当前选用",
    "zh-Hant": "目前選用",
    "en": "Selected",
    "ja": "選択中"
  },
  "inspector.selectVersion": {
    "zh-Hans": "选用此版本",
    "zh-Hant": "選用此版本",
    "en": "Select this version",
    "ja": "このバージョンを選択"
  },
  "inspector.addFixedVersion": {
    "zh-Hans": "将此固定版本加入时间线",
    "zh-Hant": "將此固定版本加入時間軸",
    "en": "Add this fixed version to timeline",
    "ja": "この固定バージョンをタイムラインに追加"
  },
  "inspector.noVersions": {
    "zh-Hans": "还没有生成版本",
    "zh-Hant": "還沒有生成版本",
    "en": "No generated versions yet",
    "ja": "生成バージョンはまだありません"
  },
  "inspector.versionScope": {
    "zh-Hans": "每次生成都保存为独立版本。你可以随时比较、切换，不会覆盖已有结果。",
    "zh-Hant": "每次生成皆儲存為獨立版本。可隨時比較、切換，不會覆寫既有結果。",
    "en": "Each generation is saved as a separate version. Compare and switch anytime without overwriting existing results.",
    "ja": "生成ごとに別のバージョンとして保存します。既存の結果を上書きせず、いつでも比較や切り替えができます。"
  },
  "inspector.start": {
    "zh-Hans": "开始创作",
    "zh-Hant": "開始創作",
    "en": "Start creating",
    "ja": "制作を始める"
  },
  "inspector.selectedToTimeline": {
    "zh-Hans": "当前选用版本 → 时间线（固定副本）",
    "zh-Hant": "目前選用版本 → 時間軸（固定副本）",
    "en": "Selected version → Timeline (fixed copy)",
    "ja": "選択中のバージョン → タイムライン（固定コピー）"
  },
  "inspector.unsaved": {
    "zh-Hans": "未保存",
    "zh-Hant": "尚未儲存",
    "en": "Unsaved",
    "ja": "未保存"
  },
  "inspector.synced": {
    "zh-Hans": "已同步",
    "zh-Hant": "已同步",
    "en": "Synced",
    "ja": "同期済み"
  },
  "inspector.shotName": {
    "zh-Hans": "镜头名称",
    "zh-Hant": "鏡頭名稱",
    "en": "Shot name",
    "ja": "ショット名"
  },
  "inspector.visualDescription": {
    "zh-Hans": "画面描述",
    "zh-Hant": "畫面描述",
    "en": "Visual description",
    "ja": "映像の説明"
  },
  "inspector.promptPlaceholder": {
    "zh-Hans": "描述主体、动作、环境与镜头运动。例如：镜头缓慢推近，晨光穿过薄雾…",
    "zh-Hant": "描述主體、動作、環境與鏡頭運動。例如：鏡頭緩慢推近，晨光穿過薄霧…",
    "en": "Describe subjects, action, setting, and camera movement. For example: the camera slowly pushes in as morning light cuts through the mist…",
    "ja": "被写体、動き、環境、カメラワークを描写します。例：朝の光が霧を通り抜ける中、カメラがゆっくり近づく…"
  },
  "inspector.promptHint": {
    "zh-Hans": "描述越具体，越接近你心中的画面。",
    "zh-Hant": "描述越具體，越接近你心中的畫面。",
    "en": "More specific descriptions bring you closer to the image you envision.",
    "ja": "具体的に描写するほど、思い描く映像に近づきます。"
  },
  "inspector.textSaveOrder": {
    "zh-Hans": "请先保存标题和提示词或处理文字恢复记录，再保存其余参考图和生成参数。完整“保存修改”不会跳过文字修改。",
    "zh-Hant": "請先儲存標題與提示詞或處理文字還原記錄，再儲存其餘參考圖與生成參數。完整的「儲存修改」不會跳過文字修改。",
    "en": "Save the title and prompt or resolve text recovery records before saving other references and generation settings. Save changes does not bypass text edits.",
    "ja": "タイトルとプロンプトを保存するか、テキストの復元記録を処理してから、他の参照画像や生成設定を保存してください。「変更を保存」でテキストの変更を飛ばすことはできません。"
  },
  "inspector.generationMode": {
    "zh-Hans": "生成方式",
    "zh-Hant": "生成方式",
    "en": "Generation mode",
    "ja": "生成方法"
  },
  "inspector.unsupported": {
    "zh-Hans": " · 不支持",
    "zh-Hant": " · 不支援",
    "en": " · Unsupported",
    "ja": "・非対応"
  },
  "inspector.referencePending": {
    "zh-Hans": "首帧连接操作结果待确认。请在任务面板恢复同一请求，再保存或生成。",
    "zh-Hant": "首幀連線操作的結果待確認。請在工作面板還原同一請求，再儲存或生成。",
    "en": "The first-frame connection result awaits confirmation. Restore that same request in the task panel before saving or generating.",
    "ja": "開始フレーム接続の操作結果は確認待ちです。タスクパネルで同じリクエストを復元してから保存や生成を行ってください。"
  },
  "inspector.openTasks": {
    "zh-Hans": "打开任务",
    "zh-Hant": "開啟工作",
    "en": "Open tasks",
    "ja": "タスクを開く"
  },
  "inspector.subjectScope": {
    "zh-Hans": "本次发送上方明确固定的主体图片；不会读取策划关联或修改画面描述。",
    "zh-Hant": "本次會傳送上方明確固定的主體圖片；不會讀取策劃關聯或修改畫面描述。",
    "en": "This sends the explicitly fixed subject images above. It does not read planning links or change the visual description.",
    "ja": "上記の明示的に固定した被写体画像を送信します。企画リンクの読み取りや映像の説明の変更は行いません。"
  },
  "inspector.textModeHint": {
    "zh-Hans": "只发送画面描述与生成参数，不发送参考图。选择图生视频可使用首帧图片。",
    "zh-Hant": "僅傳送畫面描述與生成參數，不傳送參考圖。選擇圖片生成影片即可使用首幀圖片。",
    "en": "Only the visual description and generation parameters are sent, not reference images. Choose image-to-video to use a first-frame image.",
    "ja": "映像の説明と生成パラメーターのみを送信し、参照画像は送信しません。画像から動画を選ぶと開始フレームの画像を使えます。"
  },
  "inspector.firstFrame": {
    "zh-Hans": "首帧参考图",
    "zh-Hant": "首幀參考圖",
    "en": "First-frame reference image",
    "ja": "開始フレームの参照画像"
  },
  "inspector.importReferenceHint": {
    "zh-Hans": "先在左侧导入一张图片作为参考。",
    "zh-Hant": "請先在左側匯入一張圖片作為參考。",
    "en": "Import an image on the left to use as a reference.",
    "ja": "まず左側で参照用の画像を読み込んでください。"
  },
  "inspector.clearManual": {
    "zh-Hans": "清除手动参考图选择",
    "zh-Hant": "清除手動參考圖選擇",
    "en": "Clear manual reference selection",
    "ja": "手動の参照画像選択をクリア"
  },
  "inspector.boundReferenceHint": {
    "zh-Hans": "参考图由首帧连接管理，断开后才能手动选择。",
    "zh-Hant": "參考圖由首幀連線管理，中斷後才能手動選擇。",
    "en": "The first-frame connection manages the reference. Disconnect it before selecting manually.",
    "ja": "参照画像は開始フレームの接続で管理されています。手動で選ぶには接続を解除してください。"
  },
  "inspector.firstFrameImage": {
    "zh-Hans": "首帧图片",
    "zh-Hant": "首幀圖片",
    "en": "First-frame image",
    "ja": "開始フレームの画像"
  },
  "inspector.matchAspect": {
    "zh-Hans": " · 图片比例必须与镜头一致",
    "zh-Hant": " · 圖片比例須與鏡頭一致",
    "en": " · Image aspect ratio must match the shot",
    "ja": "・画像のアスペクト比はショットと一致する必要があります"
  },
  "inspector.aspectRatio": {
    "zh-Hans": "画面比例",
    "zh-Hant": "畫面比例",
    "en": "Aspect ratio",
    "ja": "アスペクト比"
  },
  "inspector.shotDuration": {
    "zh-Hans": "镜头时长",
    "zh-Hant": "鏡頭時長",
    "en": "Shot duration",
    "ja": "ショットの長さ"
  },
  "inspector.shotConflict": {
    "zh-Hans": "此镜头已在别处更新。你的输入还在，请先载入最新内容再继续。",
    "zh-Hant": "此鏡頭已在別處更新。輸入仍保留，請先載入最新內容再繼續。",
    "en": "This shot was updated elsewhere. Your input is retained. Load the latest content before continuing.",
    "ja": "このショットは別の場所で更新されています。入力は保持されています。最新の内容を読み込んでから続けてください。"
  },
  "inspector.saveChanges": {
    "zh-Hans": "保存修改",
    "zh-Hant": "儲存修改",
    "en": "Save changes",
    "ja": "変更を保存"
  },
  "inspector.advanced": {
    "zh-Hans": "高级参数",
    "zh-Hant": "進階參數",
    "en": "Advanced settings",
    "ja": "詳細設定"
  },
  "inspector.mockScenario": {
    "zh-Hans": "模拟场景",
    "zh-Hant": "模擬情境",
    "en": "Mock scenario",
    "ja": "モックシナリオ"
  },
  "inspector.mockSuccess": {
    "zh-Hans": "正常完成",
    "zh-Hant": "正常完成",
    "en": "Complete normally",
    "ja": "正常完了"
  },
  "inspector.mockFailure": {
    "zh-Hans": "明确失败（可手动重试）",
    "zh-Hant": "明確失敗（可手動重試）",
    "en": "Definitive failure (manual retry allowed)",
    "ja": "明確な失敗（手動再試行可）"
  },
  "inspector.mockDelay": {
    "zh-Hans": "延迟完成",
    "zh-Hant": "延遲完成",
    "en": "Delayed completion",
    "ja": "遅延完了"
  },
  "inspector.mockTimeout": {
    "zh-Hans": "请求超时",
    "zh-Hant": "請求逾時",
    "en": "Request timeout",
    "ja": "リクエストのタイムアウト"
  },
  "inspector.mockUnknown": {
    "zh-Hans": "提交状态未知（禁止重提）",
    "zh-Hant": "提交狀態未知（禁止重新提交）",
    "en": "Submission unknown (resubmission blocked)",
    "ja": "送信状態不明（再送信禁止）"
  },
  "inspector.seed": {
    "zh-Hans": "随机种子（可选）",
    "zh-Hant": "隨機種子（選填）",
    "en": "Random seed (optional)",
    "ja": "乱数シード（任意）"
  },
  "inspector.seedUnsupported": {
    "zh-Hans": "此模型不支持，请清空",
    "zh-Hant": "此模型不支援，請清空",
    "en": "Unsupported by this model; clear the value",
    "ja": "このモデルでは非対応です。値をクリアしてください"
  },
  "inspector.automatic": {
    "zh-Hans": "自动",
    "zh-Hant": "自動",
    "en": "Automatic",
    "ja": "自動"
  },
  "inspector.clearUnsupported": {
    "zh-Hans": "清除不支持的参数",
    "zh-Hant": "清除不支援的參數",
    "en": "Clear unsupported parameters",
    "ja": "非対応のパラメーターをクリア"
  },
  "inspector.historyScope": {
    "zh-Hans": "参数和参考图随每次生成保存快照，修改镜头不会改变历史版本。",
    "zh-Hant": "每次生成會儲存參數與參考圖的快照，修改鏡頭不會變更歷史版本。",
    "en": "Parameters and reference images are snapshotted for each generation. Editing a shot does not change historical versions.",
    "ja": "生成ごとにパラメーターと参照画像のスナップショットを保存します。ショットを編集しても過去のバージョンは変わりません。"
  },
  "inspector.billingUnknown": {
    "zh-Hans": "服务商可能已接受任务并计费。先核实状态，不要重复提交。",
    "zh-Hant": "服務商可能已接受工作並計費。請先核實狀態，不要重複提交。",
    "en": "The provider may have accepted and billed the task. Verify its status first; do not submit again.",
    "ja": "サービス提供元がタスクを受理し、課金済みの可能性があります。まず状態を確認し、重複送信しないでください。"
  },
  "inspector.saveTextFirst": {
    "zh-Hans": "先点上方“保存标题和提示词”，再生成镜头。",
    "zh-Hant": "請先點選上方的「儲存標題與提示詞」，再生成鏡頭。",
    "en": "Click Save title and prompt above before generating the shot.",
    "ja": "上の「タイトルとプロンプトを保存」をクリックしてからショットを生成してください。"
  },
  "inspector.nameRequired": {
    "zh-Hans": "镜头名称不能为空。",
    "zh-Hant": "鏡頭名稱不可為空白。",
    "en": "Shot name is required.",
    "ja": "ショット名を入力してください。"
  },
  "inspector.saveGenerate": {
    "zh-Hans": "保存并生成镜头",
    "zh-Hant": "儲存並生成鏡頭",
    "en": "Save and generate shot",
    "ja": "保存してショットを生成"
  },
  "inspector.generateShot": {
    "zh-Hans": "生成镜头",
    "zh-Hant": "生成鏡頭",
    "en": "Generate shot",
    "ja": "ショットを生成"
  },
  "inspector.clipSourceVersion": {
    "zh-Hans": "片段来源：版本 {number}",
    "zh-Hant": "片段來源：版本 {number}",
    "en": "Clip source: version {number}",
    "ja": "クリップのソース：バージョン {number}"
  },
  "inspector.fixedSourceVersion": {
    "zh-Hans": "当前片段的固定来源 · 版本 {number}",
    "zh-Hant": "目前片段的固定來源 · 版本 {number}",
    "en": "Current clip’s fixed source · Version {number}",
    "ja": "現在のクリップの固定ソース・バージョン {number}"
  },
  "inspector.characterCount": {
    "zh-Hans": {
      "one": "{count} / {limit} 字符",
      "other": "{count} / {limit} 字符"
    },
    "zh-Hant": {
      "one": "{count} / {limit} 個字元",
      "other": "{count} / {limit} 個字元"
    },
    "en": {
      "one": "{count} / {limit} characters",
      "other": "{count} / {limit} characters"
    },
    "ja": {
      "one": "{count} / {limit} 文字",
      "other": "{count} / {limit} 文字"
    }
  },
  "inspector.selectedReferences": {
    "zh-Hans": "已选 {count}",
    "zh-Hant": "已選取 {count}",
    "en": "{count} selected",
    "ja": "{count} 件選択"
  },
  "inspector.referenceNamed": {
    "zh-Hans": "参考图 {name}",
    "zh-Hant": "參考圖 {name}",
    "en": "Reference image {name}",
    "ja": "参照画像 {name}"
  },
  "inspector.minDimension": {
    "zh-Hans": " · 最短边至少 {dimension}px",
    "zh-Hant": " · 最短邊至少 {dimension}px",
    "en": " · Shortest side at least {dimension}px",
    "ja": "・短辺は {dimension}px 以上"
  },
  "inspector.maxDimension": {
    "zh-Hans": " · 最长边不超过 {dimension}px",
    "zh-Hant": " · 最長邊不超過 {dimension}px",
    "en": " · Longest side at most {dimension}px",
    "ja": "・長辺は {dimension}px 以下"
  },
  "inspector.seedRange": {
    "zh-Hans": "整数范围 {min}–{max}",
    "zh-Hant": "整數範圍 {min}–{max}",
    "en": "Integer range {min}–{max}",
    "ja": "整数の範囲 {min}–{max}"
  },
  "inspector.unsupportedParameters": {
    "zh-Hans": "此模型不支持：{parameters}",
    "zh-Hant": "此模型不支援：{parameters}",
    "en": "Unsupported by this model: {parameters}",
    "ja": "このモデルでは非対応：{parameters}"
  },
  "assets.all": {
    "zh-Hans": "全部",
    "zh-Hant": "全部",
    "en": "All",
    "ja": "すべて"
  },
  "assets.indexedLibrary": {
    "zh-Hans": "01 素材库",
    "zh-Hant": "01 素材庫",
    "en": "01 Asset library",
    "ja": "01 素材ライブラリ"
  },
  "assets.collapse": {
    "zh-Hans": "收起素材库",
    "zh-Hant": "收合素材庫",
    "en": "Collapse asset library",
    "ja": "素材ライブラリを折りたたむ"
  },
  "assets.assetsSubjects": {
    "zh-Hans": "素材与主体",
    "zh-Hant": "素材與主體",
    "en": "Assets and subjects",
    "ja": "素材と被写体"
  },
  "subjects.subjects": {
    "zh-Hans": "主体",
    "zh-Hant": "主體",
    "en": "Subjects",
    "ja": "被写体"
  },
  "assets.inspectEditHint": {
    "zh-Hans": "点击卡片查看源素材 · 拖到时间线编排",
    "zh-Hant": "點選卡片檢視來源素材 · 拖曳至時間軸編排",
    "en": "Click a card to inspect its source · Drag to the timeline to arrange",
    "ja": "カードをクリックしてソースを確認・タイムラインにドラッグして構成"
  },
  "assets.inspectCanvasHint": {
    "zh-Hans": "点击卡片快速预览 · 拖到画板构思",
    "zh-Hant": "點選卡片快速預覽 · 拖曳至畫板構思",
    "en": "Click a card to preview · Drag to the canvas to plan",
    "ja": "カードをクリックしてプレビュー・キャンバスにドラッグして構想"
  },
  "assets.importing": {
    "zh-Hans": "正在导入…",
    "zh-Hant": "正在匯入…",
    "en": "Importing…",
    "ja": "読み込み中…"
  },
  "assets.importMedia": {
    "zh-Hans": "导入图片 / 视频 / 音频",
    "zh-Hant": "匯入圖片／影片／音訊",
    "en": "Import images / video / audio",
    "ja": "画像・動画・音声を読み込む"
  },
  "assets.editHint": {
    "zh-Hans": "点击查看源素材 · 拖到时间线编排",
    "zh-Hant": "點選以檢視來源素材 · 拖曳至時間軸編排",
    "en": "Click to inspect source · Drag to the timeline to arrange",
    "ja": "クリックしてソースを確認・タイムラインにドラッグして構成"
  },
  "assets.canvasHint": {
    "zh-Hans": "点击快速预览 · 拖到画板构思",
    "zh-Hant": "點選以快速預覽 · 拖曳至畫板構思",
    "en": "Click to preview · Drag to the canvas to plan",
    "ja": "クリックしてプレビュー・キャンバスにドラッグして構想"
  },
  "assets.search": {
    "zh-Hans": "搜索素材",
    "zh-Hant": "搜尋素材",
    "en": "Search assets",
    "ja": "素材を検索"
  },
  "assets.searchPlaceholder": {
    "zh-Hans": "搜索素材…",
    "zh-Hant": "搜尋素材…",
    "en": "Search assets…",
    "ja": "素材を検索…"
  },
  "assets.markFilter": {
    "zh-Hans": "素材标记筛选",
    "zh-Hant": "素材標記篩選",
    "en": "Filter by asset mark",
    "ja": "素材のマークで絞り込み"
  },
  "assets.loadedCountHint": {
    "zh-Hans": "数量仅统计已加载素材",
    "zh-Hant": "數量僅統計已載入素材",
    "en": "Counts cover loaded assets only",
    "ja": "件数は読み込み済みの素材のみです"
  },
  "assets.readingSuffix": {
    "zh-Hans": " · 读取中",
    "zh-Hant": " · 讀取中",
    "en": " · Reading",
    "ja": "・読み取り中"
  },
  "assets.failedSuffix": {
    "zh-Hans": " · 有失败",
    "zh-Hant": " · 有失敗",
    "en": " · Some failed",
    "ja": "・一部失敗"
  },
  "assets.reloadMarks": {
    "zh-Hans": "重新读取标记",
    "zh-Hant": "重新讀取標記",
    "en": "Reload marks",
    "ja": "マークを再読み込み"
  },
  "shell.refresh": {
    "zh-Hans": "刷新",
    "zh-Hant": "重新整理",
    "en": "Refresh",
    "ja": "更新"
  },
  "assets.resetFilters": {
    "zh-Hans": "重置全部筛选",
    "zh-Hant": "重設全部篩選",
    "en": "Reset all filters",
    "ja": "すべてのフィルターをリセット"
  },
  "shell.reset": {
    "zh-Hans": "重置",
    "zh-Hant": "重設",
    "en": "Reset",
    "ja": "リセット"
  },
  "assets.type": {
    "zh-Hans": "素材类型",
    "zh-Hant": "素材類型",
    "en": "Asset type",
    "ja": "素材の種類"
  },
  "assets.markPending": {
    "zh-Hans": "有修改结果待确认，请在任务面板恢复同一请求。",
    "zh-Hant": "有修改結果待確認，請在工作面板還原同一請求。",
    "en": "A change awaits confirmation. Restore that same request in the task panel.",
    "ja": "変更結果が確認待ちです。タスクパネルで同じリクエストを復元してください。"
  },
  "assets.viewPending": {
    "zh-Hans": "查看待确认任务",
    "zh-Hant": "檢視待確認工作",
    "en": "View unconfirmed tasks",
    "ja": "未確認のタスクを表示"
  },
  "assets.selectedHidden": {
    "zh-Hans": "当前源素材未显示在筛选中",
    "zh-Hant": "目前來源素材未顯示在篩選中",
    "en": "Current source asset is hidden by filters",
    "ja": "現在のソース素材はフィルターで非表示です"
  },
  "assets.selectedHiddenHint": {
    "zh-Hans": "当前源素材不在筛选结果中，当前选择与未保存范围仍保留。",
    "zh-Hant": "目前來源素材不在篩選結果中，目前選擇與尚未儲存的範圍仍保留。",
    "en": "The current source is outside the filter results. Your selection and unsaved range are retained.",
    "ja": "現在のソース素材は絞り込み結果に含まれていません。現在の選択と未保存の範囲は保持されています。"
  },
  "assets.showAllKeepSelection": {
    "zh-Hans": "显示全部素材，保留当前选择",
    "zh-Hant": "顯示全部素材，保留目前選擇",
    "en": "Show all assets, keep selection",
    "ja": "選択を保持してすべての素材を表示"
  },
  "assets.generatedShot": {
    "zh-Hans": "生成镜头",
    "zh-Hant": "生成鏡頭",
    "en": "Generated shot",
    "ja": "生成ショット"
  },
  "assets.selected": {
    "zh-Hans": "已选用",
    "zh-Hant": "已選用",
    "en": "Selected",
    "ja": "選択済み"
  },
  "assets.addCanvasHint": {
    "zh-Hans": "以独立节点加入画布",
    "zh-Hant": "以獨立節點加入畫布",
    "en": "Add to canvas as an independent node",
    "ja": "独立したノードとしてキャンバスに追加"
  },
  "assets.addToCanvas": {
    "zh-Hans": "加入画板",
    "zh-Hant": "加入畫板",
    "en": "Add to canvas",
    "ja": "キャンバスに追加"
  },
  "assets.addTimelineHint": {
    "zh-Hans": "在首个兼容轨道末尾加入固定素材片段",
    "zh-Hant": "在第一條相容軌道的末尾加入固定素材片段",
    "en": "Add a fixed asset clip at the end of the first compatible track",
    "ja": "最初の対応トラックの末尾に固定素材クリップを追加"
  },
  "assets.addToEditing": {
    "zh-Hans": "加入剪辑",
    "zh-Hant": "加入剪輯",
    "en": "Add to edit",
    "ja": "編集に追加"
  },
  "assets.noMatches": {
    "zh-Hans": "没有匹配的素材",
    "zh-Hant": "沒有符合的素材",
    "en": "No matching assets",
    "ja": "一致する素材がありません"
  },
  "assets.emptyTitle": {
    "zh-Hans": "故事，从素材开始",
    "zh-Hant": "故事，從素材開始",
    "en": "Stories start with assets",
    "ja": "素材からストーリーを始める"
  },
  "assets.filterHint": {
    "zh-Hans": "试试其他筛选，或重置全部筛选。",
    "zh-Hant": "試試其他篩選，或重設全部篩選。",
    "en": "Try different filters or reset them all.",
    "ja": "別の条件で絞り込むか、すべてのフィルターをリセットしてください。"
  },
  "assets.emptyHint": {
    "zh-Hans": "拖入本地素材，或点击上方导入。",
    "zh-Hant": "拖入本機素材，或點選上方匯入。",
    "en": "Drop local assets here or click Import above.",
    "ja": "ローカル素材をドラッグするか、上の読み込みボタンをクリックしてください。"
  },
  "assets.localOnly": {
    "zh-Hans": "导入仅保存在本地",
    "zh-Hant": "匯入僅儲存在本機",
    "en": "Imports are saved locally only",
    "ja": "読み込んだ素材はローカルにのみ保存します"
  },
  "assets.loadingSummary": {
    "zh-Hans": "已加载 {count} · 已读 {read}",
    "zh-Hant": "已載入 {count} · 已讀取 {read}",
    "en": "Loaded {count} · Read {read}",
    "ja": "読み込み済み {count}・確認済み {read}"
  },
  "assets.unknownMarks": {
    "zh-Hans": {
      "one": "{count} 个状态未知，在标记筛选中仍显示。",
      "other": "{count} 个状态未知，在标记筛选中仍显示。"
    },
    "zh-Hant": {
      "one": "{count} 個狀態未知，仍會在標記篩選中顯示。",
      "other": "{count} 個狀態未知，仍會在標記篩選中顯示。"
    },
    "en": {
      "one": "{count} asset has unknown status and remains visible in mark filters.",
      "other": "{count} assets have unknown status and remain visible in mark filters."
    },
    "ja": {
      "one": "{count} 素材の状態が不明なため、マークで絞り込んでも表示を保持します。",
      "other": "{count} 素材の状態が不明なため、マークで絞り込んでも表示を保持します。"
    }
  },
  "assets.failedMarks": {
    "zh-Hans": {
      "one": "{count} 个素材标记读取失败，请重新读取。已确认的其他批次仍可使用。",
      "other": "{count} 个素材标记读取失败，请重新读取。已确认的其他批次仍可使用。"
    },
    "zh-Hant": {
      "one": "{count} 個素材標記讀取失敗，請重新讀取。已確認的其他批次仍可使用。",
      "other": "{count} 個素材標記讀取失敗，請重新讀取。已確認的其他批次仍可使用。"
    },
    "en": {
      "one": "Marks for {count} asset could not be read. Read again. Other confirmed batches remain usable.",
      "other": "Marks for {count} assets could not be read. Read again. Other confirmed batches remain usable."
    },
    "ja": {
      "one": "{count} 素材のマークを読み取れませんでした。再読み込みしてください。確認済みの他のバッチは引き続き使えます。",
      "other": "{count} 素材のマークを読み取れませんでした。再読み込みしてください。確認済みの他のバッチは引き続き使えます。"
    }
  },
  "assets.hiddenUsed": {
    "zh-Hans": {
      "one": "筛选隐藏了 {count} 个已用于画板或时间线的素材，已有引用和片段保持不变。",
      "other": "筛选隐藏了 {count} 个已用于画板或时间线的素材，已有引用和片段保持不变。"
    },
    "zh-Hant": {
      "one": "篩選隱藏了 {count} 個已用於畫板或時間軸的素材，既有參照與片段保持不變。",
      "other": "篩選隱藏了 {count} 個已用於畫板或時間軸的素材，既有參照與片段保持不變。"
    },
    "en": {
      "one": "Filters hide {count} asset used on the canvas or timeline. Existing references and clips are unchanged.",
      "other": "Filters hide {count} assets used on the canvas or timeline. Existing references and clips are unchanged."
    },
    "ja": {
      "one": "フィルターにより、キャンバスまたはタイムラインで使用中の {count} 素材が非表示です。既存の参照とクリップは変わりません。",
      "other": "フィルターにより、キャンバスまたはタイムラインで使用中の {count} 素材が非表示です。既存の参照とクリップは変わりません。"
    }
  },
  "assets.previewNamed": {
    "zh-Hans": "预览 {name}",
    "zh-Hant": "預覽 {name}",
    "en": "Preview {name}",
    "ja": "{name} をプレビュー"
  },
  "assets.generatedVersion": {
    "zh-Hans": "{name} · 版本 {number}",
    "zh-Hant": "{name} · 版本 {number}",
    "en": "{name} · Version {number}",
    "ja": "{name}・バージョン {number}"
  },
  "assets.addCanvasNamed": {
    "zh-Hans": "添加 {name} 到画布",
    "zh-Hant": "新增 {name} 至畫布",
    "en": "Add {name} to canvas",
    "ja": "{name} をキャンバスに追加"
  },
  "assets.addTimelineNamed": {
    "zh-Hans": "添加 {name} 到时间线",
    "zh-Hant": "新增 {name} 至時間軸",
    "en": "Add {name} to timeline",
    "ja": "{name} をタイムラインに追加"
  },
  "assets.mark.saving": {
    "zh-Hans": "正在保存标记…",
    "zh-Hant": "正在儲存標記…",
    "en": "Saving mark…",
    "ja": "マークを保存中…"
  },
  "assets.mark.loading": {
    "zh-Hans": "标记读取中",
    "zh-Hant": "正在讀取標記",
    "en": "Reading mark",
    "ja": "マークを読み取り中"
  },
  "assets.mark.unknown": {
    "zh-Hans": "标记状态未知",
    "zh-Hant": "標記狀態未知",
    "en": "Mark status unknown",
    "ja": "マークの状態は不明です"
  },
  "assets.mark.favorite": {
    "zh-Hans": "收藏",
    "zh-Hant": "收藏",
    "en": "Favorite",
    "ja": "お気に入り"
  },
  "assets.mark.rejected": {
    "zh-Hans": "拒选",
    "zh-Hant": "拒選",
    "en": "Reject",
    "ja": "不採用"
  },
  "assets.mark.clear": {
    "zh-Hans": "清除标记",
    "zh-Hant": "清除標記",
    "en": "Clear mark",
    "ja": "マークをクリア"
  },
  "assets.mark.neutral": {
    "zh-Hans": "未标记",
    "zh-Hant": "未標記",
    "en": "Unmarked",
    "ja": "マークなし"
  },
  "assets.mark.rejectHint": {
    "zh-Hans": "拒选仅作筛选标记，已有片段保持不变",
    "zh-Hant": "拒選僅作篩選標記，既有片段保持不變",
    "en": "Reject is only a filter mark; existing clips are unchanged",
    "ja": "不採用は絞り込み用のマークです。既存のクリップは変わりません"
  },
  "assets.mark.clearHint": {
    "zh-Hans": "恢复为未标记素材",
    "zh-Hant": "還原為未標記素材",
    "en": "Return to unmarked",
    "ja": "マークなしに戻す"
  },
  "assets.mark.favoriteHint": {
    "zh-Hans": "标为收藏",
    "zh-Hant": "標為收藏",
    "en": "Mark as favorite",
    "ja": "お気に入りにする"
  },
  "assets.mark.named": {
    "zh-Hans": "{name} 的素材标记",
    "zh-Hant": "{name} 的素材標記",
    "en": "Asset marks for {name}",
    "ja": "{name} の素材マーク"
  },
  "assets.mark.actionNamed": {
    "zh-Hans": "{action} {name}",
    "zh-Hant": "{action} {name}",
    "en": "{action} {name}",
    "ja": "{name}：{action}"
  },
  "assets.mark.readError": {
    "zh-Hans": "标记读取失败，请重新读取。",
    "zh-Hant": "標記讀取失敗，請重新讀取。",
    "en": "Could not read the mark. Read again.",
    "ja": "マークを読み取れませんでした。再読み込みしてください。"
  },
  "assets.mark.protocolError": {
    "zh-Hans": "标记响应不完整或不匹配；此批状态未知，请重新读取。",
    "zh-Hant": "標記回應不完整或不相符；此批狀態未知，請重新讀取。",
    "en": "The mark response is incomplete or mismatched. This batch’s status is unknown. Read again.",
    "ja": "マークの応答が不完全か一致しません。このバッチの状態は不明です。再読み込みしてください。"
  },
  "assets.mark.unconfirmed": {
    "zh-Hans": "标记未获确认。若任务中有待确认记录，请恢复同一请求；重新读取不会重发修改。",
    "zh-Hant": "標記尚未獲確認。若工作中有待確認記錄，請還原同一請求；重新讀取不會重送修改。",
    "en": "The mark was not confirmed. If a task has an unconfirmed record, restore that same request. Reading again does not resend the change.",
    "ja": "マークを確認できませんでした。タスクに未確認の記録がある場合、同じリクエストを復元してください。再読み込みによって変更を再送信することはありません。"
  },
  "assets.usage.filter": {
    "zh-Hans": "当前时间线使用筛选",
    "zh-Hant": "目前時間軸使用篩選",
    "en": "Filter current timeline usage",
    "ja": "現在のタイムラインの使用状況で絞り込み"
  },
  "assets.usage.showAll": {
    "zh-Hans": "显示全部时间线使用状态",
    "zh-Hant": "顯示全部時間軸使用狀態",
    "en": "Show all timeline usage states",
    "ja": "タイムラインのすべての使用状況を表示"
  },
  "assets.usage.unused": {
    "zh-Hans": "未用于本时间线",
    "zh-Hant": "尚未用於此時間軸",
    "en": "Not used in this timeline",
    "ja": "このタイムラインで未使用"
  },
  "assets.usage.unavailable": {
    "zh-Hans": "当前时间线使用情况暂不可用，筛选仍保留未知素材。",
    "zh-Hant": "目前時間軸的使用情況暫時無法使用，篩選仍會保留狀態未知的素材。",
    "en": "Current timeline usage is unavailable. Filters retain assets with unknown status.",
    "ja": "現在のタイムラインの使用状況を取得できません。状態不明の素材は絞り込んでも表示を保持します。"
  },
  "assets.usage.savedRevision": {
    "zh-Hans": "当前时间线 · 已保存 修订版 {revision}",
    "zh-Hant": "目前時間軸 · 已儲存 修訂版 {revision}",
    "en": "Current timeline · Saved revision {revision}",
    "ja": "現在のタイムライン・保存済み リビジョン {revision}"
  },
  "assets.usage.unknown": {
    "zh-Hans": "当前时间线 · 使用情况未知",
    "zh-Hant": "目前時間軸 · 使用情況未知",
    "en": "Current timeline · Usage unknown",
    "ja": "現在のタイムライン・使用状況は不明"
  },
  "assets.usage.zero": {
    "zh-Hans": "当前时间线 · 0 次使用",
    "zh-Hant": "目前時間軸 · 使用 0 次",
    "en": "Current timeline · 0 uses",
    "ja": "現在のタイムライン・使用 0 回"
  },
  "assets.usage.expandLabel": {
    "zh-Hans": {
      "one": "{name} 在当前时间线使用 {count} 次，查看片段位置",
      "other": "{name} 在当前时间线使用 {count} 次，查看片段位置"
    },
    "zh-Hant": {
      "one": "{name} 在目前時間軸使用 {count} 次，檢視片段位置",
      "other": "{name} 在目前時間軸使用 {count} 次，檢視片段位置"
    },
    "en": {
      "one": "{name} is used {count} time in this timeline. View clip locations.",
      "other": "{name} is used {count} times in this timeline. View clip locations."
    },
    "ja": {
      "one": "{name} は現在のタイムラインで {count} 回使用されています。クリップの位置を表示",
      "other": "{name} は現在のタイムラインで {count} 回使用されています。クリップの位置を表示"
    }
  },
  "assets.usage.collapseLabel": {
    "zh-Hans": {
      "one": "{name} 在当前时间线使用 {count} 次，收起片段位置",
      "other": "{name} 在当前时间线使用 {count} 次，收起片段位置"
    },
    "zh-Hant": {
      "one": "{name} 在目前時間軸使用 {count} 次，收合片段位置",
      "other": "{name} 在目前時間軸使用 {count} 次，收合片段位置"
    },
    "en": {
      "one": "{name} is used {count} time in this timeline. Hide clip locations.",
      "other": "{name} is used {count} times in this timeline. Hide clip locations."
    },
    "ja": {
      "one": "{name} は現在のタイムラインで {count} 回使用されています。クリップの位置を折りたたむ",
      "other": "{name} は現在のタイムラインで {count} 回使用されています。クリップの位置を折りたたむ"
    }
  },
  "assets.usage.expandSummary": {
    "zh-Hans": {
      "one": "当前时间线 · {count} 次使用 · 展开",
      "other": "当前时间线 · {count} 次使用 · 展开"
    },
    "zh-Hant": {
      "one": "目前時間軸 · 使用 {count} 次 · 展開",
      "other": "目前時間軸 · 使用 {count} 次 · 展開"
    },
    "en": {
      "one": "Current timeline · {count} use · Expand",
      "other": "Current timeline · {count} uses · Expand"
    },
    "ja": {
      "one": "現在のタイムライン・使用 {count} 回・展開",
      "other": "現在のタイムライン・使用 {count} 回・展開"
    }
  },
  "assets.usage.collapseSummary": {
    "zh-Hans": {
      "one": "当前时间线 · {count} 次使用 · 收起",
      "other": "当前时间线 · {count} 次使用 · 收起"
    },
    "zh-Hant": {
      "one": "目前時間軸 · 使用 {count} 次 · 收合",
      "other": "目前時間軸 · 使用 {count} 次 · 收合"
    },
    "en": {
      "one": "Current timeline · {count} use · Collapse",
      "other": "Current timeline · {count} uses · Collapse"
    },
    "ja": {
      "one": "現在のタイムライン・使用 {count} 回・折りたたむ",
      "other": "現在のタイムライン・使用 {count} 回・折りたたむ"
    }
  },
  "assets.usage.locations": {
    "zh-Hans": "{name} 的时间线片段位置",
    "zh-Hant": "{name} 的時間軸片段位置",
    "en": "Timeline clip locations for {name}",
    "ja": "{name} のタイムラインクリップの位置"
  },
  "assets.usage.locate": {
    "zh-Hans": "定位片段 {clip}，轨道 {track}，起点 {frame} 帧",
    "zh-Hant": "定位片段 {clip}，軌道 {track}，起點 {frame} 影格",
    "en": "Locate clip {clip}, track {track}, starting at frame {frame}",
    "ja": "クリップ {clip}、トラック {track}、開始フレーム {frame} へ移動"
  },
  "assets.usage.locationDetails": {
    "zh-Hans": "{clip} · {track} · 起点 {frame} 帧 · 长度 {duration} 帧 · 已保存 修订版 {revision}",
    "zh-Hant": "{clip} · {track} · 起點 {frame} 影格 · 長度 {duration} 影格 · 已儲存 修訂版 {revision}",
    "en": "{clip} · {track} · Start frame {frame} · Duration in frames: {duration} · Saved revision {revision}",
    "ja": "{clip}・{track}・開始 {frame} フレーム・長さ {duration} フレーム・保存済み リビジョン {revision}"
  },
  "assets.usage.start": {
    "zh-Hans": "{track} · 起点 {frame} 帧",
    "zh-Hant": "{track} · 起點 {frame} 影格",
    "en": "{track} · Start frame {frame}",
    "ja": "{track}・開始 {frame} フレーム"
  },
  "assets.reference.unnamedNode": {
    "zh-Hans": "未命名图片节点",
    "zh-Hant": "未命名圖片節點",
    "en": "Unnamed image node",
    "ja": "名前のない画像ノード"
  },
  "assets.reference.sourceUnavailable": {
    "zh-Hans": "来源节点不可用",
    "zh-Hant": "來源節點無法使用",
    "en": "Source node unavailable",
    "ja": "ソースノードを利用できません"
  },
  "assets.reference.unnamedAsset": {
    "zh-Hans": "未命名图片素材",
    "zh-Hant": "未命名圖片素材",
    "en": "Unnamed image asset",
    "ja": "名前のない画像素材"
  },
  "assets.reference.assetUnavailable": {
    "zh-Hans": "引用素材不可用，请检查项目",
    "zh-Hant": "參照素材無法使用，請檢查專案",
    "en": "Referenced asset unavailable; check the project",
    "ja": "参照素材を利用できません。プロジェクトを確認してください"
  },
  "assets.reference.nodeIdentity": {
    "zh-Hans": "{name}（节点 {id}）",
    "zh-Hant": "{name}（節點 {id}）",
    "en": "{name} (node {id})",
    "ja": "{name}（ノード {id}）"
  },
  "assets.reference.sourceDetails": {
    "zh-Hans": "来源素材：{asset}；来源节点：{node}",
    "zh-Hant": "來源素材：{asset}；來源節點：{node}",
    "en": "Source asset: {asset}; source node: {node}",
    "ja": "ソース素材：{asset}、ソースノード：{node}"
  },
  "assets.reference.unnamedShot": {
    "zh-Hans": "未命名镜头",
    "zh-Hant": "未命名鏡頭",
    "en": "Unnamed shot",
    "ja": "名前のないショット"
  },
  "assets.reference.targetOption": {
    "zh-Hans": "镜头 {number} · {name}",
    "zh-Hant": "鏡頭 {number} · {name}",
    "en": "Shot {number} · {name}",
    "ja": "ショット {number}・{name}"
  },
  "assets.reference.requiresImage": {
    "zh-Hans": "首帧连接需要当前项目中已导入的图片节点。",
    "zh-Hant": "首幀連線需要目前專案中已匯入的圖片節點。",
    "en": "A first-frame connection needs an imported image node in this project.",
    "ja": "開始フレームの接続には、現在のプロジェクトに読み込まれた画像ノードが必要です。"
  },
  "assets.reference.chooseTarget": {
    "zh-Hans": "请选择当前项目中的目标镜头。",
    "zh-Hant": "請選擇目前專案中的目標鏡頭。",
    "en": "Choose a target shot in the current project.",
    "ja": "現在のプロジェクトの対象ショットを選択してください。"
  },
  "assets.reference.alreadyConnected": {
    "zh-Hans": "此图片已连接到该镜头。",
    "zh-Hant": "此圖片已連接至該鏡頭。",
    "en": "This image is already connected to that shot.",
    "ja": "この画像はすでにそのショットに接続されています。"
  },
  "assets.reference.otherConnected": {
    "zh-Hans": "该镜头已有首帧连接。请先在镜头设置中断开，再连接新图片。",
    "zh-Hant": "該鏡頭已有首幀連線。請先在鏡頭設定中中斷，再連接新圖片。",
    "en": "This shot already has a first-frame connection. Disconnect it in shot settings before connecting another image.",
    "ja": "このショットには開始フレームの接続があります。ショット設定で解除してから、新しい画像を接続してください。"
  },
  "assets.reference.manualSelected": {
    "zh-Hans": "该镜头已手动选择参考图。请打开镜头设置，清除手动参考图并保存后再连接。",
    "zh-Hant": "該鏡頭已手動選擇參考圖。請開啟鏡頭設定，清除手動參考圖並儲存後再連接。",
    "en": "This shot has manually selected references. Open shot settings, clear and save the manual references, then connect.",
    "ja": "このショットには手動で選択した参照画像があります。ショット設定で手動参照をクリアし、保存してから接続してください。"
  },
  "assets.reference.firstFrame": {
    "zh-Hans": "首帧参考",
    "zh-Hant": "首幀參考",
    "en": "First-frame reference",
    "ja": "開始フレーム参照"
  },
  "assets.reference.visualOnlyAria": {
    "zh-Hans": "视觉连线，不参与生成",
    "zh-Hant": "視覺連線，不參與生成",
    "en": "Visual link; not used in generation",
    "ja": "視覚的なリンク。生成には使いません"
  },
  "assets.reference.attachHint": {
    "zh-Hans": "把这张图片作为目标镜头的生成首帧。每个镜头最多连接一张；连接前须清空已保存的手动参考图。",
    "zh-Hant": "將此圖片作為目標鏡頭的生成首幀。每個鏡頭最多連接一張；連接前須清空已儲存的手動參考圖。",
    "en": "Use this image as the target shot’s first frame. Each shot can connect one image. Clear saved manual references before connecting.",
    "ja": "この画像を対象ショットの生成用開始フレームとして使います。各ショットに接続できるのは1枚です。接続前に保存済みの手動参照画像をクリアしてください。"
  },
  "assets.reference.target": {
    "zh-Hans": "目标镜头",
    "zh-Hant": "目標鏡頭",
    "en": "Target shot",
    "ja": "対象ショット"
  },
  "assets.reference.targetPlaceholder": {
    "zh-Hans": "选择目标镜头",
    "zh-Hant": "選擇目標鏡頭",
    "en": "Choose target shot",
    "ja": "対象ショットを選択"
  },
  "assets.reference.openTargetSettings": {
    "zh-Hans": "打开目标镜头设置",
    "zh-Hant": "開啟目標鏡頭設定",
    "en": "Open target shot settings",
    "ja": "対象ショットの設定を開く"
  },
  "assets.reference.createShotHint": {
    "zh-Hans": "先在画布上创建一个镜头。",
    "zh-Hant": "請先在畫布上建立鏡頭。",
    "en": "Create a shot on the canvas first.",
    "ja": "まずキャンバスにショットを作成してください。"
  },
  "assets.reference.saveNodeFirst": {
    "zh-Hans": "请先保存或放弃节点修改，再连接首帧。",
    "zh-Hant": "請先儲存或放棄節點修改，再連接首幀。",
    "en": "Save or discard node changes before connecting the first frame.",
    "ja": "開始フレームを接続する前に、ノードの変更を保存または破棄してください。"
  },
  "assets.reference.previousPending": {
    "zh-Hans": "上次连接操作结果待确认，请在任务面板恢复同一请求。",
    "zh-Hant": "上次連線操作的結果待確認，請在工作面板還原同一請求。",
    "en": "The previous connection result awaits confirmation. Restore that same request in the task panel.",
    "ja": "前回の接続操作の結果は確認待ちです。タスクパネルで同じリクエストを復元してください。"
  },
  "assets.reference.syncing": {
    "zh-Hans": "正在同步连接…",
    "zh-Hant": "正在同步連線…",
    "en": "Syncing connection…",
    "ja": "接続を同期中…"
  },
  "assets.reference.connect": {
    "zh-Hans": "连接为首帧参考",
    "zh-Hant": "連接為首幀參考",
    "en": "Connect as first-frame reference",
    "ja": "開始フレーム参照として接続"
  },
  "assets.reference.connectedTo": {
    "zh-Hans": "已连接到",
    "zh-Hant": "已連接至",
    "en": "Connected to",
    "ja": "接続先"
  },
  "assets.reference.targetUnavailable": {
    "zh-Hans": "目标镜头不可用",
    "zh-Hant": "目標鏡頭無法使用",
    "en": "Target shot unavailable",
    "ja": "対象ショットを利用できません"
  },
  "assets.reference.connected": {
    "zh-Hans": "已连接首帧参考",
    "zh-Hant": "已連接首幀參考",
    "en": "First-frame reference connected",
    "ja": "開始フレーム参照が接続済み"
  },
  "assets.reference.openSource": {
    "zh-Hans": "查看来源节点",
    "zh-Hant": "檢視來源節點",
    "en": "View source node",
    "ja": "ソースノードを表示"
  },
  "assets.reference.boundHint": {
    "zh-Hans": "生成会使用此连接的图片。要换图或改为文生视频，请先断开连接；原始素材与节点会保留。",
    "zh-Hant": "生成會使用此連線的圖片。若要換圖或改為文字生成影片，請先中斷連線；原始素材與節點會保留。",
    "en": "Generation uses this connected image. Disconnect it before changing the image or switching to text-to-video. The original asset and node are retained.",
    "ja": "生成にはこの接続画像を使います。画像の変更やテキストから動画への切り替えの前に接続を解除してください。元の素材とノードは保持されます。"
  },
  "assets.reference.saveShotFirst": {
    "zh-Hans": "请先保存或放弃镜头修改，再断开连接。",
    "zh-Hant": "請先儲存或放棄鏡頭修改，再中斷連線。",
    "en": "Save or discard shot changes before disconnecting.",
    "ja": "接続を解除する前に、ショットの変更を保存または破棄してください。"
  },
  "assets.reference.pending": {
    "zh-Hans": "连接操作结果待确认，请在任务面板恢复同一请求。",
    "zh-Hant": "連線操作的結果待確認，請在工作面板還原同一請求。",
    "en": "The connection result awaits confirmation. Restore that same request in the task panel.",
    "ja": "接続操作の結果は確認待ちです。タスクパネルで同じリクエストを復元してください。"
  },
  "assets.reference.disconnect": {
    "zh-Hans": "断开首帧连接",
    "zh-Hant": "中斷首幀連線",
    "en": "Disconnect first frame",
    "ja": "開始フレームの接続を解除"
  },
  "assets.reference.connectedTarget": {
    "zh-Hans": "查看已连接目标：{name}",
    "zh-Hant": "檢視已連接目標：{name}",
    "en": "View connected target: {name}",
    "ja": "接続先を表示：{name}"
  },
  "assets.reference.boundDescription": {
    "zh-Hans": "已连接的首帧参考，{description}",
    "zh-Hant": "已連接的首幀參考，{description}",
    "en": "Connected first-frame reference, {description}",
    "ja": "接続済みの開始フレーム参照、{description}"
  },
  "assets.reference.sourceAsset": {
    "zh-Hans": "来源素材：{name}",
    "zh-Hant": "來源素材：{name}",
    "en": "Source asset: {name}",
    "ja": "ソース素材：{name}"
  },
  "assets.reference.sourceNode": {
    "zh-Hans": "来源节点：{name}",
    "zh-Hant": "來源節點：{name}",
    "en": "Source node: {name}",
    "ja": "ソースノード：{name}"
  },
  "assets.reference.viewSourceNode": {
    "zh-Hans": "查看来源节点：{name}",
    "zh-Hant": "檢視來源節點：{name}",
    "en": "View source node: {name}",
    "ja": "ソースノードを表示：{name}"
  },
  "shell.emptyEyebrow": {
    "zh-Hans": "为下一段故事留出空间",
    "zh-Hant": "為下一段故事留出空間",
    "en": "MAKE ROOM FOR YOUR NEXT STORY",
    "ja": "次の物語のための場所を"
  },
  "shell.blankEyebrow": {
    "zh-Hans": "一张空白画布，一个全新视角",
    "zh-Hant": "一張空白畫布，一個全新視角",
    "en": "A BLANK CANVAS, A NEW PERSPECTIVE",
    "ja": "白紙のキャンバス、新しい視点"
  },
  "shell.agentLabel": {
    "zh-Hans": "智能助理",
    "zh-Hant": "智慧助理",
    "en": "Agent",
    "ja": "エージェント"
  },
  "shell.node.textType": {
    "zh-Hans": "文本",
    "zh-Hant": "文字",
    "en": "Text",
    "ja": "テキスト"
  },
  "inspector.shotIndex": {
    "zh-Hans": "镜头 {number}",
    "zh-Hant": "鏡頭 {number}",
    "en": "Shot {number}",
    "ja": "ショット {number}"
  },
  "inspector.promptLabel": {
    "zh-Hans": "提示词",
    "zh-Hant": "提示詞",
    "en": "Prompt",
    "ja": "プロンプト"
  },
  "inspector.revision": {
    "zh-Hans": "修订 {number}",
    "zh-Hant": "修訂 {number}",
    "en": "Rev {number}",
    "ja": "リビジョン {number}"
  },
  "shell.actions": {
    "zh-Hans": "操作",
    "zh-Hant": "操作",
    "en": "Actions",
    "ja": "操作"
  },
  "shell.status": {
    "zh-Hans": "状态",
    "zh-Hant": "狀態",
    "en": "Status",
    "ja": "状態"
  },
  "shell.statusDetails": {
    "zh-Hans": "工作区保存与最近项目状态",
    "zh-Hant": "工作區儲存與最近專案狀態",
    "en": "Workspace save and recent-project status",
    "ja": "ワークスペースの保存と最近のプロジェクトの状態"
  },
  "assets.usage.unnamedClip": {
    "zh-Hans": "未命名片段",
    "zh-Hant": "未命名片段",
    "en": "Untitled clip",
    "ja": "名前のないクリップ"
  },
  "shell.error.storageMigration": {
    "zh-Hans": "Mioon 本地记录迁移未完成。旧记录已保留；为防止覆盖视图或重复提交，请关闭旧版窗口并检查存储冲突后重试。",
    "zh-Hant": "Mioon 本機記錄移轉尚未完成。舊記錄已保留；為避免覆寫檢視或重複提交，請關閉舊版視窗並檢查儲存衝突後重試。",
    "en": "Mioon local-record migration is incomplete. Existing records are retained. To avoid overwriting views or duplicate submissions, close older-version windows and check storage conflicts before retrying.",
    "ja": "Mioon のローカル記録の移行は未完了です。以前の記録は保持されています。表示の上書きや重複送信を避けるため、旧バージョンのウィンドウを閉じ、ストレージの競合を確認してから再試行してください。"
  },
  "shell.error.workspaceChanged": {
    "zh-Hans": "连接的工作区已变化，请重新载入页面。原请求和分支来源仍被保留，不会自动重试。",
    "zh-Hant": "連線的工作區已變更，請重新載入頁面。原請求與分支來源仍會保留，不會自動重試。",
    "en": "The connected workspace has changed. Reload the page. The original request and branch origin are retained and will not be retried automatically.",
    "ja": "接続先のワークスペースが変わりました。ページを再読み込みしてください。元のリクエストとブランチの由来は保持され、自動では再試行されません。"
  },
  "shell.error.workspacePinned": {
    "zh-Hans": "已有请求不能重新指定工作区来源。原请求仍保留；请先核对其结果，不要将它改绑到另一个工作区。",
    "zh-Hant": "既有請求無法重新指定工作區來源。原請求仍會保留；請先核對其結果，不要將它改綁至其他工作區。",
    "en": "An existing request cannot be assigned a different workspace origin. The original request is retained; verify its result rather than rebinding it to another workspace.",
    "ja": "既存のリクエストのワークスペースの由来は変更できません。元のリクエストは保持されています。別のワークスペースに付け替えず、先に結果を確認してください。"
  },
  "shell.error.lastProjectScope": {
    "zh-Hans": "最近项目记录的服务或工作区身份已变化或尚未核实，请重新打开页面。原记录仍保留，不会改用其他工作区的缓存。",
    "zh-Hant": "最近專案記錄的服務或工作區身分已變更或尚未核實，請重新開啟頁面。原記錄仍會保留，不會改用其他工作區的快取。",
    "en": "The recent-project service or workspace identity has changed or is unverified. Reopen the page. The original record is retained; no other workspace's cache will be used.",
    "ja": "最近使ったプロジェクトのサービスまたはワークスペースの識別情報が変わったか、未確認です。ページを開き直してください。元の記録は保持され、別のワークスペースのキャッシュは使われません。"
  },
  "shell.error.editorProject": {
    "zh-Hans": "编辑窗口没有有效的固定项目。请从项目列表重新打开所需项目，不会自动切换到其他项目。",
    "zh-Hant": "編輯視窗沒有有效的固定專案。請從專案清單重新開啟所需專案，不會自動切換至其他專案。",
    "en": "This editor window has no valid pinned project. Reopen the intended project from the project list; it will not switch to another project automatically.",
    "ja": "この編集ウィンドウには有効な固定プロジェクトがありません。プロジェクト一覧から目的のプロジェクトを開き直してください。別のプロジェクトには自動で切り替わりません。"
  }
} as const satisfies MessageCatalog;

assertNoDuplicateMessageKeys(shellCoreMessages, subjectsMessages);
export const shellMessages = { ...shellCoreMessages, ...subjectsMessages } as const satisfies MessageCatalog;
