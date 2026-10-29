# Clip transforms

Since 2026-10-29 a clip on a video track can move, zoom, rotate and crop its
picture. The transform is stored and rendered in preview and export. Its
position and scale keyframes are edited with numbers in the clip inspector or
by dragging a transform box over the rendered preview, and its static rotation
and crop with numbers in the inspector. Operation details are in
[the API](API.md#clip-transforms-2026-10-29).

## Model

A clip's optional `transform` is
`{profileId:"mioon-clip-transform-v1",keyframes,rotation,crop}`
(`packages/contracts/src/timeline-clip-transform.ts`):

- `keyframes`: 1 to 16 `{frame,x,y,scale}` at strictly increasing clip-local
  frames 0…duration. Values hold before the first and after the last keyframe
  and change linearly between keyframes. One keyframe means a static transform.
- `x`, `y`: timeline pixels from the clip rectangle's centre to the content's
  centre, at most ±8192, so content can enter from or leave the frame.
- `scale`: 0.05 to 8 times the size the cropped source has after fitting the
  rectangle.
- `rotation`: static clockwise degrees around the content centre, −180 to 180.
- `crop`: static fractions of the source removed from each edge before
  fitting, each 0 to 0.9, leaving at least a tenth of each dimension.

The rectangle keeps its meaning: the cropped source fits inside it with its
aspect ratio and is centred, exactly as without a transform. The transform then
scales, rotates and offsets that content around the rectangle centre, in this
order. Timeline pixels are square. `clipTransformGeometry` returns the content
centre and size at a clip frame; the renderer, the inspector and the transform
box use it.

## Editing

`timeline.clip.setTransform` sets or clears a transform as one edit; clip
updates never carry one, so Mio's clip tools keep their schemas. Mio reads
each clip's transform in `timeline.inspect` but cannot change it in this
version.

The transform follows its clip:

- A split keeps each keyframe on its side and adds the interpolated value at
  the cut, so the animation is unchanged.
- Start, source and duration edits keep clip-local keyframe times, like volume
  envelopes. A shorter clip drops keyframes past its new end and keeps the
  interpolated end value instead of refusing the trim.
- Moves, track changes between video tracks and source replacement keep the
  transform; the crop fractions then apply to the new source.

In the inspector's visual group, the transform section works on the clip frame
under the playhead. It shows the values there (a keyframe's own, or those the
keyframes give by holding or interpolating), sets a keyframe at that frame with
the entered values, removes the keyframe there, or clears the transform. Each
button is one saved edit, so the section waits until the clip draft is saved or
discarded. Removing the last keyframe clears the transform unless it rotates or
crops; then an identity keyframe keeps those. The preview is a rendered video,
so it shows a change after it is updated.

Below the keyframes, rotation (degrees) and crop (percent of the source per
edge) apply to the whole clip. Applying them is one saved edit that keeps the
keyframes; without keyframes an identity keyframe at frame 0 holds them, and a
transform left without any effect is cleared. The fields accept what the model
accepts. A crop pair summing to exactly 90% can exceed 0.9 as binary fractions
(0.34 + 0.56), so the far edge is reduced by a few units in the last place
before saving; it still reads back as the typed percent.

Over the rendered timeline preview, the selected clip shows its transform box
at the playhead frame while the clip is on screen
(`apps/web/src/ClipTransformBox.tsx`). The box is `clipTransformGeometry`
scaled onto the picture the video element shows, so it rotates and crops with
the content. Dragging the box moves the content in whole timeline pixels and
dragging a corner scales it about its centre in whole percent; releasing sets a
keyframe at that frame, like the inspector's button, and Esc cancels the drag.
The box shows the saved transform at once, while the video keeps the last render
until the preview is updated. The box follows the inspector's rules: it is
absent where the inspector cannot set transforms, and only outlined while the
clip draft has unsaved changes, the track is locked in this window or all 16
keyframes are used elsewhere.
Parts of the box beyond the preview stage are clipped, handles included; the
inspector still reaches every value.

## Rendering

`packages/business/src/timeline-transform-filter.ts` builds the graph pieces
for `timeline-media.ts`, which preview and export share. A clip without a
transform, or with the identity, keeps the historical filter chain byte for
byte.

For a transformed clip:

1. The crop is applied before fitting.
2. The source is fitted into the rectangle at an intermediate factor and padded
   onto a transparent layer. The factor is the largest keyframe scale, so a
   zoom keeps source detail, capped so that neither edge exceeds 4096 pixels.
3. The layer is rotated once (`rotate`, transparent corners).
4. It is scaled per frame (`scale` with `eval=frame`) to the keyframed size.
5. It is overlaid by its centre at the keyframed offset (`overlay` with
   `eval=frame`).

The layer never changes size before the per-frame scale.

Keyframes become nested `if(lt(…))` piecewise-linear expressions of the clip
frame `segment offset + round(t*30)`. They use the timestamp, not `n`: both
filters count `n` from an already advanced link counter, one frame ahead of the
frame they draw. FFmpeg 7.1.5 and 9.0.2 render these graphs identically. An
animated transform needs FFmpeg 5 or later, so the render first runs a two-frame
probe and fails with `TIMELINE_TRANSFORM_UNSUPPORTED` on an older tool.

Colour-managed image clips keep their prepared rectangle-size layer, so they
stay within the existing image layer pixel budget. Their crop is applied to the
source pixels when the layer is prepared. Zooming into one samples that
rectangle-size layer rather than the original image.

## Storage

Schema 70 is a marker-only layer, as schema 40 was for volume envelopes:

- No schema object changes.
- From the marker on, the transform row gate
  (`workspace-transform-validation.ts`) admits persisted transforms.
- Ordinary and restored roles before 70 refuse any transform or
  `setTransform` receipt.
- Backups of schema 70 restore as read-only schema 71 copies
  (`restored-local-v24`).

The reviewed delta is frozen in
`tests/fixtures/workspace-schema-profiles/current-ordinary-70-delta.json`.

## Tests

- `tests/timeline-clip-transform-media.test.ts` renders a known white pattern
  with real FFmpeg. Each checked frame's bounding box must match the model
  within a few pixels. The test covers an animated zoom with segment boundaries
  inside the clip, a split, a head trim, a move, and a rotated and cropped
  clip.
- `tests/timeline-clip-transform.test.ts` covers the value algebra, the
  operation's receipts, replay, undo and refusals, and the schema 68 and 70
  workspace gates through backup and restore.
- `tests/timeline-transform-filter.test.ts` evaluates the generated
  expressions against the model.
- `tests/clip-transform-ui.test.ts` covers the inspector state and markup.
- `tests/clip-transform-box.test.ts` covers the box geometry on the picture,
  the drag arithmetic, its markup and its wiring into the preview.
