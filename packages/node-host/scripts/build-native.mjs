import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw Error('Build the private storage helper with Node 24 and the Windows SDK on Windows. Cross-platform mocks do not establish Windows readiness.');
const require=createRequire(import.meta.url);
const result=spawnSync(process.execPath,[require.resolve('node-gyp/bin/node-gyp.js'),'rebuild'],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit'});
process.exitCode=result.status??1;
