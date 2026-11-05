# 第 1 组：首页、菜单、任务等待、新建、打开错误和位置风险

本轮 61 张 PNG，共 1,162,871 字节，最大单张 45,295 字节，全部低于 95,000 字节。Chromium 156.0.8078.75，简体中文、深色主题、1440×900、Asia/Shanghai、减少动画；61 个 `results.errors` 数组均为空。四语由 `tests/project-file-ui-home.test.ts` 的同一场景表 SSR 验证。

这些是 P6 受控组件截图，不是生产流程或原生桥端到端证据。示例路径、原项目身份、位置风险和回调均由夹具明确提供。12-03e/h/i、权限设置、Reveal、可信重新指向等原生能力由 S6-B/B2 提供后再接；2a 缺能力时入口隐藏。副本/复制到的画面不证明 2a 已取得可信复制来源。12-03h/i 的“复制到…”按协调人 11-05 决定复用系统存储面板，默认项目名，允许改名，不覆盖；设计预览的旧文件夹选择面板注释不再适用。

`waitingTaskCount` 表示已验证的未结束生成任务。正数禁移除，明确 0 才允许示例移除回调，未知也禁移除；没有放弃任务动作。`12-03-no-inbox` 保留历史 ID，实际含义为 confirmed waiting 0。旧 inbox 数不再用于该失败框。

## 逐图对照

