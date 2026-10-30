// Derived from the format-72 workspace schema by `node tests/helpers/project-file-schema-derivation.ts --write`.
// Owner: 丙 (timeline undo history in the local history database).
// Changing this schema requires raising HISTORY_SCHEMA_VERSION in ../databases.ts and regenerating ../manifest.ts.
export const TIMELINE_HISTORY_SCHEMA: readonly string[] = Object.freeze([
  // timeline_history
  "CREATE TABLE timeline_history(\n id TEXT PRIMARY KEY,projectId TEXT NOT NULL,\n position INTEGER NOT NULL CHECK(position>0),operation TEXT NOT NULL,createdAt TEXT NOT NULL,\n beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL,UNIQUE(projectId,position))",
  "CREATE TRIGGER immutable_timeline_history BEFORE UPDATE ON timeline_history\n BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END",
  // timeline_history_cursors
  "CREATE TABLE timeline_history_cursors(\n projectId TEXT PRIMARY KEY,position INTEGER NOT NULL CHECK(position>=0))",
]);
