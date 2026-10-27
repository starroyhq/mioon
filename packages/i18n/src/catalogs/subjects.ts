import type { MessageCatalog } from '../types.ts';

export const subjectsMessages = {
  "subjects.kind.character": {
    "zh-Hans": "角色",
    "zh-Hant": "角色",
    "en": "Character",
    "ja": "キャラクター"
  },
  "subjects.kind.product": {
    "zh-Hans": "产品",
    "zh-Hant": "產品",
    "en": "Product",
    "ja": "製品"
  },
  "subjects.kind.location": {
    "zh-Hans": "场景",
    "zh-Hant": "場景",
    "en": "Location",
    "ja": "シーン"
  },
  "subjects.kind.look": {
    "zh-Hans": "风格",
    "zh-Hant": "風格",
    "en": "Style",
    "ja": "スタイル"
  },
  "subjects.image.missing": {
    "zh-Hans": "原图片未加载或已缺失",
    "zh-Hant": "原圖片尚未載入或已遺失",
    "en": "The original image is not loaded or is missing",
    "ja": "元の画像が未読み込み、または見つかりません"
  },
  "subjects.version.notLoaded": {
    "zh-Hans": "版本尚未加载",
    "zh-Hant": "版本尚未載入",
    "en": "The version has not loaded yet",
    "ja": "バージョンはまだ読み込まれていません"
  },
  "subjects.mutation.pending": {
    "zh-Hans": "有主体修改待确认，原请求保留在任务中心",
    "zh-Hant": "有主體修改待確認，原請求保留在工作中心",
    "en": "Subject changes are awaiting confirmation. The original request is retained in the task center",
    "ja": "サブジェクトの変更は確認待ちです。元のリクエストはタスクセンターに保持されています"
  },
  "subjects.mutation.showRequest": {
    "zh-Hans": "查看原请求",
    "zh-Hant": "查看原請求",
    "en": "View original request",
    "ja": "元のリクエストを表示"
  },
  "subjects.pager.subjects": {
    "zh-Hans": "主体",
    "zh-Hant": "主體",
    "en": "Subjects",
    "ja": "サブジェクト"
  },
  "subjects.pager.versions": {
    "zh-Hans": "主体版本",
    "zh-Hant": "主體版本",
    "en": "Subject versions",
    "ja": "サブジェクトのバージョン"
  },
  "subjects.pager.label": {
    "zh-Hans": "{label}分页",
    "zh-Hant": "{label}分頁",
    "en": "{label} pagination",
    "ja": "{label}のページ切り替え"
  },
  "subjects.pager.previous": {
    "zh-Hans": "上一页",
    "zh-Hant": "上一頁",
    "en": "Previous page",
    "ja": "前のページ"
  },
  "subjects.pager.next": {
    "zh-Hans": "下一页",
    "zh-Hant": "下一頁",
    "en": "Next page",
    "ja": "次のページ"
  },
  "subjects.pager.status": {
    "zh-Hans": "第 {page} 页 · 本页 {count}",
    "zh-Hant": "第 {page} 頁 · 本頁 {count}",
    "en": "Page {page} · {count} on this page",
    "ja": "{page} ページ · このページに {count} 件"
  },
  "subjects.image.choose": {
    "zh-Hans": "选择一张已导入图片",
    "zh-Hant": "選擇一張已匯入圖片",
    "en": "Choose an imported image",
    "ja": "読み込み済みの画像を選択"
  },
  "subjects.image.selectedMissing": {
    "zh-Hans": "已选图片未加载或已缺失",
    "zh-Hant": "所選圖片尚未載入或已遺失",
    "en": "The selected image is not loaded or is missing",
    "ja": "選択した画像が未読み込み、または見つかりません"
  },
  "subjects.image.chooseAnother": {
    "zh-Hans": "已选图片不可用，请明确选择另一张图片",
    "zh-Hant": "所選圖片無法使用，請明確選擇另一張圖片",
    "en": "The selected image is unavailable. Explicitly choose another image",
    "ja": "選択した画像は利用できません。別の画像を明示的に選択してください"
  },
  "subjects.library.label": {
    "zh-Hans": "本地主体库",
    "zh-Hant": "本機主體庫",
    "en": "Local subject library",
    "ja": "ローカルサブジェクトライブラリ"
  },
  "subjects.library.new": {
    "zh-Hans": "新建主体",
    "zh-Hant": "新增主體",
    "en": "New subject",
    "ja": "サブジェクトを作成"
  },
  "subjects.library.refresh": {
    "zh-Hans": "刷新",
    "zh-Hant": "重新整理",
    "en": "Refresh",
    "ja": "更新"
  },
  "subjects.library.reset": {
    "zh-Hans": "全部 / 重置",
    "zh-Hant": "全部 / 重設",
    "en": "All / Reset",
    "ja": "すべて / リセット"
  },
  "subjects.library.planningNote": {
    "zh-Hans": "策划关联不会自动用于生成；生成输入需另行选择版本",
    "zh-Hant": "規劃關聯不會自動用於生成；生成輸入須另行選擇版本",
    "en": "Planning links are not used automatically for generation. Select an input version separately",
    "ja": "企画用の関連付けは生成に自動では使われません。生成入力のバージョンは別途選択してください"
  },
  "subjects.library.search": {
    "zh-Hans": "搜索本页主体",
    "zh-Hant": "搜尋本頁主體",
    "en": "Search subjects on this page",
    "ja": "このページのサブジェクトを検索"
  },
  "subjects.library.searchPlaceholder": {
    "zh-Hans": "搜索本页主体…",
    "zh-Hant": "搜尋本頁主體…",
    "en": "Search subjects on this page…",
    "ja": "このページのサブジェクトを検索…"
  },
  "subjects.library.kindFilter": {
    "zh-Hans": "主体类型筛选",
    "zh-Hant": "主體類型篩選",
    "en": "Filter subject type",
    "ja": "サブジェクトの種類で絞り込み"
  },
  "subjects.library.allKinds": {
    "zh-Hans": "全部类型",
    "zh-Hant": "全部類型",
    "en": "All types",
    "ja": "すべての種類"
  },
  "subjects.create.heading": {
    "zh-Hans": "从一张图片建立主体",
    "zh-Hant": "從一張圖片建立主體",
    "en": "Create a subject from an image",
    "ja": "1 枚の画像からサブジェクトを作成"
  },
  "subjects.create.name": {
    "zh-Hans": "名称",
    "zh-Hant": "名稱",
    "en": "Name",
    "ja": "名前"
  },
  "subjects.create.kind": {
    "zh-Hans": "类型",
    "zh-Hant": "類型",
    "en": "Type",
    "ja": "種類"
  },
  "subjects.create.firstImage": {
    "zh-Hans": "第一版图片",
    "zh-Hant": "第一版圖片",
    "en": "First version image",
    "ja": "最初のバージョンの画像"
  },
  "subjects.create.selectedImage": {
    "zh-Hans": "新主体已选图片",
    "zh-Hant": "新主體所選圖片",
    "en": "Selected image for the new subject",
    "ja": "新しいサブジェクトに選択した画像"
  },
  "subjects.create.importFirst": {
    "zh-Hans": "请先在素材页导入 PNG、JPEG 或 WebP 图片",
    "zh-Hant": "請先在素材頁匯入 PNG、JPEG 或 WebP 圖片",
    "en": "First import a PNG, JPEG, or WebP image on the assets page",
    "ja": "まず素材ページで PNG、JPEG、WebP の画像を読み込んでください"
  },
  "subjects.create.retained": {
    "zh-Hans": "名称和类型创建后保留。后续换图会追加版本",
    "zh-Hant": "建立後會保留名稱和類型。之後換圖會追加版本",
    "en": "The name and type are retained after creation. Changing the image later adds a version",
    "ja": "作成後も名前と種類は保持されます。後で画像を変更するとバージョンが追加されます"
  },
  "subjects.create.saving": {
    "zh-Hans": "正在创建…",
    "zh-Hant": "正在建立…",
    "en": "Creating…",
    "ja": "作成中…"
  },
  "subjects.create.submit": {
    "zh-Hans": "创建 V1",
    "zh-Hant": "建立 V1",
    "en": "Create V1",
    "ja": "V1 を作成"
  },
  "subjects.create.discard": {
    "zh-Hans": "放弃草稿",
    "zh-Hant": "放棄草稿",
    "en": "Discard draft",
    "ja": "下書きを破棄"
  },
  "subjects.library.loading": {
    "zh-Hans": "正在读取主体，本页状态待核对…",
    "zh-Hant": "正在讀取主體，本頁狀態待核對…",
    "en": "Loading subjects. This page is awaiting verification…",
    "ja": "サブジェクトを読み込み中です。このページの状態は確認待ちです…"
  },
  "subjects.library.staleRead": {
    "zh-Hans": "上次读取的项目仅供查看",
    "zh-Hant": "上次讀取的項目僅供檢視",
    "en": "Previously loaded items are for viewing only",
    "ja": "前回読み込んだ項目は閲覧のみ可能です"
  },
  "subjects.library.noMatches": {
    "zh-Hans": "本页没有匹配的主体。可重置筛选或翻页",
    "zh-Hant": "本頁沒有符合條件的主體。可重設篩選或翻頁",
    "en": "No matching subjects on this page. Reset filters or change pages",
    "ja": "このページに一致するサブジェクトはありません。絞り込みをリセットするか、ページを切り替えてください"
  },
  "subjects.library.empty": {
    "zh-Hans": "还没有主体。用已导入的图片建立角色、产品、场景或风格",
    "zh-Hant": "尚無主體。使用已匯入的圖片建立角色、產品、場景或風格",
    "en": "No subjects yet. Use imported images to create characters, products, locations, or styles",
    "ja": "サブジェクトはまだありません。読み込み済みの画像からキャラクター、製品、シーン、スタイルを作成できます"
  },
  "subjects.version.detailLabel": {
    "zh-Hans": "{name} 的主体版本",
    "zh-Hant": "{name} 的主體版本",
    "en": "Subject versions for {name}",
    "ja": "{name} のサブジェクトバージョン"
  },
  "subjects.version.currentSummary": {
    "zh-Hans": "{kind} · 当前 V{number}",
    "zh-Hant": "{kind} · 目前 V{number}",
    "en": "{kind} · Current V{number}",
    "ja": "{kind} · 現在 V{number}"
  },
  "subjects.version.outsideFilter": {
    "zh-Hans": "当前主体不在本页筛选中，详情与草稿仍保留",
    "zh-Hant": "目前主體不在本頁篩選結果中，詳細資料與草稿仍保留",
    "en": "This subject is outside the current page filters. Its details and draft are retained",
    "ja": "このサブジェクトは現在のページの絞り込み対象外ですが、詳細と下書きは保持されています"
  },
  "subjects.version.addImage": {
    "zh-Hans": "追加图片版本",
    "zh-Hant": "追加圖片版本",
    "en": "Add image version",
    "ja": "画像バージョンを追加"
  },
  "subjects.version.selectedImage": {
    "zh-Hans": "追加版本已选图片",
    "zh-Hant": "追加版本所選圖片",
    "en": "Selected image for the added version",
    "ja": "追加バージョンに選択した画像"
  },
  "subjects.version.staleDraft": {
    "zh-Hans": "主体已更新。草稿图片仍保留，请重新确认图片后追加",
    "zh-Hant": "主體已更新。草稿圖片仍保留，請重新確認圖片後再追加",
    "en": "The subject was updated. Your draft image is retained. Reconfirm the image before adding it",
    "ja": "サブジェクトが更新されました。下書きの画像は保持されています。画像を再確認してから追加してください"
  },
  "subjects.version.add": {
    "zh-Hans": "追加新版本",
    "zh-Hant": "追加新版本",
    "en": "Add new version",
    "ja": "新しいバージョンを追加"
  },
  "subjects.version.discard": {
    "zh-Hans": "放弃换图",
    "zh-Hant": "放棄換圖",
    "en": "Discard image change",
    "ja": "画像の変更を破棄"
  },
  "subjects.version.retained": {
    "zh-Hans": "旧版本与镜头固定关联会保留。策划关联的镜头需要逐个确认新版本",
    "zh-Hant": "舊版本與鏡頭的固定關聯會保留。規劃關聯的鏡頭須逐一確認新版本",
    "en": "Older versions and pinned shot links are retained. Each planning-linked shot must confirm the new version separately",
    "ja": "以前のバージョンとショットの固定関連付けは保持されます。企画用に関連付けたショットごとに新しいバージョンを確認する必要があります"
  },
  "subjects.version.heading": {
    "zh-Hans": "图片版本",
    "zh-Hant": "圖片版本",
    "en": "Image versions",
    "ja": "画像バージョン"
  },
  "subjects.version.loading": {
    "zh-Hans": "正在读取版本…",
    "zh-Hant": "正在讀取版本…",
    "en": "Loading versions…",
    "ja": "バージョンを読み込み中…"
  },
  "subjects.version.currentSuffix": {
    "zh-Hans": " · 当前",
    "zh-Hant": " · 目前",
    "en": " · Current",
    "ja": " · 現在"
  },
  "subjects.binding.heading": {
    "zh-Hans": "策划关联此主体的镜头",
    "zh-Hant": "規劃關聯此主體的鏡頭",
    "en": "Shots planning-linked to this subject",
    "ja": "このサブジェクトに企画用に関連付けたショット"
  },
  "subjects.binding.loading": {
    "zh-Hans": "正在读取镜头关联…",
    "zh-Hant": "正在讀取鏡頭關聯…",
    "en": "Loading shot links…",
    "ja": "ショットの関連付けを読み込み中…"
  },
  "subjects.binding.noneLoaded": {
    "zh-Hans": "已读取的策划关联中没有镜头",
    "zh-Hant": "已讀取的規劃關聯中沒有鏡頭",
    "en": "No shots in the planning links loaded so far",
    "ja": "読み込み済みの企画用関連付けにショットはありません"
  },
  "subjects.binding.shotMissing": {
    "zh-Hans": "镜头未加载",
    "zh-Hant": "鏡頭尚未載入",
    "en": "Shot not loaded",
    "ja": "ショット未読み込み"
  },
  "subjects.binding.reviewSuffix": {
    "zh-Hans": " · 待复核",
    "zh-Hant": " · 待複核",
    "en": " · Needs review",
    "ja": " · 要再確認"
  },
  "subjects.binding.pinnedSuffix": {
    "zh-Hans": " · 已固定版本",
    "zh-Hant": " · 已固定版本",
    "en": " · Version pinned",
    "ja": " · バージョン固定済み"
  },
  "subjects.binding.viewShot": {
    "zh-Hans": "查看镜头",
    "zh-Hant": "查看鏡頭",
    "en": "View shot",
    "ja": "ショットを表示"
  },
  "subjects.binding.loadMore": {
    "zh-Hans": "读取更多关联",
    "zh-Hant": "讀取更多關聯",
    "en": "Load more links",
    "ja": "関連付けをさらに読み込む"
  },
  "subjects.binding.subjectFallback": {
    "zh-Hans": "主体 {id}",
    "zh-Hant": "主體 {id}",
    "en": "Subject {id}",
    "ja": "サブジェクト {id}"
  },
  "subjects.binding.styleReference": {
    "zh-Hans": "风格参考",
    "zh-Hant": "風格參考",
    "en": "Style reference",
    "ja": "スタイル参照"
  },
  "subjects.binding.subjectReference": {
    "zh-Hans": "主体参考",
    "zh-Hant": "主體參考",
    "en": "Subject reference",
    "ja": "サブジェクト参照"
  },
  "subjects.binding.pinnedVersion": {
    "zh-Hans": "固定 V{number}",
    "zh-Hant": "固定 V{number}",
    "en": "Pinned V{number}",
    "ja": "固定 V{number}"
  },
  "subjects.binding.pinnedLoading": {
    "zh-Hans": "固定版本待读取",
    "zh-Hant": "固定版本待讀取",
    "en": "Pinned version awaiting load",
    "ja": "固定バージョンは読み込み待ち"
  },
  "subjects.binding.revision": {
    "zh-Hans": "关联修订版 {revision}",
    "zh-Hant": "關聯修訂版 {revision}",
    "en": "Link revision {revision}",
    "ja": "関連付けリビジョン {revision}"
  },
  "subjects.version.reload": {
    "zh-Hans": "重新读取版本",
    "zh-Hant": "重新讀取版本",
    "en": "Reload versions",
    "ja": "バージョンを再読み込み"
  },
  "subjects.version.loadMore": {
    "zh-Hans": "读取更多版本",
    "zh-Hant": "讀取更多版本",
    "en": "Load more versions",
    "ja": "バージョンをさらに読み込む"
  },
  "subjects.binding.currentPinned": {
    "zh-Hans": "当前固定 V{number}",
    "zh-Hant": "目前固定 V{number}",
    "en": "Currently pinned V{number}",
    "ja": "現在の固定 V{number}"
  },
  "subjects.binding.currentPinnedUnknown": {
    "zh-Hans": "当前固定版本",
    "zh-Hant": "目前固定版本",
    "en": "Currently pinned version",
    "ja": "現在の固定バージョン"
  },
  "subjects.binding.candidate": {
    "zh-Hans": "待选用 V{number}",
    "zh-Hant": "待選用 V{number}",
    "en": "Available V{number}",
    "ja": "選択候補 V{number}"
  },
  "subjects.binding.candidateUnknown": {
    "zh-Hans": "待选用新版本",
    "zh-Hant": "待選用新版本",
    "en": "New version available",
    "ja": "新しいバージョンを選択可能"
  },
  "subjects.binding.imageLabel": {
    "zh-Hans": "{name} · {status}",
    "zh-Hant": "{name} · {status}",
    "en": "{name} · {status}",
    "ja": "{name} · {status}"
  },
  "subjects.binding.newVersion": {
    "zh-Hans": "新版本",
    "zh-Hant": "新版本",
    "en": "new version",
    "ja": "新しいバージョン"
  },
  "subjects.binding.oldVersion": {
    "zh-Hans": "旧版本",
    "zh-Hant": "舊版本",
    "en": "older version",
    "ja": "以前のバージョン"
  },
  "subjects.binding.reviewSummary": {
    "zh-Hans": "主体已有{head}，此镜头仍固定{pinned}",
    "zh-Hant": "主體已有{head}，此鏡頭仍固定{pinned}",
    "en": "The subject has {head}. This shot remains pinned to {pinned}",
    "ja": "サブジェクトには {head} があります。このショットは {pinned} に固定されたままです"
  },
  "subjects.binding.useVersion": {
    "zh-Hans": "使用 {version}",
    "zh-Hant": "使用 {version}",
    "en": "Use {version}",
    "ja": "{version} を使用"
  },
  "subjects.binding.keepVersion": {
    "zh-Hans": "保留 {version}",
    "zh-Hant": "保留 {version}",
    "en": "Keep {version}",
    "ja": "{version} を保持"
  },
  "subjects.binding.unlink": {
    "zh-Hans": "解除关联",
    "zh-Hant": "解除關聯",
    "en": "Unlink",
    "ja": "関連付けを解除"
  },
  "subjects.binding.sectionLabel": {
    "zh-Hans": "主体策划关联",
    "zh-Hant": "主體規劃關聯",
    "en": "Subject planning links",
    "ja": "サブジェクトの企画用関連付け"
  },
  "subjects.binding.title": {
    "zh-Hans": "主体与风格",
    "zh-Hant": "主體與風格",
    "en": "Subjects and styles",
    "ja": "サブジェクトとスタイル"
  },
  "subjects.binding.unverified": {
    "zh-Hans": "关联待核对",
    "zh-Hant": "關聯待核對",
    "en": "Links awaiting verification",
    "ja": "関連付けは確認待ち"
  },
  "subjects.binding.unknown": {
    "zh-Hans": "当前关联状态未知，暂不能修改",
    "zh-Hant": "目前關聯狀態未知，暫時無法修改",
    "en": "The current link state is unknown. Changes are unavailable for now",
    "ja": "現在の関連付けの状態が不明なため、まだ変更できません"
  },
  "subjects.binding.incomplete": {
    "zh-Hans": "关联尚未读取完整，请继续核对后编辑",
    "zh-Hant": "關聯尚未讀取完整，請繼續核對後再編輯",
    "en": "Not all links have loaded. Continue checking before editing",
    "ja": "関連付けをすべて読み込めていません。引き続き確認してから編集してください"
  },
  "subjects.binding.continue": {
    "zh-Hans": "继续读取关联",
    "zh-Hant": "繼續讀取關聯",
    "en": "Continue loading links",
    "ja": "関連付けの読み込みを続ける"
  },
  "subjects.binding.empty": {
    "zh-Hans": "此镜头还没有本地主体关联",
    "zh-Hant": "此鏡頭尚無本機主體關聯",
    "en": "This shot has no local subject links yet",
    "ja": "このショットにはローカルサブジェクトの関連付けがまだありません"
  },
  "subjects.binding.chooseLabel": {
    "zh-Hans": "选择主体（素材库当前页）",
    "zh-Hant": "選擇主體（素材庫目前頁面）",
    "en": "Choose subject (current library page)",
    "ja": "サブジェクトを選択（ライブラリの現在のページ）"
  },
  "subjects.binding.choose": {
    "zh-Hans": "选择角色、产品、场景或风格",
    "zh-Hant": "選擇角色、產品、場景或風格",
    "en": "Choose a character, product, location, or style",
    "ja": "キャラクター、製品、シーン、スタイルを選択"
  },
  "subjects.binding.fixedImage": {
    "zh-Hans": "固定图片版本",
    "zh-Hant": "固定圖片版本",
    "en": "Pinned image version",
    "ja": "固定する画像バージョン"
  },
  "subjects.binding.selectedVersion": {
    "zh-Hans": "已选固定 V{number}",
    "zh-Hant": "已選固定 V{number}",
    "en": "Selected pinned V{number}",
    "ja": "固定として選択済み V{number}"
  },
  "subjects.binding.selectedUnknown": {
    "zh-Hans": "已选固定版本待读取",
    "zh-Hant": "已選固定版本待讀取",
    "en": "Selected pinned version awaiting load",
    "ja": "選択した固定バージョンは読み込み待ち"
  },
  "subjects.binding.staleDraft": {
    "zh-Hans": "主体或关联已变化，草稿仍保留。请重新确认主体和固定版本",
    "zh-Hant": "主體或關聯已變更，草稿仍保留。請重新確認主體和固定版本",
    "en": "The subject or link has changed. Your draft is retained. Reconfirm the subject and pinned version",
    "ja": "サブジェクトまたは関連付けが変更されました。下書きは保持されています。サブジェクトと固定バージョンを再確認してください"
  },
  "subjects.binding.styleNote": {
    "zh-Hans": "将作为风格参考关联。当前固定选择不会随新版本自动变化",
    "zh-Hant": "將作為風格參考關聯。目前固定的選擇不會隨新版本自動變更",
    "en": "This will be linked as a style reference. The pinned selection will not change automatically with new versions",
    "ja": "スタイル参照として関連付けます。新しいバージョンが追加されても、固定した選択は自動では変わりません"
  },
  "subjects.binding.subjectNote": {
    "zh-Hans": "将作为主体参考关联。当前固定选择不会随新版本自动变化",
    "zh-Hant": "將作為主體參考關聯。目前固定的選擇不會隨新版本自動變更",
    "en": "This will be linked as a subject reference. The pinned selection will not change automatically with new versions",
    "ja": "サブジェクト参照として関連付けます。新しいバージョンが追加されても、固定した選択は自動では変わりません"
  },
  "subjects.binding.save": {
    "zh-Hans": "保存固定关联",
    "zh-Hant": "儲存固定關聯",
    "en": "Save pinned link",
    "ja": "固定関連付けを保存"
  },
  "subjects.binding.discard": {
    "zh-Hans": "放弃选择",
    "zh-Hant": "放棄選擇",
    "en": "Discard selection",
    "ja": "選択を破棄"
  },
  "subjects.binding.limit": {
    "zh-Hans": "已达到 8 个有效关联；可修改已有版本或先解除一个关联",
    "zh-Hant": "已達到 8 個有效關聯；可修改既有版本或先解除一個關聯",
    "en": "The limit of 8 active links is reached. Change an existing version or unlink one first",
    "ja": "有効な関連付けの上限 8 件に達しています。既存のバージョンを変更するか、先に 1 件解除してください"
  },
  "subjects.binding.libraryHelp": {
    "zh-Hans": "在左侧主体页可创建主体、追加版本。此处关联不改变首帧参考图",
    "zh-Hant": "可在左側主體頁建立主體、追加版本。此處關聯不會變更首幀參考圖",
    "en": "Create subjects and add versions on the left subject page. These links do not change the first-frame reference image",
    "ja": "左側のサブジェクトページで作成やバージョン追加ができます。ここでの関連付けは先頭フレームの参照画像を変更しません"
  },
  "subjects.video.libraryLoading": {
    "zh-Hans": "主体库尚未加载，请等待当前项目读取完成",
    "zh-Hant": "主體庫尚未載入，請等待目前專案讀取完成",
    "en": "The subject library has not loaded yet. Wait for this project to finish loading",
    "ja": "サブジェクトライブラリはまだ読み込まれていません。現在のプロジェクトの読み込み完了をお待ちください"
  },
  "subjects.video.pending": {
    "zh-Hans": "有主体修改待确认，请先在任务中心核对",
    "zh-Hant": "有主體修改待確認，請先在工作中心核對",
    "en": "Subject changes are awaiting confirmation. Check them in the task center first",
    "ja": "サブジェクトの変更は確認待ちです。先にタスクセンターで確認してください"
  },
  "subjects.video.saving": {
    "zh-Hans": "主体修改正在保存，请稍候",
    "zh-Hant": "正在儲存主體修改，請稍候",
    "en": "Saving subject changes. Please wait",
    "ja": "サブジェクトの変更を保存中です。しばらくお待ちください"
  },
  "subjects.video.sectionLabel": {
    "zh-Hans": "本次主体图片生成视频",
    "zh-Hant": "本次主體圖片生成影片",
    "en": "Subject-image video for this request",
    "ja": "今回のサブジェクト画像からの動画生成"
  },
  "subjects.video.toggle": {
    "zh-Hans": "本次使用主体图片生成视频",
    "zh-Hant": "本次使用主體圖片生成影片",
    "en": "Use a subject image for this video",
    "ja": "今回の動画にサブジェクト画像を使用"
  },
  "subjects.video.sessionNote": {
    "zh-Hans": "这次选择仅保留在当前页面会话中，不保存为镜头参数，也不保证跨重启保留。策划关联不会自动作为生成输入；提示词保持原样",
    "zh-Hant": "本次選擇僅保留於目前頁面工作階段，不會儲存為鏡頭參數，也不保證重新啟動後仍保留。規劃關聯不會自動成為生成輸入；提示詞保持原樣",
    "en": "This selection lasts only for the current page session. It is not saved as a shot parameter and may not survive a restart. Planning links are not automatically used as generation inputs; the prompt remains unchanged",
    "ja": "この選択は現在のページセッションでのみ保持されます。ショットのパラメータには保存されず、再起動後の保持も保証されません。企画用の関連付けは生成入力に自動では使われず、プロンプトも変更されません"
  },
  "subjects.video.choose": {
    "zh-Hans": "明确选择角色、产品或场景",
    "zh-Hant": "明確選擇角色、產品或場景",
    "en": "Explicitly choose a character, product, or location",
    "ja": "キャラクター、製品、シーンを明示的に選択"
  },
  "subjects.video.planningOnlySuffix": {
    "zh-Hans": " · 仅供策划",
    "zh-Hant": " · 僅供規劃",
    "en": " · Planning only",
    "ja": " · 企画用のみ"
  },
  "subjects.video.refresh": {
    "zh-Hans": "刷新主体库",
    "zh-Hant": "重新整理主體庫",
    "en": "Refresh subject library",
    "ja": "サブジェクトライブラリを更新"
  },
  "subjects.video.pinLabel": {
    "zh-Hans": "明确固定图片版本",
    "zh-Hant": "明確固定圖片版本",
    "en": "Explicitly pin an image version",
    "ja": "画像バージョンを明示的に固定"
  },
  "subjects.video.pinPlaceholder": {
    "zh-Hans": "请选择固定版本，不会自动选用当前版本",
    "zh-Hant": "請選擇固定版本，不會自動選用目前版本",
    "en": "Choose a pinned version; the current version is not selected automatically",
    "ja": "固定するバージョンを選択してください。現在のバージョンは自動選択されません"
  },
  "subjects.video.currentSuffix": {
    "zh-Hans": " · 主体库当前版本",
    "zh-Hant": " · 主體庫目前版本",
    "en": " · Current library version",
    "ja": " · ライブラリの現在のバージョン"
  },
  "subjects.video.historicalSuffix": {
    "zh-Hans": " · 历史版本",
    "zh-Hant": " · 歷史版本",
    "en": " · Historical version",
    "ja": " · 過去のバージョン"
  },
  "subjects.video.constraints": {
    "zh-Hans": "仅发送一个固定主体版本。PNG / JPEG 可使用方形图片，主体图片比例与输出画幅独立；具体大小与像素限制见模型输入限制。风格仅供策划，不参与生成",
    "zh-Hant": "僅傳送一個固定主體版本。PNG / JPEG 可使用正方形圖片，主體圖片比例與輸出畫幅相互獨立；具體大小與像素限制請參閱模型輸入限制。風格僅供規劃，不參與生成",
    "en": "Only one pinned subject version is sent. PNG / JPEG images may be square; the subject image ratio is independent of the output aspect ratio. See the model input limits for size and pixel restrictions. Styles are for planning only, not generation",
    "ja": "送信するのは固定したサブジェクトの 1 バージョンのみです。PNG / JPEG は正方形でも使用でき、サブジェクト画像の比率は出力のアスペクト比とは独立しています。サイズと画素数の制限はモデルの入力制限を確認してください。スタイルは企画用のみで、生成には使用しません"
  },
  "subjects.summary.label": {
    "zh-Hans": "本次生成的固定主体图片",
    "zh-Hant": "本次生成的固定主體圖片",
    "en": "Pinned subject image for this generation",
    "ja": "今回の生成に固定したサブジェクト画像"
  },
  "subjects.summary.alt": {
    "zh-Hans": "{name} 固定 V{number}",
    "zh-Hant": "{name} 固定 V{number}",
    "en": "{name}, pinned V{number}",
    "ja": "{name}、固定 V{number}"
  },
  "subjects.summary.imageUnavailable": {
    "zh-Hans": "固定版本原图暂不可用",
    "zh-Hant": "固定版本原圖暫時無法使用",
    "en": "The pinned version’s original image is currently unavailable",
    "ja": "固定バージョンの元画像は現在利用できません"
  },
  "subjects.summary.nameMissing": {
    "zh-Hans": "主体名称未提供",
    "zh-Hant": "未提供主體名稱",
    "en": "Subject name not provided",
    "ja": "サブジェクト名がありません"
  },
  "subjects.summary.pendingNumber": {
    "zh-Hans": "待核对",
    "zh-Hant": "待核對",
    "en": "awaiting verification",
    "ja": "確認待ち"
  },
  "subjects.summary.kindVersion": {
    "zh-Hans": "{kind} · 固定 V{number}",
    "zh-Hant": "{kind} · 固定 V{number}",
    "en": "{kind} · Pinned V{number}",
    "ja": "{kind} · 固定 V{number}"
  },
  "subjects.summary.newer": {
    "zh-Hans": "本次仍固定 V{number}；主体库当前为 V{latest}。需要换图时请明确选择新版本",
    "zh-Hant": "本次仍固定 V{number}；主體庫目前為 V{latest}。需要換圖時請明確選擇新版本",
    "en": "This request remains pinned to V{number}; the library is now at V{latest}. Explicitly select a new version to change the image",
    "ja": "今回は V{number} に固定されたままです。ライブラリの現在のバージョンは V{latest} です。画像を変更する場合は、新しいバージョンを明示的に選択してください"
  },
  "subjects.summary.details": {
    "zh-Hans": "固定版本、素材与来源详情",
    "zh-Hant": "固定版本、素材與來源詳細資料",
    "en": "Pinned version, asset, and source details",
    "ja": "固定バージョン、素材、ソースの詳細"
  },
  "subjects.summary.versionId": {
    "zh-Hans": "主体版本 ID",
    "zh-Hant": "主體版本 ID",
    "en": "Subject version ID",
    "ja": "サブジェクトバージョン ID"
  },
  "subjects.summary.assetId": {
    "zh-Hans": "素材 ID",
    "zh-Hant": "素材 ID",
    "en": "Asset ID",
    "ja": "素材 ID"
  },
  "subjects.summary.hashMissing": {
    "zh-Hans": "未提供校验值",
    "zh-Hant": "未提供校驗值",
    "en": "Checksum not provided",
    "ja": "チェックサムがありません"
  },
  "subjects.summary.image": {
    "zh-Hans": "图片",
    "zh-Hant": "圖片",
    "en": "Image",
    "ja": "画像"
  },
  "subjects.summary.imageNameMissing": {
    "zh-Hans": "名称未加载",
    "zh-Hant": "名稱尚未載入",
    "en": "Name not loaded",
    "ja": "名前未読み込み"
  },
  "subjects.summary.provenance": {
    "zh-Hans": "完整来源记录",
    "zh-Hant": "完整來源記錄",
    "en": "Full provenance record",
    "ja": "出自の完全な記録"
  },
  "subjects.read.failed": {
    "zh-Hans": "读取失败，请重新读取",
    "zh-Hant": "讀取失敗，請重新讀取",
    "en": "Could not load the data. Reload to try again",
    "ja": "データを読み込めませんでした。再読み込みしてください"
  },
  "subjects.read.protocol": {
    "zh-Hans": "主体响应不完整或不匹配，当前状态尚未确认。请重新读取",
    "zh-Hant": "主體回應不完整或不符，目前狀態尚未確認。請重新讀取",
    "en": "The subject response is incomplete or does not match. The current state is unconfirmed. Reload it",
    "ja": "サブジェクトの応答が不完全、または一致しません。現在の状態は未確認です。再読み込みしてください"
  },
  "subjects.mutation.unconfirmed": {
    "zh-Hans": "修改尚未获得完整确认，草稿仍保留。请在任务中心核对原请求",
    "zh-Hant": "修改尚未獲得完整確認，草稿仍保留。請在工作中心核對原請求",
    "en": "The change has not been fully acknowledged. Your draft is retained. Check the original request in the task center",
    "ja": "変更の完全な確認応答を受信できていません。下書きは保持されています。タスクセンターで元のリクエストを確認してください"
  },
  "subjects.mutation.failed": {
    "zh-Hans": "主体修改未能确认，草稿仍保留。请核对任务中心中的原请求，不要重复提交",
    "zh-Hant": "主體修改未能確認，草稿仍保留。請核對工作中心中的原請求，請勿重複提交",
    "en": "The subject change could not be confirmed. Your draft is retained. Check the original request in the task center; do not submit it again",
    "ja": "サブジェクトの変更を確認できませんでした。下書きは保持されています。タスクセンターで元のリクエストを確認し、重複して送信しないでください"
  },
  "subjects.warning.ark": {
    "zh-Hans": "Ark 不支持直接上传真实人脸图片。请勿选择含真实人脸的主体图；工作台不进行人脸检测，也不提供身份锁定",
    "zh-Hant": "Ark 不支援直接上傳真實人臉圖片。請勿選擇含真實人臉的主體圖片；工作台不會進行人臉偵測，也不提供身分鎖定",
    "en": "Ark does not support direct uploads of real human face images. Do not select subject images containing real faces. The workbench does not detect faces or provide identity locking",
    "ja": "Ark は実在する人の顔画像の直接アップロードに対応していません。実在する人の顔を含むサブジェクト画像は選択しないでください。ワークベンチは顔検出も、人物の同一性の固定も行いません"
  },
  "subjects.warning.mock": {
    "zh-Hans": "Mock 仅验证工作流，输出为测试图案，不会呈现主体图片或提示词描述的内容",
    "zh-Hant": "Mock 僅驗證工作流程，輸出為測試圖案，不會呈現主體圖片或提示詞描述的內容",
    "en": "Mock only validates the workflow. Its output is a test pattern, not the subject image or content described by the prompt",
    "ja": "Mock はワークフローの検証のみを行います。出力はテストパターンであり、サブジェクト画像やプロンプトの内容は再現しません"
  },
  "subjects.conflict.boundFrame": {
    "zh-Hans": "主体图片不能与首帧连线一起提交。请先明确断开首帧连线，再选择本次主体输入",
    "zh-Hant": "主體圖片不能與首幀連線一起提交。請先明確斷開首幀連線，再選擇本次主體輸入",
    "en": "A subject image cannot be submitted with a first-frame connection. Explicitly disconnect the first frame before selecting a subject input for this request",
    "ja": "サブジェクト画像は先頭フレームの接続と同時に送信できません。先頭フレームの接続を明示的に解除してから、今回のサブジェクト入力を選択してください"
  },
  "subjects.conflict.frames": {
    "zh-Hans": "主体图片不能与首帧或尾帧组合。请手动清除首帧与尾帧选择，并保存镜头后再启用；不会自动清除素材",
    "zh-Hant": "主體圖片不能與首幀或尾幀組合。請手動清除首幀與尾幀選擇，並儲存鏡頭後再啟用；不會自動清除素材",
    "en": "A subject image cannot be combined with a first or last frame. Manually clear both frame selections and save the shot before enabling this. Assets will not be cleared automatically",
    "ja": "サブジェクト画像は先頭または末尾フレームと組み合わせられません。両方のフレーム選択を手動で解除し、ショットを保存してから有効にしてください。素材が自動で消去されることはありません"
  },
  "subjects.reference.choose": {
    "zh-Hans": "请明确选择一个主体及其固定图片版本，不会自动选用当前版本或策划关联",
    "zh-Hant": "請明確選擇一個主體及其固定圖片版本，不會自動選用目前版本或規劃關聯",
    "en": "Explicitly select a subject and its pinned image version. Neither the current version nor planning links are selected automatically",
    "ja": "サブジェクトと固定する画像バージョンを明示的に選択してください。現在のバージョンや企画用の関連付けは自動では選択されません"
  },
  "subjects.reference.incomplete": {
    "zh-Hans": "主体固定版本记录不完整，请重新明确选择版本",
    "zh-Hant": "主體固定版本記錄不完整，請重新明確選擇版本",
    "en": "The pinned subject version record is incomplete. Explicitly select the version again",
    "ja": "固定サブジェクトバージョンの記録が不完全です。バージョンをもう一度明示的に選択してください"
  },
  "subjects.reference.foreign": {
    "zh-Hans": "主体固定版本不属于当前项目，请重新选择",
    "zh-Hant": "主體固定版本不屬於目前專案，請重新選擇",
    "en": "The pinned subject version does not belong to this project. Select it again",
    "ja": "固定サブジェクトバージョンは現在のプロジェクトに属していません。選択し直してください"
  },
  "subjects.reference.missing": {
    "zh-Hans": "主体固定版本的原图未加载或已缺失，不能提交",
    "zh-Hant": "主體固定版本的原圖尚未載入或已遺失，無法提交",
    "en": "The pinned subject version’s original image is not loaded or is missing. It cannot be submitted",
    "ja": "固定サブジェクトバージョンの元画像が未読み込み、または見つからないため送信できません"
  },
  "subjects.reference.changed": {
    "zh-Hans": "主体固定版本的原图内容或元数据已变化，不能替换后提交。请核对原图",
    "zh-Hant": "主體固定版本的原圖內容或中繼資料已變更，不能替換後提交。請核對原圖",
    "en": "The pinned subject version’s original image content or metadata has changed. It cannot be replaced and submitted. Check the original image",
    "ja": "固定サブジェクトバージョンの元画像の内容またはメタデータが変更されています。差し替えて送信することはできません。元の画像を確認してください"
  },
  "subjects.source.missing": {
    "zh-Hans": "来源未提供",
    "zh-Hant": "未提供來源",
    "en": "Source not provided",
    "ja": "ソースがありません"
  },
  "subjects.source.import": {
    "zh-Hans": "用户导入图片",
    "zh-Hant": "使用者匯入圖片",
    "en": "User-imported image",
    "ja": "ユーザーが読み込んだ画像"
  },
  "subjects.source.frame": {
    "zh-Hans": "从视频提取的固定帧",
    "zh-Hant": "從影片擷取的固定幀",
    "en": "Pinned frame extracted from a video",
    "ja": "動画から抽出した固定フレーム"
  },
  "subjects.source.mock": {
    "zh-Hans": "Mock 工作流测试图片",
    "zh-Hant": "Mock 工作流程測試圖片",
    "en": "Mock workflow test image",
    "ja": "Mock ワークフローテスト画像"
  },
  "subjects.source.imageGenerated": {
    "zh-Hans": "图像生成结果",
    "zh-Hant": "圖像生成結果",
    "en": "Image generation result",
    "ja": "画像生成結果"
  },
  "subjects.source.videoGenerated": {
    "zh-Hans": "视频生成结果",
    "zh-Hant": "影片生成結果",
    "en": "Video generation result",
    "ja": "動画生成結果"
  },
  "subjects.source.export": {
    "zh-Hans": "导出素材",
    "zh-Hant": "匯出素材",
    "en": "Exported asset",
    "ja": "書き出した素材"
  },
  "subjects.source.recorded": {
    "zh-Hans": "已记录图片来源",
    "zh-Hant": "已記錄圖片來源",
    "en": "Image source recorded",
    "ja": "画像のソースを記録済み"
  },
  "subjects.library.allChip": {
    "zh-Hans": "全部",
    "zh-Hant": "全部",
    "en": "All",
    "ja": "すべて"
  },
  "subjects.library.count": {
    "zh-Hans": "{count} 个主体",
    "zh-Hant": "{count} 個主體",
    "en": "Subjects: {count}",
    "ja": "サブジェクト {count} 件"
  },
  "subjects.library.defaultVersion": {
    "zh-Hans": "默认 V{number}",
    "zh-Hant": "預設 V{number}",
    "en": "Default V{number}",
    "ja": "既定 V{number}"
  },
  "subjects.inspector.label": {
    "zh-Hans": "主体属性",
    "zh-Hant": "主體屬性",
    "en": "Subject properties",
    "ja": "サブジェクトのプロパティ"
  },
  "subjects.inspector.title": {
    "zh-Hans": "主体 · {name}",
    "zh-Hant": "主體 · {name}",
    "en": "Subject · {name}",
    "ja": "サブジェクト · {name}"
  },
  "subjects.inspector.unavailable": {
    "zh-Hans": "主体尚未读取，或已不在当前项目中",
    "zh-Hant": "主體尚未讀取，或已不在目前專案中",
    "en": "This subject hasn't loaded or is no longer in this project",
    "ja": "このサブジェクトは未読み込みか、現在のプロジェクトにありません"
  },
  "subjects.inspector.versionCount": {
    "zh-Hans": "{count} 个版本",
    "zh-Hant": "{count} 個版本",
    "en": "Versions: {count}",
    "ja": "バージョン {count} 件"
  },
  "subjects.inspector.basics": {
    "zh-Hans": "基本信息",
    "zh-Hant": "基本資訊",
    "en": "Basics",
    "ja": "基本情報"
  },
  "subjects.inspector.readOnly": {
    "zh-Hans": "名称和类型创建后不能修改",
    "zh-Hant": "名稱和類型建立後不能修改",
    "en": "The name and type can't be changed after creation",
    "ja": "名前と種類は作成後に変更できません"
  },
  "subjects.inspector.versions": {
    "zh-Hans": "版本",
    "zh-Hant": "版本",
    "en": "Versions",
    "ja": "バージョン"
  },
  "subjects.inspector.usage": {
    "zh-Hans": "使用情况",
    "zh-Hant": "使用情況",
    "en": "Usage",
    "ja": "使用状況"
  },
  "subjects.inspector.defaultVersion": {
    "zh-Hans": "默认版本",
    "zh-Hant": "預設版本",
    "en": "Default version",
    "ja": "既定のバージョン"
  },
  "subjects.inspector.variantAngle": {
    "zh-Hans": "补角度",
    "zh-Hant": "補角度",
    "en": "New angle",
    "ja": "別アングル"
  },
  "subjects.inspector.variantLight": {
    "zh-Hans": "打光",
    "zh-Hant": "打光",
    "en": "Relight",
    "ja": "ライティング"
  },
  "subjects.inspector.variantNote": {
    "zh-Hans": "不会成为默认版本。默认版本仍是 V{number}，用到{name}的镜头不需要复核。",
    "zh-Hant": "不會成為預設版本。預設版本仍是 V{number}，用到{name}的鏡頭不需要複核。",
    "en": "This doesn't become the default version. The default is still V{number}, so shots that use {name} don't need review.",
    "ja": "既定のバージョンにはなりません。既定は引き続き V{number} なので、{name} を使うショットの再確認は不要です。"
  },
  "subjects.inspector.viewVersion": {
    "zh-Hans": "查看 V{number}",
    "zh-Hant": "查看 V{number}",
    "en": "View V{number}",
    "ja": "V{number} を表示"
  },
  "subjects.inspector.today": {
    "zh-Hans": "今天 {time}",
    "zh-Hant": "今天 {time}",
    "en": "Today {time}",
    "ja": "今日 {time}"
  },
  "subjects.inspector.needsReview": {
    "zh-Hans": "待复核",
    "zh-Hant": "待複核",
    "en": "Needs review",
    "ja": "要確認"
  },
  "subjects.origin.import": {
    "zh-Hans": "上传",
    "zh-Hant": "上傳",
    "en": "Upload",
    "ja": "アップロード"
  },
  "subjects.origin.generated": {
    "zh-Hans": "生成",
    "zh-Hant": "生成",
    "en": "Generated",
    "ja": "生成"
  },
  "subjects.origin.mock": {
    "zh-Hans": "模拟",
    "zh-Hant": "模擬",
    "en": "Mock",
    "ja": "モック"
  },
  "subjects.origin.export": {
    "zh-Hans": "导出",
    "zh-Hant": "匯出",
    "en": "Export",
    "ja": "書き出し"
  },
  "subjects.origin.frame": {
    "zh-Hans": "截帧",
    "zh-Hant": "擷取影格",
    "en": "Video frame",
    "ja": "動画フレーム"
  },
  "subjects.variant.modelOpenAI": {
    "zh-Hans": "GPT Image",
    "zh-Hant": "GPT Image",
    "en": "GPT Image",
    "ja": "GPT Image"
  },
  "subjects.variant.modelMock": {
    "zh-Hans": "模拟服务",
    "zh-Hant": "模擬服務",
    "en": "Mock service",
    "ja": "モックサービス"
  },
  "subjects.angle.front": {
    "zh-Hans": "正面",
    "zh-Hant": "正面",
    "en": "Front",
    "ja": "正面"
  },
  "subjects.angle.frontLeft": {
    "zh-Hans": "左前",
    "zh-Hant": "左前",
    "en": "Front left",
    "ja": "左斜め前"
  },
  "subjects.angle.left": {
    "zh-Hans": "左",
    "zh-Hant": "左",
    "en": "Left",
    "ja": "左側"
  },
  "subjects.angle.backLeft": {
    "zh-Hans": "左后",
    "zh-Hant": "左後",
    "en": "Back left",
    "ja": "左斜め後ろ"
  },
  "subjects.angle.back": {
    "zh-Hans": "背",
    "zh-Hant": "背",
    "en": "Back",
    "ja": "背面"
  },
  "subjects.angle.backRight": {
    "zh-Hans": "右后",
    "zh-Hant": "右後",
    "en": "Back right",
    "ja": "右斜め後ろ"
  },
  "subjects.angle.right": {
    "zh-Hans": "右",
    "zh-Hant": "右",
    "en": "Right",
    "ja": "右側"
  },
  "subjects.angle.frontRight": {
    "zh-Hans": "右前",
    "zh-Hant": "右前",
    "en": "Front right",
    "ja": "右斜め前"
  },
  "subjects.angle.high": {
    "zh-Hans": "俯拍",
    "zh-Hant": "俯拍",
    "en": "High angle",
    "ja": "ハイアングル"
  },
  "subjects.angle.low": {
    "zh-Hans": "仰拍",
    "zh-Hant": "仰拍",
    "en": "Low angle",
    "ja": "ローアングル"
  },
  "subjects.angle.wide": {
    "zh-Hans": "广角",
    "zh-Hant": "廣角",
    "en": "Wide",
    "ja": "広角"
  },
  "subjects.light.soft": {
    "zh-Hans": "柔光",
    "zh-Hant": "柔光",
    "en": "Soft light",
    "ja": "ソフトライト"
  },
  "subjects.light.hard": {
    "zh-Hans": "硬光",
    "zh-Hant": "硬光",
    "en": "Hard light",
    "ja": "ハードライト"
  },
  "subjects.light.back": {
    "zh-Hans": "逆光",
    "zh-Hant": "逆光",
    "en": "Backlight",
    "ja": "逆光"
  },
  "subjects.light.detail": {
    "zh-Hans": "方位 {azimuth}° · 俯仰 {elevation}° · {kelvin}K",
    "zh-Hant": "方位 {azimuth}° · 俯仰 {elevation}° · {kelvin}K",
    "en": "Azimuth {azimuth}° · elevation {elevation}° · {kelvin}K",
    "ja": "方位 {azimuth}° · 仰角 {elevation}° · {kelvin}K"
  }
} as const satisfies MessageCatalog;
