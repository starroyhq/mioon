# Saved clip loudness UI verification

This evidence belongs to the runtime source inventory in `sources.json` and the
production staging hashes in `manifest.json`. The source tree hash is a custom
path-sorted SHA-256 inventory root, not a Git commit or Git tree ID.

- `affected-ui.txt`: final 337/337 pass, using exactly the 26 nonmedia files in
  `affected-files.txt`.
- `pure-gates.txt`: final 12/12 pass for the positive pure repair filter documented
  in `tests/fixtures/timeline-mix-loudness/README.md`; no subprocess/media bodies.
- `production-build.txt`: the documented `node scripts/tooling.mjs build
  --channel=production` command, successful foundation/browser checks, web build
  and desktop staging. Standard Base UI directive and large-chunk warnings remain.
- `initial-ui-red.txt`: first UI run, 24/25. The test mistakenly matched the word
  `disabled` inside Tailwind CSS classes; it now checks the actual HTML attribute.
- `baseline-fades-red.txt`: the pre-existing raw `Offline` copy expectation failed
  on unchanged 7115279. The final test checks the exact existing localized
  recovery notice, rejects raw error leakage, and keeps draft/error/no-retry
  assertions. No recovery production behavior changed.

An early localization audit also found the literal LUFS unit in the new JSX;
it was moved into the four-locale catalog before final validation. Initial
source-only key-order matching was repaired by retaining the existing inspector
key prop ordering. These were not runtime/media defects.

The independent reviewer separately passed the focused 25/25 UI cases and checked
all 693 runtime/build-source hashes plus 53 staging artifact hashes. Component
and hook tests use SSR/harnesses, not native GUI or an actually mounted React
StrictMode tree. The feature has no claimed installer, GUI, macOS, live-provider,
full-suite or long-playback acceptance. No 60/600-second media qualification ran
in this frontend task. Backend scope remains whole saved clips up to 60 seconds;
the unsuccessful 600-second experiment remains in its separate archive.
