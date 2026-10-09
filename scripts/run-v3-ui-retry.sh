#!/bin/sh
cd /workspace/shared/video-workbench
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
python3 tests/browser_ui_components.py > evidence/v3-ui-components/run.log 2>&1
echo $? > evidence/v3-ui-components/run.exit
