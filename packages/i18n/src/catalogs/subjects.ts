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
  },
  "subjects.variants.kindOnly": {
    "zh-Hans": "补角度只用于角色和产品",
    "zh-Hant": "補角度只用於角色和產品",
    "en": "New angles are for characters and products only",
    "ja": "別アングルはキャラクターと製品のみ"
  },
  "subjects.variants.newBadge": {
    "zh-Hans": "新",
    "zh-Hant": "新",
    "en": "New",
    "ja": "新規"
  },
  "subjects.variants.rowAngle": {
    "zh-Hans": "补角度 · {done}/{total} 已完成",
    "zh-Hant": "補角度 · {done}/{total} 已完成",
    "en": "New angles · {done} of {total} done",
    "ja": "別アングル · {total} 件中 {done} 件完了"
  },
  "subjects.variants.rowLight": {
    "zh-Hans": "打光 · {done}/{total} 已完成",
    "zh-Hant": "打光 · {done}/{total} 已完成",
    "en": "Relight · {done} of {total} done",
    "ja": "ライティング · {total} 件中 {done} 件完了"
  },
  "subjects.variants.rowFailed": {
    "zh-Hans": "{failed} 张失败",
    "zh-Hant": "{failed} 張失敗",
    "en": "{failed} failed",
    "ja": "{failed} 件失敗"
  },
  "subjects.variants.rowUnknown": {
    "zh-Hans": "{unknown} 张结果未知",
    "zh-Hant": "{unknown} 張結果未知",
    "en": "{unknown} with an unknown result",
    "ja": "{unknown} 件は結果不明"
  },
  "subjects.variants.rowUnsubmitted": {
    "zh-Hans": "{pending} 张未提交",
    "zh-Hant": "{pending} 張未提交",
    "en": "{pending} not submitted",
    "ja": "{pending} 件未送信"
  },
  "subjects.variants.undo": {
    "zh-Hans": "撤销本批",
    "zh-Hant": "撤銷本批",
    "en": "Undo batch",
    "ja": "このバッチを取り消す"
  },
  "subjects.variants.undoConfirm": {
    "zh-Hans": "撤销这批？这批的 {total} 个版本会被隐藏，图片留在素材库。",
    "zh-Hant": "撤銷這批？這批的 {total} 個版本會被隱藏，圖片留在素材庫。",
    "en": "Undo this batch? Its versions are hidden ({total}); the images stay in the library.",
    "ja": "このバッチを取り消しますか？{total} 件のバージョンは非表示になり、画像は素材ライブラリに残ります。"
  },
  "subjects.variants.undoBlocked": {
    "zh-Hans": "暂时不能撤销本批",
    "zh-Hant": "暫時不能撤銷本批",
    "en": "This batch can't be undone right now",
    "ja": "このバッチは今は取り消せません"
  },
  "subjects.variants.blocker.inProgress": {
    "zh-Hans": "{item} 还在生成，完成后再撤销",
    "zh-Hant": "{item} 還在生成，完成後再撤銷",
    "en": "{item} is still generating. Undo after it finishes",
    "ja": "{item} はまだ生成中です。完了してから取り消してください"
  },
  "subjects.variants.blocker.unknown": {
    "zh-Hans": "{item} 的结果未知，先到任务中心核对",
    "zh-Hant": "{item} 的結果未知，請先到工作中心核對",
    "en": "{item} has an unknown result. Check it in the task center first",
    "ja": "{item} の結果が不明です。先にタスクセンターで確認してください"
  },
  "subjects.variants.blocker.bound": {
    "zh-Hans": "{item} 已被镜头 {shot} 选用，先在镜头里换成别的版本",
    "zh-Hant": "{item} 已被鏡頭 {shot} 選用，請先在鏡頭裡換成其他版本",
    "en": "{item} is used by shot {shot}. Choose another version in that shot first",
    "ja": "{item} はショット {shot} で使われています。先にショットで別のバージョンに替えてください"
  },
  "subjects.variants.blocker.boundAnyShot": {
    "zh-Hans": "{item} 已被镜头选用，先在镜头里换成别的版本",
    "zh-Hant": "{item} 已被鏡頭選用，請先在鏡頭裡換成其他版本",
    "en": "{item} is used by a shot. Choose another version in that shot first",
    "ja": "{item} はショットで使われています。先にショットで別のバージョンに替えてください"
  },
  "subjects.variants.blocker.generated": {
    "zh-Hans": "{item} 已用于生成视频，不能撤销这批",
    "zh-Hant": "{item} 已用於產生影片，不能撤銷這批",
    "en": "{item} was used to generate a video, so this batch can't be undone",
    "ja": "{item} は動画生成に使われたため、このバッチは取り消せません"
  },
  "subjects.variants.blocker.source": {
    "zh-Hans": "{item} 是另一批的源图，先撤销那一批",
    "zh-Hant": "{item} 是另一批的來源圖，請先撤銷那一批",
    "en": "{item} is the source of another batch. Undo that batch first",
    "ja": "{item} は別のバッチの元画像です。先にそのバッチを取り消してください"
  },
  "subjects.variants.item.queued": {
    "zh-Hans": "排队中",
    "zh-Hant": "排隊中",
    "en": "Queued",
    "ja": "待機中"
  },
  "subjects.variants.item.running": {
    "zh-Hans": "生成中",
    "zh-Hant": "生成中",
    "en": "Generating",
    "ja": "生成中"
  },
  "subjects.variants.item.submitting": {
    "zh-Hans": "提交中",
    "zh-Hant": "提交中",
    "en": "Submitting",
    "ja": "送信中"
  },
  "subjects.variants.item.pending": {
    "zh-Hans": "未提交",
    "zh-Hant": "未提交",
    "en": "Not submitted",
    "ja": "未送信"
  },
  "subjects.variants.item.failed": {
    "zh-Hans": "失败",
    "zh-Hant": "失敗",
    "en": "Failed",
    "ja": "失敗"
  },
  "subjects.variants.item.failedReason": {
    "zh-Hans": "服务商拒绝了请求",
    "zh-Hant": "服務商拒絕了請求",
    "en": "The provider refused the request",
    "ja": "プロバイダーがリクエストを拒否しました"
  },
  "subjects.variants.item.cancelledReason": {
    "zh-Hans": "未发出就取消了",
    "zh-Hant": "未送出就取消了",
    "en": "Cancelled before it was sent",
    "ja": "送信前に取り消されました"
  },
  "subjects.variants.item.unknown": {
    "zh-Hans": "结果未知",
    "zh-Hant": "結果未知",
    "en": "Unknown result",
    "ja": "結果不明"
  },
  "subjects.variants.item.unknownHint": {
    "zh-Hans": "不会自动重发，请到任务中心核对原请求",
    "zh-Hant": "不會自動重送，請到工作中心核對原請求",
    "en": "Not resent automatically. Check the original request in the task center",
    "ja": "自動では再送しません。タスクセンターで元のリクエストを確認してください"
  },
  "subjects.variants.retry": {
    "zh-Hans": "重试",
    "zh-Hant": "重試",
    "en": "Retry",
    "ja": "再試行"
  },
  "subjects.variants.retryConfirmPaid": {
    "zh-Hans": "重新提交这一张？只提交这一张，会产生费用。",
    "zh-Hant": "重新提交這一張？只提交這一張，會產生費用。",
    "en": "Submit this image again? Only this one is sent, and it is charged.",
    "ja": "この1枚を再送信しますか？送信されるのはこの1枚だけで、料金が発生します。"
  },
  "subjects.variants.retryConfirmMock": {
    "zh-Hans": "重新提交这一张？模拟服务不产生费用。",
    "zh-Hant": "重新提交這一張？模擬服務不產生費用。",
    "en": "Submit this image again? The mock service is free.",
    "ja": "この1枚を再送信しますか？モックサービスは無料です。"
  },
  "subjects.variants.continue": {
    "zh-Hans": "继续提交",
    "zh-Hant": "繼續提交",
    "en": "Continue submitting",
    "ja": "送信を続ける"
  },
  "subjects.variants.continueConfirmPaid": {
    "zh-Hans": "继续提交这批没有提交的 {total} 张？会产生费用。",
    "zh-Hant": "繼續提交這批尚未提交的 {total} 張？會產生費用。",
    "en": "Submit the images of this batch that were not sent ({total})? They are charged.",
    "ja": "このバッチの未送信の {total} 枚を送信しますか？料金が発生します。"
  },
  "subjects.variants.continueConfirmMock": {
    "zh-Hans": "继续提交这批没有提交的 {total} 张？模拟服务不产生费用。",
    "zh-Hant": "繼續提交這批尚未提交的 {total} 張？模擬服務不產生費用。",
    "en": "Submit the images of this batch that were not sent ({total})? The mock service is free.",
    "ja": "このバッチの未送信の {total} 枚を送信しますか？モックサービスは無料です。"
  },
  "subjects.variants.showTasks": {
    "zh-Hans": "到任务中心核对",
    "zh-Hant": "到工作中心核對",
    "en": "Check in the task center",
    "ja": "タスクセンターで確認"
  },
  "subjects.variants.readFailed": {
    "zh-Hans": "补角度和打光记录读取失败，请重新读取",
    "zh-Hant": "補角度和打光紀錄讀取失敗，請重新讀取",
    "en": "Angle and lighting batches couldn't be read. Read again",
    "ja": "別アングルとライティングの記録を読み込めませんでした。再読み込みしてください"
  },
  "subjects.variants.unconfirmed": {
    "zh-Hans": "补角度请求的结果尚未确认。请重新读取，或重新提交同一请求；不会自动重试。",
    "zh-Hant": "補角度請求的結果尚未確認。請重新讀取，或重新提交同一請求；不會自動重試。",
    "en": "The batch request isn't confirmed yet. Read again, or resend the same request. Nothing is retried automatically.",
    "ja": "バッチのリクエスト結果はまだ確認できていません。再読み込みするか、同じリクエストを再送信してください。自動では再試行しません。"
  },
  "subjects.variants.recoveredUnsubmitted": {
    "zh-Hans": "这批已记录，还有图片没有提交。请在版本区继续提交。",
    "zh-Hant": "這批已記錄，還有圖片尚未提交。請在版本區繼續提交。",
    "en": "The batch was recorded, but some images were not submitted. Continue submitting in Versions.",
    "ja": "バッチは記録されましたが、未送信の画像があります。バージョン欄で送信を続けてください。"
  },
  "subjects.variants.reconcile": {
    "zh-Hans": "重新读取",
    "zh-Hant": "重新讀取",
    "en": "Read again",
    "ja": "再読み込み"
  },
  "subjects.variants.resend": {
    "zh-Hans": "重新提交同一请求",
    "zh-Hant": "重新提交同一請求",
    "en": "Resend the same request",
    "ja": "同じリクエストを再送信"
  },
  "subjects.variants.refused.queueFull": {
    "zh-Hans": "图片队列放不下整批，请等已排队的图片完成后再试。没有记录这批。",
    "zh-Hant": "圖片佇列放不下整批，請等已排隊的圖片完成後再試。沒有記錄這批。",
    "en": "The image queue can't hold the whole batch. Wait for queued images to finish. Nothing was recorded.",
    "ja": "画像キューにバッチ全体が入りません。待機中の画像が終わってから再試行してください。何も記録されていません。"
  },
  "subjects.variants.refused.source": {
    "zh-Hans": "这个模型不能编辑选中的版本，请换一张。没有记录这批。",
    "zh-Hant": "這個模型不能編輯選中的版本，請換一張。沒有記錄這批。",
    "en": "This model can't edit the chosen version. Choose another. Nothing was recorded.",
    "ja": "このモデルは選んだバージョンを編集できません。別の画像を選んでください。何も記録されていません。"
  },
  "subjects.variants.refused.kind": {
    "zh-Hans": "补角度和打光只用于角色和产品。",
    "zh-Hant": "補角度和打光只用於角色和產品。",
    "en": "Angles and lighting are for characters and products only.",
    "ja": "別アングルとライティングはキャラクターと製品のみです。"
  },
  "subjects.variants.refused.changed": {
    "zh-Hans": "这批已经变化，已重新读取。请再确认一次。",
    "zh-Hant": "這批已經變化，已重新讀取。請再確認一次。",
    "en": "The batch changed and was read again. Check it and try again.",
    "ja": "バッチが変わったため再読み込みしました。もう一度確認してください。"
  },
  "subjects.variants.refused.undoBlocked": {
    "zh-Hans": "这批已经不能撤销，原因见下方。",
    "zh-Hant": "這批已經不能撤銷，原因見下方。",
    "en": "This batch can't be undone. See the reasons below.",
    "ja": "このバッチは取り消せません。理由は下に表示されています。"
  },
  "subjects.variants.refused.retry": {
    "zh-Hans": "只有服务商拒绝或未发出就取消的图片可以重试。",
    "zh-Hant": "只有服務商拒絕或未送出就取消的圖片可以重試。",
    "en": "Only an image the provider refused, or one cancelled before it was sent, can be retried.",
    "ja": "プロバイダーが拒否した画像か、送信前に取り消した画像だけ再試行できます。"
  },
  "subjects.variants.refused.hidden": {
    "zh-Hans": "这个版本属于已撤销的批次，已隐藏。",
    "zh-Hant": "這個版本屬於已撤銷的批次，已隱藏。",
    "en": "This version belongs to an undone batch and is hidden.",
    "ja": "このバージョンは取り消されたバッチのもので、非表示です。"
  },
  "subjects.variants.refused.capacity": {
    "zh-Hans": "补角度记录已满，暂时不能记录新批次。",
    "zh-Hant": "補角度紀錄已滿，暫時不能記錄新批次。",
    "en": "The batch records are full. A new batch cannot be recorded now.",
    "ja": "バッチ記録がいっぱいです。今は新しいバッチを記録できません。"
  },
  "subjects.variants.submit.queueFull": {
    "zh-Hans": "图片队列已满，这张没有提交。稍后继续提交。",
    "zh-Hant": "圖片佇列已滿，這張沒有提交。稍後繼續提交。",
    "en": "The image queue is full, so this image was not submitted. Continue later.",
    "ja": "画像キューがいっぱいのため、この画像は送信されていません。後で続けてください。"
  },
  "subjects.variants.submit.sourceInvalid": {
    "zh-Hans": "源图没有通过核验（例如有透明区域），这张没有提交。",
    "zh-Hant": "來源圖沒有通過核驗（例如有透明區域），這張沒有提交。",
    "en": "The source didn't pass the check (for example, it has transparency), so this image was not submitted.",
    "ja": "元画像が検証に通らなかったため（例：透明部分がある）、この画像は送信されていません。"
  },
  "subjects.variants.submit.settings": {
    "zh-Hans": "GPT Image 的连接设置已变化或不可用，这张没有提交。",
    "zh-Hant": "GPT Image 的連線設定已變化或不可用，這張沒有提交。",
    "en": "The GPT Image connection changed or is unavailable, so this image was not submitted.",
    "ja": "GPT Image の接続設定が変わったか使えないため、この画像は送信されていません。"
  },
  "subjects.variants.submit.unknown": {
    "zh-Hans": "这张的提交结果未确认。请重新读取，或到任务中心核对；不会自动重试。",
    "zh-Hant": "這張的提交結果未確認。請重新讀取，或到工作中心核對；不會自動重試。",
    "en": "This image's submission isn't confirmed. Read again or check the task center. Nothing is retried automatically.",
    "ja": "この画像の送信結果は未確認です。再読み込みするか、タスクセンターで確認してください。自動では再試行しません。"
  },
  "subjects.variants.submit.rejected": {
    "zh-Hans": "这张的审批已被拒绝，不会生成。",
    "zh-Hant": "這張的審批已被拒絕，不會產生。",
    "en": "The review for this image was rejected, so it will not be made.",
    "ja": "この画像の承認は拒否されたため、作成されません。"
  },
  "subjects.variants.dialogTitle": {
    "zh-Hans": "生成新版本",
    "zh-Hant": "產生新版本",
    "en": "New versions",
    "ja": "新しいバージョン"
  },
  "subjects.variants.dialogDescription": {
    "zh-Hans": "以一个版本为源图，补拍其他机位或换一种打光。结果加入版本列表，不会成为默认版本。",
    "zh-Hant": "以一個版本為來源圖，補拍其他機位或換一種打光。結果加入版本列表，不會成為預設版本。",
    "en": "Use one version as the source to shoot other camera positions or relight it. Results join the versions and never become the default.",
    "ja": "1つのバージョンを元画像にして、別のカメラ位置やライティングで撮り直します。結果はバージョンに加わり、既定にはなりません。"
  },
  "subjects.variants.tabs": {
    "zh-Hans": "新版本类型",
    "zh-Hant": "新版本類型",
    "en": "New version type",
    "ja": "新しいバージョンの種類"
  },
  "subjects.variants.source": {
    "zh-Hans": "源图",
    "zh-Hant": "來源圖",
    "en": "Source",
    "ja": "元画像"
  },
  "subjects.variants.changeSource": {
    "zh-Hans": "换一张",
    "zh-Hant": "換一張",
    "en": "Change",
    "ja": "変更"
  },
  "subjects.variants.sourcePicker": {
    "zh-Hans": "选择源图版本",
    "zh-Hant": "選擇來源圖版本",
    "en": "Choose the source version",
    "ja": "元画像のバージョンを選択"
  },
  "subjects.variants.sourceAngleHint": {
    "zh-Hans": "以这张图为准，只改变机位",
    "zh-Hant": "以這張圖為準，只改變機位",
    "en": "Keeps this image and changes only the camera",
    "ja": "この画像のまま、カメラ位置だけを変えます"
  },
  "subjects.variants.sourceLightHint": {
    "zh-Hans": "以这张图为准，只改变光线",
    "zh-Hant": "以這張圖為準，只改變光線",
    "en": "Keeps this image and changes only the light",
    "ja": "この画像のまま、光だけを変えます"
  },
  "subjects.variants.sourceUsable": {
    "zh-Hans": "可以用于图片编辑",
    "zh-Hant": "可以用於圖片編輯",
    "en": "Can be edited",
    "ja": "画像編集に使えます"
  },
  "subjects.variants.sourceUnusable": {
    "zh-Hans": "不能用于图片编辑",
    "zh-Hant": "不能用於圖片編輯",
    "en": "Can't be edited",
    "ja": "画像編集に使えません"
  },
  "subjects.variants.sourceChecking": {
    "zh-Hans": "正在检查透明区域…",
    "zh-Hant": "正在檢查透明區域…",
    "en": "Checking for transparency…",
    "ja": "透明部分を確認中…"
  },
  "subjects.variants.issue.format": {
    "zh-Hans": "只接受 PNG、JPEG 或 WebP。",
    "zh-Hant": "只接受 PNG、JPEG 或 WebP。",
    "en": "Only PNG, JPEG or WebP can be edited.",
    "ja": "編集できるのは PNG、JPEG、WebP のみです。"
  },
  "subjects.variants.issue.bytes": {
    "zh-Hans": "图片需小于 50 MB。",
    "zh-Hant": "圖片需小於 50 MB。",
    "en": "The image must be under 50 MB.",
    "ja": "画像は 50 MB 未満にしてください。"
  },
  "subjects.variants.issue.dimensions": {
    "zh-Hans": "最长边不能超过 4096 像素。",
    "zh-Hant": "最長邊不能超過 4096 像素。",
    "en": "The long edge must be 4096 pixels or less.",
    "ja": "長辺は 4096 ピクセル以下にしてください。"
  },
  "subjects.variants.issue.origin": {
    "zh-Hans": "视频生成结果和导出素材不能用于图片编辑。",
    "zh-Hant": "影片產生結果和匯出素材不能用於圖片編輯。",
    "en": "Video results and exports can't be used for image editing.",
    "ja": "動画の生成結果と書き出し素材は画像編集に使えません。"
  },
  "subjects.variants.issue.missing": {
    "zh-Hans": "源图未加载或已缺失。",
    "zh-Hant": "來源圖尚未載入或已遺失。",
    "en": "The source image hasn't loaded or is missing.",
    "ja": "元画像が読み込まれていないか、見つかりません。"
  },
  "subjects.variants.issue.transparent": {
    "zh-Hans": "有透明区域。图片编辑只接受不透明的图片。",
    "zh-Hant": "有透明區域。圖片編輯只接受不透明的圖片。",
    "en": "It has transparent areas. Image editing accepts only opaque images.",
    "ja": "透明部分があります。画像編集には不透明な画像のみ使えます。"
  },
  "subjects.variants.sourceRequired": {
    "zh-Hans": "源图不可用，换一张后才能生成",
    "zh-Hant": "來源圖不可用，換一張後才能產生",
    "en": "The source can't be used. Choose another to continue",
    "ja": "元画像が使えません。別の画像を選んでください"
  },
  "subjects.variants.model": {
    "zh-Hans": "模型",
    "zh-Hant": "模型",
    "en": "Model",
    "ja": "モデル"
  },
  "subjects.variants.modelOpenAI": {
    "zh-Hans": "GPT Image · 图片编辑",
    "zh-Hant": "GPT Image · 圖片編輯",
    "en": "GPT Image · image edit",
    "ja": "GPT Image · 画像編集"
  },
  "subjects.variants.modelMock": {
    "zh-Hans": "模拟服务 · 图片编辑",
    "zh-Hant": "模擬服務 · 圖片編輯",
    "en": "Mock service · image edit",
    "ja": "モックサービス · 画像編集"
  },
  "subjects.variants.modelCompatible": {
    "zh-Hans": "兼容服务 · 不支持图片编辑",
    "zh-Hant": "相容服務 · 不支援圖片編輯",
    "en": "Compatible service · no image editing",
    "ja": "互換サービス · 画像編集に非対応"
  },
  "subjects.variants.modelComfy": {
    "zh-Hans": "本地 ComfyUI · 不支持图片编辑",
    "zh-Hant": "本機 ComfyUI · 不支援圖片編輯",
    "en": "Local ComfyUI · no image editing",
    "ja": "ローカル ComfyUI · 画像編集に非対応"
  },
  "subjects.variants.modelOpenAIUnavailable": {
    "zh-Hans": "GPT Image 未连接。在设置里启用官方连接并保存密钥后可用。",
    "zh-Hant": "GPT Image 未連線。在設定裡啟用官方連線並儲存金鑰後可用。",
    "en": "GPT Image is not connected. Enable the official connection and save a key in Settings.",
    "ja": "GPT Image は未接続です。設定で公式接続を有効にしてキーを保存すると使えます。"
  },
  "subjects.variants.camera": {
    "zh-Hans": "机位",
    "zh-Hant": "機位",
    "en": "Camera",
    "ja": "カメラ位置"
  },
  "subjects.variants.selected": {
    "zh-Hans": "已选 {count} 个",
    "zh-Hant": "已選 {count} 個",
    "en": "Selected: {count}",
    "ja": "{count} 件選択"
  },
  "subjects.variants.clear": {
    "zh-Hans": "清空",
    "zh-Hant": "清空",
    "en": "Clear",
    "ja": "クリア"
  },
  "subjects.variants.ringCenter": {
    "zh-Hans": "面朝上方",
    "zh-Hant": "面朝上方",
    "en": "Facing up",
    "ja": "上向き"
  },
  "subjects.variants.existing": {
    "zh-Hans": "已有",
    "zh-Hant": "已有",
    "en": "Exists",
    "ja": "作成済み"
  },
  "subjects.variants.height": {
    "zh-Hans": "高度",
    "zh-Hant": "高度",
    "en": "Height",
    "ja": "高さ"
  },
  "subjects.variants.heightHint": {
    "zh-Hans": "俯拍、仰拍以正面为基准",
    "zh-Hant": "俯拍、仰拍以正面為基準",
    "en": "High and low angles are taken from the front",
    "ja": "ハイ・ローアングルは正面が基準です"
  },
  "subjects.variants.willGenerate": {
    "zh-Hans": "将生成",
    "zh-Hant": "將產生",
    "en": "Will make",
    "ja": "作成予定"
  },
  "subjects.variants.remove": {
    "zh-Hans": "移除 {angle}",
    "zh-Hant": "移除 {angle}",
    "en": "Remove {angle}",
    "ja": "{angle} を外す"
  },
  "subjects.variants.focal": {
    "zh-Hans": "焦距",
    "zh-Hant": "焦距",
    "en": "Focal length",
    "ja": "焦点距離"
  },
  "subjects.variants.focalCurrent": {
    "zh-Hans": "当前：{angle}",
    "zh-Hant": "目前：{angle}",
    "en": "Current: {angle}",
    "ja": "現在：{angle}"
  },
  "subjects.variants.focalStandard": {
    "zh-Hans": "标准 50mm",
    "zh-Hant": "標準 50mm",
    "en": "Standard 50mm",
    "ja": "標準 50mm"
  },
  "subjects.variants.focalWide": {
    "zh-Hans": "广角 24mm",
    "zh-Hant": "廣角 24mm",
    "en": "Wide 24mm",
    "ja": "広角 24mm"
  },
  "subjects.variants.focalHint": {
    "zh-Hans": "焦距按机位分别设置。",
    "zh-Hant": "焦距按機位分別設定。",
    "en": "Each camera keeps its own focal length.",
    "ja": "焦点距離はカメラ位置ごとに設定します。"
  },
  "subjects.variants.focalExisting": {
    "zh-Hans": "{angle}已有{focal}版本。",
    "zh-Hant": "{angle}已有{focal}版本。",
    "en": "{angle} already has a {focal} version.",
    "ja": "{angle} には{focal}のバージョンがあります。"
  },
  "subjects.variants.limit": {
    "zh-Hans": "一批最多 8 张",
    "zh-Hant": "一批最多 8 張",
    "en": "Up to 8 images per batch",
    "ja": "1 バッチ最大 8 枚"
  },
  "subjects.variants.pickAngle": {
    "zh-Hans": "至少选一个机位",
    "zh-Hant": "至少選一個機位",
    "en": "Choose at least one camera",
    "ja": "カメラ位置を1つ以上選んでください"
  },
  "subjects.variants.lightDirection": {
    "zh-Hans": "光源方向",
    "zh-Hant": "光源方向",
    "en": "Light direction",
    "ja": "光源の方向"
  },
  "subjects.variants.reset": {
    "zh-Hans": "复位",
    "zh-Hant": "復位",
    "en": "Reset",
    "ja": "リセット"
  },
  "subjects.variants.azimuth": {
    "zh-Hans": "方位角",
    "zh-Hant": "方位角",
    "en": "Azimuth",
    "ja": "方位角"
  },
  "subjects.variants.elevation": {
    "zh-Hans": "俯仰角",
    "zh-Hant": "俯仰角",
    "en": "Elevation",
    "ja": "仰角"
  },
  "subjects.variants.dirRight": {
    "zh-Hans": "偏右",
    "zh-Hant": "偏右",
    "en": "Right",
    "ja": "右寄り"
  },
  "subjects.variants.dirLeft": {
    "zh-Hans": "偏左",
    "zh-Hant": "偏左",
    "en": "Left",
    "ja": "左寄り"
  },
  "subjects.variants.dirFront": {
    "zh-Hans": "正前",
    "zh-Hant": "正前",
    "en": "Front",
    "ja": "正面"
  },
  "subjects.variants.dirBehind": {
    "zh-Hans": "偏后",
    "zh-Hant": "偏後",
    "en": "Behind",
    "ja": "後ろ寄り"
  },
  "subjects.variants.dirUp": {
    "zh-Hans": "偏上",
    "zh-Hant": "偏上",
    "en": "Up",
    "ja": "上寄り"
  },
  "subjects.variants.dirDown": {
    "zh-Hans": "偏下",
    "zh-Hant": "偏下",
    "en": "Down",
    "ja": "下寄り"
  },
  "subjects.variants.dirLevel": {
    "zh-Hans": "水平",
    "zh-Hant": "水平",
    "en": "Level",
    "ja": "水平"
  },
  "subjects.variants.lightHint": {
    "zh-Hans": "拖动球面上的光点，或直接输入角度。0° 为镜头方向。",
    "zh-Hant": "拖曳球面上的光點，或直接輸入角度。0° 為鏡頭方向。",
    "en": "Drag the light on the sphere, or type the angles. 0° faces the camera.",
    "ja": "球面の光点をドラッグするか、角度を入力します。0° はカメラ方向です。"
  },
  "subjects.variants.sphereLabel": {
    "zh-Hans": "光源位置",
    "zh-Hant": "光源位置",
    "en": "Light position",
    "ja": "光源の位置"
  },
  "subjects.variants.up": {
    "zh-Hans": "上",
    "zh-Hant": "上",
    "en": "Up",
    "ja": "上"
  },
  "subjects.variants.down": {
    "zh-Hans": "下",
    "zh-Hant": "下",
    "en": "Down",
    "ja": "下"
  },
  "subjects.variants.left": {
    "zh-Hans": "左",
    "zh-Hant": "左",
    "en": "Left",
    "ja": "左"
  },
  "subjects.variants.right": {
    "zh-Hans": "右",
    "zh-Hant": "右",
    "en": "Right",
    "ja": "右"
  },
  "subjects.variants.quality": {
    "zh-Hans": "光质",
    "zh-Hant": "光質",
    "en": "Quality",
    "ja": "光の質"
  },
  "subjects.variants.kelvin": {
    "zh-Hans": "色温",
    "zh-Hant": "色溫",
    "en": "Color temperature",
    "ja": "色温度"
  },
  "subjects.variants.warm": {
    "zh-Hans": "暖",
    "zh-Hant": "暖",
    "en": "Warm",
    "ja": "暖"
  },
  "subjects.variants.cool": {
    "zh-Hans": "冷",
    "zh-Hant": "冷",
    "en": "Cool",
    "ja": "寒"
  },
  "subjects.variants.summary": {
    "zh-Hans": "将生成 {count} 张，加入{name}的版本",
    "zh-Hant": "將產生 {count} 張，加入{name}的版本",
    "en": "Adds {count} to {name}'s versions",
    "ja": "{name} のバージョンに {count} 枚追加します"
  },
  "subjects.variants.sizeLine": {
    "zh-Hans": "每张 {size}，跟随源图比例 · 不会成为默认版本",
    "zh-Hant": "每張 {size}，跟隨來源圖比例 · 不會成為預設版本",
    "en": "Each {size}, following the source ratio · never the default version",
    "ja": "各 {size}（元画像の比率）· 既定のバージョンにはなりません"
  },
  "subjects.variants.generate": {
    "zh-Hans": "生成 {count} 张",
    "zh-Hant": "產生 {count} 張",
    "en": "Make {count}",
    "ja": "{count} 枚作成"
  },
  "subjects.variants.generateOne": {
    "zh-Hans": "生成",
    "zh-Hant": "產生",
    "en": "Make",
    "ja": "作成"
  },
  "subjects.variants.costPaid": {
    "zh-Hans": "会产生费用，生成前会再确认一次",
    "zh-Hant": "會產生費用，產生前會再確認一次",
    "en": "Charged by the provider; you confirm once before it starts",
    "ja": "料金が発生します。開始前に一度確認します"
  },
  "subjects.variants.costMock": {
    "zh-Hans": "模拟服务不产生费用，只生成测试图",
    "zh-Hant": "模擬服務不產生費用，只產生測試圖",
    "en": "The mock service is free and makes test images only",
    "ja": "モックサービスは無料で、テスト画像のみ作成します"
  },
  "subjects.variants.confirmPaid": {
    "zh-Hans": "用 GPT Image 生成 {count} 张{name}的新版本？会产生费用；确认后依次提交。",
    "zh-Hant": "用 GPT Image 產生 {count} 張{name}的新版本？會產生費用；確認後依次提交。",
    "en": "Make {count} new versions of {name} with GPT Image? This is charged; they are submitted one by one after you confirm.",
    "ja": "GPT Image で {name} の新しいバージョンを {count} 枚作成しますか？料金が発生します。確認後に順番に送信します。"
  },
  "subjects.variants.confirmMock": {
    "zh-Hans": "用模拟服务生成 {count} 张{name}的测试版本？不产生费用。",
    "zh-Hant": "用模擬服務產生 {count} 張{name}的測試版本？不產生費用。",
    "en": "Make {count} test versions of {name} with the mock service? This is free.",
    "ja": "モックサービスで {name} のテストバージョンを {count} 枚作成しますか？無料です。"
  },
  "subjects.variants.busy": {
    "zh-Hans": "有补角度请求正在处理，请稍候",
    "zh-Hant": "有補角度請求正在處理，請稍候",
    "en": "A batch request is in progress. Please wait",
    "ja": "バッチのリクエストを処理中です。お待ちください"
  },
  "subjects.variants.pendingBlock": {
    "zh-Hans": "上一个补角度请求的结果未确认，先在版本区核对",
    "zh-Hant": "上一個補角度請求的結果未確認，請先在版本區核對",
    "en": "The previous batch request isn't confirmed. Check it in Versions first",
    "ja": "前のバッチのリクエスト結果が未確認です。先にバージョン欄で確認してください"
  },
  "subjects.binding.angleFilter": {
    "zh-Hans": "按角度筛选版本",
    "zh-Hant": "按角度篩選版本",
    "en": "Filter versions by angle",
    "ja": "アングルでバージョンを絞り込む"
  },
  "subjects.binding.usesThis": {
    "zh-Hans": "本镜头使用此版本",
    "zh-Hant": "本鏡頭使用此版本",
    "en": "This shot uses this version",
    "ja": "このショットはこのバージョンを使います"
  },
  "subjects.binding.onlyOne": {
    "zh-Hans": "{angle}只有这一张。换角度请在上方筛选。",
    "zh-Hant": "{angle}只有這一張。換角度請在上方篩選。",
    "en": "This is the only {angle} version. Filter above to change the angle.",
    "ja": "{angle} はこの1枚だけです。アングルを変えるには上で絞り込んでください。"
  },
  "subjects.binding.pickVersion": {
    "zh-Hans": "选用 V{number}",
    "zh-Hant": "選用 V{number}",
    "en": "Use V{number}",
    "ja": "V{number} を使う"
  }
} as const satisfies MessageCatalog;
