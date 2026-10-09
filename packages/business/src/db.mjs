import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,writeFileSync,readFileSync,unlinkSync,existsSync,closeSync} from 'node:fs';
import path from 'node:path';
export function openStore(root,{lock=true}={}){
 mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(path.join(root,'media'),{recursive:true});
 const lockPath=path.join(root,'server.lock');
 if(lock){if(existsSync(lockPath)){const pid=Number(readFileSync(lockPath,'utf8'));let active=false;try{process.kill(pid,0);active=true;}catch{}if(active)throw Error('This data directory already has a running backend');unlinkSync(lockPath);}const fd=openSync(lockPath,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);INSERT OR IGNORE INTO schema_version VALUES(1);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS shots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS timelines(id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(scope,requestId));
 CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL,event TEXT NOT NULL,createdAt TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_timeline_responses BEFORE UPDATE ON timeline_requests BEGIN SELECT RAISE(ABORT,'timeline request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_timeline_render_snapshot BEFORE UPDATE ON exports
 WHEN json_extract(OLD.data,'$.mode')='timeline' AND (
 json_extract(NEW.data,'$.mode') IS NOT 'timeline' OR
 json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot') OR
 json_extract(NEW.data,'$.timelineRevision') IS NOT json_extract(OLD.data,'$.timelineRevision') OR
 json_extract(NEW.data,'$.purpose') IS NOT json_extract(OLD.data,'$.purpose'))
 BEGIN SELECT RAISE(ABORT,'timeline render snapshots are immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(2);`);
 const tables=new Set(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']);
 const table=t=>{if(!tables.has(t))throw Error('Unknown table');return t;};
 const get=(t,id)=>{const r=db.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);return r?JSON.parse(r.data):null;};
 const list=(t,p)=>db.prepare(`SELECT data FROM ${table(t)}${p?' WHERE projectId=?':''}`).all(...p?[p]:[]).map(r=>JSON.parse(r.data));
 const put=(t,obj)=>{table(t);const cols=t==='projects'?['id','data']:t==='versions'?['id','projectId','jobId','data']:['id','projectId','data'];const values=cols.map(k=>k==='data'?JSON.stringify(obj):obj[k]);db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);return obj;};
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const close=()=>{db.close();if(lock&&existsSync(lockPath)&&readFileSync(lockPath,'utf8')===String(process.pid))unlinkSync(lockPath);};
 return {db,root,get,list,put,tx,close};
}
