#!/bin/sh
cd /workspace/shared/video-workbench || exit 1
export PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:$PATH
mkdir -p evidence/v4-desktop evidence/v4-browser-timeline evidence/v4-browser-original evidence/v4-browser-components
WB_FFMPEG_PATH=/usr/bin/ffmpeg WB_FFPROBE_PATH=/usr/bin/ffprobe WB_DESKTOP_SMOKE_OUTPUT=/workspace/shared/video-workbench/evidence/v4-desktop/smoke.json node apps/desktop/scripts/smoke.mjs > evidence/v4-desktop/smoke.log 2>&1
echo $? > evidence/v4-desktop/smoke.exit
WB_BROWSER_EVIDENCE=evidence/v4-browser-timeline python3 tests/browser_timeline.py > evidence/v4-browser-timeline/run.log 2>&1
echo $? > evidence/v4-browser-timeline/run.exit
WB_BROWSER_EVIDENCE=evidence/v4-browser-original python3 tests/browser_flow.py > evidence/v4-browser-original/run.log 2>&1
echo $? > evidence/v4-browser-original/run.exit
WB_UI_EVIDENCE=evidence/v4-browser-components python3 tests/browser_ui_components.py > evidence/v4-browser-components/run.log 2>&1
echo $? > evidence/v4-browser-components/run.exit
