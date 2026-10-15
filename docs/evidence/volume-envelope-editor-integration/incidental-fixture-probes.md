# Nonqualifying broad-run scope incident

The initial broad affected run (`affected-first.log`) included the existing
`tests/local-drafts-transports.test.mjs` and completed 504/522 tests. It must NOT
be described as nonmedia or a fully passing qualification.

A bounded read-only trace after completion found four direct tests plus three
crash-phase cases in that file. Each calls its fixture once. The fixture's parent
awaits one `asset.import` of inert synthetic PNG before starting the guarded HTTP
child. That path awaits `fileInfo` -> `probe` -> `run('ffprobe', ...)`. Intended
count: seven FFprobe invocations. No FFmpeg invocation occurs on this seed path.
All seven tests progressed beyond that awaited import. Six passed; the backup
case failed later on an outdated schema-26 assertion against activated schema40.
The runtime's success path resolves from the child's close event, so successful
awaited return is supported by code and progress. However the test log captured
neither probe PIDs nor independent identity/retirement evidence. No PID-qualified
retirement assertion is made.

The HTTP child itself installs a deny-all external network/provider/subprocess
guard, and its no-effects assertions passed. That guard did not cover the parent
seed. Selecting this suite without checking the seed path violated the no-media
scope. No importer-suite rerun, extra probe, process sweep or signaling was used
to investigate it.

Final qualification uses the explicit `nonmedia-tests.json` list and a fail-fast
preload denying media, shell and unreviewed child processes. Only the pinned Node
test-worker and pinned esbuild transform-service commands are allowed. The guard
self-test throws before forwarding an ffprobe spawn; it does not launch a probe.
