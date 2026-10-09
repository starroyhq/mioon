#!/bin/sh
cd /workspace/shared/video-workbench
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe MIOON_DESKTOP_SMOKE_OUTPUT=/workspace/shared/video-workbench/evidence/v3-desktop/smoke.json node apps/desktop/scripts/smoke.mjs > evidence/v3-desktop/smoke.log 2>&1
echo $? > evidence/v3-desktop/smoke.exit
