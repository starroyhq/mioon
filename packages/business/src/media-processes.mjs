import {spawn} from 'node:child_process';

const active = new Set(), observers = new Set();
const notify = event => {for(const observer of observers) {try {observer(event);} catch { /* telemetry must not alter rendering */ }}};
/** Only trusted executable paths and generated argv arrays reach this module. */
export function spawnMedia(command,args,options,{kind}={}) {
  const child=spawn(command,args,{...options,shell:false});
  active.add(child);
  if (child.pid) notify({type:'started',pid:child.pid,kind});
  child.once('close',()=>{active.delete(child);if(child.pid)notify({type:'exited',pid:child.pid,kind});});
  child.once('error',()=>{active.delete(child);});
  return child;
}
export function onMediaProcess(observer) {observers.add(observer);return()=>observers.delete(observer);}
export function mediaInterrupted(child) {return Boolean(child.workbenchInterrupted);}
export function interruptedMediaError() {return Object.assign(Error('Local render interrupted by shutdown'),{code:'MEDIA_CANCELLED'});}
export async function terminateMediaProcesses() {
  await Promise.all([...active].map(child=>new Promise(resolve=>{
    child.workbenchInterrupted=true;
    if(child.exitCode!==null||child.signalCode!==null){resolve();return;}
    const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
    child.once('close',()=>{clearTimeout(timer);resolve();});
    child.once('error',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGTERM');
  })));
}
