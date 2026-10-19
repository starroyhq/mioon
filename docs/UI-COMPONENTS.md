# Shared shadcn/ui components

The editor consumes `@mioon/ui`, a workspace source package. It vendors
15 **official shadcn/ui `base-nova` components built on `@base-ui/react`**. These
are the actual published registry sources, not locally invented wrappers that
imitate shadcn styling. There are no Radix imports or dependencies in this package.
The native `label` and `textarea` elements are intentional: the corresponding
official base-nova components use these elements directly.

## Provenance and license

Fetched **2026-10-09** from the official HTTPS registry, using the individual
`https://ui.shadcn.com/r/styles/base-nova/<name>.json` endpoints below.

- Each decoded registry payload is faithfully preserved as locally serialized
  JSON under `packages/ui/src/registry/base-nova/`. JSON whitespace/serialization
  was normalized during download; these files are not the original HTTP response
  bytes. The decoded embedded TSX source strings are preserved exactly.
- `manifest.json` records the complete SHA-256 of each local serialized registry
  JSON (`registrySha256`), the original decoded TSX string encoded as UTF-8
  (`sourceSha256`), and the installed TSX source (`vendoredSha256`). The table
  below lists the original embedded-source SHA-256. These are content hashes,
  not HTTP wire-byte hashes or unverified Git commits.
