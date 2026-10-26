# Bounded 3D Cube parser and numeric reference

Status: independent, unintegrated dependency candidate. **This is not complete LUT support.**
Base: accepted `f8b91713af0c8ed3994e32fa57447827a0ab3883`. This slice does not change the pending loudness candidate or its acceptance status.

## Purpose and boundary

`packages/business/src/cube-lut.ts` parses supplied text, produces immutable semantic metadata, serializes canonical text, and evaluates a normalized RGB triplet with a fixed interpolation/strength contract. It imports nothing and has no filesystem, network, process, URL-loading, renderer or storage capability. A path or URL string is merely invalid input text, not an instruction to load a resource.

The parser does **not** identify a LUT's intended input/output colour space. A normalized table, its filename, its title and even an identity table do not prove SDR compatibility or distinguish a look from a Log/HDR conversion. The reference operates on the caller's numeric RGB code values without transfer-function or primaries conversion. Future integration must establish input eligibility separately; this parser cannot grant it.

## Restricted format profile

Profile identity: `mioon-cube3d-normalized-tetrahedral-v1`. The restrictions below are intentional admission decisions, not claims that other Cube files are invalid under the broader specification.

- Source: a JavaScript string containing at most 32 MiB of ASCII text. Accepted characters are tab, printable ASCII, LF and CRLF. Lone CR, BOM, NUL, other controls, Unicode and invalid surrogates are rejected. For accepted text, UTF-8 byte count equals string length. A future byte loader must enforce the cap before decoding, decode strictly, and not silently replace or strip invalid bytes.
- Lines: at most 250 content bytes, excluding LF/CRLF. At most 4,096 non-data lines total, counting headers, blanks and whole-line comments. A final line need not end with LF. Mixed LF/CRLF, whitespace-only lines and indented whole-line comments are accepted explicit compatibility extensions. Inline comments are not accepted.
- Exactly one uppercase `LUT_3D_SIZE N`, with decimal integer spelling, no sign/leading zero/fraction/exponent, and `2 <= N <= 65`. Exactly `N^3` RGB data rows must follow. Nothing is padded, truncated, resampled, inferred or ignored to meet the count.
- Optional `TITLE`, `DOMAIN_MIN`, `DOMAIN_MAX`, each at most once, in any header order before the first data row. Titles must use literal double-quote delimiters, with printable ASCII content excluding double quotes. No escape syntax or embedded tab. Empty title is distinct from omitted title; inner spaces, `#` and backslashes are preserved.
- Domains must be omitted or exactly `(0,0,0)` and `(1,1,1)` after numeric parsing. Other domains, reversed/equal domains and per-channel remapping are not supported. Output samples must also be within `[0,1]`; legal general-Cube negative or super-white samples are deliberately rejected in this slice.
- Each row has exactly three complete decimal tokens, at most 64 characters per token. Signed decimals, fractional-only decimals and scientific notation are allowed. Hex, separators, suffixes, NaN/Infinity, overflow and nonzero-to-zero underflow are rejected. Values are parsed as JavaScript binary64 numbers, not arbitrary-precision decimals; signed zero is canonicalized to positive zero. Finite representable subnormals are permitted.
- Every unknown directive is rejected. In particular, 1D tables, mixed 1D+3D/shaper files, input-range extensions, includes, colour-space directives and vendor keywords cannot be silently discarded.

The source-length and table-size bounds are checked before table allocation; later line, row and non-data bounds are enforced while scanning. The largest retained sample table is `65^3 * 3 * 8 = 6,591,000` bytes per handle, plus the small handle/metadata. Parsing scans bounded lines rather than splitting the entire source. Canonical serialization additionally allocates row strings and the output string. These are explicit bounds, not a benchmark or a zero-copy claim. A future loader still needs cancellation/scheduling/concurrency controls; this synchronous pure reference provides none.

## API and deterministic representation

- `parseCube3D(text): Cube3D` returns a frozen opaque handle with frozen `metadata`. Its private float64 storage is never exposed. Malformed input throws a generic error carrying a fixed `code` and a one-based `line`, or `null` for source-level/final-count errors. Diagnostics never echo untrusted text.
- Metadata records profile ID, size, literal title/null, fixed domain endpoints, row count, red-fastest order, tetrahedral interpolation and float64 precision. It intentionally contains no path, filename, URL, time, ownership, colour-space guess or source byte count.
- `canonicalCube3D(handle): string` emits optional title, size, explicit domain minimum, explicit domain maximum and rows, in that order; one ASCII space separates tokens and each line ends in LF. Numbers use the standard JavaScript shortest round-trip decimal spelling. Comments and lexical spelling are discarded, not semantic title/sample changes. Reparse/reserialize is idempotent. The maximum serialized numeric width and 65-edge cap keep canonical output below the 32 MiB input cap.
- `sampleCube3D(handle, [r,g,b], strength = 1): readonly [number,number,number]` returns a new frozen triplet. Inputs must be a length-three array with three own data properties containing finite numbers within `[0,1]`, and strength must be finite within `[0,1]`. Coordinate accessors/inherited values are rejected without invoking getters; caller array methods and iterators are never used. Values are snapshotted once before calculation. There is no string coercion, clamping of invalid inputs, extrapolation or alpha channel. This API is not an in-process JavaScript sandbox: malicious Proxy reflection traps or modified global built-ins are outside its input-data threat model.
- Only handles created by this module instance are accepted. Forged objects, JSON clones and handles from another module instance must be reparsed from canonical text. Handles are not a durable persistence or IPC representation. Canonical text is not a cryptographic digest or an authorization/ownership proof; later resource identity must bind the chosen profile and owned content with an appropriate digest.

