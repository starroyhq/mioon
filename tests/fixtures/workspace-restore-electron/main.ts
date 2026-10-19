// QA-only fixed Electron main. No BrowserWindow, renderer, token or provider.
// Authored as TypeScript; tests/workspace-restore-electron-qa.mjs strips the
// types and writes the .cjs entry it launches, so no generated file is tracked.
const {app,utilityProcess} = require('electron') as typeof import('electron');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const root = path.resolve(__dirname,'../../..');
const evidence = path.join(root,'evidence/workspace-restore/electron-final');
interface UtilityReport {readonly ok?: boolean}
let report: UtilityReport | undefined, child: import('electron').UtilityProcess | undefined, failed = false;
app.setName('Mioon Restore Gate QA');
app.setPath('userData',path.join(evidence,'user-data'));
process.on('SIGTERM',()=>{failed=true;if(child)child.kill();else app.exit(1);});
app.whenReady().then(()=>{
 child=utilityProcess.fork(path.join(root,'tests/workspace-restore-electron-qa.mjs'),['utility'],{env:{},stdio:'pipe',serviceName:'Mioon restore gate QA'});
 child.stdout?.on('data',(bytes: Buffer)=>process.stdout.write(bytes));child.stderr?.on('data',(bytes: Buffer)=>process.stderr.write(bytes));
 child.on('message',(value: unknown)=>{report=value as UtilityReport;fs.writeFileSync(path.join(evidence,'utility-report.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});child!.postMessage('report-saved');});
 const watchdog=setTimeout(()=>{failed=true;child?.kill();},60000);
 child.on('exit',(code: number)=>{clearTimeout(watchdog);app.exit(!failed&&code===0&&report?.ok?0:1);});
}).catch((error: unknown)=>{process.stderr.write(String(error)+'\n');app.exit(1);});
