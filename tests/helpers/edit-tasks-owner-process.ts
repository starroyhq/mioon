// Synthetic child process for the retained-task exclusive-owner regression.
// It never signals another process or changes lock/security settings.
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
interface OwnerRequest {projectId: string; taskId: string; digest: string; [key: string]: unknown}
const [root,text]=process.argv.slice(2);
if(!root||!text)throw Error('Usage: edit-tasks-owner-process <root> <requestJson>');
const request: OwnerRequest=JSON.parse(text);
let ownerDenied=false;let unexpectedOwner: ReturnType<typeof openStore>|undefined;
try{unexpectedOwner=openStore(root);}catch(error){ownerDenied=/already has a running backend/.test(error!==null&&typeof error==='object'&&'message' in error?String((error as {message: unknown}).message):'');}finally{unexpectedOwner?.close();}
const store=openStore(root,{lock:false});
try{
 const tasks=createEditTasks({store,services:createServices(store,new Map())});
 const before=tasks.get({projectId:request.projectId,taskId:request.taskId}) as {task: {status: string; [key: string]: unknown}};
 const failures: Record<string,string>={};
 for(const [name,run] of Object.entries({
  startup:()=>tasks.reconcileStartup(),
  reconcile:()=>tasks.reconcile({projectId:request.projectId,taskId:request.taskId,digest:request.digest}),
  execute:()=>tasks.execute(request),
 })){
  try{await run();failures[name]='UNEXPECTED_SUCCESS';}catch(error){failures[name]=error!==null&&typeof error==='object'&&'code' in error?String((error as {code: unknown}).code):'UNKNOWN';}
 }
 const after=tasks.get({projectId:request.projectId,taskId:request.taskId}) as {task: {status: string; [key: string]: unknown}};
 process.stdout.write(JSON.stringify({ownerDenied,before:before.task.status,after:after.task.status,
  unchanged:JSON.stringify(before.task)===JSON.stringify(after.task),failures}));
}finally{store.close();}
