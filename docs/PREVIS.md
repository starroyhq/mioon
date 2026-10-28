# Camera previs

Status: storage and operations (schema 64), the canvas node, the 3D editor,
keyframes, keyframe export and setting a shot's first or last frame are
implemented. Contracts: `packages/contracts/src/previs.ts`; web UI:
`apps/web/src/previs/`.

A previs node is a canvas node of type `previs`. It holds one small 3D scene:
mannequins, props, one key light, the current camera and recorded camera
keyframes. The editor renders it in the browser and costs nothing. An exported
keyframe image enters the asset library through `asset.import`; its asset ID is
then saved on the keyframe.

## Node record

```json
{"id":"…","projectId":"…","type":"previs","label":"机位预演","text":"",
 "position":{"x":40,"y":60},"revision":3,"sceneRevision":2,"scene":{…},"createdAt":"…"}
```

`revision` advances on every change of the node. `sceneRevision` advances only
when the scene is saved, so moving or renaming the node on the canvas never
conflicts with an open editor. `node.update` may change a previs node's
`label` and `position`; a `text` change is refused with `INVALID_NODE_PATCH`.
`node.create` cannot create a previs node.

## Scene format (`schemaVersion` 1)

Units are metres, degrees and millimetres. +Y is up and the ground is y = 0.
A camera with yaw 0 and pitch 0 looks along −Z; positive yaw turns left
(counter-clockwise seen from above) and positive pitch looks up. A figure or
prop with rotation 0 faces +Z. Focal lengths assume a 36 mm long frame edge.
Every number keeps at most three decimals (`roundPrevisNumber`), so a saved
scene compares exactly.

| Field | Content |
| --- | --- |
| `figures` | Up to 8: `{id:"f1…",name,visible,position:[x,y,z],rotation,pose,held}`. `pose` is `stand`, `walk`, `sit`, `hold` or `look-back`. `held` is `null` or `{propId,hand:"left"\|"right"}`. |
| `props` | Up to 24: `{id:"p1…",kind,name,visible,position,rotation,size:[w,h,d]}`. `kind` is `box`, `cylinder`, `sphere`, `panel`, `umbrella`, `phone`, `bag` or `cup`; a cylinder or sphere uses the width as its diameter. |
| `light` | `{visible,azimuth,elevation,intensity}`; intensity 0–4. |
| `camera` | `{position,yaw,pitch,focalLength}`; focal length 10–300 mm. |
| `keyframes` | Up to 24: `{id:"k1…",name,camera,exports}`. `exports` holds the asset IDs of the newest four exported images, oldest first. |
| `activeKeyframeId` | `null` or an existing keyframe ID. |

Positions are within ±100 m, angles within ±180° (pitch and elevation ±90°)
and sizes 0.01–20 m. IDs are a prefix and 1–9999. Names are at most 20
characters without control characters; an empty name means the editor shows
a localized default (keyframes default by focal length: 24 全景, 35 中景,
50 中近景, 85 近景). Only an umbrella, phone, bag or cup can be held, by one
figure at most. An exported image belongs to one keyframe. A scene at every
item limit stays under the 16 KiB bound, and a previs node row stays under
24 KiB, well inside the 32 KiB rows Mio reads when it inspects the canvas.

## Operations

| Operation | Strict RPC input |
| --- | --- |
| `previs.create` | `{projectId,label?,position,requestId}` |
| `previs.scene.set` | `{projectId,nodeId,expectedSceneRevision,scene,requestId}` |
| `previs.thumbnail.set` | `{projectId,nodeId,slot,sceneRevision,dataBase64}` |
| `previs.thumbnail.get` | `{projectId,nodeId,slots}` |

`create` adds a node with the default scene: one standing figure, the key light
and an eye-level camera. `scene.set` replaces the whole scene when
`expectedSceneRevision` matches, keeps the label and position, and returns the
node. A stale save fails with `REVISION_CONFLICT`; `details.current` is the
current node, so an editor can tell whether only the canvas moved it or the
scene changed. New keyframe exports must be PNG, JPEG or WebP assets of the
same project (`PREVIS_EXPORT_INVALID`). A non-previs target fails with
`PREVIS_NODE_REQUIRED`; another project's node reads as `NOT_FOUND`.

Both writes require a stable `requestId` and replay their original response
exactly. Autosave writes often, so only the newest four scene saves of a node
keep receipts. A retry of an older save finds no receipt and fails the
revision check: it is never applied twice. Read the node back to learn whether
that save is the current scene. Create receipts are kept for good; at most 256
nodes per project and 1,024 per workspace are created this way
(`PREVIS_CAPACITY`).

## Thumbnails

Thumbnails are a disposable cache in `previs_thumbnails`. A slot is `card` or
a keyframe ID of the current scene. `thumbnail.set` takes a baseline or
progressive JPEG, at most 384 pixels on the long edge and 64 KiB, rendered at
the node's current `sceneRevision` (`PREVIS_THUMBNAIL_STALE`,
`PREVIS_THUMBNAIL_SLOT`, `PREVIS_THUMBNAIL_INVALID`). A new write replaces the
slot. Saving a scene removes the thumbnails of keyframes it no longer has; the
others keep their older `sceneRevision`, which tells the editor to redraw
them. Each project keeps at most 1,000 and the workspace 2,048 thumbnails;
the oldest are evicted first. `thumbnail.get` returns the requested slots that
exist, in request order, as base64.

