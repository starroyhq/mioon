import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Independently pinned hashes of the reviewed schema23 CHECK additions. This
// helper removes only those exact bytes, never a wildcard future schema change.
const digest=value=>createHash('sha256').update(value).digest('hex');
const EDIT_BRANCH_SHA256='3fcd8d1772be6cf3c92e282114d497ce45c7c0985941969f08c8c095e35d7ed6';
const SEPARATION_SHA256='85175b5a5cf8143e0d0348cc057f232aae09bcb14ab8ddc166cd80e47614d1cf';
export function legacyImageReviewSql(sql){
 const marker='CONSTRAINT image_review_intent_v23';
 assert.equal(sql.split(marker).length,2,'exactly one schema23 intent CHECK');
 const branchStart=sql.indexOf("\n        OR\n        (json_extract(canonicalIntent,'$.schemaVersion') IS 4");
 const branchEnd=sql.indexOf('\n      ),\n      CONSTRAINT image_review_edit_separation_v23',branchStart);
 assert.ok(branchStart>=0&&branchEnd>branchStart,'bounded edit CHECK addition');
 const branch=sql.slice(branchStart,branchEnd);
 assert.equal(digest(branch),EDIT_BRANCH_SHA256,'only the reviewed edit CHECK can be normalized');
 const separationStart=sql.indexOf('      CONSTRAINT image_review_edit_separation_v23');
 const separationEnd=sql.indexOf("\n      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts')",separationStart);
 assert.ok(separationStart>=0&&separationEnd>separationStart);
 const separation=sql.slice(separationStart,separationEnd);
 assert.equal(digest(separation),SEPARATION_SHA256,'only the reviewed legacy/edit separation CHECK can be normalized');
 return sql.replace(branch+'\n','').replace(separation+'\n','').replace(marker,'CONSTRAINT image_review_intent_v19');
}
export function normalizeImageReviewObject(row){return Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql:legacyImageReviewSql(row.sql)});}