| 设计稿 | 状态 | 截图 | 核对内容与限制 |
|---|---|---|---|
| 12-01 | 就绪 | [12-01.png](12-01.png) | 6 个登记项目、最近打开标签、排序/网格切换、封面/时长/名称/画幅/路径/日期；缺失卡片说明和警告色“2 个生成任务在等这个项目”；任务等待横幅、定位和保存期限提示 |
| 12-01 | 列表 | [12-01-list.png](12-01-list.png) | 同一组卡片改为列表；缺失、锁定、项目文件只读和无效分别说明；无等待任务时无横幅 |
| 12-01 | 空目录 | [12-01-empty.png](12-01-empty.png) | 空状态，以及调用方提供的打开/新建回调 |
| 12-01 | 加载 | [12-01-loading.png](12-01-loading.png) | 骨架和加载状态，不伪造登记项或任务数 |
| 12-01 | 读取失败 | [12-01-error.png](12-01-error.png) | 错误提示和重试 |
| 12-01 | 无等待任务 | [12-01-inbox-none.png](12-01-inbox-none.png) | 无横幅及任务计数；保留历史场景 ID，内容已改成任务等待语义 |
| 12-01 | 无摘要、从未成功打开 | [12-01-no-summary.png](12-01-no-summary.png) | 保留登记和路径，封面占位；不编造最近打开标签、画幅、时长和时间 |
| 12-01 | 封面解码失败 | [12-01-cover-error.png](12-01-cover-error.png) | 真实图像 onError 后占位；临时 HTTP 200 无效图像，不能据此声称真实 404 控制台错误为零，见下方说明 |
| 12-01 | 搜索无匹配 | [12-01-no-matches.png](12-01-no-matches.png) | 保留总数、排序和任务提示，显示无匹配，不冒充空目录 |
| 12-21 | 找得到文件 | [12-21.png](12-21.png) | 打开、复制、Finder 显示、废纸篓四项，危险项分隔；availability=open 而未声明编辑窗口时不误禁复制 |
| 12-21b | 已有编辑窗口 | [12-21-open.png](12-21-open.png) | 明确窗口信息使复制/废纸篓置灰；打开/显示位置保留；“先关闭项目”在悬停 title 中，静态图不展示 |
| 12-21b | 缺失 | [12-21-missing.png](12-21-missing.png) | 仅定位、从最近移除，不出现复制/废纸篓；示例回调不证明安全忘记登记 API 已实现 |
| 12-21b | 缺失且有任务 | [12-21-waiting.png](12-21-waiting.png) | 移除置灰，title 为“还有生成任务在等，先找回项目”；无放弃任务动作 |
| 12-21b | 任务未知 | [12-21-unknown.png](12-21-unknown.png) | 移除仍置灰，不把读取失败当作没有任务 |
| 12-21b | 网页能力 | [12-21-web.png](12-21-web.png) | 仅打开；未给定位、复制、显示、废纸篓、忘记回调，相关项隐藏 |
| 12-24 | 多项目折叠 | [12-24.png](12-24.png) | 前 2 项加第 3 行“还有 4 个项目的生成任务在等”，全部显示、保存期限及卡片计数；第二排底部任务行在固定 900px 视口外，不声称完整长页 |
| 12-24 | 六种原因 | [12-24-reasons.png](12-24-reasons.png) | 通用不可用、系统权限、只读、被占用、本机缺失、外置卷缺失及对应能力按钮；六个独立示例各带保存期限，与总稿示意顺序及只写一次说明不同 |
| 12-24 | 后台摘要失败 | [12-24-error.png](12-24-error.png) | 警告和重试，不显示未经确认的任务数，不静默使用空任务列表 |
| 12-02 | 就绪 | [12-02.png](12-02.png) | 受控新建的名称、位置、方向、三种画幅和创建；不证明原生位置选择/创建已接线 |
| 12-02 | 不建同名文件夹 | [12-02-no-folder.png](12-02-no-folder.png) | 路径直接指向所选位置下的 .mioon |
| 12-02 | 名称为空 | [12-02-empty-name.png](12-02-empty-name.png) | 创建禁用，不显示虚假的最终路径 |
| 12-02 | 名称非法 | [12-02-invalid-name.png](12-02-invalid-name.png) | 行内说明和禁用创建 |
| 12-02 | 创建中 | [12-02-creating.png](12-02-creating.png) | 字段只读、取消/关闭禁用、主按钮加载 |
| 12-02 | 目标已存在 | [12-02-exists.png](12-02-exists.png) | 已存在提示，不暗示覆盖文件 |
| 12-02 | 网页固定文件夹 | [12-02-web.png](12-02-web.png) | 无系统选择器；folderMode=always，文件夹勾选且禁用，不提供无法执行的布局切换 |
| 12-02b | 云同步风险 | [12-02b-cloud.png](12-02b-cloud.png) | 明确提供 iCloud 事实，保存位置下警告；不阻止创建，不按路径猜服务 |
| 12-02b | exFAT 风险 | [12-02b-exfat.png](12-02b-exfat.png) | 明确 exFAT 权限事实；警告其他账户可读写、拔盘前关闭；不阻止创建 |
| 12-02b | 无权限保护风险 | [12-02b-permissions.png](12-02b-permissions.png) | 明确缺少权限保护，但文件系统未知；使用通用说明，不造 exFAT 名称 |
| 12-02b | 网络位置拒绝 | [12-02b-network.png](12-02b-network.png) | 项目文件不可放 SMB/NFS；素材仍可在网络盘；创建禁用 |
| 12-02b | 位置核对中 | [12-02b-checking.png](12-02b-checking.png) | 位置未确认时创建禁用，不冒充可写本机位置 |
| 12-02b | 位置无法确认 | [12-02b-unavailable.png](12-02b-unavailable.png) | 错误和选择其他位置说明，创建禁用 |
| 12-02 | 创建结果未知 | [12-02-unknown.png](12-02-unknown.png) | 输入冻结、取消关闭禁用，只提供核对原创建结果；无再次创建入口 |
| 12-02 | 已创建、未打开 | [12-02-created.png](12-02-created.png) | 保留已有项目名称，只重试打开；无再次创建入口 |
| 12-02 | 重试打开中 | [12-02-created-opening.png](12-02-created-opening.png) | 已创建事实保留，输入和关闭冻结，重试显示加载 |
| 12-03 | 已确认 2 个等待任务 | [12-03.png](12-03.png) | 使用 waitingTaskCount=2，任务等待说明、移除禁用、定位；不使用旧 inbox 计数 |
| 12-03 | 已确认等待任务为 0 | [12-03-no-inbox.png](12-03-no-inbox.png) | 保留历史场景 ID；waitingTaskCount=0 才启用示例移除回调，不是放弃后台任务 |
| 12-03 | 定位中 | [12-03-locating.png](12-03-locating.png) | 已确认 2 个等待任务，定位加载、其他动作禁用；受控动作态 |
| 12-03 | 定位失败 | [12-03-error.png](12-03-error.png) | 真实任务等待语义与动作错误提示；不自动放弃任务 |
| 12-03 | 等待任务未知 | [12-03-tasks-unknown.png](12-03-tasks-unknown.png) | 不显示未经确认的数量；移除禁用，不能当作已确认 0 或放弃任务 |
| 12-03b | 被占用 | [12-03b.png](12-03b.png) | 原有占用说明和关闭按钮 |
| 12-03c | 格式更新 | [12-03c.png](12-03c.png) | 格式/支持版本分别说明；更新按钮来自示例回调 |
| 12-03c | 本机记录更新 | [12-03c-history.png](12-03c-history.png) | 区分项目文件与本机记录，不给更新回调时只显示关闭 |
| 12-03d | 无效 | [12-03d.png](12-03d.png) | 原有无效说明，恢复按钮来自示例回调，不证明生产恢复已接线 |
| 12-03d | 恢复中 | [12-03d-restoring.png](12-03d-restoring.png) | 原有恢复动作加载，关闭禁用 |
| 12-03d | 只读、无复制能力 | [12-03d-read-only.png](12-03d-read-only.png) | 只读标题与写入要求，不叫损坏、不提供恢复；仅给示例 Reveal，无 copyTo 时隐藏复制入口 |
| 12-03e | 副本及示例能力 | [12-03e.png](12-03e.png) | 完整原项目路径、改写副本的影响和原文件不变；原项目/采纳动作来自示例回调 |
| 12-03e | 副本、能力缺失 | [12-03e-no-capabilities.png](12-03e-no-capabilities.png) | 相同的受控事实，未给原项目或采纳回调时隐藏按钮，只保留取消 |
| 12-03e | 采纳结果未知 | [12-03e-unknown.png](12-03e-unknown.png) | 关闭和原有动作禁用，只能核对原请求；不提供重复写入 |
| 12-03f | MOVED 后找不到文件 | [12-03f-missing.png](12-03f-missing.png) | 仅在 writeRejected=true 的示例事实下说明刚才一步未写入；关闭项目、定位 |
| 12-03f | MOVED 后权限拒绝 | [12-03f-access.png](12-03f-access.png) | 原因明确为没有权限访问新位置，不替换成找不到文件 |
| 12-03f | MOVED 后磁盘断开 | [12-03f-disk.png](12-03f-disk.png) | 原因明确为磁盘断开；不以路径推断外置盘状态 |
| 12-03g | macOS 权限帮助 | [12-03g.png](12-03g.png) | 文件与文件夹设置路径、Finder 共享与权限、重试；设置按钮来自示例能力 |
| 12-03g | 新建时权限拒绝 | [12-03g-create.png](12-03g-create.png) | 保留输入说明、取消和选择其他位置；没有重试打开按钮 |
| 12-03g | 非 macOS 权限拒绝 | [12-03g-web.png](12-03g-web.png) | 只显示系统权限通用说明，不给 macOS 专用引导或设置回调 |
| 12-03h | 只读及示例复制能力 | [12-03h.png](12-03h.png) | 与 12-03d 的只读语义一致；示例 Reveal 和复制到，不显示恢复；复制到使用系统存储面板 |
| 12-03i | 网络位置及示例复制能力 | [12-03i.png](12-03i.png) | 网络位置拒绝和素材可保留网络盘；示例复制到使用系统存储面板 |
| 12-03i | 网络位置、无复制能力 | [12-03i-no-copy.png](12-03i-no-copy.png) | 缺少可信来源/复制能力时隐藏复制按钮，只保留关闭 |
| 12-03g | 无法确认打开原因 | [12-03-unknown.png](12-03-unknown.png) | 无路径、版本和来源事实时使用通用失败；不编造格式数字或诊断 |
| 12-15 | 打开会话的云同步风险 | [12-15-cloud.png](12-15-cloud.png) | 受控单条横幅、知道了；无编辑器顶栏，不证明原生打开事实已接入 |
| 12-15 | 打开会话的 exFAT 风险 | [12-15-exfat.png](12-15-exfat.png) | 受控权限/拔盘提示与知道了；示例回调不持久化已读标记 |
| 12-15 | 多个已确认风险 | [12-15-combined.png](12-15-combined.png) | 同一横幅显示云同步与通用权限风险；一次会话一个受控关闭动作 |

