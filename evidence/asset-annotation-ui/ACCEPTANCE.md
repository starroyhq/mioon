# Asset annotation UI combined checkpoint

## Source and scope

- Export preview parent: `5a3751b234f17f9f70cd4fff09acc8d989130d52`.
- Annotation backend parent: `fc40d809ad1643aef4d7a4fa8852f538549568ce`.
- Real, unsquashed merge: `bdc732539ba94a73cc0771f4a96f7608de837cb7`.
- Final application/test source manifest: `final-source-sha256.txt`, 1,501 files.
- Manifest SHA-256: `c20d3778990fa2ebdd9fa5b82e6ede804de2bbbcde3b12ed5860e18af95edd77`.
- Runtime used: existing pinned Node v24.21.0, reviewed existing dependencies copied locally; no dependency installation, network fetch, lockfile change or provider call.

Implemented project-owned tags/plain-text notes, composed saved-tag filtering,
four-locale presentation, bounded retained drafts, exact session request replay,
explicit stale conflict treatment and independent native-close protection.
Source ranges, timeline undo and backend annotation contracts are unchanged by
this frontend slice. Existing export-preview source ancestry is preserved.

## Independent review

Final source/test review cleared all identified blockers on 2026-10-15 at
19:29 UTC. The reviewer independently verified every manifest entry with
`sha256sum -c`, exit 0, and accepted the narrow fixture updates below. This is a
source review, not a claim of interactive GUI or native runtime validation.

Focused regression coverage includes delayed ACK versus newer read, actual hook
StrictMode cleanup/setup, original-workspace uncertainty after navigation,
missing/deleted-asset pending receipts, exact union admission cap, stale native
close commit rejection, unchanged-read close identity, immutable repeated-save
intent, four-locale actual TSX, hidden/old-selection handlers, actual library
filter composition and actual App exact-request replay.

## Discovery run and corrective fixture changes

The initial deduplicated 53-file run completed **691 tests: 679 passed, 12 failed,
0 skipped**, in 570,765 ms. Its complete failed output is retained in
`discovery-failed.log`; it is not presented as a pass.

The 12 failures were stale fixtures. No production business change was made to
make these tests pass:

- Disposition discovery expected 11 local mutation operations, actual 12 after
  explicitly adding `asset.annotation.set`.
- The existing AssetLibrary harness did not provide the new annotation module.
  It now imports the actual annotation helpers; original assertions remain.
- Two CLI help checks omitted the two explicitly added annotation operation
  names. Expected additions are inserted after `asset.disposition.set` while
  preserving frozen legacy bytes, order and prose; the baseline is not rewritten.
- Four extracted Inspector close continuations lacked the existing `msg`
  descriptor binding after prior localization. Their real control flow and all
  close-safety assertions remain intact.
- Three auto-current backup/readiness fixtures expected ordinary schema 26 or
  32, while `openStore` now correctly produces 36. Only those auto-current
  expectations change. Pinned historical 32/34 to restored 33/35 fixtures remain
  untouched. The current cold restore remains ordinary 36 to restored 37.
- One unknown-marker negative fixture used 28, now a supported ordinary marker;
  its refusal reached database-invalid rather than the old unsupported IO code.
  The negative fixture now uses explicitly unsupported 999, preserving its
  original refusal/code and byte-preservation assertions.

Separately, the existing native-close source harness initially had eight import
failures after earlier localization. It now supplies the existing i18n,
creation-format and Comfy helpers without modifying Agent/Image production
code. All 15 source tests pass. The affected legacy-close/topbar group passes
34/34, including the new annotation-aware topbar status assertion. These focused
counts overlap the final run and are not added to its total.

## Final gates

The final frozen-source deduplicated run passed **711/711 tests**, 0 failures,
0 skipped, in 575,266.816 ms. It used 54 unique files
(`final-regression-files.txt`), including the original 53-file affected set and
topbar status coverage. Full output: `final-regression.log`.

Production-channel source build passed with pinned Node v24.21.0:
`node scripts/tooling.mjs build --channel=production`. This runs the foundation
and browser typechecks, Vite build and desktop staging build. Full output:
`production-build.log`. The initial space-separated `--channel production`
invocation failed argument validation before building; its output is preserved
in `build-option-failed.log`.

Artifact identity is `app.starroy.mioon`, channel `production`, product `Mioon`,
application version 0.4.1. Staging is `apps/desktop/build`, with bundled shared
backend and the same built web UI, no node_modules or data directories. Exact
staging file hashes are recorded in `production-staging-sha256.txt`. Expected
upstream bundle warnings (ignored use-client directives and large chunks) do
not represent a failed build.

After building, all 1,501 frozen source entries verified again (exit 0;
`source-verification.log`) and `git diff --check` passed. Source review remains
bound to the same manifest. No source or test fixture changed after the freeze.

No interactive native GUI, AT-SPI, macOS, paid provider, signing, distribution
package installation, push or publication was attempted. Component rendering
and actual service/HTTP/CLI/MCP verification must not be described as visual GUI
validation or a release qualification.
