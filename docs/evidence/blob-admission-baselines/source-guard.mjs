import {registerHooks} from 'node:module';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const primary='/Users/kouzen/Documents/data/mioon/';
const checkout=process.env.BLOB_CHECKOUT_ROOT;
const out=process.env.BLOB_IMPORT_AUDIT;
registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);
 if(result.url.startsWith('file:')){const p=fileURLToPath(result.url);
  if(p.startsWith(primary)&&/^(?:apps|packages|scripts|tests|config)\//.test(p.slice(primary.length)))throw Error('MAIN_SOURCE_LEAK:'+p);
  if(checkout&&p.startsWith(checkout+'/')&&/^(?:apps|packages|scripts|tests|config)\//.test(p.slice(checkout.length+1)))fs.appendFileSync(out,p+'\n',{mode:0o600});
 }
 return result;}});
