# Native tray artwork

These assets use the existing cat-ear film-ribbon body, without the Dock icon's
rounded backplate, platform mask or shadow. The shared app/Dock icon is unchanged.

The sole source is the existing `apps/web/src/assets/mioon-mark.png`. No generated
replacement, new silhouette or alternate master is used. The original source
and app/Dock assets are not modified.

Run `swift apps/desktop/scripts/generate-tray-icons.swift` on macOS to export:

- `trayTemplate.png`: 18×18 px at 72 dpi, black RGB plus transparency.
- `trayTemplate@2x.png`: 36×36 px at 144 dpi; same 18-point logical size.
- `tray-color.png` / `tray-color@2x.png`: matching color variants.
- `tray.ico`: PNG-backed 32-bit RGBA frames at 16, 20, 24, 32, 48 and 64 px.

The native exporter identifies the largest 8-connected component whose original
alpha is greater than 4/255, then preserves those exact pixels and their original
one-pixel antialias fringe. All disconnected dots outside that component/fringe
are removed. This does not trace, fill or erode the core or its edges. It crops
to the remaining body's bounds and fits it with one logical point of padding
into an 18-point square. Other sizes use the same proportional geometry.
Each black template is derived from the already-rasterized color pixels by
zeroing RGB only, preserving alpha byte-for-byte. No alternate shape is traced
or redrawn. `manifest.json` records the original PNG path, SHA-256 and exact export
parameters. The ICO frames are PNG-encoded RGBA images, preserving transparency.

Ordinary builds use the committed output files; they require no image service,
Swift runtime, extra image library or native build step. Only the five runtime
image names above need to be copied into the application (not the manifest/docs).
On macOS keep the `Template`/`@2x` basenames and mark the native image as a template;
the OS decides its black/white tint from the system menu bar, independently of the
workbench theme. Windows consumes the colored multi-resolution ICO.
