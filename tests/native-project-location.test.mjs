import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeProjectLocation} from '../apps/web/src/native-project-location.ts';
import {combineNativeEntryClose} from '../apps/web/src/native-entry-close.ts';
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
test('native pop restores exact assigned project without opening, writing business or pushing history', () => {
  const own=`http://127.0.0.1:45123/?project=${a}`, writes=[];
  const window={location:{href:own},history:{replaceState(data,unused,url){writes.push([data,unused,url]);window.location.href=url;}}};
  const route=createNativeProjectLocation(window,a); assert.equal(route.restore(),true); assert.deepEqual(writes,[]);
  window.location.href=`http://127.0.0.1:45123/?project=${b}`; assert.equal(route.restore(),true); assert.equal(window.location.href,own); assert.deepEqual(writes,[[{projectId:a},'',own]]);
  window.location.href=own+'#untrusted'; assert.equal(route.restore(),true); assert.equal(window.location.href,own);
});
test('native route rejects unassigned identity/extra routes and does not fall back on history failure', () => {
  for(const href of [`http://127.0.0.1:45123/?project=${b}`,`http://127.0.0.1:45123/?project=${a}&x=1`,`https://example.com/?project=${a}`,`file:///${a}`])
    assert.throws(()=>createNativeProjectLocation({location:{href},history:{replaceState(){assert.fail();}}},a));
  const window={location:{href:`http://127.0.0.1:45123/?project=${a}`},history:{replaceState(){throw Error('Unavailable');}}};
  const route=createNativeProjectLocation(window,a); window.location.href='about:blank'; assert.equal(route.restore(),false);
});
test('project entry close projection retains exact independent input versions and unknowns without mutation', () => {
  const editor=Object.freeze({dirty:false,busy:false,unknown:true,identity:Object.freeze(['editor-owner',4])});
  const entry=Object.freeze({dirty:true,busy:true,unknown:false,identity:Object.freeze(['entry-owner',7])});
  assert.deepEqual(combineNativeEntryClose(editor,entry),{dirty:true,busy:true,unknown:true,identity:['editor',2,'editor-owner',4,'project-entry',2,'entry-owner',7]});
  assert.notDeepEqual(combineNativeEntryClose(editor,{...entry,identity:['entry-owner',8]}),combineNativeEntryClose(editor,entry));
});
