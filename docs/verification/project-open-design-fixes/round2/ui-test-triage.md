# UI 与渲染测试失败归类

本表记录第二轮全量执行暴露的 UI 失败、修复依据与实际定向复验，不替代完整测试结果或浏览器验收

## 已修复的失败

| 原失败 | 归类与修复 | 保留的关键断言 | 最终定向结果 |
| --- | --- | --- | --- |
| `clip-lut-ui.test.mjs`：源预览提示的 `style.whiteSpace` 不存在 | 产品可见性回归：完整的原声、gain/fade 和 LUT/调色限定语曾仅在 tooltip/sr-only 中；经主代理授权，恢复为播放器外的普通流段落，紧凑可换行 | 四语言、图像/视频/音频、已选片段与原始素材、原媒体 URL、完整限定语均保留；新增检查提示不在媒体舞台内、不隐藏、不省略；渲染输出不误标为未处理 | 59/59 |
| `design-tokens.test.ts`：时间线私有调色板 | 产品规范回归：8 个轨道媒体颜色改为已有且色值相同的共享 token，文字和阴影改用现有语义 token | 不放宽私有色检测或 token 存在性、对比度断言；未改共享 token 或设计颜色定义 | 5/5 |
| `desktop-launcher-root.test.ts`：首页 `useMemo` 调用 React dispatcher 时为 null | 测试夹具过时：首页新增 memo 所有权门禁，局部 React mock 漏了该 hook；补依赖感知 memo 与共享控件映射 | 原所有权、项目切换、旧回调、创建状态断言全部保留 | 17/17 |
| `export-range-ui.test.mjs`：`useConfirmation` 不存在 | 测试夹具过时：导出工作流新增确认 hook 和 memo；只补渲染期 hook 依赖，意外请求确认会显式抛错 | 不执行任何导出、确认、文件检查或被动请求；范围半开区间与冻结报告断言保留 | 16/16，含下一项 |
| `export-range-ui.test.mjs`：无 range 字段历史仍出现范围摘要 | 测试预期过时：新版历史表格明确显示“全部原时间线”；选段快照与预览范围语义未变 | named/unnamed 原选段仍读取冻结 30–90 帧；legacy 明确全片且不向 snapshot 写入 range；preview 仍无范围摘要；非法 range 继续阻断文件动作 | 同上 |
| `last-project-app.test.mjs`：项目切换时 `setSelectedTaskId` 不存在 | 测试夹具过时：实际 App 项目切换新增清除旧任务详情选择，源码提取环境漏注入该 setter；补记录调用的局部桩 | 最近打开项目、加载失败、旧回调、恢复工作区、缓存身份与取消导航断言全部保留；新增跨项目清空任务详情选择断言 | 14/14 |
| `local-delivery-render.test.mjs`：全局匹配任意展开的 details | 测试选择范围过宽：新版外层原请求摘要可展开，技术参数来源详情仍折叠；按 `delivery-intent-provenance` 的实际开始标签检查 open 属性 | 保留来源参数默认折叠、精确请求参数、冻结规格与终态不再执行文案；额外检查 pending 请求摘要仍展开可见 | 10/10 |
| `local-drafts-app.test.mjs`：实际 mutateTimeline 提取缺 `touchesLockedTrack` | 测试夹具过时：导入真实锁轨判断并提供空的本窗口锁 ref，没有替换为恒 false 桩 | 丢弃草稿后原 unknown 请求身份与原阻断路径不变，不能产生新 requestId 或自动重试 | 17/17 |
| `opacity-candidate-app-entry.test.mjs`：要求 `basicEditingOnly` 必须是 Timeline 第一个属性 | 测试匹配过时：新增锁轨属性排在前面；用已锁定的 TypeScript 编译器解析实际 App TSX，定位唯一 Timeline 上的真实属性 | 仍要求候选 basicEditingOnly 严格绑定 `Boolean(application)`，保留原应用身份、恢复只读、媒体与不支持编辑器的全部断言 | 6/6 |

上述九项中的产品改动仅涉及 `Preview.tsx` 和 `timeline-editing.css`；其余修复仅修改相应测试或局部夹具，未改协议、后端、持久化、依赖或真实供应商调用

## 导出设置首屏布局复验

