# Historical audio extraction proof

`renderer-extraction-0343ed3.json` contains the exact UTF-8 source from
`git show 0343ed390a85c319210b5f179180cf9c8c3985c2:packages/business/src/timeline-media.mjs`.
The source field (not JSON serialization) has SHA-256
`4b5f850dfc388d972ab42decfff5f76b5951315b16ab73902a7dcaec411fae37`.

The existing four exact reverse-extractions reconstruct
`b9e7d1e57a687010407ae284cb55c0d4eed23abb:packages/business/src/timeline-media.mjs`,
SHA-256 `c1586a7dc67f2e0c44ff5a4cc97262e71181f258a0fc66646fc5bac83e25fa95`.
These hashes remain pinned in the test independently of fixture metadata.
The fixture is data, never imported or executed.

The live renderer legitimately changed in accepted commits `16b7b4d` (SDR LUT),
`93a0575` (PNG) and `75ad276` (JPEG). Applying only the old four audio reversals
cannot erase those additions. This historical proof therefore does not claim
that today's whole renderer or argv is identical to b9e7d1e.

The separate current-source test pins its four exact audio integration sites
and the unchanged audio-only module `timeline-audio-filter-graph.ts` from
0343ed3, SHA-256 `7701c38b8b2001da046d4801bb981607cbedf24635e489acdfc776cf477c5779`.
Existing pure filter-literal and typed fade-extraction tests remain intact.
This is not a substitute for media/colour runtime qualification.

## Bounded repair validation

From clean merge base `a64c931c9ddf3d34993420c55e2a709584db9f15`, the following
positive filter runs only the pure bodies relevant to these gate repairs:

```sh
node --test --test-name-pattern='^(legacy chunk|continuous UTF-8|actual full shared|every inventoried|inspection arguments|every shared operation|shared subject operations|Comfy remote operations|shared filter literals|historical 0343ed3|current renderer|typed fade extraction)' tests/transport-utf8-output.test.mjs tests/inspection-contracts.test.mjs tests/timeline-mix-loudness-decoder.test.mjs
```

On 2026-10-15 the corrected repair passed all 12 selected tests. An initial
current-wiring assertion used an incorrect source literal and failed; the
assertion was corrected to the actual audio integration site before this pass.
No media/native GUI or CLI/MCP subprocess test bodies were run. This is not
whole-suite clearance. Workspace dependencies resolved to this repair worktree.
