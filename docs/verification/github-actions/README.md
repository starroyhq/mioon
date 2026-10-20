# GitHub Actions 实施验证

基线：`c9a81ac050e23bc0cf3298a41f428c0afa26b46c`（已合并 PR #11）。独立分支：`codex/github-actions`。原工作区、私有 designs 和无关待办未纳入修改

## 本地检查

在 macOS arm64 使用 Node `24.21.0`、pnpm `11.25.0`，临时目录使用真实路径 `/private/tmp`

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，复用 397 个依赖，锁文件未改 |
| `node scripts/tooling.ts typecheck` | 通过，包含 `.github/scripts/**/*.ts` |
| `node scripts/tooling.ts build --channel=development` | 通过 |
| `node scripts/tooling.ts build --channel=production` | 本地暂存构建通过，未等同安装包验收 |
| `node scripts/tooling.ts test --suite=portable --concurrency=1 --reporter=tap` | 98/98 通过，无跳过 |
| `node --test tests/actions-{release,desktop-helpers,desktop-media,ffmpeg-install,test-shards}.test.ts` | 49/49 通过，无跳过 |
| actionlint `1.7.12`、`git diff --check` | 通过 |
| macOS 基础 FFmpeg/ffprobe 探针 | 通过；仅证明本地合成所需基础编码能力 |

辅助测试覆盖版本、标签、main 归属、标签移动、凭据缺失、错误或缺失附件、哈希、公开版本拒绝、草稿恢复、归档路径和链接安全、错误脱敏及超时。媒体集成通过与原生冒烟相同的公共 HTTP 配方，实际导入合成媒体、编排音视频、渲染 MP4，再由 ffprobe 检查 1280×720 与音频流

扩展严格类型检查后，两个既有测试对 tsconfig 的精确列表断言需要同步增加 CI 脚本目录；已更新断言，未放宽编译选项或减少原有覆盖

## 远端与发布验收边界

