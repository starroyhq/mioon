# 项目文件界面组件（U1）的截图

这里是 U1 组件（`apps/web/src/project-file/`）的截图，用来和设计预览 12-01 到 12-14 对照。组件只收数据和回调，截图用的是 `tests/fixtures/project-file-ui/fixtures.ts` 里的示例数据；示例项目名、路径和封面都是编的，封面是代码生成的 SVG。

截图里只有 U1 的组件。设计预览里组件周围的应用（顶栏、工作台、时间线、Mio 面板）不在截图里，所以整页的截图和预览比，内容的位置会有偏移。不做像素比对，对照结果写在各组的 README 里。

## 各组
| 目录 | 设计稿 | 内容 |
|---|---|---|
| [`home/`](home/README.md) | 12-01、12-02、12-03、12-03b、12-03c、12-03d | 首页的最近项目和收件箱提示、新建项目、打不开的四种情况和只读 |
| [`media/`](media/README.md) | 12-04、12-05、12-06 | 素材状态的标签和提示条、重新指向、项目外位置的确认 |

## 怎样重新生成
```sh
node tests/fixtures/project-file-ui/build-gallery.ts --out /tmp/u1-gallery
python3 tests/fixtures/project-file-ui/capture.py --dist /tmp/u1-gallery --group home
```
- `build-gallery.ts` 用 Vite 的 JS 接口单独构建画廊（`tests/fixtures/project-file-ui/gallery/`），不读 `apps/web/vite.config.ts`，也不进产品构建。
- `capture.py` 要 Python 3.11、Playwright 和 Pillow。浏览器按顺序找：`$MIOON_CHROMIUM`、`PATH` 上的 `chromium`、macOS 的 Google Chrome。
- `--group` 是 `all` 或一个目录名。截一组之前会删掉这一组旧的图片和 `results.json`，`README.md` 留着。`--only <id,id>` 只重截列出的场景，其余的留着。
- 画廊地址是 `index.html?scene=<场景 id>&locale=<语言>`，场景表在 `tests/fixtures/project-file-ui/scenes.tsx`。

## 截法
- 深色主题，简体中文，视口 1440×900，减少动画，时区 Asia/Shanghai。示例数据的“现在”是 2026-10-21 14:40（+08:00）。
- 对话框打开时如果是按钮带着焦点，截图前在对话框标题上点一下鼠标：无头浏览器没有鼠标操作时会给按钮画键盘焦点框，用鼠标打开的对话框不画。
- `page`：整个视口，1 倍。用于首页、对话框和菜单。
- `dialog`：对话框四周各留 24px，1 倍。用于 12-03b、12-03c、12-03d，这三张预览本身就是对话框的裁切。
- `frame`：只截场景外框，2 倍。用于卡片、角标和提示卡。
- 每张图小于 95,000 字节：先存 256 色 PNG，超了改存 JPEG（质量 82，还超就 72）。256 色的 PNG 里，封面的渐变会有色带。
- 有页面错误、控制台报错、找不到场景，或者图片压不到上限以内，脚本退出 1。每组的 `results.json` 记下每张图的场景、状态、格式、大小和错误，不记时间。

## CI 里的检查
CI 不截图。`tests/project-file-ui-*.test.ts` 用同一份场景表做服务端渲染，每个场景都在四种界面语言下渲染一遍，并断言各状态；同时检查每组的 `results.json` 和场景表一致、每张图都在而且小于上限、`README.md` 写到了每张图和每个设计稿编号。
