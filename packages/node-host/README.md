# Standalone Node private storage

This package is composed explicitly by standalone CLI, MCP and headless server
entry points. Shared contracts/client modules do not load native libraries, and
Electron does not initialize this helper. `initializeNodePrivateStorage()` does
nothing on POSIX. On Windows it requires the complete locally built Node-API v8
helper; a missing/incompatible helper fails closed. Installation does not build
or download native binaries.

Build on Windows with the supported Node 24, matching Visual C++ target tools and
Windows SDK:

```sh
pnpm --filter @mioon/node-host build:native
node --test tests/windows-private-storage-native.test.ts
node --test tests/windows-private-storage-stream.test.ts
```

The supported storage profile is a canonical drive-absolute path on fixed local
NTFS. Creation uses the real process TokenUser SID and a protected DACL allowing
only that SID and SYSTEM. SQLite children may inherit that closed ACL from a
verified protected private root. Every opened component is pinned without delete
sharing and inspected by handle; reparse points, namespace/ADS/device aliases,
noncanonical short names, foreign ownership, unsafe grants and multi-link files
are rejected. File identity uses the full volume serial and 128-bit FileIdInfo.
Case-variant managed-root spellings must resolve to that same full identity,
including on NTFS directories with case sensitivity enabled.
The adapter obtains actual Node lstat metadata through a fixed trusted callback
while every verified native ancestor/leaf handle remains pinned, then rechecks
their attributes and the full leaf identity. No CRT fd or HANDLE is exposed;
`privateStorageIdentity()` is the only Windows security identity comparison, and
unbound later fstat objects fail closed. Windows uid/mode are not fabricated.
The walk requests real read/list access: attribute-only Windows opens do not
participate in the sharing checks needed to prevent renaming. The bridge uses
only Node-API and Win32, with no libuv or Node C++ ABI dependency.

Native writes create a protected temporary file, flush its bytes, then publish by
handle rename with explicit replace/no-clobber semantics. Removal marks only the
verified open file for deletion. This protects against other ordinary OS users;
processes already executing as the same account, SYSTEM or an administrator are
outside the existing policy's isolation boundary. No ACL repair is attempted.

Backup uses opaque native leases that retain the complete verified handle walk
across asynchronous chunk processing. They admit at most 8 GiB per file and
1 MiB per read/write allocation; ordinary whole-file secret operations retain
their 64 MiB ceiling. Leases supply actual Node metadata with full native IDs,
bounded handle-based directory enumeration, exact owned removal and no-clobber
publication. File and directory flushes call `FlushFileBuffers` on verified
handles and reject any unsupported or failed operation; none is a no-op.

Real Windows tests must establish readiness. POSIX unit tests, skipped Windows
tests, synthetic identity tests and cross compilation are insufficient. The
optional elevated `tests/windows-private-storage-two-user.ps1` uses a disposable
standard local account and only synthetic bytes to test actual access denial.
It first verifies that the second user can list a fresh read-only probe parent,
then requires that user to be denied both private child listing and file reads;
an inaccessible original user profile cannot make that check pass.
Offline backup integration requires its own Windows end-to-end evidence beyond
the lease tests. The current Windows 11 ARM64 acceptance includes a 65 MiB media
fixture through CLI create/verify/restore/status and bundle export/import,
cancellation and uncertain publication checks; see the
[acceptance record](../../docs/verification/ai-workflows-acceptance/CLI-SDK-ACCEPTANCE.md).
Older manual-draft paths with direct POSIX descriptor/permission checks fail
closed, including the draft-protected `project.delete` flow. They must not be
claimed as supported Windows flows; v2 SQLite editing claims and task controls
are separate. Native x64 and Windows desktop packaging are not certified here.

API references:

- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
- https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
