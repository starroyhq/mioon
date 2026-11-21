# Format-5 render/export UI acceptance

Headless acceptance of the **production web app** on the format-5 render/export
path. It starts no module mocks: the page talks to the real project service and
runs the real export workflow, local delivery prepare/execute and
`timeline.render` worker. The output file is fetched through the authenticated
media route, probed, and compared with the reviewed D-walkthrough consistency
fixture (`consistency.json`, copied from
`board-edit-3/evidence/consistency.json`).

## Prerequisite

Start the development backend + built web app with the D walkthrough data
directory (see
`/Users/kouzen/Documents/data/mioon/.agents/tasks/howard-format5-walkthrough/README.md`).
The project `D 导出走查 1121` must be present; it is the reviewed 4-second
project with two main-track clips, a separated sound on A1, a muted source and a
0–60 frame subtitle.

## Run

```sh
python3 tests/fixtures/format5-render-export/acceptance.py \
  --url http://127.0.0.1:4339 \
  --base http://127.0.0.1:4339 \
  --token <MIOON_TOKEN> \
  --screens /tmp/format5-render-export-screens
```

Screens and the run report stay local; only this script and the small
`consistency.json` fixture are committed. Pass `--expected-mp4 <D evidence mp4>`
to additionally require byte equality with the reviewed backend export, and
`--expected-frames <D evidence dir>` to compare the available extracted frames.
The default project name is `D 导出走查 1121`; use `--project-id` or
`--project-name` for another equivalent project.