真实浏览器的 `screens/export-02.png` 显示正常草稿说明和混音检查占据开头，范围与预计行落到滚动区域外；据此经主代理授权重新调整导出布局

- 主字段先排，响度独立一行；高级编码和音频说明集中折叠
- 正常草稿说明放在末尾详情，存在候选、冲突、错误、未知结果、未确认准备或尚未确认接受的原请求时保持展开；未传新状态的调用方默认展开，主代理接入原始实际状态
- 入点与出点并排，诚实的大小和用时信息与唯一检查按钮放进固定步骤底栏；未改估算依据、左栏步骤或后台继续语义
- Workflow 9/9、Preflight 49/49、Settings 37/37、Range 16/16、catalog 5/5，共 116/116；相邻 Preview 5/5、FileActions 12/12、History 9/9、NamedDelivery 9/9 也通过，合计 151/151、0 跳过，其中与本表其他范围有重复，不相加为全量数字

日志为 `/private/tmp/mioon-round2-export-layout-{workflow,preflight,settings,range,catalog}.tap`。新增回归验证固定底栏 slots 与恢复默认安全展开；主代理重建后 `screens/export-02.png` 已重拍，独立目检确认范围、响度、诚实估算行和固定底栏首屏可见

此次 browser tsc 最初在非导出文件 `TimelineInspector.tsx(198,2315)` 报 TS2345（string | undefined 传给 string），主代理修复后完整 browser TypeScript project 复验退出 0，日志 `/private/tmp/mioon-round2-output-size-browser-types.tap`；未放宽校验

## 全量后续暴露的 UI 夹具

| 文件 | 根因与有效修复 | 完整文件定向结果 |
| --- | --- | --- |
| `project-specifications-ui.test.mjs` | Preflight 新增范围说明使用真实 `exportRangeDescription`，组件夹具缺该模块；接入真实 export-range-state，不替代范围算法 | 43/43 |
| `right-dock-layout.test.mjs` | 授权意图新增原消息捕获，旧 exact regex 未含 `message:state.draft`；保留授权准入断言并检查确认前当前消息一致 | 6/6 |
| `timeline-loudness-apply-app.test.ts` | 实际 mutateTimeline 提取环境缺真实锁轨 helper/ref，发送前抛异常，造成 unknown 连锁失败；导入真实 helper，提供空的本窗口 ref | 7/7 |
| `timeline-loudness-apply-close.test.ts` | 同上，导致未创建任务后的恢复用例连锁失败；不改超时、关闭或原请求恢复断言 | 18/18 |
| `timeline-recovery-audit.test.mjs` | 同一锁轨依赖缺失；另 TaskCenter 新增属性后不再以 taskViewScope 作首属性，改为同一组件标签内检查原两个属性 | 26/26 |
| `topbar-save-status.test.mjs` | selectProject 提取环境缺新增的任务详情选择 setter；补记录桩，保留项目隔离、延迟 ACK、重试和确认门禁 | 15/15 |
| `workbench-shell.test.mjs` | openTasks 提取环境漏可选任务选择 setter；补记录桩，并断言普通入口显式清除旧选择 | 5/5 |
| `web-layout-polish.test.mjs` | 真实规范问题：画幅选中标记使用 9px；经该样式所有者授权仅改为 10px，不改其他样式或字级断言 | 6/6 |

上述日志为 `/private/tmp/mioon-round2-repair-{specs,dock,loudness-app,loudness-close,recovery-audit-final,topbar-status,workbench-shell-final,layout-polish}.tap`。首次 audit 补齐运行依赖后还保留了两项过时属性顺序断言失败，修复前后日志均保留，不计作通过

## 导出真实输出大小与取消确认竞态

历史表原记录并不携带 `sizeBytes`。普通和命名行现在通过显式 `outputAssets` 只读匹配同项目、同 assetId 的真实资源元数据，只接受正安全整数；缺失、外项目、非法值均显示 `—`，不使用附加在原 receipt 上的伪大小，不修改冻结记录或准入。History 10/10、NamedDelivery 10/10、Range 16/16、Settings 37/37，共 73/73、0 跳过；重拍的 `screens/export-06.png` 已实见成功输出的 1.3 MB，取消且无输出的行保持 `—`

