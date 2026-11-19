# G 线：格式 5 预演界面接统一入口和缩略图

- 卡片：`previs-ui-brief.md`；前置 G-3（`previs-report.md`）把写入口改到 `previsIntent`，本卡把网页预演编辑器接上。
- 分支：`howard/previs-ui`，从 G-3 第二轮 merge head（#318 未合入 main）开出。
- 范围：格式 5 项目的预演新建/自动保存与缩略图缓存走真实写路径；人偶/道具属性面板加「主体」下拉（跟随/锁定）；格式 3/4 行为原样。

## 服务端

- `previs.thumbnail.set` 从 FR-0 门禁（`FORMAT5_LEGACY_WRITE_USES`）放行：缩略图是可重建的派生缓存，不进统一历史、不制造撤销步，仍在保存事务外单独写。
- 格式 5 写入要求节点当前 `sceneRevision`（CAS）：不一致返回 `REVISION_CONFLICT`（带当前节点，供编辑器冲突处理）；帧预设不一致仍是 `PREVIS_THUMBNAIL_STALE`；按 nodeId+slot 覆盖与容量淘汰不变，无回执。格式 3/4 的过期回答保持 `PREVIS_THUMBNAIL_STALE`。
- `previs.thumbnail.get` 只读、格式 5 可读不变。
- Mio/MCP：不新增工具或 schema；`previs.thumbnail.set` 从 `FORMAT5_UNAVAILABLE_OPERATIONS` 去掉（沿用现有工具，格式 5 可写），`previs.create` / `previs.scene.set` 的不可用说明保留给 MT-5。`docs/PREVIS.md`、`docs/AGENT-TASKS-V2.md` 同步。

## Web

- `apps/web/src/previs/previs-format5-rpc.ts`：预演 rpc 签名不变，格式 5 下把 `previs.scene.set` / `previs.create` 翻译成 `sequence.preview`（`previsIntent`）→`sequence.commit`，再用现有只读 `project.get` 读回节点，返回 `PrevisNodeRecord`；冲突映射成 `REVISION_CONFLICT`+current，自动保存/重试/冲突条不用改。`previs.create` 按 requestId 派生稳定 nodeId，未知结果重试不会建出第二个节点。格式 3/4 纯透传。
- `PrevisEditorHost`→`PrevisEditor`→`PrevisProperties` 增加可选 `subjects`：数据来自 App 的 `useSubjects` 状态（`previsSubjectChoices`），只在 `projectFormatVersion === 5` 传入。选中主体写 `subject:{subjectId}`（跟随最新），版本行选「锁定 V{n}」写 `subjectVersionId`（当前 head），清除选择删除字段；保存仍走既有自动保存。格式 3/4 不渲染该控件（服务端同样拒绝）。
- 界面文字只有标签与状态（主体 / 版本 / 无 / 跟随最新 / 锁定 V1 / 主体 {id}），没有解释小字。

## 验证

- 本机：`node scripts/tooling.ts typecheck`；`tests/previs.test.ts`（新增格式 5 缩略图写入/读回/过期 CAS/无历史与回执）、`tests/format5-legacy-write-gates.test.ts`、`tests/format5-mio-tools.test.ts`、`tests/previs-editor.test.ts`、`tests/format5-subject-binding.test.ts`、`tests/sequence-edit-*`、i18n 完整性、五指守卫、三格式请求指纹。
- 真实格式 5 无头流程（本机，非 CI）：`node tests/browser_previs_ui_wire.mjs --screens <本地截图目录>`。真实格式 5 kernel + 真实 HTTP project RPC + 生产 `PrevisEditorHost`（vite 现场打包）+ 生产格式 5 rpc 适配器；覆盖打开编辑器、选人偶、选主体、跟随→锁定、自动保存经 `sequence.preview/commit`（真实 RPC 断言节点 scene 含 subject、历史一条 `previs.scene.set`）、缩略图写入与读回、过期缩略图 `REVISION_CONFLICT`、缩略图不产生历史步。截图与 `report.json` 只留 `.agents/` 本地。
- 无头环境里编辑器自身的卡片缩略图自动上传没有触发（未观测到 `previs.thumbnail.set`），验收脚本改用同一生产适配器的真实 RPC 写入真实 CPU canvas JPEG 作为回落；三条服务端路径（写入/读回/过期拒绝）都经真实 RPC 与单测覆盖。WebGL 在无头 Chrome 里可用，截图是真实生产组件。
- 新 browser 脚本按 `browser_*.mjs` 惯例不进 CI 分片（本机依赖 Chrome/Playwright）。

## 已知边界

- 预演卡片缩略图自动上传的无头触发未定位；不影响写入路径与格式 3/4。
- Mio 的格式 5 预演场景写仍归 MT-5（`mioon_sequence_edit` 的预演动作）；本卡只开缩略图缓存工具。
- 预演输出→生成输入的消费仍留给 RI/GE。
