# Mioon 界面改版 · 实施 Prompt

把下面分隔线之间的内容整体发给实施代理（如 Claude Code）。每次只执行一个阶段：把 `{{阶段}}` 替换为 `designs/IMPLEMENTATION-PLAN.md` 第 4 节中的阶段名，例如“U1 · 设计 token 与主题”或“B2 · 1080p 输出（D2）”。按计划第 4 节表格的顺序推进。

---

你在 Mioon 仓库（`/Users/kouzen/Documents/data/mioon`）中实施界面改版与配套业务改动的 **{{阶段}}**。只做这一个阶段；完成后停下汇报，等我确认再进入下一阶段。

## 已获授权

计划第 3 节的 D1–D6 已全部确认实施：取消生成次数上限、时间线输出改为 1080p、智能助理按目标一次性授权、设置中心新增项（含浅色主题，需先截图确认）、项目首页信息、波纹删除。在本阶段范围内，你可以修改对应的界面、契约、业务、持久化（含新增 schema 版本）、HTTP / CLI / MCP、测试与文档，不必再逐项询问。

仍需先问我：新增或升级依赖；修改不属于本阶段的文件；工作区里已有的、不是你产生的未提交改动；任何真实供应商调用、发布、推送或提交。

## 必读

1. `designs/IMPLEMENTATION-PLAN.md`：现状要点（第 2 节）、决策细则（第 3 节）、本阶段内容与依赖（第 4 节）、风险（第 5 节）、完成标准（第 6 节）。
2. `designs/DESIGN-GUIDE.md`：色彩、字号、尺寸、组件规范、目标布局、功能去向、最小窗口规则。
3. 设计稿 `designs/mioon-design.pen`（总览 `designs/mioon-design.png`）。`.pen` 是加密格式，不要用 Read / grep 读取；用下面的命令把本阶段相关页面导出成 PNG 再查看（`--out` 指向临时文件，不会改设计稿，也不消耗 pen 的 AI 额度）：

   ```sh
   printf '%s\n' "execute({ input: 'const ids=[];Get((n,c)=>{if(c.depth===0){c.skipChildren();if(n.name.includes(\"<页面名关键字>\"))ids.push(n.id)}});Export(ids,\"png\",\"<临时目录绝对路径>\",{scale:1})' })" 'exit()' \
     | pen interactive --in designs/mioon-design.pen --out <临时目录>/scratch.pen
   ```

   需要精确数值（间距、字号、颜色变量）时，在同一命令的 `execute` 中用 `Print(JSON.stringify(Get("<节点id>",{depth:3})))` 读取节点数据。
4. 项目说明：`README.md`、`docs/ARCHITECTURE.md`、`docs/CONTRACT.md`、`docs/UI-COMPONENTS.md`、`docs/TYPESCRIPT.md`，以及本阶段涉及模块附近的文档与测试。

## 原则

- 设计稿与计划是目标。与之冲突的旧测试断言、旧文档按新设计更新；不要为了让旧测试通过而偏离设计或削弱断言。
- 业务改动严格按计划第 3 节的细则执行，并保留其中列出的保护：真实生成默认关闭、未知结果先对账不自动重发、密钥只在后端、旧 720 项目与历史记录可用、智能助理未授权不发送。
- 契约统一在 `packages/contracts` 修改，HTTP / CLI / MCP 同步；新增 schema 版本遵循现有 `workspace-schema-v*.ts` 规则，并保证旧备份可恢复。
- 复用现有能力（预检、导出设置、草稿、任务对账、撤销历史、偏好存储），只在计划要求处改变其行为。
- 保留所有现有 `data-testid` 与功能入口；被移动的入口按 DESIGN-GUIDE 第 6 节“原有功能去向”放到新位置。
- 新文件使用 `.ts` / `.tsx`；存量 `.js/.jsx/.mjs` 只做必要修改。遵循现有命名、目录与写法；不引入、不升级依赖。
- 所有新增或修改的界面文案通过 `packages/i18n` 提供简中、繁中、English、日本語；英文、日文按比中文长 30–50% 预留空间。
- 颜色、尺寸引用 token，不写死；文字 ≥ 10px，点击区 ≥ 24px，正文对比度 ≥ 4.5:1。
- `WorkbenchTooltip` 包裹的按钮 `data-slot` 是 `tooltip-trigger`，样式不要只依赖 `[data-slot="button"]`。
- 不在日志、测试、截图或提交信息中输出密钥、令牌。