独立审查另确认了真实竞态：取消确认等待期间，同一导出从 queued 进入 running，旧 activity callback 的 owner 已退役，用户确认后可能零派发。Workflow 确认后保留原 project/exportId/可见性所有权与非终态校验，同时调用 live ref 的最新 callback；新增 deferred-confirm 回归，同一身份更新状态后仅调用最新 callback 一次，替换项目/导出、隐藏再打开、终态与卸载仍拒绝。Workflow 完整 10/10；日志 `/private/tmp/mioon-round2-export-cancel-status-transition-final.tap`

确认步骤的主按钮还受到旧 footer 的 `flex:1` 影响。仅在工作流第 3 步局部覆盖为内容宽、36px 高，保持原颜色、权限和事件；Workflow、Preflight、token 定向检查均通过，最终新构建截图复核另见视觉报告

## UTF-8 测试采集边界

`transport-utf8-output.test.mjs` 的原源文本扫描未识别 TypeScript 非空断言、类型断言和 `stderrStream` 别名，先在 generation-input 的 4 个既有监听中漏扫 2 个。现在只对已列入文本清单的 TypeScript 文件，用既有 esbuild 编译后的真实 JavaScript 注册表达式审计；保留所有既有监听数，并将原先漏扫的 SDK stderr 明确增入每文件计数。每个文本注册仍通过真实 PassThrough 按字节输入中文与 emoji，验证监听前已启用连续 UTF-8，未按字符串替换忽略乱码

新增 task/workspace 两个 SDK stderr 监听仅丢弃字节，单独列出精确空回调与每文件 1 个的清单；不把文本拼接监听放进该例外，也不放宽未分类监听失败。Typed 别名的可选访问仍验证缺失接收者不会抛错

该审计还揭示了 3 个测试夹具中的 4 处真实连续解码缺失：`timeline-jpeg-transports.test.ts` 的 CLI stdout/stderr 循环和 SDK stderr、`asset-annotation-transports.test.ts` 的 SDK stderr、`timeline-loudness-apply-transports.test.ts` 的 SDK stderr。只补 `setEncoding('utf8')` 与真实 Readable 类型，不改业务、协议、时限、输出约束或原断言；没有重跑这些重型 transport 整套

UTF-8 完整文件最终 4/4、0 跳过，日志 `/private/tmp/mioon-round2-repair-transport-utf8-final8.tap`。中间清单漏项和原测试夹具错误均如实失败，早期日志保留；不将其计为成功。最终测试 TypeScript project 退出 0，日志 `/private/tmp/mioon-round2-ui-tests-types-final4.tap`；`git diff --check` 退出 0

本代理的 35 项完整文件复验、分类、命令、日志与每文件 pass/fail 已单列在 `ui-retest-results.json`。其中三个 transport 测试的 decoder 改动只由完整 UTF-8 inventory 审计真实监听表达式，未重新执行该三文件整套，机器清单亦明确标识，不用子范围冒充全文件通过

## 后续公共操作文案缺失

继续监看全量时，`i18n-command-unit` 和 `i18n-backup-mcp-diagnostics` 暴露了真实产品缺陷：本轮新增的 12 个 export/workspace/task 公共操作缺少四语言 operation presentation，使用显式 locale 的 MCP 会在注册工具时抛出 `Unknown presentation message key`，尚未进入正常 transport 初始化

经主代理授权，仅在 `packages/i18n/src/catalogs/operations.ts` 补齐这 12 项的四语言文案；未修改 operation 身份、输入 schema、effects 或公共契约中的机器描述。两份 legacy CLI help 测试仅显式前置新增操作，保留全部旧机器文案、字节和既有操作相对顺序

严格 catalog 穷举检查 `missing=[]`、`catalogErrors=[]`；未知 operation key 继续显式失败，不回退吞错。CLI 补验实际四 locale 的完整 schema 输出，MCP 补验四 locale 初始化、完整 tools/list 以及这 12 项的 schema 工具调用

最终实际命令：

