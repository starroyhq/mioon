# Connect to the desktop app

Keep the intended Mioon desktop app running. The CLI and configured MCP server use that app and its open projects. The installed skill works as a standalone copy with the command's absolute path substituted by Mioon. The command is `mioon` in the release channel and `mioon-dev` in development.

1. Prefer the already-connected Mioon MCP server. Use `mioon_doctor` to check readiness and `mioon_schema` to discover the available tools and exact inputs. Use the registration for the intended channel if both are available.
2. With the CLI, run `"{{MIOON_COMMAND}}" doctor`. For syntax, use `"{{MIOON_COMMAND}}" --help` or `"{{MIOON_COMMAND}}" schema`. For example, `"{{MIOON_COMMAND}}" schema sequence clip edit` lists the action branches for clip editing.
3. Use the installed absolute path as the executable. Keep it quoted so directories with spaces work. For paths containing shell syntax, pass the executable as a separate argument or quote the actual path as a shell literal. Use `--input-file` for JSON that contains user text or a long envelope.

## Recover the connection

| Symptom | Action |
| --- | --- |
| The executable is missing or the command marker is still present | Ask the user to open Settings → External Agents, install or repair the command-line tool, then install or update the skill. |
| Mioon is closed or reports `CLI_RUNTIME_UNAVAILABLE` | Tell the user to open Mioon and wait for readiness before checking again. |
| `CLI_VERSION_MISMATCH` | Tell the user to repair the command-line tool in Mioon Settings. Use the matching app channel. |
| MCP disconnected after Mioon closed or restarted | Keep Mioon running, then reopen the Agent session to reconnect. After moving the installed command, the user can copy the updated MCP registration command from Settings → External Agents. |

The app owns its integration credentials. Use the existing connection and keep credential files and values out of requests and replies.
