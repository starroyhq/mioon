/* Test-only SQLite VFS observer. It delegates every operation to the real
 * default VFS and stops the child after a designated call succeeds. */
#include <signal.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum Kind { OTHER, PROJECT_DB, ROLLBACK_JOURNAL, HISTORY_WAL, PROJECT_WAL };
typedef struct {
  sqlite3_file handle;
  sqlite3_file *real;
  enum Kind kind;
  sqlite3_int64 commit_page;
} ProbeFile;

static sqlite3_vfs *parent_vfs;
static const char *phase;
static bool armed;
static bool checkpointing;
static bool reached;
static unsigned int journal_syncs, other_syncs, superjournal_unlinks;

static bool ends_with(const char *name, const char *suffix) {
  if (!name) return false;
  size_t n = strlen(name), s = strlen(suffix);
  return n >= s && !strcmp(name + n - s, suffix);
}

static void pause_at(const char *point) {
  if (reached || strcmp(phase, point)) return;
  reached = true;
  printf("SYNC %u %u %u\n", journal_syncs, other_syncs, superjournal_unlinks);
  printf("PAUSED %s\n", point);
  fflush(stdout);
  raise(SIGSTOP);
}

static void pause_sql(sqlite3_context *context, int argc, sqlite3_value **arguments) {
  const unsigned char *point = argc == 1 ? sqlite3_value_text(arguments[0]) : NULL;
  if (point) pause_at((const char *)point);
  sqlite3_result_null(context);
}

static int observed_close(sqlite3_file *file) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  int rc = real->pMethods->xClose(real);
  file->pMethods = NULL;
  return rc;
}
static int observed_read(sqlite3_file *file, void *data, int n, sqlite3_int64 offset) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xRead(real, data, n, offset);
}
static int observed_write(sqlite3_file *file, const void *data, int n, sqlite3_int64 offset) {
  ProbeFile *probe = (ProbeFile *)file;
  sqlite3_file *real = probe->real;
  int rc = real->pMethods->xWrite(real, data, n, offset);
  if (rc != SQLITE_OK || !armed) return rc;
  /* Ignore page 1: its header change counter alone doesn't expose an
   * application-level tear. At least two later pages change in this fixture. */
  if (probe->kind == PROJECT_DB && offset >= 4096) {
    pause_at(checkpointing ? "checkpoint_project_page" : "project_page_written");
  } else if (probe->kind == HISTORY_WAL || probe->kind == PROJECT_WAL) {
    // The fixture fixes a 4096-byte page. A 24-byte frame header uses its
    // second big-endian u32 as the committed DB size (zero for other frames).
    // Pause once the complete commit frame, including the page, was written.
    if (probe->commit_page >= 0 && offset == probe->commit_page && n >= 4096) {
      probe->commit_page = -1;
      pause_at(probe->kind == HISTORY_WAL ? "history_wal_commit_frame" : "project_wal_commit_frame");
    }
    if (offset >= 32 && (offset - 32) % (4096 + 24) == 0 && n >= 24) {
      const unsigned char *header = data;
      if (header[4] || header[5] || header[6] || header[7]) {
        if (n >= 4096 + 24) {
          pause_at(probe->kind == HISTORY_WAL ? "history_wal_commit_frame" : "project_wal_commit_frame");
        } else probe->commit_page = offset + 24;
      }
    }
  }
  return rc;
}
static int observed_truncate(sqlite3_file *file, sqlite3_int64 length) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xTruncate(real, length);
}
static int observed_sync(sqlite3_file *file, int flags) {
  ProbeFile *probe = (ProbeFile *)file;
  int rc = probe->real->pMethods->xSync(probe->real, flags);
  if (rc == SQLITE_OK && armed) {
    if (probe->kind == ROLLBACK_JOURNAL) {
      journal_syncs++;
      pause_at("rollback_journal_synced");
    } else other_syncs++;
  }
  return rc;
}
static int observed_size(sqlite3_file *file, sqlite3_int64 *size) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xFileSize(real, size);
}
static int observed_lock(sqlite3_file *file, int level) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xLock(real, level);
}
static int observed_unlock(sqlite3_file *file, int level) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xUnlock(real, level);
}
static int observed_reserved(sqlite3_file *file, int *reserved) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xCheckReservedLock(real, reserved);
}
static int observed_control(sqlite3_file *file, int op, void *arg) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xFileControl(real, op, arg);
}
static int observed_sector(sqlite3_file *file) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xSectorSize(real);
}
static int observed_capabilities(sqlite3_file *file) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xDeviceCharacteristics(real);
}
static int observed_map(sqlite3_file *file, int page, int page_size, int extend, void volatile **out) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xShmMap(real, page, page_size, extend, out);
}
static int observed_shm_lock(sqlite3_file *file, int offset, int n, int flags) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xShmLock(real, offset, n, flags);
}
static void observed_barrier(sqlite3_file *file) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  real->pMethods->xShmBarrier(real);
}
static int observed_unmap(sqlite3_file *file, int delete_flag) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xShmUnmap(real, delete_flag);
}
static int observed_fetch(sqlite3_file *file, sqlite3_int64 offset, int n, void **out) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xFetch(real, offset, n, out);
}
static int observed_unfetch(sqlite3_file *file, sqlite3_int64 offset, void *buffer) {
  sqlite3_file *real = ((ProbeFile *)file)->real;
  return real->pMethods->xUnfetch(real, offset, buffer);
}