```sh
TMPDIR=/private/tmp node --test --test-reporter=tap tests/i18n-command-unit.test.ts
TMPDIR=/private/tmp node --test --test-reporter=tap tests/i18n-command-presentation.test.ts
TMPDIR=/private/tmp node --test --test-reporter=tap tests/i18n-backup-mcp-diagnostics.test.ts
TMPDIR=/private/tmp node --test --test-reporter=tap tests/i18n-catalog-integrity.test.ts
```

前三文件分别 4/4、5/5、8/8，共 17/17、0 跳过；完整 catalog 规范检查另为 5/5，均退出 0。日志为 `/private/tmp/mioon-round2-repair-i18n-command-unit-final.tap`、`/private/tmp/mioon-round2-repair-i18n-command-presentation-frozen.tap`、`/private/tmp/mioon-round2-repair-i18n-backup-mcp-diagnostics.tap`、`/private/tmp/mioon-round2-repair-i18n-catalog-integrity.tap`

冻结前的 presentation 试跑曾读到两种 `export.cancel.effects.fileWrite`：父进程已缓存 false，后启动的 CLI/MCP 子进程读到主代理刚改为 true 的源码，严格比较如实失败。没有放宽 effects 断言；主代理确认契约冻结后完整重跑为上述 5/5。准备阶段的旧夹具运行也不计为通过，相关原日志保留

## 整合审查的补充证据

- 主代理已修复 App 的音量建议锁轨准入，新增 `agent-timeline-gain-renderer.test.mjs` 实际组件回归验证：锁定当前轨道后，已加载的音量提议不能批准；拒绝入口仍可用；旧批准回调、解锁后的旧回调均不发送；只有新的合法批准发送一次并应用一次，24/24 通过
- `agent-timeline-app.test.ts` 的 `lockedTrackIds` 源码提取环境由另一代理修复，本代理独立复跑 3/3 通过，未重复编辑
- 整合审查发现的 task disposition 同步重复提交缺口由主代理补上 flight 门禁，未在本表冒充为本代理修复

## 实际命令与覆盖

以下各测试分别使用独立 Node 进程运行，`TMPDIR=/private/tmp`，未放宽内部测试时限

```sh
TMPDIR=/private/tmp node --test tests/clip-lut-ui.test.mjs
TMPDIR=/private/tmp node --test tests/design-tokens.test.ts
TMPDIR=/private/tmp node --test tests/desktop-launcher-root.test.ts
TMPDIR=/private/tmp node --test --test-reporter=tap tests/export-range-ui.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/agent-timeline-app.test.ts
TMPDIR=/private/tmp node --test --test-reporter=tap tests/source-range-ui.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/source-range-preview.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/workspace-visibility.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/video-first-last-ui.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/timeline-audio-preview-ui.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/last-project-app.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/local-delivery-render.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/local-drafts-app.test.mjs
TMPDIR=/private/tmp node --test --test-reporter=tap tests/opacity-candidate-app-entry.test.mjs
node node_modules/typescript/bin/tsc -p tests/typecheck/tsconfig.browser.json --noEmit
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json --noEmit
git diff --check
```

14 个上述测试文件共 259/259 通过、0 跳过；导出二次布局前两个 TypeScript project 和 diff 检查均退出 0。公共操作文案与当时测试源码冻结后，tests TypeScript project 再次复核退出 0，日志 `/private/tmp/mioon-round2-repair-i18n-testtypes-final.tap`；后续导出布局的类型检查状态见上节

相邻预览覆盖分别为 source-range-ui 14、source-range-preview 26、workspace-visibility 17、video-first-last-ui 24、timeline-audio-preview-ui 31 项，包含真实组件事件、媒体绑定与旧回调门禁；未仅依赖样式文本断言

日志保存在 `/private/tmp/mioon-round2-repair-*.tap`；Agent 锁轨回归日志为 `/private/tmp/mioon-agent-gain-lock-review.tap`

## 未宣称通过的边界

- 初轮全量日志保留原失败，不能因本表的定向复验将尚未结束的完整测试标为通过
- 本次未另启重型媒体或多传输整套；drawtext/subtitles 环境缺失与长耗时 wire 的分类见 `settings-test-triage.md`
- 普通流提示的实际 1440×900、1050×680 视觉效果仍需最终新构建截图复核；本表不以合成组件树代替浏览器验收
- 36 页截图由主代理在真实状态下采集，私有设计源和设计截图未复制到本报告目录
