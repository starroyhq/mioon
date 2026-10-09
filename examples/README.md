# Synthetic example data

`synthetic/reference.png` is an original geometric test image made with FFmpeg. No user product files were copied.

`demo-project/` is a portable, prebuilt five-shot project. After installation/build, launch with:

```sh
node apps/desktop/scripts/migrate-data.mjs --source="$PWD/examples/demo-project" --destination="$PWD/data-demo/workspace"
MIOON_DATA_DIR=./data-demo/workspace pnpm start
```

Read `data-demo/workspace/access-token` after this first local startup and enter it in the local login form. No token is distributed with the sample. Copy the sample directory before experimenting if you want an untouched reference copy. A full data backup includes its SQLite database and all media.

The project uses the requested Stanley × Maltese story only as shot/prompt data: white/light-brown dogs chase stars → catch with a small cup → match the pose to a flat cup print → show tumbler and pet bowl → both products hold. Five2-second clips make a10-second portrait test film. The actual video pictures are watermarked simulated motion test patterns, not generated dogs or accurately depicted products, and not a finished advertisement. Real product artwork and brand review remain separate.

`pnpm demo` seeds the same story into an already running backend if it is absent.

`mcp-project/` is a separate three-shot technical acceptance fixture created by the official MCP client. It is retained only so the browser test can show the exact project/versions from the archived protocol evidence after moving the source bundle to another computer. The requested story sample is `demo-project/`.

## V2 multitrack fixture

`multitrack-project/` is a separate10second compositing project made entirely from the original procedural media in `timeline-synthetic/`. It has two video tracks and one audio track. Main pictures occupy0–4s and5–10s; the upper star card occupies2–7s in a smaller rectangle; independent sound occupies0–4s and5–9s with a source trim on its second clip. The second main picture also contains embedded audio.

After the normal build, copy the closed sample into a fresh private workspace:

```sh
node apps/desktop/scripts/migrate-data.mjs --source="$PWD/examples/multitrack-project" --destination="$PWD/data-multitrack/workspace"
MIOON_DATA_DIR=./data-multitrack/workspace pnpm start
```

No access token is packaged. Keep the original sample unchanged; the destination must not exist. Old broadly readable sample directories are refused at startup, not silently repaired. See [private-storage recovery](../docs/PRIVATE-STORAGE.md). `MIOON_V2_DEMO_DIR="$PWD/data-timeline-demo" pnpm demo:timeline` reproduces the source fixtures and both the preview/export in a new private directory through the shared business service. It uses no model provider or external media.
