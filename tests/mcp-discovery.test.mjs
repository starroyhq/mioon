import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink, realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {resolveConnection,validateLocalUrl} from '../apps/mcp/src/connection.ts';
const token='synthetic-desktop-mcp-token-for-tests';
test('MCP explicit credentials preserve existing loopback config',async()=>{
 assert.deepEqual(await resolveConnection({MIOON_TOKEN:token}),{base:'http://127.0.0.1:4318',token});
 for(const url of ['https://127.0.0.1:1','http://evil.example','http://user:pass@localhost:4318','http://localhost:4318/path','http://localhost:4318/?secret=x'])assert.throws(()=>validateLocalUrl(url));
 await assert.rejects(resolveConnection({}),/MIOON_TOKEN/);
});
test('MCP desktop discovery reads owner-only files and follows token rotation',async()=>{
 const dir=await mkdtemp(path.join(await realpath(tmpdir()),'wb-mcp-discovery-')),tokenFile=path.join(dir,'mcp-token'),file=path.join(dir,'mcp-connection.json');
 const descriptor={version:1,url:'http://127.0.0.1:45123',tokenFile,pid:process.pid};
 await writeFile(tokenFile,token,{mode:0o600});await writeFile(file,JSON.stringify(descriptor),{mode:0o600});
 const env={MIOON_CONNECTION_FILE:file};assert.deepEqual(await resolveConnection(env),{base:descriptor.url,token});
 await writeFile(tokenFile,token+'-rotated');assert.equal((await resolveConnection(env)).token,token+'-rotated');
 await assert.rejects(resolveConnection({...env,MIOON_BASE_URL:'http://localhost:4318'}),/mix/);
 await chmod(tokenFile,0o644);await assert.rejects(resolveConnection(env),/0600/);await chmod(tokenFile,0o600);
 await writeFile(file,JSON.stringify({...descriptor,tokenFile:path.join(dir,'..','foreign-token')}));await assert.rejects(resolveConnection(env),/beside/);
 await writeFile(file,JSON.stringify({...descriptor,pid:2147483647}));await assert.rejects(resolveConnection(env),/not running/);
 const link=path.join(dir,'symlink.json');await symlink(file,link);await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:link}),/regular file/);
});
