# Asset tags and plain-text notes

The asset library now has a selected-asset editor in all four application locales:
Simplified Chinese, region-neutral Traditional Chinese, English and Japanese.
It operates on the existing project-owned `projectId + assetId` annotation contract.
It is not a version, clip, source-range or timeline editor.

## User workflow

1. Select an asset in the library or select its existing canvas/editing source.
2. Add tags and write a plain-text note. Tags are trimmed and normalized to NFC
   before they enter a frozen save request. Tags are case-sensitive.
3. Save explicitly. There is no auto-save, provider call or cloud synchronization.
4. Clear only empties the draft; Save is still required to change saved metadata.
   Discard resets the draft to the latest verified record. Refresh rereads current
   metadata without replacing a dirty draft.
5. If another edit advances the independent annotation revision, the editor shows
   a conflict and retains the draft. It never automatically merges or rebases.
   Refresh and explicitly discard the old draft before editing the latest record.

The tag filter composes with the existing type, asset-name, favorite/rejected and
unused-media filters. It does not duplicate favorite/rejected as tags. Assets
whose annotations have not been verified remain visible under tag filters and
are marked unverified. Draft tag edits do not alter saved-tag filter results.
The selected editor remains available even when the selected asset is filtered out.
Only assets positively owned by the current project expose their annotation fields.
Restored workspaces permit reads but not annotation writes.

## Retention and recovery boundaries

Unsaved drafts are held in this mounted workbench window, across selection,
filter, mode and project navigation. They are not saved to disk. New draft
admission is bounded to 32 distinct dirty/saving/uncertain owners, counting the
union of current drafts and exact session-receipt asset owners, including
unloaded or deleted assets. Existing receipt overflow is retained, not silently
evicted; further new drafts are blocked. Clean metadata is retained only for the
current loaded asset set. A confirmed global discard can abandon local drafts,
including drafts for an asset that is no longer loaded, but cannot remove or
cancel an uncertain request.

Save uses the existing session receipt mechanism. Request ID, expected revision,
tags and note are saved as one exact input before dispatch. Task Center can
recover that same request. An uncertain outcome must not be re-keyed or replaced.
Recovery belongs to this browser window's session; cross-restart retention is not
guaranteed. A historical replay acknowledgment is not a current metadata read:
Task Center settlement triggers a fresh list read. A delayed acknowledgment also
cannot regress a newer annotation revision already read by the editor.

Annotation drafts and uncertain requests have an independent native-close source.
A changed draft invalidates an earlier close ticket, and an uncertain request
blocks close even if its asset is absent from the loaded list. This integration
never adds annotation changes to timeline undo or changes source ranges.

## Validation

Focused tests exercise the actual TSX editor and hook, four-locale catalogs,
StrictMode effect replay, hidden/collapsed/unmounted and old-selection handlers,
plain-text rendering, revision races, owner-scoped session uncertainty, strict
new-draft admission, original-request recovery boundaries and native-close
snapshot invalidation. Broader validation includes actual HTTP annotation
transport tests, schema/backup/replay tests and export-preview regressions.

No interactive native GUI, provider, or cloud-sync test is claimed by these
component and service checks. The implementation must be evaluated with the
recorded combined-checkpoint test and production build evidence.
