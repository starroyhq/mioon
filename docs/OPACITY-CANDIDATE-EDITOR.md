# 透明度候选编辑器与草稿 v3

日期：2026-10-16。基线提交完整 SHA：`0ac49ab861a28c22a09e2324404d3762ea23d896`。

本片在内部候选装配中接入实际 Inspector、同一片段草稿控制器及独立 v3 companion。默认生产启动仍使用 40/41；不迁移用户项目、不通过 payload、URL、schema marker 或环境开关启用候选入口。

## 编辑闭环

- `createOpacityCandidateInspectorBinding` 创建不可由 JSON 或对象复制伪造的本地绑定，固定使用候选草稿客户端；普通 Inspector 不创建该绑定。新 TSX 控件提供简中、繁中、英文、日语文案，保留不完整数值文本，保存时才检查七点、帧范围、顺序及 0–1。
- 原 `createClipDraftController` 继续拥有 autosave、恢复、Save、Cancel、关闭保护与迟到确认。候选客户端由私有 WeakSet 确切识别；普通客户端即使收到编辑标记也不能保存透明度。完整 ACK 检查包含未变动的透明度字段以及 absent/null 区别。
- 音量与透明度共享一个 composition owner，并记录字段种类。仅当前控件可完成输入；另一个控件、保存、取消、移除及关闭保持阻断。连接或内部绑定变化不会把输入转给其他客户端。
- `createOpacityCandidateEditorAssembly` 只组合真实候选服务、原编辑任务协调器和原草稿 HTTP handler，不建立 listener、worker 或 provider。合成测试通过实际客户端／HTTP／控制器／任务／SQLite 验证保存、重开、恢复及取消。

## 独立草稿文件

`createOpacityCandidateLocalDrafts` 绑定真实 owned42 store，写入 `local-drafts-v3.json`。旧 `local-drafts-v1.json` 不读取、不覆盖、不升级；原 v1/v2 服务和音量编辑器继续使用原路径。43 仍不支持 companion 写入，显式 origin 下的时间线编辑沿原任务保护执行。

v3 完整 PUT 含 JPEG/LUT、audioRole、16 点音量、7 点透明度及三个来源字段时是 **132 节点、7590 字节、深度 5**。候选 walker 明确限制 132；旧 v1/v2 的 128 节点上限不变。行 8192、HTTP 12288、磁盘 2 MiB、128 个槽位及 CAS、目录同步、不确定写入语义保留。133 节点或超限请求不写入。

## 验证

最终定向集合 500/500 通过、零跳过；规格 Inspector 的独立定向用例另 1/1。Canonical `node scripts/tooling.mjs typecheck` 通过。独立审查覆盖客户端／控制器、真实 HTTP→草稿与任务持久化、编译器及候选 snapshot。双控件 IME 所有权和未完成时长的显示错误已修正并回归。64 个冻结文件 SHA-256 保持原值。

完整 `project-specifications-ui.test.mjs` 的 12 项既有 App guard 提取夹具缺少 `clipDraftRef`，本轮未修这些夹具，`App.jsx` 未改；不把上述定向通过写成整个仓库全量验收。没有启动真实媒体／provider、网络 listener 或用户项目。

## 渲染与运行时边界

新纯 TypeScript 编译器和 render snapshot/ACK 契约已覆盖片段局部帧、跨分段、选区开始偏移、LUT 次序及 straight/premultiplied alpha 代数。它们尚无渲染消费者，不能算作预览／导出已应用透明度；候选 Inspector 明确显示该状态。具体接缝与未执行像素探针见 [渲染接缝方案](OPACITY-RENDER-SEAM-PROPOSAL.md)。

PATH、Homebrew、nvm、fnm、mise/rtx、asdf、Volta、下载目录及可见 Node 缓存未找到本机 Node24，只确认 `/opt/homebrew/Cellar/node/26.9.0/bin/node`。历史 Node24.21.0 路径属于另一 Linux 环境；内置 dependency runtime 查询在当前执行环境不可用。本轮只记录 Node26 证据，不安装运行时，不修改系统设置。