static const sqlite3_io_methods io = {
  .iVersion = 3,
  .xClose = observed_close, .xRead = observed_read, .xWrite = observed_write, .xTruncate = observed_truncate,
  .xSync = observed_sync, .xFileSize = observed_size, .xLock = observed_lock, .xUnlock = observed_unlock,
  .xCheckReservedLock = observed_reserved, .xFileControl = observed_control, .xSectorSize = observed_sector,
  .xDeviceCharacteristics = observed_capabilities, .xShmMap = observed_map, .xShmLock = observed_shm_lock,
  .xShmBarrier = observed_barrier, .xShmUnmap = observed_unmap, .xFetch = observed_fetch, .xUnfetch = observed_unfetch,
};
static sqlite3_io_methods io_v1, io_v2;

static int open_observed(sqlite3_vfs *vfs, sqlite3_filename filename, sqlite3_file *file, int flags, int *out_flags) {
  (void)vfs;
  ProbeFile *probe = (ProbeFile *)file;
  probe->real = (sqlite3_file *)(probe + 1);
  file->pMethods = NULL;
  probe->commit_page = -1;
  probe->kind = OTHER;
  if ((flags & SQLITE_OPEN_MAIN_DB) && ends_with(filename, "study.mioon")) probe->kind = PROJECT_DB;
  if (flags & SQLITE_OPEN_MAIN_JOURNAL) probe->kind = ROLLBACK_JOURNAL;
  if ((flags & SQLITE_OPEN_WAL) && ends_with(filename, "history.db-wal")) probe->kind = HISTORY_WAL;
  if ((flags & SQLITE_OPEN_WAL) && ends_with(filename, "study.mioon-wal")) probe->kind = PROJECT_WAL;
  int rc = parent_vfs->xOpen(parent_vfs, filename, probe->real, flags, out_flags);
  if (rc != SQLITE_OK) return rc;
  int version = probe->real->pMethods->iVersion;
  file->pMethods = version >= 3 ? &io : version == 2 ? &io_v2 : &io_v1;
  return SQLITE_OK;
}

static int delete_observed(sqlite3_vfs *vfs, const char *file, int sync_dir) {
  (void)vfs;
  int rc = parent_vfs->xDelete(parent_vfs, file, sync_dir);
  const char *basename = strrchr(file, '/');
  if (rc == SQLITE_OK && armed && strstr(basename ? basename : file, "history.db-mj")) {
    superjournal_unlinks++;
    pause_at("superjournal_deleted");
  }
  return rc;
}

