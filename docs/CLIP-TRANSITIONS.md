# Clip transitions

Since 2026-10-29 the cut between two adjacent clips on one video track can
carry a picture transition: a dissolve, a dip to black, a wipe or a push. The
transition is stored, rendered in preview and export, and set in the clip
inspector of the incoming clip. Operation details are in
[the API](API.md#clip-transitions-2026-10-29).

## Model

A cut is where a clip (the incoming clip) starts and another clip on the same
track (the outgoing clip) ends. The incoming clip's optional `transitionIn` is
`{profileId:"mioon-clip-transition-v1",kind,durationFrames}`
(`packages/contracts/src/timeline-clip-transition.ts`):

- `kind`: `dissolve`, `dipToBlack`, `wipeLeft`, `wipeRight`, `pushLeft` or
  `pushRight`. Wipes and pushes are named by the direction the picture moves:
  in `wipeLeft` the incoming picture is revealed from the right edge.
- `durationFrames`: 2 to 60 timeline frames, centred on the cut. The ⌊D/2⌋
  frames before it show the incoming clip's source from before its in point;
  the rest, after the cut, show the outgoing clip's source after its out point.
  Clip positions and the timeline length do not change.

A transition fits its cut when:

- the incoming clip's source has at least ⌊D/2⌋ frames before its in point,
  and the outgoing clip's source at least the rest after its out point; a still
  repeats, so it always has them;
- the outgoing clip keeps ⌊D/2⌋ of its own frames beside the transition on
  its other cut, and the incoming clip keeps the rest beside the next one;
- the composition stays within 200 segments when every transition adds the
  edges of its span, the bound 100 clips already reach.

`clipTransitionRoom` gives the longest transition a cut takes, and the
inspector shows it. Progress follows FFmpeg's `xfade`: transition frame k is k/D
of the way, so the first frame still shows only the outgoing picture.

## Editing

`timeline.clip.setTransition` sets or clears the transition at one cut as one
edit; clip updates never carry one, so Mio's clip tools keep their schemas. Mio
reads each clip's `transitionIn` in `timeline.inspect` but cannot change it in
this version.

A transition belongs to its cut. Every other timeline edit keeps the
transitions that still fit and removes, in the same revision, those it leaves
without a cut or room: each track is read left to right, and a transition stays
when it fits beside the ones already kept on its left; over the segment bound
the latest cuts lose theirs. So a move away from the cut, a trim into the
handles or removing the outgoing clip removes it, while splitting either clip
keeps it at the outer cut. The new inner cut of a split is always plain. The
editor tells the user when an edit removed a transition.

In the inspector's visual group of the incoming clip, the transition section
shows the saved transition and the longest one the cut takes, and applies a
kind and a duration or removes the transition. Each button is one saved edit,
so the section waits until the clip draft is saved or discarded. The preview is
a rendered video, so it shows a change after it is updated.

On the timeline (`TimelineTransitionMarks.tsx`, rules in
`timeline-transition-marks.ts`):

- Each transition is a bar across its cut near the bottom of the video lane,
  as wide as the frames it covers. Selecting it selects the incoming
  clip, whose inspector edits it.
- While a clip is selected, each cut at its start or end without a transition
  shows a + button. It adds the cut's default, a 15-frame dissolve or the
  longest one that fits, as one saved edit, then selects the incoming clip.
- The button waits for a saved clip draft and an unlocked track, and says why
  when the cut has no room. Restored and read-only timelines show the bars
  only.

## Rendering

`packages/business/src/timeline-transition-filter.ts` builds the graph pieces
for `timeline-media.ts`, which preview and export share. A timeline without
transitions keeps the historical segments and filter chains byte for byte.

- The span of each transition adds segment edges, so every segment lies wholly
  inside or outside it. Inside, the outgoing clip's picture reaches to the
  span's end and the incoming clip's picture starts at the span's start; their
  sound keeps its own range, so the sound cuts hard at the cut.
- On the track of the cut, the two clips are placed together:
  - dissolve and wipes split the composition below into two, place each clip
    on one copy and mix the two complete pictures with `xfade` (`fade`,
    `wipeleft`, `wiperight`), so layers under the clips stay as they are;
  - a dip fades the outgoing clip's own layer to black in the first half and
    the incoming one up from black in the second, switching at the midpoint;
  - a push moves both clips' placements horizontally by the timeline width per
    frame, together with any transform.
- A segment that starts inside the span pads both streams with the frames
  already played and trims them off after the mix, so the transition continues
  where it is.
- FFmpeg 7 leaves the rate unknown after `setpts`, which `xfade` and `tpad`
  refuse, so both get `fps=30` first; and `fade` scales packed RGBA's alpha
  too, so the dip fades planar RGB. FFmpeg 7.1.5 and 9.0.2 render these graphs
  alike. The render first runs a small probe of every filter a transition
  uses and fails with `TIMELINE_TRANSITION_UNSUPPORTED` without them.
- With managed colour, a transition between two images shows both at once, so
  both count towards the two visible images a segment may open. The colour
  plan counts clip ranges only; export preflight and every render snapshot
  also count the transitions and report `TIMELINE_IMAGE_COMPOSITOR_BUDGET`
  (`assertTransitionImageBudget`).

## Storage

Schema 72 is a marker-only layer, as schema 70 was for transforms:

- No schema object changes.
- From the marker on, the transition row gate
  (`workspace-transition-validation.ts`) admits persisted transitions.
- Ordinary and restored roles before 72 refuse any transition or
  `setTransition` receipt.
- Backups of schema 72 restore as read-only schema 73 copies
  (`restored-local-v25`).

The reviewed delta is frozen in
`tests/fixtures/workspace-schema-profiles/current-ordinary-72-delta.json`.

## Tests

- `tests/timeline-clip-transition-media.test.ts` renders red and blue clips in
  a centred rectangle over a green track with real FFmpeg. Inside the
  rectangle each kind follows its model frame by frame; outside it the green
  never changes. It also checks that the sound cuts hard and that a push moves
  a transformed clip with its transform.
- `tests/timeline-clip-transition.test.ts` covers the value checks, the fitting
  rules and pruning, the operation's receipts, replay, undo and refusals
  (including the segment bound), the edits that keep or remove a transition,
  the managed image budget in preflight and render, and the schema 70 and 72
  workspace gates through backup and restore.
- `tests/clip-transition-ui.test.ts` covers the inspector state, its markup
  and its wiring.
- `tests/timeline-transition-marks.test.ts` covers the timeline marks, the
  quick-add cuts, their markup and App's wiring;
  `tests/timeline-collapsed-presentation.test.ts` checks that they keep to
  video lanes and the timeline body's gate.
