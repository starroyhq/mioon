#!/bin/sh
cd /workspace/shared/video-workbench
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe node apps/desktop/scripts/packaged-qa.mjs > evidence/v3-desktop/packaged-qa.log 2>&1
echo $? > evidence/v3-desktop/packaged-qa.exit
