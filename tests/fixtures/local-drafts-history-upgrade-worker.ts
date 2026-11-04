/** Isolated SIGKILL fixture only. No production fault hook or inspection port. */
import {DatabaseSync} from 'node:sqlite';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';
import {HISTORY_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';

const input=JSON.parse(process.argv[2]??'null') as {projectFile:string;localDir:string;cacheDir:string;tempDir:string;point:string};
if(!input||![input.projectFile,input.localDir,input.cacheDir,input.tempDir,input.point].every(value=>typeof value==='string'&&value.length>0))throw Error('Missing owned S8 fixture');
const exec=DatabaseSync.prototype.exec,version=`UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`;let upgrading=false;
DatabaseSync.prototype.exec=function(sql:string):void{
  if(input.point==='before-version'&&sql===version)process.kill(process.pid,'SIGKILL');
  exec.call(this,sql);
  if(sql.startsWith('CREATE TABLE main.local_draft_states('))upgrading=true;
  const tables:Readonly<Record<string,string>>={'after-state-table':'local_draft_states','after-delivery-table':'local_delivery_drafts','after-shot-table':'local_shot_text_drafts'};const table=tables[input.point];
  if(table&&sql.startsWith(`CREATE TABLE main.${table}(`)||input.point==='after-version'&&sql===version||input.point==='after-commit'&&upgrading&&sql==='COMMIT')process.kill(process.pid,'SIGKILL');
};
openProjectConnection({projectFile:input.projectFile,locate:()=>({localDir:input.localDir,cacheDir:input.cacheDir,tempDir:input.tempDir})}).close();
throw Error('The requested S8 upgrade boundary was not reached');
