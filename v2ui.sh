#!/usr/bin/env bash
set -u
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
mkdir -p evidence/v2-browser evidence/v2-v1-browser
npm run build > evidence/v2-browser/build.log 2>&1
result=$?
if [ "$result" -eq 0 ]; then python3 tests/browser_timeline.py > evidence/v2-browser/run.log 2>&1; result=$?; fi
echo "$result" > evidence/v2-browser/exit-code.txt
tail -45 evidence/v2-browser/run.log
exit "$result"
