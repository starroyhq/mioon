# Dormant volume-envelope form foundation

This foundation is not mounted by App or TimelineInspector. It does not activate a capability, change local-draft schemas, save business state, perform media work, or provide a second persistence owner.

## API and integration gates

- `rawVolumeEnvelopeFields` projects numeric saved fields with exact `String(number)` conversion, preserving absence, null and value. `validateRawVolumeEnvelope` validates draft-only zero rows and incomplete numerals separately from lexical admission; only complete 1–16 point curves can become business values. `volumeEnvelopeChange` validates against the proposed duration even if the curve is unchanged, and returns an envelope-only patch for the caller's atomic duration merge. Clearing means null, never absence.
- `ClipVolumeEnvelopeControls` receives already admitted raw values and proposed duration. Its ordinary `onEdit` callback must synchronously retain accepted input in the existing form owner, even if durable writes are unavailable or aggregate admission fails. It owns no durable state and has no Save button. Parent callbacks must be bound to owner, input serial and current selection. Do not reuse a mounted editor for another owner while a composition is pending.
- Required `onCompositionChange` starts synchronously with `{pending:true,dirty:true,row,field,text}`. Updates retain transient IME DOM text, even when it is outside the ASCII lexical bounds. All row-changing buttons are guarded synchronously with the pending ref and disabled visually. The parent must treat pending as dirty and block Save, close, selection/project changes, restore, discard and owner replacement until composition ends or the platform cancels it. A mere focus/blur or component cleanup is not cancellation. No unmount notification falsely marks the transient text clean.
- Composition end makes one whole lexical decision, applies accepted input through `onEdit` or explicitly restores the prior value with localized rejection, then releases the pending guard. Platform cancellation ending with the original value is a no-op. There is intentionally no custom Escape handler: browser IME cancellation owns that event sequence, avoiding a premature guard release followed by stale native composition events. The parent must not intercept Escape as navigation while pending.
- The callback contract is NOT completed close/navigation integration, durable composition capture, or an owner/serial fence. Those remain integration gates. Pending transient input cannot be truthfully marked locally saved.
- Production sidecar compatibility, full request/response/disk size admission, retained-in-memory oversize status, native-close coordination, exact ACK matching and capability eligibility are intentionally unchanged and remain required before live wiring. Unsupported capability must not silently drop changed or recovered envelope values.

## Bounds and evidence

The ASCII field alphabet excludes quote, backslash and control characters. For 16 rows at frame length 8 and multiplier length 32, JSON serialization of the complete `{volumeEnvelope: ...}` field is exactly 1182 UTF-8 bytes: empty-envelope wrapper + 16 point objects + 15 commas. In a nonempty containing object its incremental cost is 1181 bytes (the wrapper's braces are not added).

All valid saved frames are integers 0–18000, so their decimal strings need at most 5 characters. IEEE-754 double shortest round-trip strings for nonnegative multipliers at most 1 fit comfortably inside 32 ASCII characters, including `5e-324`. Conversion does not localize or round for display. Deterministic tests cover extremes and 10,000 additional values; this sampling supplements, rather than replaces, the numeric representation bound.

Fixtures include all ten legacy numeric fields, a 200-control-character name, source IDs/hash, revisions, colour source and LUT look metadata, audio role and timestamp. With an ordinary publisher-style timestamp, the legacy slot is 5430 bytes and bounded envelope slot is 6611 bytes. Reusing the old 48-arbitrary-Unicode-character rule for all 32 envelope strings instead would yield 15187 bytes, over the unchanged 8192-byte row cap.

A distinct adversarial schema-valid legacy timestamp with an extended fractional part yields an existing slot of exactly 8192 bytes; the bounded envelope brings it to 9373 bytes. The current publisher does not generate these long timestamps. This demonstrates why a field-only bound cannot establish aggregate capacity for every schema-valid prior draft. Existing authoritative row 8192, HTTP 12288 and disk 2097152 caps remain unchanged. No claim is made that this component can persist envelope drafts under the current production schema; it cannot.

## Narrow checks

Use only the pinned absolute Node 24.21 executable for the focused test and scoped TypeScript project. The component tests run deterministic React hook/event-handler fixtures, not a browser or native IME. Actual platform IME sequencing, keyboard/focus/layout and close integration still require later authorized browser qualification before mounting the editor.

## Subsequent integration

The dormant state described above is the historical foundation checkpoint. The
accepted backend is now merged and the editor is wired through the existing
controller. See [integration qualification](VOLUME-ENVELOPE-EDITOR-INTEGRATION.md).
Composition notifications now include an opaque session, and composed onEdit
carries that same session; both rendered Controls handlers and the Inspector
adapter preserve its origin before controller owner/serial validation.
