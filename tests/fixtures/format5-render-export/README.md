# Format-5 render/export UI acceptance

Headless acceptance of the production web app on the format-5 render/export
path. It starts no module mocks: the page talks to the real project service and
runs the real export workflow, local delivery prepare/execute and
`timeline.render` worker.

By default the script builds its own project through the public RPC write
entries:

- ffmpeg synthesizes two 2-second 1080x1920 30fps clips locally: a test pattern
  with a 440 Hz tone, and a silent blue clip;
- both are imported and inserted on the main track;
- the reviewed clip gain is set, the first clip's sound is separated (leaving a
  muted source and one sound-only audio clip), and a 0-60 frame subtitle is
  added;
- the script then exports from the real interface and compares the probed output
  with the committed `consistency.json` (duration, frames, codecs, subtitle
  interval, one audible first half, silent second half).

No local project or data directory is required. Existing equivalent projects can
be selected with `--project-id` or `--project-name`. `--expected-mp4` optionally
requires byte equality with a reviewed export.

## Prerequisites

- A development backend started with a format-5-enabled build (a build that
  creates format-5 projects), and the built web assets served by that backend.
- A development token for that backend.
- `ffmpeg`/`ffprobe` with `libx264` and AAC support. Use `--ffmpeg`/`--ffprobe`
  or the backend's `MIOON_FFMPEG_PATH`/`MIOON_FFPROBE_PATH` environment values.
- Python Playwright and a local Chromium/Chrome.

If the backend creates format 3/4 projects, the script stops with a clear
message because this acceptance needs a format-5 project.

## Run

```sh
python3 tests/fixtures/format5-render-export/acceptance.py \
  --url http://127.0.0.1:4319 \
  --token "$MIOON_TOKEN" \
  --screens ./screens
```

Screens and the run report stay under the caller-provided `--screens`
directory; only this script and `consistency.json` are committed.

Use a token file instead with `--token-file`. When selecting a reviewed
existing project with `--project-id`/`--project-name`, pass
`--expected-mp4 path/to/reviewed-export.mp4` for the optional byte comparison;
the self-built synthetic project is structure-compatible, not byte-identical.
