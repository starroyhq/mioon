# No-cost format-5 trial

Use a throwaway format-5 project with at least one ready clip. To make a synthetic clip, choose the built-in Mock service in Mioon and wait until the clip is ready. Use this trial only for the test project the user selects.

Have Mioon open. Use the connected MCP tools in [Sequence editing](sequence.md) or follow these CLI steps. Use the real test project and clip IDs. Create `project.json` containing `projectId`.

```sh
"{{MIOON_COMMAND}}" doctor
"{{MIOON_COMMAND}}" sequence inspect --input-file project.json
"{{MIOON_COMMAND}}" timeline inspect --input-file project.json
```

Pick one ready clip and record its ID, name and the current history. Write `clip-edit.json` using the rename example in [Sequence editing](sequence.md) with a different test name. Preview it, build `commit.json` from the returned plan, then commit and reread the same clip.

```sh
"{{MIOON_COMMAND}}" sequence history get --input-file project.json
"{{MIOON_COMMAND}}" sequence clip edit --input-file clip-edit.json
"{{MIOON_COMMAND}}" sequence action commit --input-file commit.json
"{{MIOON_COMMAND}}" timeline inspect --input-file project.json
"{{MIOON_COMMAND}}" sequence history get --input-file project.json
```

Check that the edited name is saved and that the action ID in the commit receipt matches `undo.actionId` in the current history. Prepare `undo.json` using that action ID, the latest cursor, the project ID, and a stable request ID for this undo.

```sh
"{{MIOON_COMMAND}}" sequence undo --input-file undo.json
"{{MIOON_COMMAND}}" timeline inspect --input-file project.json
"{{MIOON_COMMAND}}" sequence history get --input-file project.json
```

Verify that the same clip has its original name and the just-undone action is the redo target. Stop if a concurrent edit moved the cursor. Report the project, clip and action IDs and the observed before, after and restored names.
