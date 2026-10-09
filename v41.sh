#!/bin/sh
cd /workspace/shared/video-workbench || exit 1
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
MIOON_IDENTITY_QA_SCREENSHOT=1 node apps/desktop/scripts/identity-packaged-qa.mjs > evidence/v4.1-app-id/packaged-runtime.log 2>&1
echo $? > evidence/v4.1-app-id/packaged-runtime.exit