- `packages/ui/src/LICENSE.shadcn.md` preserves the upstream MIT license and
  `Copyright (c) 2023 shadcn` notice from the
  [official license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
- Source paths are `registry/base-nova/ui/<name>.tsx` in each registry response.
  The original registry endpoints are mutable; the local snapshot and content
  hashes pin exactly what was incorporated into this repository.

| Component | Official source | Original source SHA-256 |
| --- | --- | --- |
| `button` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/button.json) | `313353436d0fcc8e44ab470adb614b9fd013d28626f624328ea0d66d41a6c81b` |
| `input` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/input.json) | `dab990dfefa0ba78854ab6602ad074270dba9d7d1262184d9bfbb62bd990903b` |
| `textarea` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/textarea.json) | `82601c91ffc6c727d924162c78d7cb853114bcced4e2eb922a68ca12d4239c0f` |
| `select` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/select.json) | `6918ba753234e510c57db3fe395f8b67936421db1efa2ed88694d186aa736c59` |
| `dialog` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/dialog.json) | `5be79d2cf2d2152a29d9f14c8e209ad57b696e9dfbf0b9cdf4523a7c710c8d02` |
| `dropdown-menu` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/dropdown-menu.json) | `ba92acc16e141ad77880f8c4a27f9854b8024075130df6f04b6b0bf9cfa9d3f2` |
| `tabs` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/tabs.json) | `958b817b256cffae986d046168b70dd0153d542b4c521ee8bbdda349010011ef` |
| `switch` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/switch.json) | `d232e2ffcfa122c59099872bcb8395eaad36d42fa9d2e0e40382ad19994065e2` |
| `collapsible` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/collapsible.json) | `ead4349ff7b01d696ef89294a81d18ee1d3f732321398896462c834ab9b9e065` |
| `tooltip` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/tooltip.json) | `f83d5f511812573f4ac98b866d397a46fda0f27eeb0af0ea89af01969eefbc5a` |
| `scroll-area` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/scroll-area.json) | `829549f352f1e56dfe887446bcc3d1707c0ced739a9efcb75f0af364cd88c581` |
| `label` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/label.json) | `b3b7b21d2877838fc73713df48a47248392de04a3b3fafa8961369f33ab14530` |
| `badge` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/badge.json) | `d9fb280e266119c4b62a4c518e63152de27b094c68d3e5f8929d05bfb0c1bc6c` |
| `separator` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/separator.json) | `9a80ff8c110e0c55489509f4f82ebcc929c0174b59544047147b7134f86a54e7` |
| `slider` | [registry JSON](https://ui.shadcn.com/r/styles/base-nova/slider.json) | `1fd32ee03ddaa382aabccce0bd88669aa8f91e4fe487622a68745d2ed1d5f5b9` |

The Mioon namespace update only changes the two workspace import substitutions below.
All pinned registry/source hashes are unchanged. Current `vendoredSha256` values
are derived from those unchanged upstream sources using the documented transform,
then checked byte-for-byte against the installed files; they are not arbitrary
replacement hashes. `installationNamespace` records `@mioon/ui`.

### Explicit installation adaptations

The installed TSX source differs from the official embedded source only by these
mechanical registry-installation substitutions:

1. `import { cn } from "cn"` resolves to the shared
   `@mioon/ui/lib/utils` helper. The helper combines `clsx` with
   `tailwind-merge`, so caller utility classes can override component defaults.
2. `@/registry/base-nova/ui/*` references resolve to the workspace's
   `@mioon/ui/components/*` exports.
3. Registry `IconPlaceholder` elements resolve to the named `lucide-react`
   component in the placeholder's `lucide` attribute; unused icon-library
   attributes are removed. Other attributes are retained.

The DOM composition, Base UI imports, prop types, default variants, focus-visible
classes, portal behavior, indicators, and accessibility primitives remain the
published source. The tests reproduce the substitutions and compare every
installed source file to its original snapshot exactly. Editor convenience
compositions, when present (for example `workbench-select.tsx` and
`workbench-tooltip.tsx`), are application adapters rather than additional official
registry components and are kept separately named.

## Workspace use

Import components individually. Examples:

```tsx
import { Button } from "@mioon/ui/components/button"
import { Dialog, DialogContent, DialogTitle } from "@mioon/ui/components/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@mioon/ui/components/select"
```

The renderer imports `@mioon/ui/globals.css` once before its editor
layout stylesheet. Package export mappings resolve component entries to
`./src/components/*.tsx`, utility entries to `./src/lib/*.ts`, and the CSS entry
to `./src/styles/globals.css`. Vite compiles the source package; there is no copied
UI bundle and no separate UI build output to keep in sync.

`components.json` declares `base-nova`, React client-side rendering, TypeScript,
Lucide icons, neutral semantic tokens, and monorepo aliases. `tsconfig.json`
provides matching aliases for strict, no-emit source type checking.

## Tailwind and the editor theme

`src/styles/globals.css` uses Tailwind v4 and `tw-animate-css`. Explicit `@source`
directives scan both workspace component files and `apps/web/src/**`; the raw
registry snapshots are excluded from scanning. The app's Vite configuration must
use `@tailwindcss/vite`. Because pnpm resolves imports from the owning package,
`tailwindcss` itself must also be a direct dependency of `@mioon/ui`.

The theme follows shadcn's semantic-token structure, mapped to the application's
palette; private design materials are not included in the repository. Canvas/panel/surface/raised are
`#0B0C0E` / `#141518` / `#1B1D21` / `#23252A`, and the action color is white
(`#F2F3F5` on `#0B0C0E`). This application palette is not an unmodified upstream
neutral preset. Color, typography, spacing, radius and control/layout dimensions
live in `packages/ui/src/styles/globals.css` as `--wb-*` tokens; renderer styles
reference those tokens instead of maintaining private palettes.
The renderer uses `class="dark"` on the document element. Both the web renderer
and Electron renderer use the same stylesheet and component code.

The local CSS contains the subset of shadcn state utilities needed by these
components, tailored to Base UI's data attributes: open, closed, checked,
unchecked, active, disabled, and the horizontal/vertical `data-orientation`
selectors. It supplies `cn-font-heading` and `no-scrollbar` utilities and honors
`prefers-reduced-motion`. The source reference for the state utilities is
[shadcn's Tailwind stylesheet](https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/tailwind.css).
The full stylesheet is not imported: it also includes unrelated compatibility
and utility code. Animation utilities come from `tw-animate-css`.

Keep legacy editor layout variables separate from shadcn's semantic tokens:
`--muted` is a surface color, `--muted-foreground` is text, `--accent` is an
interactive hover surface, and `--primary` is the white action color. Legacy
variables use the `--wb-` prefix rather than overriding these names. In particular,
`--wb-accent` is the white action color and maps to shadcn `--primary`;
shadcn `--accent` maps to `--wb-hover`, not white. Text on media clips uses the
separate `--wb-media-text` (`#FFFFFF`): the specified image fill needs this to meet
the design's 9:1 clip-text contrast target (the ordinary `#ECEDEF` text gives 8.44:1).

## Redesign application compositions

Import the optional application adapters from
`@mioon/ui/components/workbench-controls`. Their CSS is imported by the existing
`@mioon/ui/globals.css` entry. They do not patch any pinned registry source,
change its variants or replace its Base UI behavior.

- `WorkbenchButton`: primary, secondary, ghost, danger, danger-ghost and icon;
  compact/default/large heights of 24/28/36px; disabled/loading/focus states.
  Loading retains its label, exposes `aria-busy`, and prevents repeated clicks.
  The stable `.wb-button` class also works when a Tooltip changes `data-slot`.
- `WorkbenchTabs`: controlled segmented or underline presentation using the real
  Tabs primitives, manual activation and disabled options. Labels/test IDs are
  caller-supplied; callers may compose the existing `TabsContent` children.
- `WorkbenchChip`, `WorkbenchBadge`, `WorkbenchAlert`, `WorkbenchEmptyState` and
  `WorkbenchProgress`: display compositions with caller-localized copy. Progress
  bounds finite percentages to 0–100 and exposes an accessible progressbar.
- `WorkbenchPanel` and `WorkbenchGroup`: 36px header, scrollable content and 48px
  footer, plus Base UI collapsible sections that retain their mounted drafts.
- `WorkbenchDialogContent`: 420px, 560px or 960×640 content with a scrollable body
  and fixed actions. The existing Dialog root continues to own open/close,
  navigation admission and focus behavior. `WorkbenchToastRegion` and
  `WorkbenchToast` provide the top-right stack without submitting/dismissing work.

Input/Textarea, the existing scalar Select adapter and existing Switch/Slider
primitives use the same tokens. Native checkbox/radio controls can use
`.wb-checkbox` / `.wb-radio`; number/timecode displays use `--wb-font-mono`.
All new labels, errors, tooltip text and actions remain the caller's four-language
responsibility. No model/service or persistence behavior lives in these adapters.

`node --test tests/design-tokens.test.mjs` checks token mappings, text/action/media
contrast, renderer token references and Tooltip-safe selectors without installed
dependencies. `node --test tests/workbench-controls.test.mjs` checks real React /
Base UI rendering, callback/test-ID forwarding, loading and progress bounds under
the shipped classic JSX transform. These checks complement the official-source
integrity suite; browser keyboard/focus and screenshot acceptance are still needed
as the redesigned pages adopt the compositions. System light appearance is not
enabled by this foundation; its separate two-page screenshot review remains a gate.

## Editor adoption map

- Shared `Button`, `Input`, `Textarea` and `Label` are used throughout the renderer.
- `WorkbenchSelect` adapts Base UI `Select` to the editor's existing scalar fields.
- `Dialog` powers create, compare, exports, real-generation confirmation and the
  jobs drawer. The `workbench-confirm` composition also handles asynchronous
  discard, remove and stop confirmations: Escape or Cancel resolves `false`,
  overlapping confirmation requests resolve `false`, and initial focus is Cancel.
- `DropdownMenu` powers the project switcher.
- `Tabs` powers library filters, workspace modes, preview and inspector tabs.
- `Collapsible` powers library, inspector, storyboard, timeline and advanced sections.
  Desktop timeline collapse retains the same mounted timeline and its full 40px
  toolbar. Its hidden body is inert; waveform work, clip dragging and removal
  shortcuts stop until expansion. Explicit toolbar actions retain their existing
  domain admission. Very narrow windows keep the single-panel recall fallback;
  expanding restores the selected clip, scroll position and saved panel height.
  Agent sending options remain fully disclosed before permission. A saved grant
  defaults to a compact model/scope/target summary that can expand for review;
  changing the mounted disclosure key or revoking permission reopens the details.
  Hidden options remain mounted and inert, and retained scope-change callbacks
  must pass their current presentation owner. This state never grants permission
  or changes the existing send/approval admission.
- `Switch` controls track visibility and mute; `Slider` controls timeline zoom.
- `ScrollArea` wraps the asset library and inspector. `Tooltip` supports icon and
  library actions; `Badge` displays status chips; `Separator` divides inspector sections.

The existing editor state, action handlers and API contract are retained. The
confirmation sequencing is now asynchronous and waits for explicit approval
before continuing a consequential action; cancellation cannot fall through to
later actions. ReactFlow's canvas and time-positioned timeline tracks retain
their specialized rendering and geometry. The browser-native `beforeunload`
warning intentionally remains in place to protect closing an unsaved page.

## Behavior and accessibility

- Dialog uses Base UI Root, Portal, Backdrop, Popup, Title, Description and Close.
  The Base UI primitive supplies modal focus management and dismissal behavior.
- Select and dropdown menu use Base UI popup positioning, portals, item state,
  keyboard navigation and indicators.
- Tabs, Switch, Collapsible, Tooltip, Slider and Scroll Area retain Base UI
  behavior rather than reimplementing it with click handlers and CSS.
- Composition must use Base UI's `render` prop instead of `asChild`. Callers must
  provide visible or programmatic labels, dialog titles, and appropriate values.
- Icon-only controls still need an accessible name. A tooltip alone is not a
  substitute for the trigger's accessible label.
- Base UI slider values should be passed as arrays to this upstream wrapper
  (for example `value={[zoom]}`) so its thumb count matches the controlled value.

## Verification and maintenance

Run `node --test tests/ui-components.test.mjs` after dependency installation for
offline provenance, source composition, and server-rendered runtime checks.
They validate all 15 registry/source/install hashes, exact
installation transformations, real Base UI imports, portal/label composition,
Tailwind workspace scanning/state mappings, configuration, and the retained MIT
notice. A bundled React server-rendering smoke test also checks the actual
installed Button, Input, Label, Switch, Tabs, Collapsible and Slider output for
disabled, labeled, checked, selected and expanded state and semantic roles.
These tests deliberately do not claim to simulate browser focus traps, keyboard
navigation or visual layout. The renderer's browser checks and the UI TypeScript
check are separate validation stages.

For an upstream update, retrieve the official `base-nova` registry responses,
review the changes, perform the same documented substitutions, update all three
hashes in the manifest, and rerun the source checks, UI typecheck, renderer build,
and interaction tests. Do not silently edit an official component into a local
approximation; record any non-mechanical patch explicitly and extend its tests.

## Subsequent dual-workspace change — 2026-10-09

The global Base UI Tabs switch now selects 画板 or 剪辑 for the same project. Unlike the earlier migration checkpoint, the inactive workspace is intentionally unmounted. Canvas has no timeline and its storyboard defaults closed; Editing has no storyboard or React Flow tree. The inspector's collapsible content retains drafts within its active workspace, while a workspace change first applies explicit dirty-navigation confirmation. Per-project view preferences restore Canvas geometry/selection and Editing playhead/zoom/scroll after remount. See [dual-workspace acceptance](ACCEPTANCE-DUAL-WORKSPACE.md) for current checks; the migration evidence below is historical.

## Verified migration checkpoint — 2026-10-09

The final UI-specific checkpoint used the production build below and Chromium
154.0.8037.57 with its sandbox explicitly enabled. It used an isolated copy of
the synthetic multitrack example, the real authenticated HTTP/SQLite backend,
and no live generation provider.

- Production renderer build: passed.
- `node --test tests/ui-components.test.mjs`: **28/28 passed**, including official
  source integrity, real-runtime SSR, renderer adoption, safe confirmation
  defaults, project-menu grouping, and bounded integer-frame ruler navigation.
- `python3 tests/browser_ui_components.py`: **12/12 passed**, zero page errors and
  zero native dialogs. The final run started at 2026-10-09 10:40:20 UTC.
- Covered keyboard menus, dialog Tab/Shift+Tab containment, Escape dismissal and
  focus return, close/reopen, select arrow navigation/typeahead, manual-activation
  tabs, panel collapses, zoom slider, bounded ruler Home/End/Page/arrow keys,
  track switches, and discard/removal confirmations.
- Escape/Cancel kept drafts and clips intact. Explicit removal issued exactly
  one mutation and one timeline revision; source media and versions remained
  intact. Reopening the confirmation after success also passed.
- The enabled Continue button's measured foreground `rgb(36, 41, 26)` on
  background `rgb(215, 230, 170)` has a **11.22:1** contrast ratio, exceeding the
  test's 4.5:1 minimum. This is a specific control check, not a claim of complete
  WCAG conformance.

Evidence is in `evidence/v3-ui-components/report.json`, `run.log`, and the numbered
screenshots in that directory. The report records source asset hashes and each
case's actual mutations. Historical failures and the pre-contrast pass are kept
in `initial-regression/` and `precontrast/` respectively. The real-browser menu
check caught a missing `DropdownMenuGroup` around `DropdownMenuLabel`; the app
composition was corrected without altering the pinned upstream component.

Validated production artifacts:

| Artifact | SHA-256 |
| --- | --- |
| `apps/web/dist/index.html` | `0562ac6861c3d35c43ea11fc03983686533f5c10c5c0b83aa24632c12d56408a` |
| `apps/web/dist/assets/index-QRXyjFjg.js` | `562fa8d5438d4a33673f0cf13d6b7b5a304cd3ebe56f54dffb516d7a599357ea` |
| `apps/web/dist/assets/index-DAc-5vtg.css` | `6d170950af6e6b829b0d73faee6c808d5be1cdd3a385249bb114c51fe31c06bf` |

The TypeScript no-emit check was not run because TypeScript and React declaration
packages were not installed; Vite compiled the TSX sources and the runtime tests
executed them. The separate application-wide HTTP/MCP/media and full-flow browser
suites are reported in the project's aggregate acceptance documentation, rather
than being implied by these UI-specific checks.

### 界面文案

界面提示的每段末尾不加中文或日文句号 `。`、英文句点 `.`，段落内部的句号、省略号及其他标点保留。此规则在静态文案模板中应用，不裁剪用户输入、动态参数、文件名或链接。

### 浅色主题

`packages/ui/src/styles/light.css` 在根元素 `.light` 下生效。用户确认第三版截图后，外观偏好支持 `dark | light | system`；Provider维护互斥根类并公开解析后的主题，ReactFlow使用同一解析值。普通文字与操作文字最低4.5:1，媒体片段保留深色语义底与白字，最低9:1。媒体文字遮罩使用独立的 `--wb-media-overlay`，避免跟随弹窗浅色backdrop而降低可读性。系统外观监听随偏好切换与卸载清理，不会触发偏好写入。

### 小桌面窗口的面板展示

`usePanelGeometry` 按工作区的物理宽度派生紧凑展示：小于 1150px 且未进入原有极窄模式时，两侧默认显示 44px 图标栏，中央画板或预览继续可用。点击图标栏打开保留挂载的临时浮层，可固定到当前项目和模式的瞬态布局。自动收起、浮层和固定均不改写保存的面板尺寸/折叠偏好；恢复宽窗会重新使用原偏好。低于原有 800 逻辑像素或高度不足时，仍使用独立的单面板兜底模式。缩放测量同时区分物理窗口与逻辑控件尺寸。

导出文件恢复组件也遵守 `WorkspaceVisibility`：隐藏或归属变化后，旧文件选择、状态读取和回调失效；已经发出的恢复 POST 保持执行，完成后只释放当前实例的忙碌锁，重新可见的历史由自己的 GET 重核，不使用旧结果覆盖新视图或冻结下载 URL。
