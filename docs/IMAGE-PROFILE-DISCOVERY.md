# Explicit Images configuration-revision discovery

2026-10-10. Implementation baseline: `090a8e3c2cdaa0f0d75cf918916067cb4ca70f6d`.

## Public contract

`image.profile.list` remains a metadata-only read. CLI:

```sh
mioon image profile list --input '{"includeSettingsRevision":true}'
```

MCP uses `image_profile_list` with the same JSON; HTTP uses the existing authenticated RPC envelope. Omitted input, `{}`, or `includeSettingsRevision:false` preserves the original response and field order. The parser does not inject false into empty client requests, so those requests remain compatible with older strict-empty backends.

Explicit true may add only `settingsRevision` to an already-listed official OpenAI, custom-compatible Images or local ComfyUI profile. It is a positive safe integer taken from the same safe settings snapshot used for that profile's model/options/availability. Mock never gets the field. Zero, missing, malformed or unreadable revisions are omitted; incomplete custom/Comfy entries remain omitted as before. A valid revision can be visible while a profile is disabled or not ready; it grants neither readiness nor permission.

The client binds revision-bearing responses to an explicitly opted-in request. Unknown fields, invalid values and revisions on Mock remain invalid. No destination, credentials, secret storage metadata or settings object is exposed. No acquisition/decryption, network check, workflow inspection, task creation, database/file write or preparation occurs.

## Review flow and limits

For a new user-requested image intent, select the matching provider item and pass its returned revision to the existing `image.review.prepare`. Keep the complete original input and nested stable request ID. Missing metadata requires configuration help, never guessing a revision or borrowing another slot's value.

Discovery is a point-in-time read. Subsequent settings changes still fail the existing prepare/approval/dispatch fences. It does not approve requests, grant a model permission, change a retained review, create a new key or retry generation. User approval remains the existing private application action. Default older callers and historical receipts are unchanged; no migration or namespace is added.

## Acceptance

Test-driven regression and strict contracts/business/HTTP/CLI/official-MCP checks passed: **12/12 focused**, then **281/281 affected**, 0 skipped (overlapping counts). The affected gate includes old catalog/client/Images/Comfy checks and updated quickstart command contracts. Independent source review found no blocking issue.

Fresh development Web/desktop build passed. Actual CLI schema output shows the optional boolean and read-only effects. The shared schema changed bundled JavaScript without renderer source changes; a final Linux native smoke opened the default Images page and unconfigured official profile successfully, then exited normally with no image tasks or media. This smoke checks default-caller compatibility, not paid generation.

The first parent full gate failed: **3,145 total / 3,139 passed / 4 failed / 2 skipped**. One official synthetic-image task exceeded the unchanged 10-second test wait, then succeeded after 13.641 seconds; two later leaf assertions used setup values left undefined, plus the parent suite failed. The delay's root cause is unproven. The unchanged isolated suite passed **12/12**. Bounded test-only lifecycle/network timing diagnostics were added without changing deadlines, assertions or production code; the subsequent focused group passed **31/31**. The final parent rerun actually exited0: **3,145 total / 3,143 passed / 0 failed / 2 skipped**, 595,158.652846 ms. This passing release gate does not establish the cause of the earlier 13.641-second delay. All runtime fixtures are isolated and synthetic. This change does not establish live-provider, macOS Keychain or Windows readiness. The five frozen Windows proof files are excluded from this slice.
