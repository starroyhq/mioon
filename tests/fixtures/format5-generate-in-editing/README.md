# GE-b headless acceptance

`acceptance.py` drives a development server + Web build with a real format-5
project: it creates the project through RPC, adds three shots on the board,
switches to editing, opens the blank-timeline generation menu, checks the 21-09
panel, resizes the placeholder through the duration control (one history step),
checks the overlay/audio entry rules and the clip-menu before/after entries, then
seeds a 40-shot packed project that must scroll horizontally: after an overlay
right-click it right-clicks the main-track end and asserts the generated clip is
still the 41st main-track clip (WT-1-18). Screenshots are only written to
`--screens` and are not part of the PR.

Run against a server started from a build that has format 5 enabled (the local
walkthrough run tree merges the AC branch) and with a working FFmpeg:

```sh
# server (from the run worktree):
MIOON_FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
MIOON_FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
MIOON_DATA_DIR=/private/tmp/geb-acceptance PORT=4319 pnpm dev

# acceptance:
python3 tests/fixtures/format5-generate-in-editing/acceptance.py \
  --url http://127.0.0.1:4319 \
  --token-file /private/tmp/geb-acceptance/access-token \
  --screens /private/tmp/geb-acceptance/screens
```

The script exits non-zero if an entry, the panel, the duration/one-undo rule, the
placeholder name, the clip menu or the long-project main-end target is wrong.
