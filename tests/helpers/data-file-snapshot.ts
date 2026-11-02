/** Snapshot ordinary bytes without opening a SQLite file its owner holds.
 * Database paths come from that owner's actual PRAGMA database_list. */
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {projectFileIdentity} from '../../packages/business/src/app-db/identity.ts';
import {isAppLibraryHeld} from '../../packages/business/src/app-db/connection.ts';
import {isProjectFileHeld} from '../../packages/business/src/project-file/held-files.ts';
import path from 'node:path';
export function databaseFiles(db:DatabaseSync):string[]{return db.prepare('PRAGMA database_list').all().map(row=>String(row.file)).filter(Boolean);}
export async function dataFileSnapshot(root:string,databases:readonly string[],relative=''):Promise<Record<string,string>[]> {
 const excluded=new Set(databases.flatMap(file=>[file,file+'-journal',file+'-wal',file+'-shm']));
 const entries:Record<string,string>[]=[];
 for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,entry.name),file=path.join(root,name);
  if(entry.isDirectory())entries.push({directory:name},...await dataFileSnapshot(root,databases,name));
  else if(!excluded.has(file)&&name!=='server.lock'){
   // Identity lookup is lstat only and also protects a held file renamed away
   // from the owner's PRAGMA path. Do not yield between that check and reading
   // ordinary bytes: another same-process acquire cannot enter in that gap.
   const identity=projectFileIdentity(file),base=file.replace(/-(?:journal|wal|shm)$/u,''),baseIdentity=base===file?null:projectFileIdentity(base);
   if(identity&&(isProjectFileHeld(identity)||isAppLibraryHeld(identity))||baseIdentity&&(isProjectFileHeld(baseIdentity)||isAppLibraryHeld(baseIdentity)))continue;
   entries.push({file:name,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});
  }
 }
 return entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
