#!/bin/sh
cd /workspace/shared/video-workbench || exit 1
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
export XDG_DATA_HOME=/tmp/wb-pnpm-data XDG_CACHE_HOME=/tmp/wb-cache
node apps/desktop/scripts/build.mjs > evidence/v4/build-desktop.log 2>&1 || exit 1
WB_FFMPEG_PATH=/usr/bin/ffmpeg WB_FFPROBE_PATH=/usr/bin/ffprobe WB_DESKTOP_SMOKE_OUTPUT=/workspace/shared/video-workbench/evidence/v4-desktop/smoke.json node apps/desktop/scripts/smoke.mjs > evidence/v4-desktop/smoke.log 2>&1
echo $? > evidence/v4-desktop/smoke.exit
