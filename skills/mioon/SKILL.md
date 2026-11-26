---
name: mioon
description: Read or edit a Mioon project through the running desktop app using MCP or its installed command. Use for Mioon project inspection, format-5 board and timeline edits, generation, or export.
license: Apache-2.0
---

# Mioon

Use the project the user identifies. Resolve its ID and read current evidence before editing. If the project is ambiguous, ask which one to use. Use connected Mioon MCP tools when available. Otherwise run the absolute command inserted by Mioon at installation, for example `"{{MIOON_COMMAND}}" doctor`. See [Connection](references/connection.md) to recover an unavailable or mismatched installation.

## Format 5

1. Use `"{{MIOON_COMMAND}}" sequence inspect` or `sequence_inspect` to identify the node, shot, or clip. For saved clip names and properties, also use `"{{MIOON_COMMAND}}" timeline inspect` or `timeline_inspect`.
2. Preview one bounded action. Read its summary and warnings, check that it matches what the user asked for, then retain the returned `envelope` and `planDigest`. Preview does not perform the edit.
3. Send the same envelope and digest as `envelope` and `expectedPlanDigest` through `"{{MIOON_COMMAND}}" sequence action commit` or `sequence_action_commit`. Verify the receipt and reread the changed objects. For undo or redo, first read the current history and bind the requested action to that history's cursor.

Read [Sequence editing](references/sequence.md) for command/tool pairs, clip replacement, history and loudness. If a legacy command refuses a format‑5 operation, use the replacement and fields reported by Mioon, checked against the current schema.

## Choose the relevant reference

- [Media, generation and export](references/operations.md) for authorized imports, generation inputs, job status, and delivery.
- [Recovery](references/recovery.md) for a lost response, revision conflict, or unknown generation result.
- [Mock workflow](references/mock-workflow.md) for a reversible read → edit → undo trial in a test project.
- [Built-in Mio](references/agent-tasks.md) only when the user wants Mioon's own assistant to take the task.

Before submitting paid generation, confirm the provider, model, prompt and references, number of generations, and total cost limit with the user. A configured provider or a valid preview does not grant spending approval. For online images, prepare the review and let the user confirm generation in the Mioon UI. Preserve the original request and job when the result is uncertain.
