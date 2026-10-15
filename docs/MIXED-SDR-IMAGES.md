# Mixed SDR static PNG profile

This increment is opt-in. Existing unadopted image/video timelines keep their
historical renderer. Existing managed-video source, clip and render-v1 schemas
remain closed and retain their original graph and scaling. It is **not** HDR,
Log, linear-light composition, general ICC colour management or JPEG support.

## User flow

Select an image clip, open the existing Rec.709 SDR controls, inspect its current
project-owned source, and explicitly declare sRGB. An absent sRGB tag is reported
as unknown until that declaration; even a tag does not automatically enable the
profile. Confirming changes the existing clip draft, not the saved timeline.
Use Save Clip to submit through the existing revision/request/history path.
Preview and export consume the same frozen plan. Source quick-view stays original.
Every visible video/image in an adopted timeline must have a compatible explicit
interpretation. At most **two managed PNG inputs** may be open in one composition
segment. Because segments split at every clip edge, nonoverlapping images may
share the timeline; three overlapping visible PNGs produce an actionable blocked
preflight/render error. Hidden images do not open decoders. This does not change
legacy image or video concurrency limits. Replacing a source clears that interpretation but retains the
creative Look, enabled state and strength, and blocks rendering until reconfirmed.
Undo/redo preserves the exact old/new source evidence and existing Look binding.
The complete timeline retains its existing 256 KiB JSON ceiling. Image evidence
counts toward that total: an over-budget edit is rejected before writes, with
an actionable request to shorten names/subtitles or reduce clips. It cannot
create a history entry/receipt or silently enlarge historical reader budgets.

## Narrow source admission

`png-rgb8-srgb-v1` admits only static, non-interlaced RGB8/RGBA8 PNG. Dimensions,
alpha convention, orientation 1 and colour-tag status are frozen with exact
source SHA-256 and byte length. Parsing validates CRCs, ordering, one complete
zlib stream, scanline length and every filter byte. It keeps only bounded inflate
chunks, not a decoded pixel plane. The original file is never stripped or rewritten.

Limits: 32 MiB source bytes, 4096 pixels on either edge, **2,073,600 total pixels**,
1 MiB non-IDAT chunk bytes and 4096 chunks. These are additional managed-colour
admission limits; ordinary import and AI-image validators are unchanged.

Only IHDR/IDAT/IEND and sRGB, canonical gAMA (45455), canonical sRGB/D65 cHRM
are admitted. Conflicts, ICC/P3/cICP/HDR/gain-map declarations, APNG, palette,
16-bit, transparency keys and all other unknown chunks are rejected. This also
rejects benign text, pHYs, time and EXIF rather than trying to infer which metadata
is harmless. JPEG/CMYK/EXIF orientation are deliberately deferred.

## Display-referred conversion and alpha

Ordinary sRGB artwork is output-referred. The versioned default is
`srgb8-to-bt1886-zero-black-display-v1`: sRGB EOTF followed by `L^(1/2.4)` at
unchanged Rec.709 primaries and D65. The reference display has relative black 0,
white 1 and gamma 2.4. This is neither BT.709 source OETF conversion nor a promise
about any physical monitor, ambient light, actual black level or peak luminance.
For example, input `128/255` becomes `0.527924914041446` before quantization.

The built-in fixed 256-entry RGB table is canonical, 14,738 bytes, SHA-256
`383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c`.
It is trusted implementation data, not a newly accepted arbitrary LUT format.
The mixed-v2 plan freezes the source evidence, interpretation, transform version,
reference-display policy, table algorithm/SHA, alpha policy and resize profile.
Existing Cube and Look-pack profiles and receipts are unchanged.

The order is straight RGB conversion, existing creative LUT, premultiply,
explicit bilinear mirrored-edge contain resize, then premultiplied overlay.
Alpha never enters the transfer table or creative LUT. Hidden RGB at alpha 0
cannot bleed through scaling. Whole alpha is exact when not scaled. Integer
contain geometry is floored with a minimum of one pixel; transparent padding is
part of the derived layer. Old video resizing is not changed.

Composition still uses **encoded RGB8**, not linear light or HDR. Output remains
the existing Rec.709 limited-range yuv420p delivery. Those output transfer tags do
not encode or substitute for the frozen relative reference-display policy.

## Bounded execution and persistence

Each exact source/look/geometry combination is evaluated once per render attempt
into a private lossless premultiplied RGBA8 PNG. This internal container is not an
ordinary straight-alpha source and is never imported or persisted as a proxy.
Cache/dedup identity includes exact source SHA, all transform/profile/table and
alpha/resize identities, source/output dimensions, canonical Look binding and
actual staged Look SHA. Per-frame work only decodes/loops and overlays it.

Derivation is sequential, one frame, one thread, 20-second timeout per layer;
maximum 100 input layers, 2,073,600 pixels per output, 32 million unique output
pixels, 9 MiB per derived file and 128 MiB total staged image/table bytes. Source
files and stages retain hash/inode checks, no-follow/nonblocking reads, lifecycle
fences and cancellation. Unknown replacements are preserved. Unconfirmed process
termination retains owned staging until the actual child join; it is not deleted
under a process that could still be using it.

The 2,073,600-pixel source cap follows measured bounds, not the earlier nominal
16 MP ceiling: a 1920×1080 RGBA source plus a 33³ Look to 1280×720 completed in
2.924 seconds at 259.47 MiB peak RSS in the isolated probe. The 4096×3906 case
failed safely under a 1 GiB address-space limit with no output. These are current
Linux measurements, not cross-platform performance guarantees. The final bounded
65³-LUT probe passed twelve sequential derives at a maximum of 270.51 MiB RSS
and 2.271 seconds per child. Two simultaneous 720p derived inputs passed at
202.06 MiB RSS. Twelve inputs exceeded a 512 MiB RSS watchdog under a 2 GiB
virtual-address limit, and their partial output was rejected and cleaned.
The earlier 1 GiB virtual-space thread failures alone were not treated as proof
of physical-memory exhaustion. No optimization or limit increase was attempted;
these results justify the conservative two-PNG segment limit.

Ordinary schema 32 and restored schema 33 introduce this generation. Schema
implementations 24–31 and historical constructor identities are unchanged; their
colour validators reject image/mixed branches. Restored 33 can read and execute
its bounded saved semantics, but new source inspection and LUT import remain
blocked. New inspection is a separate, read-only `timeline.colour.image.inspect`
operation using bounded local parsing without a process or external IO. No new
embedded-agent tool authority, dependency, runtime, arbitrary script or provider
call is introduced.

## Acceptance and known limits

See `MIXED-SDR-IMAGES-ACCEPTANCE.md` for final verified evidence. Source tests
cover admission/CRC/bombs, exact table and alpha math, staged-file tamper and
cancellation, actual mixed video/PNG/subtitle preview/export, request replay,
source replacement, undo/redo, cold reopen and schema32→33 backup restoration.
Native Linux UI acceptance is separate from numerical and business-layer proof.

JPEG, ICC/P3, Log/HDR, linear composition and native Mac/Windows remain outside
this slice. Existing issues #1 (stopped investigation), #2 (desktop cross-restart
intake recovery) and #3 (unknown packaged exit) are not fixed or re-investigated.
