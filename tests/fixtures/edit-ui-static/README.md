# 剪辑界面静态组件夹具

此入口只组装真实剪辑时间线、UI-E1 投影和新增的可选组件，用合成画面和仓库自带示例媒体。顶栏、素材栏、预览和属性栏下半部分是截图薄壳，不是应用入口；不启动服务端业务、不打开项目、不发 RPC、不保存偏好。

用仓库约定的 Node 24（构建用应用自己的 Vite + Tailwind 流程）以及已有浏览器 QA 的 Python Playwright 和本机 Chrome：

```sh
mkdir -p /private/tmp/edit-ui-static/tmp
TMPDIR=/private/tmp/edit-ui-static/tmp node tests/browser_edit_ui_static.mjs --mode design --report /private/tmp/edit-ui-static/result.json
```

`--mode baseline` 构建只渲染真实时间线、不带 `editUiProjection` 的对照页；配合 `--out <png>` 或 `--compare <png>` 做改动前后的截图对照。`--serve` 打印独立本机夹具地址，供交互检查，Ctrl+C 关闭。`--browser` 可指定 Chromium，`--python` 可指定 QA Python。构建和截图都写进临时目录，退出时清理；截图只放 `.agents/` 本地，不提交、不上传。

场景：

- `main`：主轨 V1、跟随画板 V2、锁定 V1、4 秒未生成占位、三条挂靠锚线，对应 21-02。
- `copy-move`：同一时间线加「复制成新镜头再挪？」确认框，对应 21-03；确认参数绑定原片、段组、目标轨、目标帧和修订。
- `removed`：移除 02 后主轨前移、字幕 2 未挂靠、顶部撤销条，对应 21-04。

媒体 URL 由夹具自己的 loopback server 按仓库示例文件回放；夹具不发任何后台或外部请求。
