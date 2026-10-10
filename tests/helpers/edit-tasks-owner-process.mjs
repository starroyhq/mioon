// Synthetic child process for the retained-task exclusive-owner regression.
// It never signals another process or changes lock/security settings.
import {openStore} from '../../packages/business/src/db.mjs';
import {createServices} from '../../packages/business/src/services.mjs';
import {createEditTasks} from '../../packages/business/src/edit-tasks.mjs';
const [root,text]=process.argv.slice(2),request=JSON.parse(text);
let ownerDenied=false,unexpectedOwner;
try{unexpectedOwner=openStore(root);}catch(error){ownerDenied=/already has a running backend/.test(error.message);}finally{unexpectedOwner?.close();}
const store=openStore(root,{lock:false});
try{
 const tasks=createEditTasks({store,services:createServices(store,new Map())});
 const before=tasks.get({projectId:request.projectId,taskId:request.taskId});
 const failures={};
 for(const [name,run] of Object.entries({
  startup:()=>tasks.reconcileStartup(),
  reconcile:()=>tasks.reconcile({projectId:request.projectId,taskId:request.taskId,digest:request.digest}),
  execute:()=>tasks.execute(request),
 })){
  try{await run();failures[name]='UNEXPECTED_SUCCESS';}catch(error){failures[name]=error.code;}
 }
 const after=tasks.get({projectId:request.projectId,taskId:request.taskId});
 process.stdout.write(JSON.stringify({ownerDenied,before:before.task.status,after:after.task.status,
  unchanged:JSON.stringify(before.task)===JSON.stringify(after.task),failures}));
}finally{store.close();}
