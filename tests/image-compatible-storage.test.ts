import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {validateWorkspaceStorage} from '../packages/business/src/application-storage.ts';
import {startServer} from '../apps/server/src/index.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS} from '../packages/contracts/src/generation-image-settings.ts';
interface CapturedEntry {mode: number; uid: number; ino: number; nlink: number; bytes: string | null}
function capture(root: string): Record<string, CapturedEntry> {const result: Record<string, CapturedEntry> = {};const visit=(file: string,key: string)=>{const info=fs.lstatSync(file);result[key]={mode:info.mode,uid:info.uid,ino:info.ino,nlink:info.nlink,bytes:info.isFile()?fs.readFileSync(file).toString('hex'):info.isSymbolicLink()?fs.readlinkSync(file):null};if(info.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),key+'/'+name);};visit(root,'root');return result;}
for(const kind of ['permissions','symlink','hardlink','oversize','directory'])test(`custom settings ${kind} fails private startup preflight without stale lock, file, mode or SQLite writes`,{skip:process.platform==='win32'},async t=>{
 const base=fs.mkdtempSync(path.join(tmpdir(),'mioon-custom-image-storage-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'workspace'),outside=path.join(base,'sentinel');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(path.join(root,'image-settings'),{mode:0o700});fs.writeFileSync(outside,'synthetic-external-preserved',{mode:0o600});fs.writeFileSync(path.join(root,'server.lock'),'not-a-pid',{mode:0o600});
 const file=path.join(root,'image-settings','custom-settings.json');
 if(kind==='symlink')fs.symlinkSync(outside,file);else if(kind==='hardlink')fs.linkSync(outside,file);else if(kind==='directory')fs.mkdirSync(file,{mode:0o700});else{fs.writeFileSync(file,kind==='oversize'?'x'.repeat(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.envelopeBytes+1):'synthetic-preserved',{mode:0o600});if(kind==='permissions')fs.chmodSync(file,0o644);}
 const before=capture(base);assert.throws(()=>validateWorkspaceStorage(root),{code:'STORAGE_PRIVATE_REQUIRED'});for(const token of [undefined,'a'.repeat(64)])await assert.rejects(startServer({dataDir:root,port:0,token}),{code:'STORAGE_PRIVATE_REQUIRED'});assert.deepEqual(capture(base),before);
});
