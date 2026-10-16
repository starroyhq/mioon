# 全新42透明度应用入口

日期：2026-10-16。基线：`ec01753056c0f31706d29ed279ae1944c822ad94`。

本片将全新、独立42工作区接入同一个实际App。生产默认仍为40/41；没有迁移已有目录，没有新增普通payload、URL或环境profile开关。43冷备份／恢复产品链和40/41升级不在本片。

## 已接通的路径

内部TypeScript launcher仅接受不存在的绝对目录，独占创建42并授予不可复制的一次性启动证明。实际server、RPC、持久任务与ACK、项目读取、受管素材导入、时间线初始化、track／clip增删改、undo／redo、Inspector和v3草稿使用原组件。浏览器只在独立构建入口创建私有能力；普通main入口继续DesktopRoot和原客户端。没有复制App。

同一App可创建项目、导入素材、加入剪辑、选择片段、编辑透明度、Save，再请求合成预览，进入交付预检和导出历史。候选界面隐藏或禁用尚未接通的format、split、seed、来源替换、字幕、画布生成、Agent／Image和额外音频检查。画面保持现有720×1280／30fps片段架构，未扩大到位置、缩放或转场功能。

编辑任务保留原request ID、digest、结果不确定状态及迟到ACK守卫。透明度原始值、absent／null、同一片段add确认、历史和回执均经过候选校验。偏好仍使用原CAS，草稿写入独立`local-drafts-v3.json`；`local-drafts-v1.json`不迁移。

预览和下载复用原文件响应器及Range行为。只有精确新42守卫可播放preview／export产物，export允许有名／无名下载。读取绑定原始snapshot、queued回执、输出素材、发布路径和owned store，并在打开文件后、响应前复核。裸媒体仅接受规范受管导入路径和owned graph，反向export关系及输出路径不能靠改provenance绕过。旧默认守卫仍只允许原export／有名下载规则。

## 构建与最短使用步骤

构建命令不启动监听或媒体，可以单独执行：

```sh
node scripts/tooling.mjs build
cd apps/web
node node_modules/vite/bin/vite.js build --mode opacity-candidate
```

候选产物位于`apps/web/dist-opacity-candidate/`，页面为`opacity-candidate.html`；构建插件生成固定`mioon-opacity-candidate-entry.json`。默认产物仍为`apps/web/dist/index.html`。标记只用于防止内部启动器误配前端，不赋予后端工作区权限。

**以下监听／GUI步骤尚未执行，需要父任务判断此前监听限制。** 最小后续命令（在仓库根目录）：

```sh
node apps/server/src/opacity-candidate-cli.ts --new-workspace /private/tmp/mioon-opacity42-manual-20261016 --port 4319
```

该目录必须不存在，不允许改成用户已有工作区。监听目标为`127.0.0.1:4319`。用浏览器打开`http://127.0.0.1:4319`，访问令牌由这个新目录的`access-token`提供，不需要配置provider。之后创建项目→导入专用测试素材→加入剪辑→选择片段→透明度关键帧→保存→合成预览→交付预检／导出→历史播放／下载。真实导入会运行媒体探测，渲染会运行FFmpeg；本片未执行这些手动步骤。

本入口每次只创建全新目录，不支持关闭后重新启动已有42应用目录。已保存数据保留在目录内，但通用启动器仍拒绝42；这不能写成正式发布或重开／备份完成。42冷备份→43恢复及正式重开策略留给下一切片。

## 验证范围与剩余验收

测试使用真实SQLite、实际共享HTTP handler（内存请求，无listen）、实际客户端／任务协调器、Inspector／播放器组件及合成受管文件。素材服务测试只替换codec transport，禁止真实媒体子进程；文件GET／HEAD／Range使用合成字节。关闭失败继续向上传播，不在停止结果不确定时强行释放SQLite／lease。

具体命令、通过数量、构建结果和独立审查见[验证证据](evidence/opacity-application/qualification.json)。没有启动GUI、监听、媒体或provider；没有安装依赖、修改凭据、接触实际项目或push。

真实GUI四语言、IME、草稿恢复、Save／Cancel／关闭、实际素材的预览／导出／播放／下载和性能尚未验收。当前仅有Node26.9.0，未取得Node24或产品固定FFmpeg验收；沿用此前短像素探针证据不能替代本次实际App验证。此前loopback监听EPERM没有重试或绕过。
