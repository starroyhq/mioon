# Restricted JFIF JPEG SDR input

This opt-in increment adds one closed JPEG profile. It does **not** mean general
JPEG, camera JPEG, EXIF, ICC colour management, P3, Log or HDR support. The existing
PNG profile, video-v1 renderer, PNG-only mixed-v2 plan, Cube/Look-pack formats and
resource receipts retain their identities. See `MIXED-SDR-IMAGES.md` for the
unchanged PNG and display-referred alpha/composition policy.

## User flow and authority

Inspect the selected project-owned JPEG and explicitly declare that its decoded
RGB is to be interpreted as sRGB. JFIF identifies the encoding, **not** the original
RGB colour space; inspection therefore always returns `needs_interpretation`.
Confirming changes only the existing clip draft; Save Clip uses the existing
revision, request-replay and undo/redo path. Source replacement clears the saved
interpretation while retaining the creative Look, strength and enabled state.
Original source quick-view remains original, not the transformed timeline output.

`timeline.colour.jpeg.inspect` is a separate read-only operation, with
`localProcess: true`, no file writes, no external IO and no paid calls. Unlike the
process-free PNG operation, it runs one bounded strict software JPEG decode. The
original `timeline.colour.image.inspect` remains PNG-only. Neither operation
adds authority to the embedded generic Agent tool catalog.

## Admission is deliberately narrow

`jfif-ycbcr8-srgb-v1` admits one complete baseline sequential Huffman-coded 8-bit
JFIF 1.01/1.02 image, three Y/Cb/Cr components with IDs 1/2/3, and one interleaved
scan. Sampling is 4:4:4, 4:2:2 or 4:2:0. Chroma components are 1×1; Y is 1×1,
2×1 or 2×2. Densities must imply square pixels. The source is always opaque and
orientation 1. There is no automatic orientation or metadata stripping.

Limits remain 32 MiB source bytes, 4096 pixels per edge and 2,073,600 pixels total.
A cumulative 1 MiB framing/metadata budget also bounds marker fill and restarts.
The parser checks marker order and lengths, quantization and canonical Huffman
tables, every scan block's Huffman structure and coefficient ranges, per-component
DC predictor bounds, stuffed `FF00`, complete MCUs, all-ones padding, restart
interval/order/reset, unique EOI and no trailing bytes. It yields cooperatively
for cancellation. Structural validation is followed by a separate real decoder;
valid marker framing is never treated as sufficient decoded-image evidence.
After hash verification, strict admission and the real decode, metadata probing
explicitly selects `jpeg_pipe` with only `file,pipe` protocols. A valid JFIF may
autodetect as `image2`; that does not justify adding `image2` or filename-pattern
behavior to the generic whitelist. PNG and video probing remain unchanged.

All EXIF is rejected, including otherwise benign orientation 1. Orientations 2–8
are not silently rotated. ICC, XMP, MPF/multiple images, gain maps, Adobe APP14,
CMYK/YCCK, progressive/arithmetic/lossless JPEG, grayscale, thumbnails, comments,
unknown APP markers and trailing garbage are rejected. This intentionally also
rejects ordinary metadata-bearing photos. Export an explicitly sRGB baseline
JFIF without metadata first; do not infer compatibility from its filename.

The parser is not an OS decoder sandbox. It and the media runtime retain bounded
reads, hash/inode ownership checks, no-follow/nonblocking file access, cancellation
and exact-child lifecycle fencing. An unconfirmed child termination retains the
single-flight inspection permit until that actual child joins. Shutdown also
waits for a join installed after drain begins.

## Fixed decode and numerical boundary

`ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1` fixes the software MJPEG decoder,
integer IDCT, disabled CPU-specific acceleration, one thread, bit-exact flags,
strict bitstream/error options, no concealment and no implicit autorotation.
Inspection requires exactly one `width × height × 3` RGB24 frame within its
12-second decoder timeout (15-second overall inspection deadline).

JFIF YCbCr is **full-range BT.601**, not limited-range video or BT.709 YCbCr.
The conversion explicitly selects BT.601 full range, centred chroma positions,
bilinear chroma interpolation, accurate rounding and full chroma interpolation
before RGB24 quantization. These are a chosen reproducible implementation policy,
not a claim that every JPEG library uses the same chroma reconstruction. Version
or platform changes to the decoder still require numerical revalidation.

Only then does decoded RGB24 enter the existing
`srgb8-to-bt1886-zero-black-display-v1` table: sRGB EOTF followed by `L^(1/2.4)`,
unchanged Rec.709/D65 primaries and relative reference display black 0 / white 1.
The table remains 14,738 bytes, SHA-256
`383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c`.
Actual decoded sample 128 becomes 0.527924914041446 before output quantization.

The order is JPEG decode → RGB24 → fixed display transform → existing creative
Look → opaque alpha → existing premultiplied contain resize/compositor. JPEG has
no source alpha; transparent contain padding still belongs to the derived layer.
PNG alpha behavior is unchanged. Composition remains encoded RGB8, not linear
light; delivery remains Rec.709 limited-range yuv420p.

Numerical tests first inspect actual decoded RGB samples, independently compare
4:4:4 decoding against the full-range BT.601 formula, and then apply the transfer
oracle to **those decoded samples**. JPEG compression/chroma loss relative to an
original RGB fixture is reported separately and is not disguised as transfer
error. All three sampling modes exercise actual decode and staged RGBA output.

## Plans, staging, resources and history

JPEG clip identity is `mioon-jfif-image-clip-v1`; any visible JPEG selects
`mioon-mixed-sdr-render-v3`. Video-only plans remain v1 and PNG-only mixed plans
remain v2. JPEG evidence freezes source SHA/length/dimensions, sampling, opaque
alpha, orientation, user declaration and decoder policy. Snapshot and derived
staging keys include these identities. Original PNG staging keys and arguments
remain unchanged when no JPEG is present.

The cap is **two concurrently decoded managed image inputs in total**, PNG plus
JPEG together, not two of each. Clip edges split segments; hidden tracks do not
open sources and nonoverlapping clips do not consume simultaneous decoder slots.
Existing per-attempt staging pixel/byte limits and the 256 KiB complete timeline
JSON budget remain unchanged. All staging is attempt-owned, lossless and private;
it is not imported as a new asset or persisted as a proxy.

Ordinary schema 34 and restored schema 35 carry this generation. Closed schemas
32/33 remain PNG-only and reject JPEG semantics, including through restored clip
mutation gates. Restored31 allows only prior video colour, restored33 video/PNG,
and restored35 video/PNG/JPEG. Restored35 can read retained Cube and Look resources,
apply origin-bound local timeline edits and render explicitly acknowledged saved
semantics. It cannot inspect new sources or import new resources; captured queued
exports do not gain execution authority during restore.

## Verification and limits

See `JFIF-SDR-IMAGES-ACCEPTANCE.md` for evidence and exact verified scope. Linux
backend, transport and native UI results are separate from other-platform claims.
No new runtime dependency, ICC engine, model, preset pack or arbitrary script
interface is added. Existing issues #1 (stopped investigation), #2 (cross-restart
intake) and #3 (packaged exit) are not fixed or re-investigated.

Primary format references: [JFIF 1.02](https://www.w3.org/Graphics/JPEG/jfif3.pdf),
[ITU-T T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf), and the
[FFmpeg scale filter](https://ffmpeg.org/ffmpeg-filters.html#scale-1).
