# Local volume-envelope draft compatibility

The companion pathname remains `local-drafts-v1.json`. Its filename is not its
format discriminator. The embedded `version` is strictly either 1 or 2.

- Version 1 retains the frozen legacy raw-field whitelist. `volumeEnvelope`,
  including `null`, is not legal in a version 1 row.
- Version 2 admits the same legacy fields plus optional `volumeEnvelope`.
  Absence and explicit `null` remain distinct. A non-null envelope has exactly
  `profileId: "mioon-clip-linear-attenuation-v1"` and `points`, with zero to 16
  strict `{frame, multiplier}` records. Both values are raw strings containing
  only ASCII `[0-9eE+.-]`, bounded to 8 and 32 characters respectively. Empty,
  incomplete, out-of-order and otherwise business-invalid editing input is
  recoverable; this is not permission to apply it to the business timeline.
- Reading either known version never rewrites or migrates the file. Missing
  storage is distinct from corrupt, unknown-version, unknown-field or unsafe
  storage. Invalid storage remains visible as unavailable and is never reset.
- A successful explicit PUT containing an envelope field, including null,
  atomically promotes the complete companion to version 2. Unrelated rows,
  revision counters and tombstones remain intact. A rejected or pre-publication
  failed PUT does not promote. Post-publication uncertainty follows the existing
  exact replay and mandatory durability-checkpoint rules.
- Legacy-only PUTs remain version 1 until promotion. Version 2 never downgrades,
  including after envelope removal or deletion of the last live draft.
- Existing strict version 1 readers reject version 2 before mutation. They cannot
  read the companion as empty or overwrite it with a legacy-only record.
- Service object admission permits an array only at the exact
  `raw.volumeEnvelope.points` path. It checks the ordinary array prototype,
  bounded dense own index descriptors, no extra/symbol properties, no getters,
  and no proxies before schema parsing. Arrays elsewhere remain invalid.
- Limits stay 8,192 bytes per serialized complete slot, 12,288 bytes per HTTP
  request, 2,097,152 bytes for the companion, and 128 slots including tombstones.
  Envelope field limits do not imply that every combined raw form fits a slot.

## Fresh regression evidence

`tests/local-drafts-volume-envelope-format.test.mjs` uses private fresh synthetic
workspaces and the real private-storage atomic helper, without opening a media
file or business database. The frozen fixtures `local-drafts-v1-reader.ts` and
`local-drafts-v1-contracts.ts` contain actual baseline `b86d0d3` service/contracts
with only import-path changes. Tests run that old service against a real promoted
file and verify GET, list, PUT and DELETE all fail without changing its bytes.
The suite also covers field bounds, raw absence/null, whole-file promotion,
unknown storage evidence preservation, hostile descriptors, and publication
faults with exact retries. Existing business tests separately use real SQLite
fixtures and retain their domain non-mutation and source-ownership assertions.

## Aggregate byte qualification

The extended format suite serializes complete objects, including keys, source
IDs/hash, maximum safe revisions, all ten legacy numeric text fields, a
200-control-character name, colour source/LUT metadata, audio role, timestamp,
16 bounded envelope points and protocol metadata. Exact UTF-8 measurements:

- Legacy slot with normal publisher-length timestamp: 5,430 bytes.
- Same slot plus bounded envelope: 6,611 bytes, accepted and actually published.
- Complete PUT request for that promoted slot: 6,706 bytes.
- Complete `{ok:true,data:...}` success response: 6,817 bytes.
- Legacy slot padded through legal fractional timestamp precision: 8,192 bytes.
- That adversarial legacy slot plus envelope: 9,373 bytes. It remains field-schema
  valid but exceeds aggregate admission; the real service refuses it as stored
  corruption without changing any bytes.
- Complete success response for a legal 8,192-byte envelope slot: 8,398 bytes.

Fresh service reads accept exact complete rows of 8,191 and 8,192 bytes and refuse
8,193, preserving the entire companion. These boundary rows use the existing
schema's legal long fractional timestamps, not arbitrary added fields or bigger
field limits. The current publisher itself emits ordinary ISO timestamps.

The actual HTTP handler is exercised through finite Node readable streams,
without a listening socket. Valid complete PUT JSON plus legal trailing
whitespace is accepted at 12,287 and 12,288 bytes and refused at 12,289, both with
Content-Length and with streamed byte counting. Successful exact replays and
size refusals leave the file byte-identical. The actual client likewise accepts
complete maximum-row success responses padded to 12,287/12,288 bytes and rejects
12,289, both with and without a declared Content-Length.

A complete 128-row companion, every slot exactly 8,192 bytes, is 1,048,814 bytes:
1,048,576 row bytes plus 238 bytes for the fixed envelope metadata, commas and
final newline. Replacing one maximum row with a 193-byte maximum-revision
tombstone gives 1,040,815 bytes. Both read correctly; an additional slot is refused
without eviction. Tombstones count toward the same 128 slots, so 128 live rows
plus an extra tombstone is not legal.

Consequently a canonical compact companion cannot reach 2 MiB while respecting
both current row and slot caps. The raw-file read limit is independently tested
with legal JSON whitespace: exact files of 2,097,151 and 2,097,152 bytes read
without rewrite, while 2,097,153 bytes is refused and remains untouched. No cap
was widened and no timing loop, media processing or native/browser action was
used for this qualification.
