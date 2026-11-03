import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import type {TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServerProject,openServerProject} from './project-database.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
/** The persisted public render asset projection, without private cache fields. */
export function publicAsset(asset:Readonly<Record<string,unknown>>):Record<string,unknown> {
 return Object.fromEntries(['id','sha256','mimeType','duration','width','height','hasAudio','relativePath'].filter(key=>Object.hasOwn(asset,key)&&asset[key]!==null).map(key=>[key,asset[key]]));
}
/** Raw values and schema of every actual attached database, on its owner connection. */
export function snapshot(db:DatabaseSync) {
 const objects:Record<string,unknown>[]=[];
 const tables:Record<string,{fields:string[];rows:unknown[][]}>={};
 for(const {name} of db.prepare('PRAGMA database_list').all()){
  if(typeof name!=='string'||name==='temp')continue;
  const catalog=db.prepare(`SELECT type,name,tbl_name,sql FROM ${quote(name)}.sqlite_schema ORDER BY type,name`).all();
  for(const item of catalog){
   objects.push({database:name,...item});
   if(item.type!=='table'||typeof item.name!=='string')continue;
   const fields=db.prepare(`PRAGMA ${quote(name)}.table_info(${quote(item.name)})`).all().map(row=>String(row.name));
   const expressions=fields.flatMap(field=>[`typeof(${quote(field)})`,`CASE WHEN typeof(${quote(field)})='real' THEN printf('%!.26g',${quote(field)}) ELSE hex(CAST(${quote(field)} AS BLOB)) END`]);
   const statement=db.prepare(`SELECT CAST(rowid AS TEXT),${expressions.join(',')} FROM ${quote(name)}.${quote(item.name)} ORDER BY rowid`);
   statement.setReturnArrays(true);
   const key=Object.hasOwn(tables,item.name)?`${name}.${item.name}`:item.name;
   tables[key]={fields,rows:statement.all() as unknown as unknown[][]};
  }
 }
 return {objects,tables};
}
export function insert(db:DatabaseSync,table:string,row:Readonly<Record<string,SQLInputValue>>) {
 const entries=Object.entries(row);
 return db.prepare(`INSERT INTO ${quote(table)}(${entries.map(([name])=>quote(name)).join(',')}) VALUES(${entries.map(()=>'?').join(',')})`).run(...entries.map(([,value])=>value));
}
export function probe<T>(db:DatabaseSync,read:()=>T):T {
 db.exec('SAVEPOINT retained_probe');
 try{return read();}finally{db.exec('ROLLBACK TO retained_probe; RELEASE retained_probe');}
}
/** Real server layout, registration, three-file kernel and application ownership. */
export function kernelFixture(t:TestContext,name='Retained fixture') {
 const dataDir=mkdtempSync(path.join(tmpdir(),'mioon-retained-'));
 const created=createServerProject(dataDir,{name});let store=created.store;
 t.after(()=>{if(store.db.isOpen)store.close();rmSync(dataDir,{recursive:true,force:true});});
 return {dataDir,projectId:created.projectId,get store(){return store;},reopen(){if(store.db.isOpen)store.close();store=openServerProject(dataDir,created.projectId);return store;}};
}
/** Independent value-reader fuzz surface. These unconstrained SQLite tables
 * provide current cell names only: no Store, schema version or owner claim.
 * Native guards and ownership are tested through kernelFixture instead. */
export function lexerDatabase(t:TestContext):DatabaseSync {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA trusted_schema=OFF;
 CREATE TABLE projects(id TEXT,data TEXT);
 CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);
 CREATE TABLE timelines(id TEXT,projectId TEXT,data TEXT);
 CREATE TABLE timeline_history(id TEXT,projectId TEXT,position INTEGER,operation TEXT,createdAt TEXT,beforeSnapshot TEXT,afterSnapshot TEXT);
 CREATE TABLE timeline_history_cursors(projectId TEXT,position INTEGER);
 CREATE TABLE timeline_requests(requestId TEXT,requestHash TEXT,response TEXT);
 CREATE TABLE exports(id TEXT,projectId TEXT,data TEXT);
 CREATE TABLE edit_tasks(position INTEGER,id TEXT,projectId TEXT,operation TEXT,input TEXT,requestId TEXT,digest TEXT,lane TEXT,origin TEXT,status TEXT,revision INTEGER,acknowledged INTEGER,claim TEXT,claimInstance TEXT,receiptDigest TEXT,errorCode TEXT,createdAt TEXT,updatedAt TEXT,bytes INTEGER);
 CREATE TABLE project_lut_resources(id TEXT,projectId TEXT,name TEXT,sha256 TEXT,sizeBytes INTEGER,profile TEXT,metadata TEXT,content BLOB,createdAt TEXT);
 CREATE TABLE lut_import_requests(requestId TEXT,projectId TEXT,inputHash TEXT,resourceId TEXT);
 CREATE TABLE asset_annotations(assetId TEXT,projectId TEXT,revision INTEGER,tags TEXT,note TEXT);
 CREATE TABLE asset_annotation_requests(requestId TEXT,operation TEXT,projectId TEXT,canonicalInput TEXT,response TEXT);
 CREATE TABLE mutation_requests(requestId TEXT);CREATE TABLE asset_range_requests(requestId TEXT);
 CREATE TABLE asset_disposition_requests(requestId TEXT);CREATE TABLE subject_requests(requestId TEXT);`);
 return db;
}
