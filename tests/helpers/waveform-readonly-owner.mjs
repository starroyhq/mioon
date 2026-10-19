import {openStore,ownsStoreLock} from '../../packages/business/src/db.ts';
import {createWaveformServices} from '../../packages/business/src/waveforms.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';

const [root,serialized]=process.argv.slice(2),input=JSON.parse(serialized),store=openStore(root,{lock:false});
let txCalls=0,spawns=0;const tx=store.tx;
store.tx=fn=>{txCalls++;return tx(fn);};
const stopObserving=onMediaProcess(event=>{if(event.type==='started')spawns++;});
const changes=()=>store.db.prepare('SELECT total_changes() AS n').get().n,before=changes();
const service=createWaveformServices(store),read=service.handlers['asset.waveform.get'](input);
const request=service.handlers['asset.waveform.request']({...input,retry:true}),after=service.handlers['asset.waveform.get'](input);
let exclusiveDenied=false;try{const unexpected=openStore(root);unexpected.close();}catch{exclusiveDenied=true;}
await service.drain();stopObserving();
const result={owner:ownsStoreLock(store),txCalls,spawns,changes:changes()-before,read,request,after,exclusiveDenied};
store.close();process.stdout.write(JSON.stringify(result));
