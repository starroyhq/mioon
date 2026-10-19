import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {catalogs as before} from './before/i18n/index.ts';
import {catalogs as after} from './verify/packages/i18n/src/index.ts';
import {schemas} from './verify/packages/client/src/index.mjs';
const missing=catalog=>Object.keys(schemas).map(operation=>'operation.'+operation).filter(key=>!Object.hasOwn(catalog,key)).sort();
const previous=missing(before),current=missing(after);assert.deepEqual(current,previous);await writeFile(new URL('./operation-key-comparison.json',import.meta.url),JSON.stringify({schemas:Object.keys(schemas).length,beforeMissing:previous,afterMissing:current,unchanged:true},null,2)+'\n');console.log(JSON.stringify({schemas:Object.keys(schemas).length,unchanged:true,missing:current}));
