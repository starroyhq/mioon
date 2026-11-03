import {openStore} from '../../packages/business/src/project-file/test-store.ts';
let code: string | undefined;
try { const unexpected = openStore(process.argv[2]); unexpected.close(); }
catch (error) { code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'; }
process.send?.({code}, () => process.disconnect());
