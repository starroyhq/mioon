import {DatabaseSync} from 'node:sqlite';
import {openProjectConnection} from '../../packages/business/src/project-file/connection.ts';

const input=JSON.parse(process.argv[2]??'null') as {projectFile:string;localDir:string;cacheDir:string;tempDir:string;point:string};
if(!input||![input.projectFile,input.localDir,input.cacheDir,input.tempDir,input.point].every(value=>typeof value==='string'&&value.length>0))throw Error('Missing owned test fixture');
const exec=DatabaseSync.prototype.exec;let upgrading=false;
DatabaseSync.prototype.exec=function(sql:string):void{
 exec.call(this,sql);
 if(sql==='DROP TABLE main.image_reviews')upgrading=true;
 if(input.point==='after-drop'&&sql==='DROP TABLE main.image_reviews'||input.point==='after-copy'&&sql.startsWith('INSERT INTO main.image_reviews(rowid,')||input.point==='after-commit'&&upgrading&&sql==='COMMIT')process.kill(process.pid,'SIGKILL');
};
openProjectConnection({projectFile:input.projectFile,locate:()=>({localDir:input.localDir,cacheDir:input.cacheDir,tempDir:input.tempDir})}).close();
