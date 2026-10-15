# Dormant envelope expression compiler

This is pure preparation, not shipped processing support. The candidate module
has no package export and no production import. Existing contracts, filters,
consumers, source admission, workspace profiles and UI are unchanged.

`compileVolumeEnvelopeFilterCandidate(clip, offsetSamples, sampleCount)` reuses
the existing pure envelope validation/detached copy helper. Its intended inputs
are bounded ordinary data, not arbitrary adversarial proxies. The output is one
fixed `aeval=exprs=val(ch)*(…):c=same` stage, or the exact empty string for absent
or null envelopes. No separator is returned. Numeric inputs alone are serialized;
profile names, labels, strings and arbitrary graph fragments are never inserted.
Expression commas are escaped once for a filtergraph argument, not for a shell.
A future caller must pass the resulting graph as an argument, not add shell
interpretation. This helper neither accepts nor escapes caller graph text.

All coordinates are integer 48 kHz samples, with exactly 1600 samples per frame.
The supplied positive half-open input range must fit the original clip duration;
offset zero is valid but negative zero is rejected. The expression uses `n+offset`
throughout, never segment-local n alone or timestamps. First/last values hold
outside their anchors. Strict below-right interval selection preserves exact
anchors; interpolation grouping matches the pure numeric evaluator. The count
is validated but not encoded as an extra trim: eventual callers must supply and
verify that actual input count, rate and layout.

## Conservative serialized bound

The cap is 4096 bytes for the entire escaped ASCII stage, which is stricter than
an expression-only cap. With at most 16 points there are at most 15 interval
clauses. Each clause contains three multiplier literals (<=32 ASCII characters
per finite binary64 shortest decimal), two `(n+offset)` terms (<=12 each), three
sample-coordinate/delta literals (<=8 each), and <=27 fixed syntax characters
including graph comma escapes. This is <=171 bytes per interval. A conservative
192-byte reservation covers the initial hold, final constant and complete stage
wrapper. Therefore the complete emitted stage is <=2757 bytes, below 4096.
The compiler additionally measures UTF-8 bytes and rejects a cap violation.
Tests exercise maximal point counts, eight-digit positions and long/tiny decimal
literals; they do not mistake one observed fixture for the general bound.
No global cap is enlarged. This is not proof of FFmpeg stack, CPU or memory cost.

## Planned integration only

Do not import this helper into active DSP until the coherent processing rollout
is reviewed. Keep the old path verbatim for absent/null. For non-null envelopes,
the proposed location is after existing scalar gain, pad/trim and clip-local
fades, before mixing and the final timestamp reset. Separate planned fences are
fltp/48000/stereo, then dblp/48000/stereo, then aeval, then fltp/48000/stereo.
The first fence protects upstream fade precision; the last protects mixer
precision. These fences are not emitted here and their actual negotiation has
not been verified. Multiplying existing fades by an envelope is not equivalent
to interpolating the product of their endpoints.

The official aeval documentation describes sample index n and val(ch), while
upstream source requires planar double and initializes n at zero:
https://ffmpeg.org/ffmpeg-filters.html#aeval
https://ffmpeg.org/doxygen/trunk/aeval_8c_source.html
Neither is evidence of the installed binary's filter availability or behavior.

Pure tests use a separate restricted grammar parser/interpreter, not arbitrary
JavaScript eval. They check compiler grammar, escaping and numerical intent only.
They do not run FFmpeg and do not prove installed parser acceptance, resampling,
format negotiation, per-sample execution, channel behavior or audio equivalence.
Installed-filter and short media/PCM comparison gates remain unresolved, as do
coherent render/continuous/both-analysis rollout, actual-source eligibility,
legacy audition refusal, budgets and feature activation. No media process or
long acceptance run is part of this slice.