## 已知视觉与证据边界

- 12-01/21/24 保留上一轮首页与菜单状态；gallery 缺少应用顶栏、搜索框和真实工作台，菜单独立显示。固定 900px 视口可能不包含第二排卡片最底部的任务行，不能据此声称长页全部可见。
- 12-02b 设计把三类风险纵向排在示意稿里，本组分别放到完整受控新建框；共享控件的间距、图标和字体有差异。unknown/created 是额外的真实边界状态，没有对应静态设计预览。
- 12-03e 原路径完整显示，宽度不足时横向滚动/换行由共享样式处理。12-03f 只截自动重开失败后的对话框，不冒充已验证自动重试过程或顶部瞬时提示。
- 12-03g 使用共享对话框的权限列表。无 macOS 事实时使用通用说明。系统设置/定位/复制等示例回调只控制可见性，不启动操作系统动作。
- 12-15 只截横幅外框，2 倍图；设计中的编辑器顶栏未包含。多个风险合在一个受控横幅，与稿中两条独立示意不同。跨打开会话重置由真实 owner/浏览器另测，截图不证明生命周期行为。
- 模态框背景暗化/模糊、SVG 封面渐变的 256 色色带、等宽字体回退与确认 PNG 有差异。创建输入自动聚焦形成的边框来自共享控件；截图工具仅按既有规则处理按钮焦点。

