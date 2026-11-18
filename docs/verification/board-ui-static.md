# 画板静态投影与组件（UI-B1）

这一层消费 SA 链推导及界面状态。组件不读取后台、不调用项目命令、不改变项目格式；正式入口的接线由 UI-B2 完成。

## 给 UI-B2 / CS 的接口

`apps/web/src/board-ui/projection.ts` 的 `projectBoardUi(derivation, nodes, references)` 接收 `deriveFilmChains` 返回值、`BoardUiNode[]` 和带源、目标节点 ID 的引用边。展示节点只有 ID、SA kind、名称、可选画幅、整数 `durationFrames`、状态 `ready/generating/pending` 和缩略图 URL，独立于存储 JSON 字段名。

输出 `BoardUiProjection` 包含：

- `films[]`：根 ID/名称/画幅、总时长、镜头数、按链顺序的 `items[]` 及单成片概览；
- `floatingNodeIds[]`：所有成片链之外、且没有直接引用到成片链内镜头的节点。仅引用游离镜头的节点依然游离；
- `overview`：所有成片链去重后的镜头数、完成/生成中/待生成计数、游离数及总时长；
- `issues[]`：保留 SA 的诊断，展示层不把坏链伪装为完整链。

镜头状态计数只计算 `kind:'shot'`，链中的图片、视频也参与时长。任意成员时长未知则成片时长为 `null`，空链为零。渲染使用工程的 30 fps 时基。成片节点和成片条标题显示本地化秒数，镜头卡和格子显示紧凑秒数，小数最多两位。概览使用原有的时钟格式。UI-B2 应从受信读模型提供状态和有效时长，并按链顺序排列。

`connection-ports.ts` 定义左右顺序端口及顶部/底部引用端口。`resolveBoardPortConnection` 归一正向或反向拖线，复用 SA `classifyChainConnection`；结果含源/目标 ID、端口和 kind，引用另带 role。该函数只检查类型和端口族，图的一进一出、无环、角色基数、项目身份与修订等由 CS 的真实准入检查。

`BoardUiStatic` 将这些组件组合为独立展示场景。传入 `nodes/edges/projection/positions`、`onConnect/onAddShot`，可传 `selectedNodeId/onSelectNode/onLocateNode`。连接成功只回调，不自动添加边。卡片拖动只改变此展示实例的位置；生产坐标持久化由后续接线卡决定。底部成片条点击格子在实例内居中定位，再回调节点 ID；收起仅改变本地展示状态。

可独立复用的组件：`BoardFilmOverview`、`BoardFloatingLabel`、`BoardFilmStrip`、`BoardPorts`、`SequenceEdgeView`、`ReferenceEdgeView`；自定义边注册表为 `boardEdgeTypes`。引用默认使用上/下方合适的接口，也可显式传端口。界面和角色标签来自四语 catalog。

## 动态效果

顺序边为无箭头实线和单个光点，引用边为朝目标流动的虚线和角色标签。光点与路径共享同一几何，CSS/SVG 执行动画，不使用逐帧 React 状态更新。系统 `prefers-reduced-motion`、应用 `data-reduce-motion=true`、组件 `reduceMotion` 都将持续动画置为 `none`，保持连线和角色可见。

键盘可聚焦节点后用 Enter/Space 选取；端口可先后按 Enter/Space 指定连接端点，Escape 取消。指针和键盘都走同一端口分类和回调。

## 验证入口

```sh
node --test --test-timeout=600000 tests/board-ui-projection.test.ts
node --test --test-timeout=600000 tests/board-ui-edges.test.ts
node --test --test-timeout=600000 tests/board-ui-static.test.ts
node tests/browser_board_ui_static.mjs --report /private/tmp/board-ui-static-acceptance.json
```

按开发环境约定使用 Node24；浏览器脚本使用已有 esbuild 和 Python Playwright。可以 `--browser <浏览器可执行文件>` 选 Chromium，`--skip-performance` 只验功能，`--serve` 打开仅合成场景的本地测试入口。截图可用 `--screens .agents/tasks/howard-board-ui-static/screens`，只留本地，不提交或上传。

浏览器检查实际端口拖线、回调、节点键盘选择、成片条排序/收起/定位、新增回调、四语及三种减少动态效果；按动画相位核对光点与 SVG 路径的实际坐标。性能场景包含100条顺序线与100条引用线，检查200条路径可见，分别以正常/减少动态效果实测三轮4秒真实画板平移，报告rAF间隔、长帧和实际viewport移动。它是隔离组件场景，整合后的正式画板还需 UI-B2 再验。

合成画面沿已确认布局构造。四段时长 4+3+3+5 为 15 秒。参考图和人物都引用到链内镜头，只有文字卡游离，概览显示 1。
