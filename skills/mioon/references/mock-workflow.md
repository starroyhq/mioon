# Executable no-cost workflow

This sample creates a new project and synthetic reference, imports it, creates a shot, generates one labeled local mock MP4, selects that version, seeds an empty timeline, renders and downloads the MP4. It requires an already-running service and connection environment from [connection.md](connection.md). It never switches to a real provider.

Run from any folder with an absolute authorized application checkout and a new writable work directory:

```sh
python3 /absolute/to/mioon/skills/mioon/scripts/mock_workflow.py \
  --repo /absolute/to/mioon \
  --work-dir /absolute/new/mock-study
```

The script needs Python 3 standard library, Node 24+, and the application's installed CLI dependencies. FFmpeg/ffprobe run in the backend. It creates its own 360×640 original PNG without external downloads. To use a user-authorized image instead, explicitly pass `--image /absolute/approved/reference.png`; this imports the file into the user's local service, with no provider upload.

The new work directory contains `requests.json`, the synthetic image (unless one was supplied), and `mock-result.mp4`. Each original request is written before dispatch. If a command fails, the script stops and retains its state; the same directory cannot be blindly rerun. Inspect the existing IDs and use the documented recovery rules.

Shot creation, node creation and version selection include stable request IDs in that log. To recover a lost response for a keyed edit, use its saved operation and complete `input` unchanged, including the request ID and any original revision. The script does not automatically retry or resume. Project creation and asset import remain keyless; inspect existing projects/assets before deciding whether another attempt is needed.

To inspect a result in the UI, select the returned project ID in the running application. CLI, MCP and renderer see the same stored project. The result is a real decodable MP4 with a permanent SIMULATED MOCK label; it is not an AI depiction of the prompt.

For a user's existing project, do not run this new-project demonstration unasked. Use the individual schema-driven CLI/MCP operations to make only their requested changes.