## Numeric contract

Rows use index `r + N*g + N*N*b`: red changes fastest. Each normalized input coordinate is scaled by `N-1`. The last face uses the last valid cell and fraction one, so no lookup can reach index `N`.

Each cell is split into six tetrahedra around its low-low-low to high-high-high diagonal. Sort local fractions descending as `a >= b >= c`, breaking equal fractions in red, green, blue order. Use four vertices: all-low; advance the largest-fraction axis; also advance the middle-fraction axis; all-high. Their weights are `(1-a, a-b, b-c, c)`. Evaluate the four terms in this order with binary64 arithmetic, per output channel. A final `[0,1]` clamp removes numerical roundoff only; all admitted sample values already lie in that range. This is deliberately **not trilinear interpolation**.

Strength blends the original code-value triplet with the evaluated triplet, component by component: `input*(1-strength) + mapped*strength`. It does not interpolate coordinates before lookup, apply a gamma transform or perform a linear-light blend. Zero returns an exact copied input triplet, including signed zero; one returns the mapped value directly. Invalid handles, RGB and strength are still rejected when strength is zero. Intermediate strengths also clamp arithmetic roundoff to `[0,1]`.

This is a deterministic CPU reference contract, not proof of GPU/FFmpeg parity or cross-renderer bitwise equality. A future renderer must pin compatible interpolation, stage ordering, format/range conversion, strength semantics and tolerances and compare actual rendered frames against independent oracles.

## Tests and verification

`tests/cube-lut.test.ts` covers literal identity/channel-swap tables; grids of several sizes; all six tetrahedra with independently hand-calculated equal and unequal weights; an analytic min-channel oracle that differs from trilinear interpolation; cell/tie/top-face boundaries; exact strength zero, half and one; immutable handles; canonical round trips; malformed headers/rows/numbers/domains/encoding; every bound; maximum 65-edge tables; and the no-I/O module boundary. Numeric expectations do not call the production indexing or interpolation implementation to construct their expected values.

`tests/typecheck/cube-lut.consumer.mts` checks exact/non-any types and intentional negative cases for opacity, readonly metadata/output, fixed interpolation and no path-loading API. Its isolated ES2022-only configuration requires no Node or browser globals. The repository's existing foundation include already admits the new runtime `.ts` file automatically. No new application JavaScript, gate allowlist change, package-barrel export or dependency is introduced.

Focused verification commands (run serially in an available test lane):

1. Run `node --test --test-concurrency=1 tests/cube-lut.test.ts` with the repository's Node24 runtime.
2. Run the exact pinned TypeScript compiler against `tests/typecheck/tsconfig.cube-lut.json` with `--noEmit`; do not install, substitute or bypass dependency policy.
3. Run the existing no-new-JavaScript source guard and the full standard typecheck when a dependency-equipped integration checkout is available.

Verification on 2026-10-14 after the independent test lane was released: all **21/21** runtime tests passed, zero failures/cancellations/skips, 3,310.93 ms; the isolated strict ES2022-only typecheck exited **0**; and the existing no-new-JavaScript source guard passed. Runtime was Node **24.21.0**. TypeScript **6.0.3** came from the existing repository installation, validated by its unchanged `installedTypeScript` helper; the compiler checked this separate worktree's source, with no dependency install or replacement. The new leaf and tests were unchanged after these passes; only this verification paragraph was updated.

An independent parent runtime repeat also passed **21/21**, zero failures/cancellations/skips, in 2,886.89 ms against the same leaf and tests.

The full standard two-project typecheck and full application suite were **not run for this slice**. Neither was an app build, GUI/native acceptance or actual rendered-pixel comparison. Those remain integration gates, not implied by these focused passes. The earlier loudness investigation was not rerun or modified.

## Remaining work before any LUT feature claim

Project-owned resource import, bounded strict byte reading, digest identity, backup/restore and deletion lifecycle; project/clip settings and durable edit/replay rules; frozen render-snapshot identity; explicit SDR input admission and colour handling; UI import/enable/strength/recovery flows; preview/export implementation and measured parity; Linux/native/package regression and other platform acceptance. A LUT resource must never be registered as playable media. No generic effects framework, app integration, schema migration, backup change, live provider call or desktop access is part of this candidate.

## Primary references checked 2026-10-14

- Adobe-authored [Cube LUT Specification 1.0](https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf), sections 4–8, supplies the decimal/text/header conventions, table layout and tetrahedral recommendation. This is a mirror of the primary document, not an official Adobe host. The historical [Adobe download URL](https://wwwimages2.adobe.com/content/dam/acom/en/products/speedgrade/cc/pdfs/cube-lut-specification-1.0.pdf) was unavailable to the research tool. The restricted bounds and normalized-only policy above are Mioon decisions.
- Official Academy Software Foundation OpenColorIO [Iridas Cube reader](https://raw.githubusercontent.com/AcademySoftwareFoundation/OpenColorIO/main/src/OpenColorIO/fileformats/FileFormatIridasCube.cpp) and [3D LUT CPU implementation](https://raw.githubusercontent.com/AcademySoftwareFoundation/OpenColorIO/main/src/OpenColorIO/ops/lut3d/Lut3DOpCPU.cpp) were consulted as a primary implementation cross-check. This implementation does not copy their parser, runtime dependency, alternative layout, permissive input handling or floating-point policy.
