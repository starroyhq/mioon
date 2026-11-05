# 第 1 组：首页、卡片菜单、任务等待、新建和打开失败

本组 35 张 PNG，共 645,565 字节，最大单张 45,295 字节，均低于 95,000 字节。Chromium 156.0.8078.75，简体中文、深色主题、1440×900、Asia/Shanghai、减少动画。最终 `results.json` 的 35 个 `errors` 数组均为空；四种语言由 `tests/project-file-ui-home.test.ts` 做服务端渲染检查。

本组验证受控组件和示例状态。`RecentProjectsView`、`RecentProjectCard`、`RecentProjectMenu`、`ProjectWaitingNotice` 对应 12-01、12-21、12-21b、12-24。新建和打开失败仍是原有 `NewProjectFileDialog`、`ProjectOpenFailureDialog` 场景。截图不证明原生选择器、复制、废纸篓、定位、更新或备份恢复已经接入生产流程：gallery 为展示状态提供示例回调，生产没有能力时隐藏相应入口。

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
| 12-02 | 就绪 | [12-02.png](12-02.png) | 原有受控新建框的字段、路径、方向、三种画幅和按钮；不是新流程端到端接线证据 |
| 12-02 | 不建同名文件夹 | [12-02-no-folder.png](12-02-no-folder.png) | 路径直接指向所选位置下的 .mioon |
| 12-02 | 名称为空 | [12-02-empty-name.png](12-02-empty-name.png) | 创建禁用，不显示虚假的最终路径 |
| 12-02 | 名称非法 | [12-02-invalid-name.png](12-02-invalid-name.png) | 行内说明和禁用创建 |
| 12-02 | 创建中 | [12-02-creating.png](12-02-creating.png) | 字段只读、取消/关闭禁用、主按钮加载 |
| 12-02 | 目标已存在 | [12-02-exists.png](12-02-exists.png) | 已存在提示，不暗示覆盖文件 |
| 12-02 | 网页位置 | [12-02-web.png](12-02-web.png) | 位置由调用方给出，无系统选择器 |
| 12-03 | 缺失 | [12-03.png](12-03.png) | 原有失败框的名称、完整路径和动作；框内仍用旧可选 inboxCount 文案，不能当成 S3 新任务语义已接入 |
| 12-03 | 无旧 inbox 计数 | [12-03-no-inbox.png](12-03-no-inbox.png) | 不显示旧结果说明，不等于后台已确认没有未结束任务 |
| 12-03 | 定位中 | [12-03-locating.png](12-03-locating.png) | 定位加载、移除禁用，仅受控动作态 |
| 12-03 | 定位失败 | [12-03-error.png](12-03-error.png) | 定位错误提示，仅示例错误态 |
| 12-03b | 被占用 | [12-03b.png](12-03b.png) | 原有占用说明和关闭按钮 |
| 12-03c | 格式更新 | [12-03c.png](12-03c.png) | 格式/支持版本分别说明；更新按钮来自示例回调 |
| 12-03c | 本机记录更新 | [12-03c-history.png](12-03c-history.png) | 区分项目文件与本机记录，不给更新回调时只显示关闭 |
| 12-03d | 无效 | [12-03d.png](12-03d.png) | 原有无效说明，恢复按钮来自示例回调，不证明生产恢复已接线 |
| 12-03d | 恢复中 | [12-03d-restoring.png](12-03d-restoring.png) | 原有恢复动作加载，关闭禁用 |
| 12-03d | 只读 | [12-03d-read-only.png](12-03d-read-only.png) | 说明只读，不叫损坏、不显示恢复；显示位置来自示例回调 |

## 共同视觉差异

- gallery 只有 U1 组件，没有应用顶栏、搜索输入、窗口或工作台。12-01 比整页设计靠上；12-21 独立显示菜单，没有整张项目卡片背景。真实生产首页的壳和交互另行验证。
- 卡片菜单按钮在悬停、键盘焦点或展开时显示。未悬停的 12-01 不显示按钮；12-21 展开图显示触发器和菜单。
- 菜单、按钮、分段切换和模态框采用现有共用组件，边框/内边距与设计示意有差异；禁用项悬停说明不在静态图中。
- 12-02/12-03 背景是受控首页。共用对话框的暗化/模糊与预览不同；原工具在标题点鼠标，去掉无鼠标操作时的按钮焦点环。
- SVG 示例封面的渐变经 256 色 PNG 压缩后有色带；本机等宽字体回退与设计字形不同。
- 12-24 的系统权限状态只是受控展示：当前后端未给对应原因时，生产映射不会伪造权限错误。

## 复现与错误边界

第一次按原工具运行，记录了 `12-01-cover-error` 的真实 HTTP 404 控制台错误，保存在 `/private/tmp/s6c/home-capture/capture-baseline.log` 和 `baseline-evidence/home/results.json`，该轮不能算通过。

最终只在临时 bundle 目录为失败封面 URL 放入 HTTP 200 非图像字节，真实触发解码失败与 onError。没有改产品/场景源文件、截图工具或清洗 `results.errors`。真实 404 由独立浏览器交互验证，预期 resource console.error 仍须如实分类。

```sh
export PATH="$HOME/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH"
mkdir -p /private/tmp/s6c/tmp /private/tmp/s6c/home-capture
TMPDIR=/private/tmp/s6c/tmp node tests/fixtures/project-file-ui/build-gallery.ts --out /private/tmp/s6c/home-capture/gallery-dist
python3 -c 'from pathlib import Path; p=Path("/private/tmp/s6c/home-capture/gallery-dist/api/project-covers"); p.mkdir(parents=True, exist_ok=True); (p/"missing-cache").write_bytes(b"not-an-image: controlled gallery decode-error fixture\n")'
TMPDIR=/private/tmp/s6c/tmp python3 -u tests/fixtures/project-file-ui/capture.py --dist /private/tmp/s6c/home-capture/gallery-dist --group home
TMPDIR=/private/tmp/s6c/tmp node --test --test-timeout=600000 tests/project-file-ui-home.test.ts
```

bundle 日志为 `/private/tmp/s6c/home-capture/build.log`，最终截图日志为 `capture-final.log`；后者实际退出 0，35 张没有 pageerror、console error 或 fixture error。服务和浏览器均由本次专用工具创建并正常关闭。
