# Single-Look data pack v1

This pilot is a **declarative file format, not a plugin runtime, package manager,
archive, marketplace, or a camera/HDR transform system**. One `.mioon-look.cube`
file contains one bounded creative Look and the original Cube table. The whole
file remains an ordinary Cube accepted by the existing normalized 3D parser.
The new comment header is retained, not extracted into a mutable global catalog.

## Trust and scope

- Exactly one asset, with purpose `rec709-sdr-creative`, input `rec709-sdr`, output
  `rec709-sdr`, and profile `mioon-cube3d-normalized-tetrahedral-v1`.
- Rec.709 SDR is a **publisher declaration**, not measured input evidence or
  certification. It does not make arbitrary Log, HDR, sRGB, or unidentified
  footage eligible for the current SDR render path. Core source interpretation
  and clip colour checks still apply independently.
- The body SHA-256 proves correspondence to this manifest, not authenticity.
  Anyone able to replace a file can replace both the body and its declared hash.
- Publisher, provenance URL, and license text are unverified statements. A
  preview must display the license identifier/text and require the user's
  acknowledgement before the UI proceeds with import. Acknowledgement is not
  automatic license verification or a grant from the publisher.
- The provenance URL is inert display data. Inspection neither follows it nor
  requests permission to access it. Render metadata as plain text, not HTML.
- No scripts, operators, expressions, paths, remote resource locations,
  installation hooks, dependencies, executable entrypoints, or additional
  assets are defined. Unknown fields are errors at every object boundary.
- A file extension or detected marker is not proof of validity. Ordinary `.cube`
  files remain directly importable without adopting the pack format.

## Exact envelope

The first byte must be `#`, starting this exact first line:

```text
# MIOON_LOOK_PACK_V1
```

It is followed by one or more manifest comment lines. Each line begins with
exactly `# ` and carries a chunk of one JSON document. Strip only those first two
characters and concatenate the chunks **without inserting spaces or newlines**.
Chunks may split a JSON token or an escape sequence. Do not interpret Cube
comments as include directives or as additional objects.

The next delimiter is exactly:

```text
# MIOON_LOOK_PACK_END
```

The complete Cube body begins immediately after that delimiter's line ending.
The body's SHA-256 and byte count include every remaining byte: Cube titles,
directives, comments, spaces, line endings, numeric spelling and any final
newline. There is no trailing manifest, excluded checksum footer, canonicalized
body, or ignored tail. Valid ordinary Cube trailing comments can occur only as
part of this hashed body.

Both markers and all manifest lines require LF or CRLF terminators. Header LF
and CRLF are both accepted without rewriting. The existing Cube parser's line
ending rules apply to the body. A bare final CR is not a line ending. Missing,
repeated, indented, version-mismatched, or whitespace-suffixed markers fail.
The case-sensitive namespace `MIOON_LOOK_PACK` is reserved anywhere in the file;
finding it in any other location is not an ordinary-Cube fallback.

## Required manifest

All fields below are required. All objects reject unknown keys. There are no
arrays, optional executable hooks, or extension objects.

```json
{
  "schemaVersion": 1,
  "kind": "look-pack",
  "id": "mioon.synthetic-identity",
  "version": "1.0.0",
  "title": "Synthetic identity demonstration",
  "publisher": {
    "id": "mioon.synthetic-fixtures",
    "name": "Mioon synthetic test fixtures"
  },
  "provenance": {
    "url": "https://example.invalid/mioon/synthetic-identity"
  },
  "license": {
    "identifier": "LicenseRef-Mioon-Synthetic-Test",
    "text": "Original synthetic demonstration data. See the fixture for its complete permission statement."
  },
  "asset": {
    "id": "synthetic-identity",
    "purpose": "rec709-sdr-creative",
    "profile": "mioon-cube3d-normalized-tetrahedral-v1",
    "input": "rec709-sdr",
    "output": "rec709-sdr",
    "sha256": "<64 lowercase hexadecimal characters of the exact body SHA-256>",
    "sizeBytes": 1
  }
}
```