## Canvas and editor

The canvas toolbar's **预演** button adds a previs node next to the view's
centre. Its card shows the newest `card` thumbnail, the keyframe count, the
project frame (the timeline format, or 9:16 1080×1920 without one) and that it
renders locally. The inspector renames the node, shows the frame it follows and
a scene summary, and opens the editor; double-clicking the card opens it too.

The editor covers the window. The scene outline lists figures, props and the
key light, each with a visibility toggle, and adds figures and props. The
properties panel edits the selection: a figure's name, pose, held prop and
holding hand, position and facing; a prop's name, position, facing and size; or,
with nothing selected, the camera. The key light's direction and intensity are
always below. The 3D view looks through the scene camera itself; the frame
guide in the middle is exactly the output frame, with its focal length and
size above it and the camera height and tilt in the corner.

- Orbit mode drags the camera around the selection, or around the line of
  sight at the scene's depth. Free mode drags to look around. WASD walks,
  Space rises, Shift sinks, the wheel changes the focal length, and the right
  or middle button pans. Dragging a figure or prop moves it on the floor; a
  held prop moves with its holder. The focal presets in the keyframe strip's
  heading are 24, 35, 50 and 85 mm.
- Edits save on their own 0.8 s after the last change, one save at a time,
  under the node's scene revision. An uncertain answer resends the same
  request. A conflict offers to load the newer scene or keep this one. ⌘Z or
  Ctrl+Z undoes and ⇧⌘Z or Ctrl+Y redoes within the open session, up to 200
  steps; one drag or slider movement is one step.
- About a second after a save settles, the editor captures a 384×216 view of
  the scene for the card thumbnail.
- Leaving waits for an export under way and then the last save. If the save
  cannot finish, the editor asks before discarding the unsaved changes.
- Without WebGL the 3D view shows a notice; the panels still edit and save the
  scene. A restored copy opens read-only: the camera can be moved to look
  around, but nothing is saved.

three.js (`three` 0.186.1, MIT) renders the view. It loads only when a previs
is opened, as a separate chunk; the mannequins and props are built from basic
shapes, so no model files ship with the app.

## Keyframes and output

The strip under the 3D view lists the keyframes in order. **记录当前机位** or K
records the current camera as a new last keyframe. Keyframes are snapshots:
clicking a card moves the camera there (one undo step; a restored copy only
looks), and the card shows as current until the camera moves again. Cards are
labelled K1, K2, … in strip order, so labels follow a reorder; an unnamed
keyframe is named by shot size. Drag a card to reorder it, or focus it and
press Alt+← or Alt+→; Delete removes it, and F2 or a double-click renames it.
While the editor is open, a new keyframe never takes a deleted one's ID.

Each card shows a picture through its camera at the frame's aspect ratio. It
is redrawn locally when the figures, props, light or that camera change, and
uploaded to the keyframe's thumbnail slot after the scene is saved. The
inspector lists the keyframes with their focal length and the figures and
props each one frames, the shots the node is linked to with what each takes
from it, and the export format.

A card's menu (⋯ or right-click) has:

- **导出为图片**: renders the keyframe at the project frame size (for example
  1080×1920) without the editor overlays and adds the PNG to the asset library
  with `asset.import`. An identical image already in the project (same
  SHA-256) is reused; an uncertain answer is resolved by reading the library
  again. The asset ID is recorded in the keyframe's `exports`. Recording it is
  not an undo step, and undo keeps it.
- **设为镜头 NN 首帧 / 尾帧** for each shot the node is linked to, and
  **设为其他镜头的首帧 / 尾帧** for the others: exports the picture the same
  way, then sets it with an ordinary `shot.update` under the shot's revision.
  The first frame replaces `referenceAssetIds` with the one image; the last
  frame sets `lastFrameAssetId`. A visual link from the previs node to the
  shot is added when there is none. An item is disabled, with the reason,
  when the shot's aspect ratio differs from the previs frame or a reference
  link controls its first frame. Setting is refused, with the reason, when
  the image is already the shot's other frame, the shot has unsaved text or
  edits await confirmation. The result notice offers undo for 12 seconds.
  Undo restores the previous frame only while the shot still has the image
  that was set, and removes the link it added unless the shot's other frame
  still comes from this previs.
- **重命名** and **删除关键帧**.

On the canvas, a visual link from a previs node to a shot is drawn solid and
names the keyframes that supply the shot's frames, for example "首帧 · K2" or
"首帧 · K1 / 尾帧 · K3". Labels are derived from the shot's current frames and
the keyframes' recorded exports, so they follow a reorder and disappear when
the shot's frame is replaced.

## Packages, backups and Mio

Project packages and duplicates carry previs nodes with their scenes; keyframe
export asset IDs are remapped with the assets, and an exported image counts as
used. Receipts and thumbnails stay behind; the editor redraws thumbnails when
it opens. Imports refuse a previs node whose scene breaks these rules or whose
exports are not images of the new project. Deleting a project deletes its
previs nodes, receipts and thumbnails.

Backups carry everything. A restored copy (schema 65, `restored-local-v21`)
holds the receipts, freezes the thumbnails and allows only
`previs.thumbnail.get`: previs nodes can be viewed, not saved. Restored copies
of schema 62 backups have no previs storage.

Mio can see, rename and move previs nodes through the canvas tools, but cannot
call any `previs.*` operation yet.
