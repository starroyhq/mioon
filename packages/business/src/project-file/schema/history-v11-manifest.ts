// Frozen format 4 candidate history catalog from cd1473b4.
import {FORMAT3_RELEASE_MANIFEST} from './format3-manifest.ts';
import {FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION} from './domains/canvas.ts';
import type {SchemaManifest} from './manifest-check.ts';

export const FORMAT4_INITIAL_HISTORY_MANIFEST: SchemaManifest = Object.freeze({
  version: FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION,
  entries: Object.freeze([
    ...FORMAT3_RELEASE_MANIFEST.history.entries,
    {type: "index", name: "sqlite_autoindex_canvas_history_entries_1", tbl_name: "canvas_history_entries", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    {type: "index", name: "sqlite_autoindex_canvas_history_entries_2", tbl_name: "canvas_history_entries", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    {type: "index", name: "sqlite_autoindex_canvas_history_state_1", tbl_name: "canvas_history_state", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    {type: "index", name: "sqlite_autoindex_canvas_requests_1", tbl_name: "canvas_requests", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    {type: "table", name: "canvas_history_entries", tbl_name: "canvas_history_entries", sha256: "f2ef1f3d8d30c320313abed25c9f97653eb4f9a61029e273fa00d4b9170e27a5"},
    {type: "table", name: "canvas_history_state", tbl_name: "canvas_history_state", sha256: "3a10ecaa09605534961c25061f93925c5d057a2a48b791161cb21ba245041880"},
    {type: "table", name: "canvas_requests", tbl_name: "canvas_requests", sha256: "f247021babec3c872b565193752a899d83e13d4e283c43b675fa8fe97ece1bd8"},
    {type: "trigger", name: "immutable_canvas_requests", tbl_name: "canvas_requests", sha256: "fa3ec70ad0e46513b1a74e836a1225cd73e997eb44d1b3d8556c83f3331caac5"},
    {type: "trigger", name: "reject_canvas_request_replacement", tbl_name: "canvas_requests", sha256: "a36c2ead3f0c5a2ab61c336fea4dc3b85488496b8aec03fcdaf105fd850441d1"},
    {type: "trigger", name: "retain_canvas_requests", tbl_name: "canvas_requests", sha256: "66897a173e499bbb612080ac0cd34463522ecdd56a200405ae4c1f2341769318"},
  ]),
});
