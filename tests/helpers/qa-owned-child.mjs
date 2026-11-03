/** Only the exact still-owned ChildProcess handle may be signalled. */
export function ownQaChild(child){
 let closed=false,observedError;
 const done=new Promise(resolve=>{
  child.on('error',error=>{observedError={code:error.code||null,message:error.message};});
  child.once('close',(code,signal)=>{closed=true;resolve({code,signal,...(observedError?{error:observedError}:{})});});
 });
 return {child,done,get closed(){return closed;},async stop(){
  if(closed)return done;
  child.kill('SIGTERM');let killTimer,deadline;
  try{return await Promise.race([done,new Promise((_,reject)=>{
   killTimer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},3000);
   deadline=setTimeout(()=>reject(Error('Owned fixture child cleanup is unconfirmed')),10000);
  })]);}finally{clearTimeout(killTimer);clearTimeout(deadline);}
 }};
}
