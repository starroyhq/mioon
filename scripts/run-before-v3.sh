#!/bin/sh
cd /workspace/shared/video-workbench
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
python3 scripts/capture-before-v3.py > evidence/v3-before/capture.log 2>&1
echo $? > evidence/v3-before/exit.txt
