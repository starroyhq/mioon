import {openStore,ownsStoreLock} from '../../packages/business/src/db.ts';
import {createWaveformServices} from '../../packages/business/src/waveforms.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';

const [root,serialized]=process.argv.slice(2);
if(!root||!serialized)throw Error('Usage: waveform-readonly-owner <root> <inputJson>');
const input: Record<string, unknown>=JSON.parse(serialized),store=openStore(root,{lock:false});
let txCalls=0,spawns=0;const tx=store.tx.bind(store);
store.tx=<T>(work: ()=>T): T=>{txCalls++;return tx(work);};
const stopObserving=onMediaProcess(event=>{if(event.type==='started')spawns++;});
const changes=(): number=>Number((store.db.prepare('SELECT total_changes() AS n').get() as {n: number}|undefined)?.n??0),before=changes();
const service=createWaveformServices(store),read=service.handlers['asset.waveform.get'](input as never);
const request=service.handlers['asset.waveform.request']({...input,retry:true} as never),after=service.handlers['asset.waveform.get'](input as never);
let exclusiveDenied=false;try{const unexpected=openStore(root);unexpected.close();}catch{exclusiveDenied=true;}
await service.drain();stopObserving();
const result={owner:ownsStoreLock(store),txCalls,spawns,changes:changes()-before,read,request,after,exclusiveDenied};
store.close();process.stdout.write(JSON.stringify(result));