[PR #12](https://github.com/starroyhq/mioon/pull/12) 中运行 Ubuntu full、macOS portable、Windows portable，最终状态以 PR 的 `CI` 总检查为准。Linux full 不在 macOS 上伪装执行成功

[首轮运行](https://github.com/starroyhq/mioon/actions/runs/39387931266) 的 Ubuntu actionlint 启用了本机未安装的 shellcheck，指出内嵌 JavaScript 模板字符串的 SC2016 提示；已改为等价字符串拼接，保留完整 lint 门禁。独立审查发现的组合符号链接逃逸边界也已补回归：Linux 归档链接禁止向上路径段，实际包不符合时严格拒绝

[跨平台运行](https://github.com/starroyhq/mioon/actions/runs/39388344465) 中 macOS 全部通过；Windows 的两个既有 portable 测试暴露原生路径键与换行问题。已统一编译测试的路径键并增加 Windows 路径回归；`.gitattributes` 仅固定五个字幕资源的字节表示，原生产尺寸和 SHA 校验保持不变。临时 Git 索引模拟 `core.autocrlf=true`，确认四份文本未经约束时全部偏离既有尺寸/哈希，应用属性后全部恢复；相关两文件本地 17/17 通过

后续 Ubuntu 日志确认系统包为 FFmpeg 4.4.2。对照官方 [4.4.2 参数实现](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n4.4.2/fftools/cmdutils.c)与 [7.1.5 参数实现](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/fftools/cmdutils.c)，前者不支持当前生产代码的文件值参数；`-fps_mode` 也不在 4.4 中。CI 改为校验固定源码哈希后构建 7.1.5，保留 Ubuntu 22.04 和生产参数，新增真实命令探针，防止仅滤镜列表通过便进入长时间全量测试。官方源码压缩包签名已用发布密钥指纹 `FCF986EA15E6E293A5644F10B4322F04D67658D8` 独立核验；未导入用户钥匙环

已知环境不兼容的[运行](https://github.com/starroyhq/mioon/actions/runs/39389024360)主动取消，其 Linux full 不计为通过；该轮 macOS、Windows 各有 portable 99/99、辅助 29/29 通过。后续完整复验使用固定工具环境，继续保留全部既有测试

固定工具安装与实际参数/PNG探针补齐后，本地严格类型检查、actionlint、diff-check通过；发布、原生辅助、工具安装及真实媒体测试合计 **41/41 通过，无跳过**。源码编译的实际结果由 Ubuntu 后续运行验证，本机未冒充 Linux 编译通过

[固定工具运行](https://github.com/starroyhq/mioon/actions/runs/39394182568) 已实际完成 Ubuntu 官方源码编译、五项媒体探针、严格类型及 development 构建；macOS、Windows 检查通过。旧轮约 37 分钟仅执行到文件排序的 37%，单 job 存在明显 60 分钟超时风险，因此改为四个独立 job；每片保留原 full 准入、逐文件串行及 60 分钟限制，并验证全集恰好覆盖一次。后续全量状态以 PR 检查为准

旧轮部分日志中的非媒体失败单独修正：两处已授权响度扩展用唯一精确逆变换恢复原 schema50 字节后继续核验全部历史哈希；两份 Agent 界面 harness 按当前折叠流程展开选择区，并继续验证隐藏操作、授权、dirty 和 stale 围栏；重启说明断言对齐完整“不自动续接或重新发送”文案。生产 UI、历史哈希和旧版拒绝规则均未放宽

导出两项旧断言按已合入 `01a83cb` 的输出保护升级同步：持久记录遭替换时精确保留本次唯一空 part 的名称/inode/字节和全部文件集合；输出 inode 被替换时先报告输出身份错误，替换字节与 inode 必须原样保留。生产清理和所有权围栏未改。定点 6/6、整文件 19/20 通过；唯一未通过项为本机缺字幕滤镜的画幅矩阵，留给 Linux 实际复验

分片辅助测试 8/8、当前 785 文件的真实 full 选择校验、严格类型和 actionlint 通过；四片为 197/196/196/196 文件，并集完整、无重复，全集 SHA-256 一致。历史保留测试 13/13、两份 Agent harness 24/24 与 18/18、说明文案测试 17/17 均通过

[首次四分片运行](https://github.com/starroyhq/mioon/actions/runs/39395989355) 的 macOS、Windows 各通过 portable 99/99、辅助 47/47，无跳过。Linux 分片 2 的 3687 项中仅一项失败：历史渲染回归需要 `git show` 固定旧提交，而默认浅克隆缺少对应对象。该提交仍属于干净 main 的祖先，原源码哈希保持不变；Linux full 改为完整检出历史，继续执行原回归，不替换基线或放宽哈希

该轮 Linux 四片均执行完成，785 个文件覆盖清单已下载核对：同一源码 SHA、同一全集哈希、并集完整且互不重叠。合计 12687 项，12678 通过、7 失败、2 个既有条件跳过、0 取消。失败归为浅克隆两项、已合入 LRA 扩展的历史源码比较两项、当前普通 schema 的旧期望一项、已合入导出所有权围栏的保守清理期望两项。历史比较继续使用原哈希和有限精确逆变换，清理检查继续核对确切 inode、字节、请求回执和完整文件集合；未改生产业务行为

两项既有跳过分别要求 POSIX 更换文件所有者能力和原生 Windows ACL 环境；非 root Linux runner 不伪装这些能力，也不将其报告为通过。后续完整复验结果见 PR 的最新 `CI` 检查

本地修复验证：原历史渲染回归 1/1、opacity 历史比较 7/7、restore 源码保护 77/77、两处 owner 回归 2/2 通过。preflight 整文件 45/46，唯一未通过项为本机缺 `libwebp`，该项在上述 Linux 完整运行已通过；Look 媒体链仍受本机缺 `zscale` 限制，独立真实备份/恢复已确认普通 50 → 备份 50 → 恢复 51，完整链留给固定工具环境复验

签名发布尚未验收：仓库级 Apple Secrets 当前为空，组织级授权未知；本地没有最终签名安装包。需要维护者配置文档列出的七项凭据，并在工作流合入 main 后运行 `release_tag` 留空的演练，实际完成三平台打包、macOS 签名和公证、Gatekeeper 与最终包原生冒烟

本轮不创建版本标签、不公开 Release、不改变 main 保护规则。Windows 仍限于源码检查，现有桌面启动保护保留