The illustrative hash and size above are placeholders, not an importable pack.
The checked-in examples contain real body digests and counts.

IDs are 1–80 characters, lowercase ASCII alphanumeric segments separated by one
`.` or `-`. They are logical labels, never filenames. Slashes, backslashes,
percent-encoded separators, absolute paths and `..` segments are rejected.
Version is three numeric components (at most five digits each, no leading zero
except zero itself), optionally followed by a lowercase alphanumeric prerelease
suffix separated by `.` or `-`, with at most 40 characters overall. It is not an
update request, version range, or resolver input.

Title is 1–120 printable ASCII characters. Publisher name is 1–120. License
identifier is 1–80 alphanumeric ASCII segments separated by `.`, `+`, or `-`.
License text is 1–2048 printable ASCII characters, additionally permitting
decoded LF represented as `\n` in JSON. Whitespace-only display fields fail.
Provenance is a 1–512-character printable ASCII HTTPS URL with a hostname, no
credentials, no whitespace and no backslashes. The URL is never fetched.

## Bounds and encoding

| Boundary | Limit |
| --- | --- |
| Complete original file, including all comments | 7 MiB (7,340,032 bytes), unchanged LUT resource limit |
| Decoded manifest comment payload before JSON parsing | 16 KiB ASCII characters/bytes |
| Manifest comment lines, excluding two markers | 128 |
| JSON object depth, root counted as one | 3 |
| JSON keys, summed across all objects | 64 |
| Decoded individual JSON string before schema limits | 4,096 characters |
| Every Cube/header line, excluding its line ending | 250 ASCII bytes |
| Non-data lines across the whole file | 4,096, including pack comments and Cube directives |
| Cube dimension | 2 through 65, exactly size³ rows |

The file must be strictly valid UTF-8 and also satisfy the existing Cube ASCII
profile. No BOM, non-ASCII file characters, NUL, bare CR, or hidden controls are
accepted. Manifest header lines are printable ASCII only, without raw tabs.
JSON escapes cannot be used to smuggle control, surrogate, or non-ASCII display
text into fields. The original Cube body's existing horizontal-tab rules remain
unchanged. Line, manifest-size and total-size checks happen before any full
manifest JSON parse. A bounded grammar pass then checks nesting, string length,
key count and duplicate keys, including escape-equivalent duplicates such as
`id` and `\u0069d`. Special prototype keys are explicitly forbidden.

No compression, archive extraction, directory traversal, file lookup, network,
subprocess, provider, or dynamic code loading exists in the parser. Input must
be actual non-shared `Uint8Array` bytes; filenames, URLs, arbitrary objects,
proxies, accessors, other typed-array formats and shared memory are not accepted
as substitutes. Own input bytes are copied once before asynchronous hashing so
subsequent caller mutation cannot change the result being verified.

## APIs and persistence

`packages/business/src/look-pack.ts` exposes browser-safe APIs:

- `isLookPackBytes(bytes): boolean`: bounded reserved-marker detection only.
  Malformed marker variants still classify as pack candidates. Invalid byte
  input and oversized input throw rather than trigger an ordinary-Cube fallback.
- `parseLookPackBytes(bytes): Promise<LookPackInspection>`: strict envelope,
  closed manifest, complete existing Cube parse, exact body size and WebCrypto
  SHA-256 verification. Missing WebCrypto is a deterministic failure, not a
  weaker hash fallback.
- `inspectLookPackBytes`: alias of strict parsing.
- `inspectLookPack(bytes): Promise<LookPackInspection | null>`: one-snapshot
  detection and parsing convenience. `null` means no reserved marker, not that
  the ordinary Cube was itself validated.

Inspection returns only frozen metadata: manifest, Cube metadata, total byte
count, `bodyIntegrity: verified`, `provenanceVerification: unverified`,
`colourCompatibility: unverified`, and `licenseAcknowledgementRequired: true`.
It returns neither bytes nor handles to external locations. Errors carry a
stable `LOOK_PACK_*` code and generic message without echoing source content.
There is no automatic repair, canonicalization, file access or mutation.