static void must(int condition) {
  if (condition) return;
  fprintf(stderr, "VFS probe setup or fixture check failed\n");
  exit(2);
}
static void exec(sqlite3 *db, const char *sql) {
  char *message = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &message) == SQLITE_OK) return;
  fprintf(stderr, "SQLite probe statement failed: %s\n", message ? message : sqlite3_errmsg(db));
  sqlite3_free(message);
  exit(2);
}
static void attach(sqlite3 *db, const char *name, const char *file) {
  char *sql = sqlite3_mprintf("ATTACH DATABASE %Q AS %s", file, name);
  must(sql != NULL);
  exec(db, sql);
  sqlite3_free(sql);
}
static void configure(sqlite3 *db, const char *schema, const char *journal, const char *sync) {
  char *sql = sqlite3_mprintf("PRAGMA %s.journal_mode=%s; PRAGMA %s.synchronous=%s; PRAGMA %s.journal_size_limit=0",
                            schema, journal, schema, sync, schema);
  must(sql != NULL);
  exec(db, sql);
  sqlite3_free(sql);
  sql = sqlite3_mprintf("PRAGMA %s.journal_mode", schema);
  sqlite3_stmt *statement = NULL;
  must(sql != NULL && sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_OK);
  must(sqlite3_step(statement) == SQLITE_ROW && sqlite3_stricmp((const char *)sqlite3_column_text(statement, 0), journal) == 0);
  must(sqlite3_finalize(statement) == SQLITE_OK);
  sqlite3_free(sql);
}
static void exec_file(sqlite3 *db, const char *file) {
  FILE *source = fopen(file, "rb");
  must(source != NULL);
  char body[4096];
  size_t n = fread(body, 1, sizeof(body) - 1, source);
  must(feof(source) && !ferror(source));
  fclose(source);
  body[n] = '\0';
  exec(db, body);
}
int main(int argc, const char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts(sqlite3_libversion());
    return 0;
  }
  must(argc == 10);
  phase = argv[7];
  parent_vfs = sqlite3_vfs_find(NULL);
  must(parent_vfs != NULL);
  io_v1 = io;
  io_v1.iVersion = 1;
  io_v2 = io;
  io_v2.iVersion = 2;
  sqlite3_vfs wrapper = *parent_vfs;
  wrapper.szOsFile += (int)sizeof(ProbeFile);
  wrapper.zName = "write-durability-observer";
  wrapper.xOpen = open_observed;
  wrapper.xDelete = delete_observed;
  must(sqlite3_vfs_register(&wrapper, 0) == SQLITE_OK);
  sqlite3 *db;
  int rc = sqlite3_open_v2(argv[1], &db, SQLITE_OPEN_READWRITE, wrapper.zName);
  must(rc == SQLITE_OK);
  must(sqlite3_create_function(db, "study_stage", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY,
                               NULL, pause_sql, NULL, NULL) == SQLITE_OK);
  attach(db, "project", argv[2]);
  attach(db, "cache", argv[3]);
  exec(db, "PRAGMA locking_mode=EXCLUSIVE");
  configure(db, "main", argv[4], argv[6]);
  configure(db, "project", argv[5], argv[6]);
  configure(db, "cache", "DELETE", argv[6]);
  exec(db, "PRAGMA wal_autocheckpoint=0; BEGIN EXCLUSIVE; COMMIT");
  if (!strcmp(argv[9], "1")) exec(db, "PRAGMA fullfsync=ON");
  if (!strcmp(argv[5], "DELETE")) exec(db, "BEGIN; PRAGMA project.user_version=5; ROLLBACK");
  pause_at("idle_before");
  exec(db, "BEGIN; PRAGMA cache_spill=OFF");
  exec_file(db, argv[8]);
  pause_at("before_commit");
  armed = true;
  exec(db, "COMMIT");
  pause_at("after_commit");
  pause_at("graceful_close");
  if (!strcmp(phase, "checkpoint_project_page") || !strcmp(phase, "after_checkpoint")) {
    checkpointing = true;
    exec(db, "PRAGMA main.wal_checkpoint(TRUNCATE); PRAGMA project.wal_checkpoint(TRUNCATE)");
    pause_at("after_checkpoint");
  }
  must(sqlite3_close(db) == SQLITE_OK);
  if (!reached) fprintf(stderr, "Phase %s not reached\n", phase);
  return reached ? 0 : 3;
}
