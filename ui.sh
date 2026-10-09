#!/usr/bin/env bash
set -u
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
npm run build > evidence/browser-build.log 2>&1
python3 tests/browser_flow.py > evidence/browser-run.log 2>&1
result=$?
echo "$result" > evidence/browser-exit-code.txt
tail -35 evidence/browser-run.log
exit "$result"