## 复现、备份和错误

旧 35 张及原 results/README 已备份到主目录 `.agents/tasks/howard-s6-open-flow/s6c-2/gallery-validation/baseline/home/`。原 PR1 真实 HTTP 404 的失败原始日志与 results 另保存在同目录 `pr1-404-failure/`，该失败轮不计通过。

本轮在临时 dist 的 `/api/project-covers/missing-cache` 放入 HTTP 200 的非图像字节，真实触发浏览器解码失败和 `onError`，只验证封面占位。不能用这张图声称真实 HTTP 404 的 resource console.error 为零；真实 404 由独立生产浏览器验证另行分类。没有改产品、capture guard 或清洗 `results.errors`。

```sh
export PATH="$HOME/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH"
export TMPDIR=/private/tmp/s6c/tmp
node tests/fixtures/project-file-ui/build-gallery.ts --out /private/tmp/s6c/pr2-gallery/gallery-dist
python3 -c 'from pathlib import Path; p=Path("/private/tmp/s6c/pr2-gallery/gallery-dist/api/project-covers"); p.mkdir(parents=True, exist_ok=True); (p/"missing-cache").write_bytes(b"not-an-image: controlled gallery decode-error fixture\n")'
python3 -u tests/fixtures/project-file-ui/capture.py --dist /private/tmp/s6c/pr2-gallery/gallery-dist --group home
node --test tests/project-file-ui-home.test.ts
```

构建和首轮成功截图日志在主目录 `.agents/tasks/howard-s6-open-flow/s6c-2/gallery-validation/build.log`、`capture-home-attempt1.log`；对应 `.exit` 为 0。独立 SSR 的中间失败日志与最终结果分开保留，不把 README 未更新或断言语义未同步的中间轮记作通过。临时服务使用工具自行分配的端口，浏览器和服务均由本轮工具创建并关闭。
