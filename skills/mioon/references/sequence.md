# Format-5 sequence editing

Resolve the real `projectId` before a call. Read only the minimum needed to locate the target and make the change. Use a returned cursor unchanged on the same query. If the snapshot changed, restart the read at the first page.

| Evidence | CLI | MCP |
| --- | --- | --- |
| Main-track order, clip and group IDs, versions, sync differences | `"{{MIOON_COMMAND}}" sequence inspect` | `sequence_inspect` |
| Saved clip names, track locations, gains and timeline revision | `"{{MIOON_COMMAND}}" timeline inspect` | `timeline_inspect` |
| Board synchronization, archived rows and subject bindings | `"{{MIOON_COMMAND}}" sequence board get` | `sequence_board_get` |
| Generation input roles and whether the selected service can use them | `"{{MIOON_COMMAND}}" sequence generation-inputs get` | `sequence_generation-inputs_get` |
| Current undo/redo action and cursor | `"{{MIOON_COMMAND}}" sequence history get` | `sequence_history_get` |

The ordinary reads take `projectId`. Sequence inspection also accepts an optional `rootId`, `limit` and `cursor`. Generation-input inspection needs `shotId`; when targeting a video configuration, send the selected `connectionId`, `configurationRevision` and `modelEntryId` together.

## Preview and commit

Use the current schema to select a `kind` and its fields. Each preview request carries `projectId` alongside the action fields.

| Change | CLI preview | MCP preview |
| --- | --- | --- |
| Connect, disconnect, insert, remove, split, reorder, copy/move, follow or lock a version | `"{{MIOON_COMMAND}}" sequence action edit` | `sequence_action_edit` |
| Create or update board nodes and shots, move layout, restore or duplicate | `"{{MIOON_COMMAND}}" sequence board edit` | `sequence_board_edit` |
| Attach, detach, change role or reorder generation references | `"{{MIOON_COMMAND}}" sequence reference edit` | `sequence_reference_edit` |
| Bind subjects and edit subject cards | `"{{MIOON_COMMAND}}" sequence subject edit` | `sequence_subject_edit` |
| Create or update a previs scene | `"{{MIOON_COMMAND}}" sequence previs edit` | `sequence_previs_edit` |
| Edit tracks, subtitles and dialogue, insert media, set format, split at scenes, separate sound or generate in editing | `"{{MIOON_COMMAND}}" sequence timeline edit` | `sequence_timeline_edit` |
| Change clip properties or replace a source | `"{{MIOON_COMMAND}}" sequence clip edit` | `sequence_clip_edit` |

For a rename, put this shape in `clip-edit.json`. Replace the example UUIDs with values from the current read.

```json
{
  "projectId": "11111111-1111-4111-8111-111111111111",
  "kind": "clip-properties",
  "edits": [
    {"clipId": "22222222-2222-4222-8222-222222222222", "patch": {"name": "Opening"}}
  ]
}
```

```sh
"{{MIOON_COMMAND}}" sequence clip edit --input-file clip-edit.json
"{{MIOON_COMMAND}}" sequence action commit --input-file commit.json
```

Create `commit.json` only after reading the successful preview. Put the current `projectId`, the exact object from `data.envelope`, and the exact string from `data.planDigest` under `expectedPlanDigest`. With MCP, use the same fields for `sequence_action_commit`. Do not construct, patch or re-preview an envelope to retry the same commit. If the response is lost, retain and replay the exact commit request. If a known stale plan was refused, reread, review the new impact and preview again for the intended change.

The external action enters user history. Check the receipt's `status` and `actionId`, then read back the edited property. If `kind` is `generate`, apply the paid-video rules before committing. The commit can place a clip and submit generation in the same action.

## Replace a source

Use `"{{MIOON_COMMAND}}" sequence clip edit` or `sequence_clip_edit` with `kind` set to `replace-source`, plus the current `clipId` and desired `assetId`. Supply the matching `versionId` for a main-track shot; the shot must own or have adopted that version. A successful shot replacement locks the clip to the new version. The source must cover the clip's existing in-point and length. A fixed main-track media node shared by split clips or a reference can block an individual replacement. Report the refusal and keep the edit unapplied.

## Undo or redo one action

1. Read `"{{MIOON_COMMAND}}" sequence history get` or `sequence_history_get`. Verify `undoAvailable` or `redoAvailable` and match `undo.actionId` or `redo.actionId` to the action the user wants. Stop if a different action is on top.
2. Use `"{{MIOON_COMMAND}}" sequence undo` / `sequence_undo` or `"{{MIOON_COMMAND}}" sequence redo` / `sequence_redo`. Send `projectId`, the chosen `actionId`, a new stable `requestId` for that one history operation, and `expected: {position, revision}` from the read. Leave the user origin at its default.
3. On `SEQUENCE_EDIT_HISTORY_CONFLICT`, reread and confirm the target is still what the user asked to change. After a lost response, replay the exact command and input rather than using a new ID. Verify the returned receipt and saved state.

## Loudness and clip gain

1. Measure the saved mix with `"{{MIOON_COMMAND}}" timeline loudness prepare` or `timeline_loudness_prepare`. Use the current timeline revision as `expectedRevision`, `mixProfile: "timeline-float-mix-v1"`, `measurementProfile: "bs1770-5-48k-stereo-fir4x-v1"`, and the user's explicit `target` with `integratedLufs` and `truePeakCeilingDbtp`. Report the measured original and candidate. The measurement is advisory and does not edit anything.
2. If the user wants the reviewed candidate applied, ensure its timeline revision and affected clips still match. Use its measured `candidate.gains`: each edit has `clipId` and `patch: {gain: afterGain}` under `kind: "clip-properties"` in `"{{MIOON_COMMAND}}" sequence clip edit` / `sequence_clip_edit`. Check the target and true-peak results and the full affected set before committing. If the candidate is unavailable or the edit cannot represent the whole proposal, report the blocker. For delivery claims, measure the actual exported file.
