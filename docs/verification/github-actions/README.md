# GitHub Actions 实施验证

基线：`c9a81ac050e23bc0cf3298a41f428c0afa26b46c`（已合并 PR #11）。独立分支：`codex/github-actions`。原工作区、私有 designs 和无关待办未纳入修改

## 本地检查

在 macOS arm64 使用 Node `24.21.0`、pnpm `11.25.0`，临时目录使用真实路径 `/private/tmp`

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，复用 397 个依赖，锁文件未改 |
| `node scripts/tooling.ts typecheck` | 通过，包含 `.github/scripts/**/*.ts` |
| `node scripts/tooling.ts build --channel=development` | 通过 |
| `node scripts/tooling.ts test --suite=portable --concurrency=1 --reporter=tap` | 98/98 通过，无跳过 |
| `node --test tests/actions-release.test.ts tests/actions-desktop-helpers.test.ts tests/actions-desktop-media.test.ts` | 30/30 通过，无跳过 |
| actionlint `1.7.12`、`git diff --check` | 通过 |
| macOS 基础 FFmpeg/ffprobe 探针 | 通过；仅证明本地合成所需基础编码能力 |

辅助测试覆盖版本、标签、main 归属、标签移动、凭据缺失、错误或缺失附件、哈希、公开版本拒绝、草稿恢复、归档路径和链接安全、错误脱敏及超时。媒体集成通过与原生冒烟相同的公共 HTTP 配方，实际导入合成媒体、编排音视频、渲染 MP4，再由 ffprobe 检查 1280×720 与音频流

扩展严格类型检查后，两个既有测试对 tsconfig 的精确列表断言需要同步增加 CI 脚本目录；已更新断言，未放宽编译选项或减少原有覆盖

## 远端与发布验收边界

[PR #12](https://github.com/starroyhq/mioon/pull/12) 中运行 Ubuntu full、macOS portable、Windows portable，最终状态以 PR 的 `CI` 总检查为准。Linux full 不在 macOS 上伪装执行成功

[首轮运行](https://github.com/starroyhq/mioon/actions/runs/39387931266) 的 Ubuntu actionlint 启用了本机未安装的 shellcheck，指出内嵌 JavaScript 模板字符串的 SC2016 提示；已改为等价字符串拼接，保留完整 lint 门禁。独立审查发现的组合符号链接逃逸边界也已补回归：Linux 归档链接禁止向上路径段，实际包不符合时严格拒绝

签名发布尚未验收：仓库级 Apple Secrets 当前为空，组织级授权未知；本地没有最终签名安装包。需要维护者配置文档列出的七项凭据，并在工作流合入 main 后运行 `release_tag` 留空的演练，实际完成三平台打包、macOS 签名和公证、Gatekeeper 与最终包原生冒烟

本轮不创建版本标签、不公开 Release、不改变 main 保护规则。Windows 仍限于源码检查，现有桌面启动保护保留