## 工作区与 Git

- 开工前运行 `git status`，记录已有的未提交改动；不要覆盖、回滚或清理它们。若本阶段必须修改这些文件，先停下问我。
- 不执行 commit、push、rebase、reset、restore、checkout 或 clean，除非我明确要求。

## 构建与验证

- 仓库自带的 `node_modules` 无法用于 typecheck / build，不要确认任何清空 `node_modules` 的提示。用隔离副本验证：
  `rsync -a --exclude node_modules --exclude .git --exclude apps/desktop/build --exclude apps/web/dist <repo>/ <临时目录>/verify/`，在副本中 `CI=true pnpm install --frozen-lockfile`，再运行 `node scripts/tooling.mjs typecheck` 和 `node scripts/tooling.mjs build --channel=development`。每次修改后重新 rsync；结束时删除副本。
- 测试需把 `TMPDIR` 设为真实路径（`/private/var/folders/...`），每个测试文件单独进程运行并设超时。HEAD 基线已有约 37 个测试文件失败：判断回归前先与未修改的基线对比。测试会在 `TMPDIR` 留下 `mioon-*` 目录，结束时清理本次产生的。
- Homebrew 的 `ffmpeg` 缺 `drawtext` / `subtitles` 滤镜，部分媒体测试因此在基线即失败；涉及字幕烧录或模拟生成画面时，说明所用 FFmpeg 及其限制。
- 本阶段验证：
  1. 受影响测试（含更新过断言的文件）、typecheck、构建。
  2. 业务阶段：通过 HTTP、CLI、MCP 各至少一条路径验证新行为；涉及媒体时用 ffprobe 核对真实产物（尺寸、帧率、时长）。
  3. 界面阶段：启动应用（`pnpm start` 配独立的 `MIOON_DATA_DIR`，或 Electron 配独立的 `MIOON_DESKTOP_USER_DATA`），在 1440×900 和 1050×680 下截图，与对应设计页面逐项对照；检查四种语言无截断或溢出。
- 测试失败时，分清本次回归、已有问题、环境问题，并给出证据。

## 汇报格式

1. 本阶段完成了什么，涉及哪些文件（按 界面 / 契约 / 业务 / 传输 / 测试 / 文档 分组）。
2. 与设计稿和计划的对照：一致的部分，有意偏离的地方及原因（附截图路径）。
3. 实际运行的验证命令与结果（通过 / 失败 / 未运行及原因），与基线的对比。
4. 兼容性影响（旧项目、旧备份、旧客户端、已保存偏好）。
5. 未完成或需我决定的事项、下一阶段的注意事项。

然后停下，等我确认。

---

## 使用方式

**第一次**：发送上面的完整 Prompt，`{{阶段}}` 填“阶段 0 · 准备”。

**之后每个阶段**：在同一会话里，确认上一阶段结果后发送下面这段短 Prompt 即可（新会话则重新发送完整 Prompt）：

```text
上一阶段已确认。按 designs/IMPLEMENTATION-PLAN.md 第 4 节顺序，继续实施下一阶段：{{阶段}}。
沿用之前的全部原则、授权边界、验证方法与汇报格式；只做这一个阶段，完成后停下等我确认。
```

**阶段顺序**（同计划第 4 节）：

0 准备 → U1 设计 token 与主题 → U2 通用组件 → B1 取消生成次数上限 → B2 1080p 输出 → B3 波纹删除 → B4 智能助理一次性授权 → B5 外观偏好与项目首页数据 → U3 工作台外壳与布局 → U4 素材库 → U5 画板 → U6 剪辑与时间线 → U7 导出弹窗 → U8 任务、智能助理、设置中心 → U9 项目首页、登录、新建项目 → U10 最小窗口 1050×680 → U11 浅色主题 → 收尾

B1–B5 之间互不依赖，可以调整先后；U 阶段须在其依赖的 B 阶段完成后进行。
