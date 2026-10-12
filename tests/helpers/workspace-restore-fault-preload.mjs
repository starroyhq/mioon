// Synthetic child-process fault injection only; no production fault switches.
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const {point,destination,backup,payload}=globalThis.__restoreFault;
const native={...fs},fds=new Map();let guarded=false,linked=false,fired=false;
const candidate=value=>typeof value==='string'&&path.dirname(value)===destination&&/^\.restore-.+\.sqlite$/.test(path.basename(value));
const existsCandidate=()=>native.existsSync(destination)&&native.readdirSync(destination).some(name=>/^\.restore-.+\.sqlite$/.test(name));
function fire(expected){if(fired||point!==expected)return false;fired=true;process.exit(77);}
fs.openSync=function(file,...args){const fd=native.openSync(file,...args);fds.set(fd,String(file));return fd;};
fs.closeSync=function(fd){fds.delete(fd);return native.closeSync(fd);};
fs.writeSync=function(fd,...args){const result=native.writeSync(fd,...args);if(candidate(fds.get(fd))&&!guarded)fire('raw_copy');return result;};
fs.fsyncSync=function(fd){
 const file=fds.get(fd),isDestination=file===destination;
 if(linked&&isDestination){
  if(point==='directory_fsync_error'&&!fired){fired=true;throw Object.assign(Error('SYNTHETIC_PRIVATE_ERROR'),{code:'EIO'});}
  fire('directory_sync');
  if(point==='replace_lock'&&!fired){fired=true;native.unlinkSync(path.join(destination,'server.lock'));native.writeFileSync(path.join(destination,'server.lock'),'unknown-lock-owner',{mode:0o600});}
 }
 const result=native.fsyncSync(fd);
 if(guarded&&candidate(file))fire('candidate_sync');
 if(guarded&&typeof file==='string'&&file.startsWith(path.join(destination,'media')+path.sep)){
  fire('media_sync');
  if(point==='cancel_before'&&!fired){fired=true;process.emit('SIGTERM');}
  if(point==='replace_source'&&!fired){fired=true;native.appendFileSync(path.join(backup,'payload',payload),'changed-during-restore');}
  if(point==='unknown_destination'&&!fired){fired=true;native.writeFileSync(path.join(destination,'unknown-owner.txt'),'must-remain',{mode:0o600});}
 }
 return result;
};
fs.linkSync=function(source,target){
 if(target===path.join(destination,'workbench.sqlite')){
  fire('before_activation');
  if(point==='collision'&&!fired){fired=true;native.writeFileSync(target,'RACE_WINNER',{mode:0o600});}
  const result=native.linkSync(source,target);linked=true;
  fire('between_link_unlink');
  if(point==='link_ack_error'&&!fired){fired=true;throw Object.assign(Error('SYNTHETIC_PRIVATE_ERROR'),{code:'EIO'});}
  if(point==='cancel_after'&&!fired){fired=true;process.emit('SIGTERM');}
  return result;
 }
 return native.linkSync(source,target);
};
fs.unlinkSync=function(file){const result=native.unlinkSync(file);if(linked&&candidate(String(file)))fire('after_activation');return result;};
syncBuiltinESMExports();
const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.exec=function(sql){const present=existsCandidate(),result=exec.call(this,sql);if(present){if(sql.includes('CREATE TABLE workspace_restoration'))fire('schema_ddl');if(sql==='COMMIT'){guarded=true;fire('schema_commit');}}return result;};
DatabaseSync.prototype.prepare=function(sql){
 const statement=prepare.call(this,sql);
 if(sql.startsWith('INSERT INTO workspace_restoration')){const run=statement.run;statement.run=function(...args){const result=run.apply(this,args);if(existsCandidate())fire('identity');return result;};}
 if(sql==='PRAGMA wal_checkpoint(TRUNCATE)'){const get=statement.get;statement.get=function(...args){const result=get.apply(this,args);if(existsCandidate())fire('checkpoint');return result;};}
 return statement;
};
if(point==='ack_loss'){const write=process.stdout.write;process.stdout.write=function(chunk,...args){if(String(chunk).includes('"publication":"confirmed"'))fire('ack_loss');return write.call(this,chunk,...args);};}
