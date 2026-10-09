#!/usr/bin/env bash
set -u
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
export WB_BROWSER_EVIDENCE=/workspace/shared/video-workbench/evidence/v2-v1-browser
mkdir -p "$WB_BROWSER_EVIDENCE"
npm run build > "$WB_BROWSER_EVIDENCE/build.log" 2>&1
result=$?
if [ "$result" -eq 0 ]; then python3 tests/browser_flow.py > "$WB_BROWSER_EVIDENCE/run.log" 2>&1; result=$?; fi
echo "$result" > "$WB_BROWSER_EVIDENCE/exit-code.txt"
tail -45 "$WB_BROWSER_EVIDENCE/run.log"
exit "$result"
