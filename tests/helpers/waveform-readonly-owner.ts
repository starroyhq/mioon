import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';

const [root,serialized]=process.argv.slice(2);
if(!root||!serialized)throw Error('Usage: waveform-readonly-owner <root> <inputJson>');
JSON.parse(serialized);
let spawns=0;
const stopObserving=onMediaProcess(event=>{if(event.type==='started')spawns++;});
let code: string | undefined;
try { const unexpected = openStore(root); unexpected.close(); }
catch (error) { code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'; }
stopObserving();
process.stdout.write(JSON.stringify({code,spawns}));
