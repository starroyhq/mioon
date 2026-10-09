#!/bin/sh
cd /workspace/shared/video-workbench
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
MIOON_BROWSER_EVIDENCE=evidence/v3-browser python3 tests/browser_timeline.py > evidence/v3/browser-timeline.log 2>&1
echo $? > evidence/v3/browser-timeline.exit
MIOON_BROWSER_EVIDENCE=evidence/v3-browser-v1 python3 tests/browser_flow.py > evidence/v3/browser-v1.log 2>&1
echo $? > evidence/v3/browser-v1.exit