The existing `lut.import` still receives the **entire exact original file**.
Its content hash and stable request identity cover the manifest header and body
together. Its existing ownership, resource limits, immutable storage, atomic
receipts, retries, backup and restore semantics remain authoritative. A changed
pack version or comment changes the resource bytes/hash; it cannot silently
replace an existing immutable resource. Inspection is not application to a
clip, and import is not global installation, enabling, or colour certification.

The parser does not make legacy ordinary Cube comments newly executable or
retroactively change the admission semantics of `lut.import`. Pack-specific
declaration/acknowledgement is a separate opt-in UI and read-only inspection
layer. No schema migration, additional stored LUT representation, provider
registry, remote catalog, or downloader is introduced.

## Synthetic examples and tests

`examples/look-packs/synthetic-identity.mioon-look.cube` contains a 2³ identity
table. `synthetic-nonlinear.mioon-look.cube` contains a 3³ original synthetic table
with red `r²`, green `0.85g + 0.15g²`, and blue `0.9b + 0.1b²` at lattice points.
The examples are mathematical demonstrations, not third-party presets or
claims of a calibrated aesthetic. Both carry an explicit permission statement.
Their `example.invalid` provenance labels are deliberately non-resolving test
data. They are repository fixtures and are not imported into the application's
default bundle.

Run `node --test tests/look-pack.test.mjs`. Tests cover exact bytes, plain Cube
compatibility, duplicate/escaped JSON keys, malformed markers, forbidden fields
and paths, unknown profiles, bounds, non-ASCII/control rejection, body mutation,
LF/CRLF distinctions, complete Cube parsing, safe input snapshots, metadata-only
results, and independent synthetic sampling checks. Core LUT resource and
colour regression suites remain necessary for integration acceptance.

## Current Mioon flow

1. Open a video clip's Rec.709 SDR controls and choose “预览单 Look 数据包”.
   Reading and validating the selected file does not send an import or edit the
   timeline. The bounded preview displays the publisher, version, body hash,
   source and complete license text as inert text.
2. Explicitly acknowledge having reviewed the declared license and having the
   right to copy the Look into the current project. Choose “采用到项目 LUT”.
   This copies the **whole original file** using unchanged `lut.import` semantics.
   It does not select/apply a Look or save a clip.
3. Select the resulting project LUT, separately confirm the creative Rec.709
   purpose, add it to the draft, then use the ordinary Save Clip action. Existing
   source interpretation, strength/enable, undo/redo and rendering rules apply.
4. “查看此项目 LUT 的数据包声明” reads the saved resource, not the original file.
   The new shared read-only `lut.look.inspect` operation returns verified stored
   resource identity plus either `status: verified` and bounded declared pack
   metadata, or `status: not_pack` with `pack: null` for an ordinary Cube.
   Malformed reserved pack markers fail explicitly; no malformed-pack fallback.

Preview Cancel only discards the local preview. Once adoption is submitted, the
existing LUT original-request receipt and recovery flow own its outcome. A lost
reply never creates another request ID automatically. Same-origin reselect and
explicit replay remain supported; the pre-existing desktop cross-restart origin
limitation is unchanged and tracked in GitHub issue #2. No new persistence table,
receipt format, schema version, network permission, renderer profile, executable
runtime or bundled preset catalog is introduced by this slice.

Ordinary API/CLI/MCP `lut.import` remains a byte-preserving Cube resource intake;
it does not attest pack provenance or license acceptance. The new inspect
operation separately validates the pack envelope. Source and license declarations
survive source-file removal, project reopen and existing cold backup/restore
because they are included in the same immutable Cube BLOB. Existing restored
profiles 29/31 can inspect, but cannot import new LUT resources.

The examples in `examples/look-packs` are original synthetic test/demo data, not
film emulations or commercial presets. They are not included in the production
application bundle or automatically installed in a user's project.
