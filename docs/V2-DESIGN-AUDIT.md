# V2 functional layout audit

## Scope and source

Own-cloud Chromium capture made for this change, opening the existing five-shot synthetic project at a 1600×1000 viewport. Accepted evidence: `evidence/v2-before/01-current-workbench.png`; the saved image was inspected and is loaded, complete and on the intended surface. No external design asset or screenshot was invented.

## Findings from the captured screen

1. The left material library has a useful name and real media, but it gives no clear drag destination. The separate narrow icon rail uses valuable media-screen width without explaining its purpose.
2. The center is a functioning canvas, but the small “创作画布” breadcrumb does not explain whether it is arranging visual ideas or editing playback time. Fitting five wide-spread nodes makes content small.
3. The right inspector is useful for a selected shot, but its region name changes with selection and does not clearly explain the general “properties of the selected item” role.
4. The bottom “分镜板” is a reorderable sequence rather than a multitrack timeline. It has no time ruler, track rows, playhead, trim or cross-track layer controls. Adding track-looking rows without backend semantics would worsen this ambiguity.
5. There is no large project-output preview area. Media is visible in individual nodes, and the export is reachable via a dialog, but composition review is fragmented.

## Layout decision

- 01 素材库, left: import, search, filter, review original media, drag source assets into the canvas or timeline.
- 02 主工作区, center: switch between 画布 and 预览 while retaining state. Canvas arranges spatial idea/node relationships. Preview offers immediate source review and an explicitly rendered timeline snapshot.
- 03 属性, right: edit the selected shot, canvas node or timeline clip. Clip timing has exact-frame numeric fields and bounded visual placement controls.
- 04 多轨时间线, bottom: edit temporal placement, duration, source in-point, tracks, layering and audio. Separate from the compact storyboard, which continues to express narrative shot order.

The same region numbers and plain-language purpose descriptions appear inside the app. Panels can collapse and reopen with named controls. Existing dark visual language stays; media and usable controls take priority.

## Honesty and bounded scope

Timeline preview is a real render using the identical compositor as final export. When edits invalidate the snapshot, the UI explicitly marks it as stale and asks to update the preview. Immediate original/selected-source preview remains available. Same-track overlaps are rejected; cross-track overlaps composite in documented order. No transitions, keyframes or professional editor features are implied.

## Evidence limits

This initial audit establishes structure and visible affordances, not full WCAG compliance. Keyboard labels, focus, responsive layout and actual interactions are checked in the later browser verification; render semantics are checked with actual FFmpeg output and audio/video probes.
