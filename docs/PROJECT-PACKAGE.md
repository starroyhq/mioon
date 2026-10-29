# 项目文件（.mioon）

一个 `.mioon` 文件装一个项目：项目数据和它用到的素材。用来换电脑、交给别人、归档单个项目，或者复制一份项目。Mioon 仍然用工作区保存所有项目；`.mioon` 是交换文件，不是项目本身。

## 带什么、不带什么

| 内容 | 是否包含 |
|---|---|
| 项目名称、创作方向、时间线规格 | 是 |
| 项目说明（Mio 每轮读取的资料） | 是 |
| 分镜、画板节点与连线（含首帧参考） | 是 |
| 素材文件，以及标签、备注、收藏、入出点 | 是；导出时可选"只包含用到的" |
| 生成版本（媒体、提示词快照、服务商与模型、选用状态） | 是，作为已完成的结果 |
| 主体库与镜头绑定 | 是 |
| 时间线：轨道、片段、字幕、音频、色彩与 LUT | 是 |
| 图像生成、抽帧的结果 | 作为普通素材导入，原生成记录不带 |
| 导出的成片 | 第一版不带 |
| 撤销历史、请求回执、未完成或结果未知的任务、Mio 对话、草稿、缓存 | 否 |
| 密钥、令牌、授权、连接与工作区设置 | 永远不带 |

## 文件格式

容器沿用工作区备份导出文件的结构：魔数 `MIOON-PROJECT-1\n`，之后逐个文件写 4 字节长度、JSON 头 `{path,bytes}` 和原始字节，4 字节 0 结束。只有普通文件，不压缩。

顺序固定：

1. `manifest.json`：格式与版本、生成它的 Mioon 版本、项目名、数量、导出选项，以及每个文件的路径、大小、SHA-256；
2. `project.json`：项目文档（格式 1），id 只在文件内部有效；项目说明是可选的 `project.notes`，旧版本 Mioon 导入时忽略它，导入时按 `project.notes.set` 的规则校验；
3. `media/<sha256>.<扩展名>`：素材与 LUT，按内容去重；
4. `COMPLETE.json`：结束标记，核对清单哈希、文件数和总字节数。

上限沿用工作区备份：单文件 8 GiB、合计 64 GiB、最多 20,000 个文件、清单 8 MiB。契约在 `packages/contracts/src/project-package.ts`。

## 导出

- 读取开始那一刻已保存的内容（一个事务）；导出期间可以继续编辑。
- 素材缺失或大小不符时拒绝导出，并列出是哪些（`PROJECT_PACKAGE_SOURCE_MISSING`）。
- 写入时逐个素材重新计算哈希，源文件中途被改动就中止（`PROJECT_PACKAGE_SOURCE_CHANGED`）。
- 先写到数据目录 `project-packages/` 下的临时文件，完整重读校验后才改名。桌面版用系统存储对话框选位置，选中的路径只留在主进程；浏览器版直接下载。

## 导入与复制

- 导入先把文件暂存并完整校验：格式、版本、每个文件的大小和哈希、结束标记。之后才显示预览；确认后才创建项目。
- 总是新建项目：所有 id 都重新生成，文件按新 id 命名（`media/<素材id>.<扩展名>`、`media/result-<任务id>.mp4`），重名时自动加"（2）"。
- 创建在一个事务里完成，并在提交前用现有的归属与时间线校验器检查；任何一步失败都会回滚，并删掉已放置的文件。
- 生成版本连同一条"已成功"的任务记录一起重建，再归档出任务中心，不会联系服务商或重新对账。
- 导入和复制的请求用 `idempotency` 表记录（scope `project-import` / `project-duplicate`）：同一 requestId 重复提交时，返回同一个项目。
- 复制项目在同一工作区内完成，素材复制一份，不和原项目共享文件。

### 在系统里双击打开

桌面版打包时把 `.mioon` 关联到 Mioon（`builder-config.ts` 的 `fileAssociations`）。系统交来的文件（macOS 的 `open-file` 事件，Windows/Linux 的启动参数或第二实例参数）由主进程排队，等后端运行后以 `?source=open-file` 上传，照常校验暂存。最上层的主页或工作台每 2 秒、以及窗口获得焦点时，用 `GET /api/project-packages/imports/opened` 领取，每个文件只交给一个窗口，用户确认名称后才创建项目。正在进行导出、导入或复制时，文件留在服务端等下一次领取。

文件无效时，主进程弹出挂在窗口上的提示（sheet）。不挂窗口的提示框在 macOS 上会阻塞主进程，后端租约因此超时退出。未打包的开发版没有文件关联，只能用第二实例加文件路径参数来测试。

## 接口

不进 RPC 操作表，所以不会成为 MCP 工具或内置 Mio 的能力。恢复出来的工作区和候选工作区不提供这些接口。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/projects/:id/package-preview?media=all\|used` | 导出前的数量、大小、缺失素材、进行中的任务 |
| `POST /api/project-packages/exports` | 开始导出 `{projectId,media}` |
| `GET /api/project-packages/exports/:id` | 进度 |
| `GET /api/project-packages/exports/:id/download` | 下载完成的文件 |
| `DELETE /api/project-packages/exports/:id` | 取消或清理 |
| `POST /api/project-packages/imports[?source=open-file]` | 上传原始文件并校验，返回预览；`open-file` 表示系统打开的文件 |
| `GET /api/project-packages/imports/opened` | 领取一个系统打开、尚未被窗口领取的预览，没有时为 `null` |
| `POST /api/project-packages/imports/:id/commit` | `{requestId,name}` 创建项目 |
| `DELETE /api/project-packages/imports/:id` | 放弃暂存的导入 |
| `POST /api/project-packages/duplicates` | `{projectId,requestId,name}` 复制项目 |

会话只在内存里保存，后端重启即取消，下次启动时清掉 `project-packages/`。

CLI：

```sh
mioon project export --input '{"projectId":"<uuid>"}' --output 项目.mioon
mioon project import --file 项目.mioon --request-id <id> [--input '{"name":"新名字"}']
mioon project duplicate --request-id <id> --input '{"projectId":"<uuid>","name":"副本"}'
```

## 验证

`tests/project-package.test.ts`、`tests/project-package-service.test.ts`、`tests/project-package-http.test.ts`、`tests/project-package-client.test.ts`、`tests/project-package-native.test.ts`。覆盖跨工作区往返与重新打开、复制、永久删除、坏文件与新版本格式、备份与恢复、HTTP、CLI 客户端与桌面保存。
