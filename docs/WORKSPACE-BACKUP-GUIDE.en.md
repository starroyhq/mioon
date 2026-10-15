# Offline workspace backup guide

This entry covers the entire workspace, not only the current project. SQLite preserves all projects, chats, prompts, tasks, receipts, history, and waveform caches stored in the database exactly as they are. This is private, unencrypted data: application credentials, connection tokens, and settings files are not copied, but sensitive information you have entered into prompts or chats remains in the database backup.

Offline creation, verification, and the “Safe restoration to a new, independent workspace” procedure below are available. Restoration accepts only supported original backups and cannot overwrite an existing workspace. A restored branch allows new local imports, edits, previews, and exports; inherited tasks and approvals remain historical and are not executed again. Restored branches cannot currently create another backup, so you must retain the original backup. All these steps run locally, without calling providers or automatically resubmitting tasks.

## Procedure

1. Expand “Workspace backup” in the right-hand Properties panel and read database counts if needed. This read does not inspect media files or mean that a cold backup is ready.
2. Close Mioon normally, along with any Web/CLI backend using the same workspace. Do not delete locks, WAL, or journals to force the checks to pass.
3. In a source directory with the project's lockfile-pinned dependencies and Node24+, run:

   `node apps/cli/src/backup.mjs create --source /absolute/workspace --destination /absolute/new-backup`

   source is an existing Mioon workspace. destination must be a completely new, private directory; neither directory may contain the other. Do not use a folder of user media as a workspace. Paths are used locally and are not sent to the backend or a model.
4. Verify: `node apps/cli/src/backup.mjs verify --directory /absolute/new-backup`.
5. Only after the command succeeds and the completion marker and every file pass re-verification can it be called a verified backup. That still does not establish successful restoration or authorize old paid tasks to run again.

See [DESKTOP.md](DESKTOP.md) for the default desktop workspace location and differences between release channels. For a custom launch directory, follow the existing launch configuration; this tool does not guess or switch directories.

## Scope and limits

- Fixed-version directory: manifest.json, COMPLETE.json published last, and the original SQLite database, registered media, and staged/uncommitted results of known tasks inside payload.
- Database: at most 512MiB; individual file: 8GiB; total payload: 64GiB; at most 20,000 files; manifest: 8MiB; individual streaming chunk: 1MiB; at most 100 issues displayed. These limits do not guarantee sufficient available disk space.
- Application credential/settings files, connection tokens, browser profiles, separate cache directories, and unknown files without an established owner are not copied. Existing cache rows in the database are retained.
- Missing media, partial results, unknown tasks, and exclusions are explicitly recorded. Verifying backup file integrity does not mean the source project had no problems.
- The existing Windows storage safety gate has not yet passed native acceptance testing. This initial implementation operates under the existing supported POSIX private-directory policy and does not change existing permissions.

## File integrity and cancellation

Creation copies the closed SQLite database without changing it. SQL checks run only on a newly created private temporary copy; they do not open or migrate the source database. Verification also uses a private temporary copy under the backup's parent directory, so that parent must be writable by the current user. Neither the source nor the completed payload is opened by SQL. Temporary extra space can reach a 512MiB database copy plus up to three 64MiB SQLite sidecars; this is not included in the 64GiB payload limit.

Only the process holding the exclusive lock may capture a workspace. Any existing lock or nonempty WAL/journal stops the operation. The tool does not automatically decide that an old lock can be deleted. It does not repair permissions on existing directories; it creates only its own new directories and files with 0700/0600 permissions. This protection boundary is against other system accounts, not malicious processes running as the same user or root. It also does not guarantee that hardware or filesystems can never lose data.

Ctrl+C/SIGTERM requests that subsequent local steps stop and waits for already-issued file operations to finish. It is not a hard deadline that instantly interrupts kernel I/O. An interruption or failure may leave a new directory without a completion marker. Retain and inspect it; do not overwrite it or automatically retry. If the returned publication state is unconfirmed, retain that directory and run verify separately. The existence of COMPLETE.json alone does not prove backup integrity.

If a successful result includes SOURCE_LOCK_RELEASE_UNCONFIRMED, the backup itself has been verified, but the tool could not confirm release of its own source lock. Retain both the backup and the source lock, and first check that the original process has exited. Do not delete the lock and automatically retry. If a failure includes sourceLockRelease: unconfirmed, cleanup likewise cannot be considered complete.

## Safe restoration to a new, independent workspace

An original format1/schema24 backup can use the separate offline restore command:

```sh
node apps/cli/src/backup.mjs restore --directory /绝对路径/原始备份 --destination /绝对路径/新工作区
```

The new destination's parent directory must exist, and the destination itself must not exist. Do not select a location inside the original workspace.
The tool checks only fixed ancestor markers. format1 does not store the original path, so it cannot identify every renamed source.
After failure or interruption, retain the destination; do not delete locks, overwrite it, or automatically retry.
If all stdout output is lost, you can perform this read-only check:

```sh
node apps/cli/src/backup.mjs restore-status --directory /绝对路径/原始备份 --destination /绝对路径/新工作区
```

observed_guarded means only that the current destination's fixed schema and source binding match the original backup. It does not prove that the previous command succeeded or that an earlier fsync completed. It does not finish publication, repair anything, or execute tasks.
After opening the restored branch, you can start new local imports, edits, previews, and exports. Inherited tasks, approvals, and unknown outcomes remain historical and do not execute. New generation, Agent, Comfy, frame extraction, and waveform decoding are currently unavailable.
The initial restored-branch implementation also cannot create another backup; retaining the original backup is required.
For Desktop, place the destination in the workspace subdirectory of a new root directory and explicitly select that new root. Do not copy old token or session files. See [Safe restoration](WORKSPACE-RESTORE.md) for the full scope, limits, and verification status.
