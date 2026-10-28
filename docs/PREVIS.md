# Camera previs

Status: storage and operations implemented (schema 64). The canvas node, the
3D editor, keyframe export and setting a shot's first or last frame come next.
Contracts: `packages/contracts/src/previs.ts`.

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
